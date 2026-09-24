// E-paper cihaz kaydi: tek tek (elle / barkod / QR), toplu (Excel / CSV /
// seri no listesi), gateway ve sube atamasi.
//
// Cihazin kimligi 8 haneli seri numarasidir. Her cihaz bir bayiye aittir,
// istege bagli olarak bir subeye ve etiketleri ileten bir gateway'e baglanir.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const hub = require('../gateways');
const settings = require('../settings');
const { inScope, scopeSql } = require('../permissions');
const { fail, optionalId } = require('./util');

const api = express.Router();
const requireView = auth.requireApi('device.view');
const requireManage = auth.requireApi('device.manage');

const SERIAL_RE = /^\d{8}$/;
const IMPORT_MAX_ROWS = 5000;

function normalizeSerial(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '');
}

const SELECT_DEVICE = `
  SELECT dv.*, m.code AS model_code, m.name AS model_name, m.width_px, m.height_px,
         d.name AS dealer_name, d.active AS dealer_active, b.name AS branch_name,
         g.name AS gateway_name, g.state AS gateway_state
    FROM devices dv
    LEFT JOIN screen_models m ON m.id = dv.model_id
    JOIN dealers d ON d.id = dv.dealer_id
    LEFT JOIN branches b ON b.id = dv.branch_id
    LEFT JOIN gateways g ON g.id = dv.gateway_id`;

function view(dv) {
  return {
    serial: dv.id,
    name: dv.name,
    modelId: dv.model_id,
    modelCode: dv.model_code,
    modelName: dv.model_name,
    resolution: dv.width_px ? `${dv.width_px}x${dv.height_px}` : null,
    dealerId: dv.dealer_id,
    dealerName: dv.dealer_name,
    branchId: dv.branch_id,
    branchName: dv.branch_name,
    gatewayId: dv.gateway_id,
    gatewayName: dv.gateway_name,
    gatewayOnline: dv.gateway_id ? hub.isOnline(dv.gateway_id) : false,
    gatewayActive: dv.gateway_state === 'active',
    state: dv.state,
    notes: dv.notes,
    lastUpdateAt: dv.last_update_at,
    lastUpdateOk: dv.last_update_ok,
    lastUpdateMessage: dv.last_update_message,
    lastOkAt: dv.last_ok_at,
    lastContent: dv.last_content,
    createdAt: dv.created_at,
  };
}

// Seri no havuzu ve cihaz limiti kontrolu (tek ve toplu ekleme ortak).
// serials icin { serial: hata metni } ve { serial: havuzdaki model_id } doner.
//   - Havuzda baska bayiye tahsisli numara her zaman reddedilir.
//   - "Seri no havuzu zorunlu" ayari aciksa havuzda olmayan numara reddedilir.
//   - Bayinin max_devices limiti asilmaz (limit dolduktan sonraki satirlar reddedilir).
async function checkInventoryAndQuota(serials, dealerId) {
  const errors = {};
  const models = {};
  const required = !!(await settings.get('inventory_required'));
  const inv = await db.many('SELECT serial, model_id, dealer_id FROM device_inventory WHERE serial = ANY($1)', [serials]);
  const bySerial = Object.fromEntries(inv.map((r) => [r.serial, r]));
  for (const s of serials) {
    const row = bySerial[s];
    if (!row) {
      if (required) errors[s] = 'Seri no havuzunda yok (gecerli bir cihaz degil)';
    } else if (row.dealer_id && row.dealer_id !== dealerId) {
      errors[s] = 'Bu seri no baska bir bayiye tahsisli';
    } else {
      models[s] = row.model_id;
    }
  }
  const d = await db.one('SELECT max_devices, (SELECT count(*)::int FROM devices WHERE dealer_id = $1) AS used FROM dealers WHERE id = $1', [dealerId]);
  if (d && d.max_devices != null) {
    let remaining = d.max_devices - d.used;
    for (const s of serials) {
      if (errors[s]) continue;
      if (remaining <= 0) errors[s] = `Bayinin cihaz limiti dolu (${d.max_devices})`;
      else remaining--;
    }
  }
  return { errors, models };
}

