// Kullanici yonetimi (kapsam ve rol hiyerarsisine gore).
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { ROLE_LABELS, scopeSql, checkUserManagement } = require('../permissions');
const { fail, parseId, optionalId } = require('./util');

const api = express.Router();
const requireManage = auth.requireApi('user.manage');

api.get('/users', requireManage, async (req, res) => {
  const params = [];
  const where = scopeSql(req.user, 'u', params);
  const rows = await db.many(
    `SELECT u.id, u.username, u.role, u.dealer_id, d.name AS dealer_name, u.branch_id, b.name AS branch_name,
            u.active, u.created_at, u.last_login_at
       FROM users u
       LEFT JOIN dealers d ON d.id = u.dealer_id
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE ${where}
      ORDER BY d.name NULLS FIRST, lower(u.username)`,
    params,
  );
  res.json(rows.map((r) => ({ ...r, role_label: ROLE_LABELS[r.role] })));
});

// Olusturan kullanicinin kapsamina gore bayi/sube zorunlu olarak doldurulur:
// bayi yoneticisi sadece kendi bayisine, sube yoneticisi kendi subesine ekler.
api.post('/users', requireManage, async (req, res) => {
  const actor = req.user;
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');
  let dealerId = actor.role === 'super_admin' ? optionalId(req.body.dealerId, 'Bayi') : actor.dealer_id;
  let branchId = actor.branch_id || optionalId(req.body.branchId, 'Sube');
  if (role === 'super_admin') { dealerId = null; branchId = null; }
  if (role === 'dealer_admin') branchId = null;

  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) fail(400, 'Kullanici adi 2-64 karakter olmali (harf, rakam, . _ - @).');
  if (password.length < 6) fail(400, 'Sifre en az 6 karakter olmali.');
  const denied = checkUserManagement(actor, role, dealerId, branchId);
  if (denied) fail(403, denied);
  if (dealerId && !(await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]))) fail(404, 'Bayi bulunamadi.');
  if (branchId && !(await db.one('SELECT id FROM branches WHERE id = $1 AND dealer_id = $2', [branchId, dealerId]))) {
    fail(400, 'Secilen sube bu bayiye ait degil.');
  }

  try {
    const id = await auth.createUser(db, { username, password, role, dealerId, branchId });
    await audit.log(actor, 'user.created', { entityType: 'user', entityId: id, dealerId, branchId, message: `${username} (${ROLE_LABELS[role]})` });
    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === '23505') fail(400, 'Bu kullanici adi zaten kayitli.');
    throw err;
  }
});

async function loadTargetUser(req) {
  const id = parseId(req.params.id);
  const target = id && await db.one('SELECT * FROM users WHERE id = $1', [id]);
  if (!target) fail(404, 'Kullanici bulunamadi.');
  const denied = checkUserManagement(req.user, target.role, target.dealer_id, target.branch_id);
  if (denied) fail(403, denied);
  return target;
}

async function ensureNotLastSuperAdmin(target) {
  if (target.role !== 'super_admin') return;
  const { n } = await db.one(`SELECT count(*)::int AS n FROM users WHERE role = 'super_admin' AND active AND id <> $1`, [target.id]);
  if (n === 0) fail(400, 'Son aktif merkezi yonetici silinemez veya pasif yapilamaz.');
}

api.post('/users/:id/password', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  const password = String(req.body.password || '');
  if (password.length < 6) fail(400, 'Sifre en az 6 karakter olmali.');
  await auth.setPassword(target.id, password);
  await audit.log(req.user, 'user.password_reset', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.username });
  res.json({ ok: true });
});

api.post('/users/:id/active', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  const active = !!req.body.active;
  if (target.id === req.user.id) fail(400, 'Kendi hesabinizi pasif yapamazsiniz.');
  if (!active) await ensureNotLastSuperAdmin(target);
  await db.query('UPDATE users SET active = $2 WHERE id = $1', [target.id, active]);
  if (!active) await db.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
  await audit.log(req.user, active ? 'user.activated' : 'user.deactivated', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.username });
  res.json({ ok: true });
});

api.delete('/users/:id', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  if (target.id === req.user.id) fail(400, 'Kendi hesabinizi silemezsiniz.');
  await ensureNotLastSuperAdmin(target);
  await db.query('DELETE FROM users WHERE id = $1', [target.id]);
  await audit.log(req.user, 'user.deleted', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.username });
  res.json({ ok: true });
});

module.exports = { api };
