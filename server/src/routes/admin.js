// Merkez yonetimi: seri no havuzu (uretilen cihazlar) ve sistem ayarlari.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const settings = require('../settings');
const { fail, optionalId } = require('./util');
const { SERIAL_RE, normalizeSerial, IMPORT_MAX_ROWS } = require('./devices');

const api = express.Router();
const requireInventory = auth.requireApi('inventory.manage');

// ---- Seri no havuzu ----
// status: stock (hic tahsis edilmemis), allocated (bayiye tahsisli, henuz
// cihaz olarak eklenmemis), used (cihaz olarak kayitli)
api.get('/inventory', requireInventory, async (req, res) => {
  const params = [];
  const conds = ['TRUE'];
  if (req.query.q) { params.push(normalizeSerial(req.query.q) + '%'); conds.push(`i.serial LIKE $${params.length}`); }
  const dealerId = optionalId(req.query.dealerId, 'Bayi');
  if (dealerId) { params.push(dealerId); conds.push(`i.dealer_id = $${params.length}`); }
  if (req.query.batch) { params.push(String(req.query.batch)); conds.push(`i.batch = $${params.length}`); }
  if (req.query.status === 'stock') conds.push('i.dealer_id IS NULL AND dv.id IS NULL');
  else if (req.query.status === 'allocated') conds.push('i.dealer_id IS NOT NULL AND dv.id IS NULL');
  else if (req.query.status === 'used') conds.push('dv.id IS NOT NULL');
  const from = `FROM device_inventory i
                LEFT JOIN devices dv ON dv.id = i.serial
                LEFT JOIN dealers d ON d.id = i.dealer_id
                LEFT JOIN screen_models m ON m.id = i.model_id
               WHERE ${conds.join(' AND ')}`;
  const total = (await db.one(`SELECT count(*)::int AS n ${from}`, params)).n;
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = await db.many(
    `SELECT i.serial, i.batch, i.notes, i.created_at, i.dealer_id, d.name AS dealer_name,
            i.model_id, m.name AS model_name, dv.id IS NOT NULL AS used, dv.name AS device_name
     ${from} ORDER BY i.serial LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const summary = await db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE i.dealer_id IS NULL AND dv.id IS NULL)::int AS stock,
            count(*) FILTER (WHERE i.dealer_id IS NOT NULL AND dv.id IS NULL)::int AS allocated,
            count(*) FILTER (WHERE dv.id IS NOT NULL)::int AS used
       FROM device_inventory i LEFT JOIN devices dv ON dv.id = i.serial`,
  );
  const batches = (await db.many('SELECT DISTINCT batch FROM device_inventory WHERE batch IS NOT NULL ORDER BY batch')).map((r) => r.batch);
  res.json({ total, limit, offset, rows, summary, batches });
});

// Havuza toplu ekleme: rows [{serial, model, batch}], defaults {modelId, batch, dealerId}.
api.post('/inventory/import', requireInventory, async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const defaults = req.body.defaults || {};
  const dryRun = req.body.dryRun !== false;
  if (!rows.length) fail(400, 'Eklenecek seri no yok.');
  if (rows.length > IMPORT_MAX_ROWS * 4) fail(400, `Tek seferde en fazla ${IMPORT_MAX_ROWS * 4} seri no eklenebilir.`);
  const modelId = optionalId(defaults.modelId, 'Ekran modeli');
  const dealerId = optionalId(defaults.dealerId, 'Bayi');
  if (dealerId && !(await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]))) fail(404, 'Bayi bulunamadi.');
  const batchDefault = String(defaults.batch || '').trim().slice(0, 60) || null;
  const models = await db.many('SELECT id, code, name FROM screen_models');
  const lower = (s) => String(s || '').trim().toLocaleLowerCase('tr');

  const serials = rows.map((r) => normalizeSerial(r.serial));
  const existing = new Set((await db.many('SELECT serial FROM device_inventory WHERE serial = ANY($1)', [serials.filter((s) => SERIAL_RE.test(s))])).map((r) => r.serial));
  const seen = new Set();
  const report = rows.map((r, i) => {
    const serial = serials[i];
    const out = { row: i + 1, serial, ok: false, message: '' };
    if (!SERIAL_RE.test(serial)) { out.message = 'Seri no 8 haneli rakam olmali'; return out; }
    if (seen.has(serial)) { out.message = 'Listede tekrar ediyor'; return out; }
    seen.add(serial);
    if (existing.has(serial)) { out.message = 'Havuzda zaten var'; return out; }
    out.modelId = modelId;
    if (r.model) {
      const m = models.find((x) => lower(x.code) === lower(r.model) || lower(x.name).startsWith(lower(r.model)));
      if (!m) { out.message = `Ekran modeli bulunamadi: ${r.model}`; return out; }
      out.modelId = m.id;
    }
    out.batch = String(r.batch || '').trim().slice(0, 60) || batchDefault;
    out.ok = true;
    out.message = dryRun ? 'Eklenebilir' : 'Eklendi';
    return out;
  });
  const valid = report.filter((r) => r.ok);
  if (!dryRun && valid.length) {
    await db.tx(async (c) => {
      for (const r of valid) {
        await c.query('INSERT INTO device_inventory (serial, model_id, batch, dealer_id) VALUES ($1, $2, $3, $4)', [r.serial, r.modelId, r.batch, dealerId]);
      }
    });
    await audit.log(req.user, 'inventory.imported', { entityType: 'inventory', dealerId, branchId: null, message: `${valid.length} seri no havuza eklendi`, details: { batch: batchDefault, first: valid[0].serial, last: valid[valid.length - 1].serial } });
  }
  res.json({ dryRun, total: report.length, valid: valid.length, invalid: report.length - valid.length, rows: report.slice(0, 2000) });
});