// Eklenen cihazlarin havuz kayitlarini bayiye tahsis et.
async function allocateInventory(client, serials, dealerId) {
  await client.query('UPDATE device_inventory SET dealer_id = $2 WHERE serial = ANY($1) AND dealer_id IS NULL', [serials, dealerId]);
}

async function loadDevice(serial) {
  return db.one(`${SELECT_DEVICE} WHERE dv.id = $1`, [normalizeSerial(serial)]);
}

async function loadScopedDevice(req) {
  const dv = await loadDevice(req.params.serial);
  if (!dv || !inScope(req.user, dv)) fail(404, 'Cihaz bulunamadi.');
  return dv;
}

// Cihazin bayi / sube / gateway yerlesimini dogrular ve tamamlar.
//   - bayi: merkez icin istekten (veya gateway'in bayisinden), digerleri icin kendi bayisi
//   - gateway: ayni bayide, kullanicinin kapsaminda ve bayiye atanmis olmali
//   - sube: sube kullanicisi icin kendi subesi; verilmezse gateway'in subesi
async function resolvePlacement(user, input, current = {}) {
  let gateway = null;
  const gatewayId = input.gatewayId !== undefined ? (input.gatewayId || null) : current.gateway_id || null;
  if (gatewayId) {
    gateway = await db.one('SELECT id, dealer_id, branch_id, state FROM gateways WHERE id = $1', [String(gatewayId).toUpperCase()]);
    if (!gateway || !inScope(user, gateway)) fail(400, 'Secilen gateway bulunamadi.');
    if (!gateway.dealer_id) fail(400, 'Secilen gateway henuz bir bayiye atanmamis.');
  }

  let dealerId;
  if (user.role === 'super_admin') {
    dealerId = input.dealerId !== undefined ? optionalId(input.dealerId, 'Bayi') : current.dealer_id;
    if (!dealerId && gateway) dealerId = gateway.dealer_id;
    if (!dealerId) fail(400, 'Bayi secilmeli.');
  } else {
    dealerId = user.dealer_id;
  }
  if (gateway && gateway.dealer_id !== dealerId) fail(400, 'Gateway ile cihaz ayni bayiye ait olmali.');

  // Sube: sube kullanicisinda her zaman kendi subesi; istekte verildiyse o;
  // gateway yeni secildiyse gateway'in subesi; yoksa mevcut sube korunur.
  const gatewayChanged = gateway && gateway.id !== current.gateway_id;
  let branchId = null;
  if (user.branch_id) branchId = user.branch_id;
  else if (input.branchId !== undefined) branchId = optionalId(input.branchId, 'Sube');
  else if (gatewayChanged) branchId = gateway.branch_id;
  else if (current.dealer_id === dealerId) branchId = current.branch_id || null;
  if (branchId) {
    const b = await db.one('SELECT id FROM branches WHERE id = $1 AND dealer_id = $2', [branchId, dealerId]);
    if (!b) fail(400, 'Secilen sube bu bayiye ait degil.');
  }
  return { dealerId, branchId, gatewayId: gateway ? gateway.id : null };
}

async function resolveModelId(v) {
  const id = optionalId(v, 'Ekran modeli');
  if (!id) return null;
  if (!(await db.one('SELECT id FROM screen_models WHERE id = $1', [id]))) fail(400, 'Ekran modeli bulunamadi.');
  return id;
}

api.get('/screen-models', requireView, async (req, res) => {
  const all = req.query.all === '1' && req.user.role === 'super_admin';
  res.json(await db.many(
    `SELECT m.id, m.code, m.name, m.diagonal_in, m.width_px, m.height_px, m.colors, m.active,
            (SELECT count(*)::int FROM devices dv WHERE dv.model_id = m.id) AS device_count,
            (SELECT count(*)::int FROM designs ds WHERE ds.screen_model_id = m.id AND NOT ds.archived) AS design_count
       FROM screen_models m ${all ? '' : 'WHERE m.active'} ORDER BY m.diagonal_in, m.colors, m.name`,
  ));
});

