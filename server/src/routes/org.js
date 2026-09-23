// Bayi ve sube yonetimi.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { fail, parseId, optionalId, cleanName } = require('./util');

const api = express.Router();

function uniqueViolation(err) {
  return err && err.code === '23505';
}

// ---- Bayiler ----
// Merkez tum bayileri, diger roller sadece kendi bayisini gorur (form
// seceneklerinde kullanilir).
api.get('/dealers', auth.requireApi(), async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (req.user.role !== 'super_admin') {
    params.push(req.user.dealer_id);
    where = 'd.id = $1';
  }
  const rows = await db.many(
    `SELECT d.id, d.name, d.active, d.created_at,
            (SELECT count(*)::int FROM branches b WHERE b.dealer_id = d.id) AS branch_count,
            (SELECT count(*)::int FROM gateways g WHERE g.dealer_id = d.id) AS gateway_count,
            (SELECT count(*)::int FROM users u WHERE u.dealer_id = d.id) AS user_count
       FROM dealers d WHERE ${where} ORDER BY lower(d.name)`,
    params,
  );
  res.json(rows);
});

api.post('/dealers', auth.requireApi('dealer.manage'), async (req, res) => {
  const name = cleanName(req.body.name, 'Bayi adi');
  try {
    const row = await db.one('INSERT INTO dealers (name) VALUES ($1) RETURNING *', [name]);
    await audit.log(req.user, 'dealer.created', { entityType: 'dealer', entityId: row.id, dealerId: row.id, branchId: null, message: name });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, 'Bu isimde bir bayi zaten var.');
    throw err;
  }
});

// Isim degistirme ve aktif/pasif. Pasif bayinin kullanicilari giris yapamaz,
// acik oturumlari da gecersiz olur (bkz. auth.getSession).
api.post('/dealers/:id', auth.requireApi('dealer.manage'), async (req, res) => {
  const id = parseId(req.params.id);
  const dealer = id && await db.one('SELECT * FROM dealers WHERE id = $1', [id]);
  if (!dealer) fail(404, 'Bayi bulunamadi.');
  const name = req.body.name !== undefined ? cleanName(req.body.name, 'Bayi adi') : dealer.name;
  const active = req.body.active !== undefined ? !!req.body.active : dealer.active;
  try {
    const row = await db.one('UPDATE dealers SET name = $2, active = $3 WHERE id = $1 RETURNING *', [id, name, active]);
    await audit.log(req.user, 'dealer.updated', {
      entityType: 'dealer', entityId: id, dealerId: id, branchId: null,
      details: { before: { name: dealer.name, active: dealer.active }, after: { name, active } },
    });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, 'Bu isimde bir bayi zaten var.');
    throw err;
  }
});

// ---- Subeler (opsiyonel) ----
api.get('/branches', auth.requireApi(), async (req, res) => {
  const params = [];
  const conds = [];
  if (req.user.role !== 'super_admin') {
    params.push(req.user.dealer_id);
    conds.push(`b.dealer_id = $${params.length}`);
    if (req.user.branch_id) {
      params.push(req.user.branch_id);
      conds.push(`b.id = $${params.length}`);
    }
  }
  const dealerFilter = optionalId(req.query.dealerId, 'Bayi');
  if (dealerFilter) {
    params.push(dealerFilter);
    conds.push(`b.dealer_id = $${params.length}`);
  }
  const rows = await db.many(
    `SELECT b.id, b.dealer_id, d.name AS dealer_name, b.name, b.active, b.created_at,
            (SELECT count(*)::int FROM gateways g WHERE g.branch_id = b.id) AS gateway_count,
            (SELECT count(*)::int FROM users u WHERE u.branch_id = b.id) AS user_count
       FROM branches b JOIN dealers d ON d.id = b.dealer_id
      WHERE ${conds.length ? conds.join(' AND ') : 'TRUE'}
      ORDER BY lower(d.name), lower(b.name)`,
    params,
  );
  res.json(rows);
});

async function loadBranchForManage(req) {
  const id = parseId(req.params.id);
  const branch = id && await db.one('SELECT * FROM branches WHERE id = $1', [id]);
  if (!branch) fail(404, 'Sube bulunamadi.');
  // branch.manage sadece merkez ve bayi yoneticisinde: bayi kapsami yeterli.
  if (req.user.role !== 'super_admin' && branch.dealer_id !== req.user.dealer_id) fail(404, 'Sube bulunamadi.');
  return branch;
}

api.post('/branches', auth.requireApi('branch.manage'), async (req, res) => {
  const dealerId = req.user.role === 'super_admin' ? optionalId(req.body.dealerId, 'Bayi') : req.user.dealer_id;
  if (!dealerId) fail(400, 'Bayi secilmeli.');
  const dealer = await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]);
  if (!dealer) fail(404, 'Bayi bulunamadi.');
  const name = cleanName(req.body.name, 'Sube adi');
  try {
    const row = await db.one('INSERT INTO branches (dealer_id, name) VALUES ($1, $2) RETURNING *', [dealerId, name]);
    await audit.log(req.user, 'branch.created', { entityType: 'branch', entityId: row.id, dealerId, branchId: row.id, message: name });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, 'Bu bayide bu isimde bir sube zaten var.');
    throw err;
  }
});

api.post('/branches/:id', auth.requireApi('branch.manage'), async (req, res) => {
  const branch = await loadBranchForManage(req);
  const name = req.body.name !== undefined ? cleanName(req.body.name, 'Sube adi') : branch.name;
  const active = req.body.active !== undefined ? !!req.body.active : branch.active;
  try {
    const row = await db.one('UPDATE branches SET name = $2, active = $3 WHERE id = $1 RETURNING *', [branch.id, name, active]);
    await audit.log(req.user, 'branch.updated', {
      entityType: 'branch', entityId: branch.id, dealerId: branch.dealer_id, branchId: branch.id,
      details: { before: { name: branch.name, active: branch.active }, after: { name, active } },
    });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, 'Bu bayide bu isimde bir sube zaten var.');
    throw err;
  }
});

// Silinen subenin gateway'leri bayi seviyesine duser (branch_id = NULL);
// subeye bagli kullanici varsa silme reddedilir.
api.delete('/branches/:id', auth.requireApi('branch.manage'), async (req, res) => {
  const branch = await loadBranchForManage(req);
  const { n } = await db.one('SELECT count(*)::int AS n FROM users WHERE branch_id = $1', [branch.id]);
  if (n > 0) fail(400, `Bu subeye bagli ${n} kullanici var; once onlari silin veya baska subeye tasiyin.`);
  await db.query('DELETE FROM branches WHERE id = $1', [branch.id]);
  await audit.log(req.user, 'branch.deleted', { entityType: 'branch', entityId: branch.id, dealerId: branch.dealer_id, branchId: null, message: branch.name });
  res.json({ ok: true });
});

module.exports = { api };