// Bayiye tahsis / tahsisi kaldir (dealerId null). Cihaz olarak eklenmis
// numaralarin tahsisi degistirilemez (cihaz transferi Cihazlar sayfasindan).
api.post('/inventory/allocate', requireInventory, async (req, res) => {
  const serials = (Array.isArray(req.body.serials) ? req.body.serials : []).map(normalizeSerial).filter((s) => SERIAL_RE.test(s));
  if (!serials.length) fail(400, 'Seri no secilmedi.');
  const dealerId = optionalId(req.body.dealerId, 'Bayi');
  if (dealerId && !(await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]))) fail(404, 'Bayi bulunamadi.');
  const r = await db.query(
    `UPDATE device_inventory i SET dealer_id = $2
      WHERE i.serial = ANY($1) AND NOT EXISTS (SELECT 1 FROM devices dv WHERE dv.id = i.serial)`,
    [serials, dealerId],
  );
  await audit.log(req.user, dealerId ? 'inventory.allocated' : 'inventory.unallocated', { entityType: 'inventory', dealerId, branchId: null, message: `${r.rowCount} seri no` });
  res.json({ ok: true, affected: r.rowCount, skipped: serials.length - r.rowCount });
});

api.post('/inventory/delete', requireInventory, async (req, res) => {
  const serials = (Array.isArray(req.body.serials) ? req.body.serials : []).map(normalizeSerial).filter((s) => SERIAL_RE.test(s));
  if (!serials.length) fail(400, 'Seri no secilmedi.');
  const r = await db.query(
    'DELETE FROM device_inventory i WHERE i.serial = ANY($1) AND NOT EXISTS (SELECT 1 FROM devices dv WHERE dv.id = i.serial)',
    [serials],
  );
  await audit.log(req.user, 'inventory.deleted', { entityType: 'inventory', dealerId: null, branchId: null, message: `${r.rowCount} seri no` });
  res.json({ ok: true, affected: r.rowCount, skipped: serials.length - r.rowCount });
});

// ---- Sistem ayarlari ----
api.get('/settings', auth.requireApi('settings.manage'), async (req, res) => {
  res.json(await settings.all());
});

api.post('/settings', auth.requireApi('settings.manage'), async (req, res) => {
  const b = req.body;
  const before = await settings.all();
  if (b.company_name !== undefined) {
    const v = String(b.company_name).trim().slice(0, 80);
    if (!v) fail(400, 'Firma adi bos olamaz.');
    await settings.set('company_name', v);
  }
  if (b.inventory_required !== undefined) await settings.set('inventory_required', !!b.inventory_required);
  if (b.password_min_length !== undefined) {
    const n = Number(b.password_min_length);
    if (!Number.isInteger(n) || n < 6 || n > 64) fail(400, 'Minimum sifre uzunlugu 6-64 arasi olmali.');
    await settings.set('password_min_length', n);
  }
  if (b.queue_max_attempts !== undefined) {
    const n = Number(b.queue_max_attempts);
    if (!Number.isInteger(n) || n < 1 || n > 10) fail(400, 'Deneme sayisi 1-10 arasi olmali.');
    await settings.set('queue_max_attempts', n);
  }
  if (b.queue_ttl_hours !== undefined) {
    const n = Number(b.queue_ttl_hours);
    if (!Number.isInteger(n) || n < 1 || n > 24 * 30) fail(400, 'Bekleme suresi 1-720 saat arasi olmali.');
    await settings.set('queue_ttl_hours', n);
  }
  const after = await settings.all();
  await audit.log(req.user, 'settings.updated', { entityType: 'settings', dealerId: null, branchId: null, details: { before, after } });
  res.json(after);
});

module.exports = { api };