// Ekran modeli yonetimi (merkez): yeni panel boyutlari eklenebilir.
function modelBody(b, current = {}) {
  const code = String(b.code ?? current.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
  const name = String(b.name ?? current.name ?? '').trim().slice(0, 80);
  const width = parseInt(b.width_px ?? current.width_px, 10);
  const height = parseInt(b.height_px ?? current.height_px, 10);
  const diag = b.diagonal_in === '' || b.diagonal_in == null ? (current.diagonal_in ?? null) : Number(b.diagonal_in);
  const colors = b.colors ?? current.colors ?? 'bw';
  if (!code) fail(400, 'Model kodu gerekli (örnek EPD29-BW).');
  if (!name) fail(400, 'Model adı gerekli.');
  if (!(width >= 16 && width <= 2000 && height >= 16 && height <= 2000)) fail(400, 'Çözünürlük 16-2000 piksel arası olmalı.');
  if (!['bw', 'bwr', 'bwy', 'color'].includes(colors)) fail(400, 'Renk tipi geçersiz.');
  if (diag !== null && !(diag > 0 && diag < 100)) fail(400, 'Ekran boyutu (inç) geçersiz.');
  return { code, name, width, height, diag, colors, active: b.active !== undefined ? !!b.active : (current.active ?? true) };
}
api.post('/screen-models', auth.requireApi('settings.manage'), async (req, res) => {
  const m = modelBody(req.body || {});
  try {
    const row = await db.one('INSERT INTO screen_models (code, name, diagonal_in, width_px, height_px, colors) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [m.code, m.name, m.diag, m.width, m.height, m.colors]);
    await audit.log(req.user, 'screen_model.created', { entityType: 'screen_model', entityId: row.id, dealerId: null, branchId: null, message: `${m.name} ${m.width}x${m.height}` });
    res.json(row);
  } catch (err) {
    if (err.code === '23505') fail(400, 'Bu model kodu zaten var.');
    throw err;
  }
});
api.post('/screen-models/:id', auth.requireApi('settings.manage'), async (req, res) => {
  const cur = await db.one('SELECT * FROM screen_models WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
  if (!cur) fail(404, 'Ekran modeli bulunamadı.');
  const m = modelBody(req.body || {}, cur);
  const used = (await db.one('SELECT (SELECT count(*) FROM designs WHERE screen_model_id = $1 AND NOT archived) + (SELECT count(*) FROM devices WHERE model_id = $1) AS n', [cur.id])).n;
  if (used > 0 && (m.width !== cur.width_px || m.height !== cur.height_px || m.colors !== cur.colors)) {
    fail(400, 'Bu model tasarım veya cihazlarda kullanılıyor; çözünürlüğü ve renk tipi değiştirilemez. Yeni bir model ekleyin.');
  }
  try {
    const row = await db.one('UPDATE screen_models SET code = $2, name = $3, diagonal_in = $4, width_px = $5, height_px = $6, colors = $7, active = $8 WHERE id = $1 RETURNING *',
      [cur.id, m.code, m.name, m.diag, m.width, m.height, m.colors, m.active]);
    await audit.log(req.user, 'screen_model.updated', { entityType: 'screen_model', entityId: cur.id, dealerId: null, branchId: null, message: m.name });
    res.json(row);
  } catch (err) {
    if (err.code === '23505') fail(400, 'Bu model kodu zaten var.');
    throw err;
  }
});

// ?gatewayId= ?branchId= ?q= (seri no / isim) ?limit= ?offset=
api.get('/devices', requireView, async (req, res) => {
  const params = [];
  const conds = [scopeSql(req.user, 'dv', params)];
  if (req.query.gatewayId === 'none') {
    conds.push('dv.gateway_id IS NULL');
  } else if (req.query.gatewayId) {
    params.push(String(req.query.gatewayId).toUpperCase());
    conds.push(`dv.gateway_id = $${params.length}`);
  }
  const branchId = optionalId(req.query.branchId, 'Sube');
  if (branchId) {
    params.push(branchId);
    conds.push(`dv.branch_id = $${params.length}`);
  }
  const dealerId = optionalId(req.query.dealerId, 'Bayi');
  if (dealerId) {
    params.push(dealerId);
    conds.push(`dv.dealer_id = $${params.length}`);
  }
  if (req.query.q) {
    params.push('%' + String(req.query.q).trim().toLowerCase() + '%');
    conds.push(`(dv.id LIKE $${params.length} OR lower(coalesce(dv.name, '')) LIKE $${params.length})`);
  }
  const where = conds.join(' AND ');
  const total = (await db.one(`SELECT count(*)::int AS n FROM devices dv WHERE ${where}`, params)).n;
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = await db.many(`${SELECT_DEVICE} WHERE ${where} ORDER BY dv.id LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ total, limit, offset, devices: rows.map(view) });
});

// Detay: cihaz bilgisi + guncelleme ve yonetim gecmisi.
api.get('/devices/:serial', requireView, async (req, res) => {
  const dv = await loadScopedDevice(req);
  const history = await db.many(
    `SELECT id, created_at, username, action, success, message, details
       FROM audit_log WHERE entity_type = 'device' AND entity_id = $1
      ORDER BY id DESC LIMIT 100`,
    [dv.id],
  );
  res.json({ ...view(dv), history });
});

// Tek cihaz ekleme (elle, barkod okuyucu veya kamera ile okunan seri no).
api.post('/devices', requireManage, async (req, res) => {
  const serial = normalizeSerial(req.body.serial);
  if (!SERIAL_RE.test(serial)) fail(400, 'Seri numarasi 8 haneli olmali.');
  if (await db.one('SELECT id FROM devices WHERE id = $1', [serial])) fail(400, `${serial} seri numarali cihaz zaten kayitli.`);
  const place = await resolvePlacement(req.user, req.body);
  const check = await checkInventoryAndQuota([serial], place.dealerId);
  if (check.errors[serial]) fail(400, `${serial}: ${check.errors[serial]}.`);
  const modelId = (await resolveModelId(req.body.modelId)) || check.models[serial] || null;
  const name = String(req.body.name || '').trim().slice(0, 80) || null;
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO devices (id, name, model_id, dealer_id, branch_id, gateway_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [serial, name, modelId, place.dealerId, place.branchId, place.gatewayId, String(req.body.notes || '').slice(0, 500) || null],
    );
    await allocateInventory(c, [serial], place.dealerId);
  });
  await audit.log(req.user, 'device.created', { entityType: 'device', entityId: serial, dealerId: place.dealerId, branchId: place.branchId, message: name });
  res.json(view(await loadDevice(serial)));
});

// Toplu ekleme. rows: [{serial, name, model, gateway, branch}] - model kodu/adi,
// gateway kimligi/adi ve sube adi metin olarak gelebilir. defaults: tum
// satirlara uygulanacak gateway/sube/model/bayi. dryRun: sadece kontrol raporu.
api.post('/devices/import', requireManage, async (req, res) => {
  const user = req.user;
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const defaults = req.body.defaults || {};
  const dryRun = req.body.dryRun !== false;
  if (!rows.length) fail(400, 'Dosyada satir yok.');
  if (rows.length > IMPORT_MAX_ROWS) fail(400, `Tek seferde en fazla ${IMPORT_MAX_ROWS} cihaz eklenebilir.`);

  // Varsayilan yerlesim (tum satirlar icin ortak) bir kez dogrulanir.
  const base = await resolvePlacement(user, {
    dealerId: defaults.dealerId, branchId: defaults.branchId || undefined, gatewayId: defaults.gatewayId || null,
  });
  const defaultModelId = await resolveModelId(defaults.modelId);

  // Satirlardaki metin degerlerini cozmek icin bayinin gateway/sube/modelleri.
  const scopedGateways = (await db.many('SELECT id, name, dealer_id, branch_id FROM gateways WHERE dealer_id = $1', [base.dealerId]))
    .filter((g) => inScope(user, g));
  const branches = await db.many('SELECT id, name FROM branches WHERE dealer_id = $1', [base.dealerId]);
  const models = await db.many('SELECT id, code, name FROM screen_models WHERE active');
  const lower = (s) => String(s || '').trim().toLocaleLowerCase('tr');

  const serials = rows.map((r) => normalizeSerial(r.serial));
  const existing = new Set((await db.many('SELECT id FROM devices WHERE id = ANY($1)', [serials.filter((s) => SERIAL_RE.test(s))])).map((r) => r.id));
  const seen = new Set();

  const report = rows.map((r, i) => {
    const serial = serials[i];
    const out = { row: i + 1, serial, name: String(r.name || '').trim().slice(0, 80) || null, ok: false, message: '' };
    if (!SERIAL_RE.test(serial)) { out.message = 'Seri no 8 haneli rakam olmali'; return out; }
    if (seen.has(serial)) { out.message = 'Dosyada tekrar ediyor'; return out; }
    seen.add(serial);
    if (existing.has(serial)) { out.message = 'Zaten kayitli'; return out; }

    out.gatewayId = base.gatewayId;
    if (r.gateway) {
      const key = lower(r.gateway), idKey = String(r.gateway).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      const gw = scopedGateways.find((g) => g.id === idKey || lower(g.name) === key);
      if (!gw) { out.message = `Gateway bulunamadi: ${r.gateway}`; return out; }
      out.gatewayId = gw.id;
    }
    const gw = out.gatewayId ? scopedGateways.find((g) => g.id === out.gatewayId) : null;

    out.branchId = user.branch_id || base.branchId;
    if (r.branch && !user.branch_id) {
      const b = branches.find((x) => lower(x.name) === lower(r.branch));
      if (!b) { out.message = `Sube bulunamadi: ${r.branch}`; return out; }
      out.branchId = b.id;
    }
    if (!out.branchId && gw) out.branchId = gw.branch_id;

    out.modelId = defaultModelId;
    if (r.model) {
      const m = models.find((x) => lower(x.code) === lower(r.model) || lower(x.name) === lower(r.model) || lower(x.name).startsWith(lower(r.model)));
      if (!m) { out.message = `Ekran modeli bulunamadi: ${r.model}`; return out; }
      out.modelId = m.id;
    }
    out.ok = true;
    return out;
  });

  // Havuz ve limit kontrolu: sadece diger kontrollerden gecen satirlar icin,
  // dosyadaki sirayla (limit dolunca sonraki satirlar reddedilir).
  const candidates = report.filter((r) => r.ok);
  const check = await checkInventoryAndQuota(candidates.map((r) => r.serial), base.dealerId);
  for (const r of candidates) {
    if (check.errors[r.serial]) { r.ok = false; r.message = check.errors[r.serial]; continue; }
    if (!r.modelId && check.models[r.serial]) r.modelId = check.models[r.serial];
    r.message = dryRun ? 'Eklenebilir' : 'Eklendi';
  }

  const valid = report.filter((r) => r.ok);
  if (!dryRun && valid.length) {
    await db.tx(async (c) => {
      for (const r of valid) {
        await c.query(
          `INSERT INTO devices (id, name, model_id, dealer_id, branch_id, gateway_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [r.serial, r.name, r.modelId, base.dealerId, r.branchId, r.gatewayId],
        );
      }
      await allocateInventory(c, valid.map((r) => r.serial), base.dealerId);
    });
    await audit.log(user, 'device.imported', {
      entityType: 'device', dealerId: base.dealerId, branchId: user.branch_id || null,
      message: `${valid.length} cihaz eklendi, ${report.length - valid.length} satir atlandi`,
      details: { added: valid.map((r) => r.serial).slice(0, 1000) },
    });
  }
  const gwName = Object.fromEntries(scopedGateways.map((g) => [g.id, g.name]));
  const brName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  res.json({
    dryRun,
    total: report.length,
    valid: valid.length,
    invalid: report.length - valid.length,
    rows: report.map((r) => ({ ...r, gatewayName: gwName[r.gatewayId] || null, branchName: brName[r.branchId] || null })),
  });
});

api.post('/devices/:serial', requireManage, async (req, res) => {
  const dv = await loadScopedDevice(req);
  const place = await resolvePlacement(req.user, req.body, dv);
  const modelId = req.body.modelId !== undefined ? await resolveModelId(req.body.modelId) : dv.model_id;
  const name = req.body.name !== undefined ? (String(req.body.name).trim().slice(0, 80) || null) : dv.name;
  const state = req.body.state === 'disabled' || req.body.state === 'active' ? req.body.state : dv.state;
  const notes = req.body.notes !== undefined ? (String(req.body.notes).slice(0, 500) || null) : dv.notes;
  const dealerChanged = place.dealerId !== dv.dealer_id;
  if (dealerChanged) {
    // Bayiler arasi transfer (sadece merkez): yeni bayinin limiti kontrol edilir.
    const d = await db.one('SELECT max_devices, (SELECT count(*)::int FROM devices WHERE dealer_id = $1) AS used FROM dealers WHERE id = $1', [place.dealerId]);
    if (d.max_devices != null && d.used >= d.max_devices) fail(400, `Hedef bayinin cihaz limiti dolu (${d.max_devices}).`);
  }
  await db.tx(async (c) => {
    await c.query(
      `UPDATE devices SET name = $2, model_id = $3, dealer_id = $4, branch_id = $5, gateway_id = $6, state = $7, notes = $8 WHERE id = $1`,
      [dv.id, name, modelId, place.dealerId, place.branchId, place.gatewayId, state, notes],
    );
    if (dealerChanged) await c.query('UPDATE device_inventory SET dealer_id = $2 WHERE serial = $1', [dv.id, place.dealerId]);
  });
  await audit.log(req.user, 'device.updated', {
    entityType: 'device', entityId: dv.id, dealerId: place.dealerId, branchId: place.branchId,
    details: {
      before: { name: dv.name, gateway: dv.gateway_id, branch: dv.branch_id, model: dv.model_id, state: dv.state },
      after: { name, gateway: place.gatewayId, branch: place.branchId, model: modelId, state },
    },
  });
  res.json(view(await loadDevice(dv.id)));
});

// Toplu islem: secilen cihazlari gateway/subeye ata, devre disi birak,
// etkinlestir veya sil. Kapsam disindaki seri no'lar sessizce atlanir.
api.post('/devices-bulk', requireManage, async (req, res) => {
  const user = req.user;
  const serials = (Array.isArray(req.body.serials) ? req.body.serials : []).map(normalizeSerial).filter((s) => SERIAL_RE.test(s));
  const action = String(req.body.action || '');
  if (!serials.length) fail(400, 'Cihaz secilmedi.');
  if (serials.length > IMPORT_MAX_ROWS) fail(400, `Tek seferde en fazla ${IMPORT_MAX_ROWS} cihaz.`);
  if (!['assign', 'disable', 'enable', 'delete'].includes(action)) fail(400, 'Bilinmeyen islem.');

  const params = [serials];
  const targets = await db.many(`SELECT id, dealer_id, branch_id, gateway_id FROM devices dv WHERE dv.id = ANY($1) AND ${scopeSql(user, 'dv', params)}`, params);
  if (!targets.length) fail(404, 'Secilen cihazlar bulunamadi.');
  const ids = targets.map((t) => t.id);

  if (action === 'assign') {
    const dealers = new Set(targets.map((t) => t.dealer_id));
    if (dealers.size > 1) fail(400, 'Toplu atama icin cihazlar ayni bayiye ait olmali.');
    const place = await resolvePlacement(user, { gatewayId: req.body.gatewayId, branchId: req.body.branchId }, { dealer_id: targets[0].dealer_id });
    await db.query('UPDATE devices SET gateway_id = $2, branch_id = $3 WHERE id = ANY($1)', [ids, place.gatewayId, place.branchId]);
  } else if (action === 'delete') {
    await db.query('DELETE FROM devices WHERE id = ANY($1)', [ids]);
  } else {
    await db.query('UPDATE devices SET state = $2 WHERE id = ANY($1)', [ids, action === 'disable' ? 'disabled' : 'active']);
  }
  await audit.log(user, 'device.bulk_' + action, {
    entityType: 'device', dealerId: targets[0].dealer_id, branchId: user.branch_id || null,
    message: `${ids.length} cihaz`, details: { serials: ids.slice(0, 1000), gatewayId: req.body.gatewayId || null },
  });
  res.json({ ok: true, affected: ids.length, skipped: serials.length - ids.length });
});

api.delete('/devices/:serial', requireManage, async (req, res) => {
  const dv = await loadScopedDevice(req);
  await db.query('DELETE FROM devices WHERE id = $1', [dv.id]);
  await audit.log(req.user, 'device.deleted', { entityType: 'device', entityId: dv.id, dealerId: dv.dealer_id, branchId: dv.branch_id, message: dv.name });
  res.json({ ok: true });
});

module.exports = { api, loadDevice, SERIAL_RE, normalizeSerial, IMPORT_MAX_ROWS };
