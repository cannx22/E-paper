// Kullanici yonetimi (kapsam ve rol hiyerarsisine gore). Giris kimligi
// e-postadir; sifreyi hesabi acan yonetici belirler (veya sistem uretir),
// istenirse kullanici ilk giriste degistirmeye zorlanir.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { ROLE_LABELS, CENTRAL_ROLES, scopeSql, checkUserManagement } = require('../permissions');
const { fail, parseId, optionalId } = require('./util');

const api = express.Router();
const requireView = auth.requireApi('user.view');
const requireManage = auth.requireApi('user.manage');

const USER_SELECT = `
  SELECT u.id, u.username, u.email, u.full_name, u.phone, u.title, u.notes, u.role,
         u.dealer_id, d.name AS dealer_name, u.branch_id, b.name AS branch_name,
         u.active, u.must_change_password, u.locked_until, u.failed_login_count,
         u.created_at, u.last_login_at, u.password_changed_at,
         cb.full_name AS created_by_name, cb.email AS created_by_email,
         (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id) AS session_count
    FROM users u
    LEFT JOIN dealers d ON d.id = u.dealer_id
    LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN users cb ON cb.id = u.created_by`;

function view(u) {
  return {
    ...u,
    login: u.email || u.username,
    role_label: ROLE_LABELS[u.role],
    locked: !!(u.locked_until && new Date(u.locked_until) > new Date()),
  };
}

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max) || null;
}

// Sifre: istekte verilmisse kurala uygun olmali; generate=true ise sistem uretir.
async function resolvePassword(body) {
  if (body.generate) return { password: auth.generatePassword(), generated: true };
  const password = String(body.password || '');
  const policy = await auth.checkPasswordPolicy(password);
  if (policy) fail(400, policy);
  return { password, generated: false };
}

async function validatePlacement(dealerId, branchId) {
  if (dealerId && !(await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]))) fail(404, 'Bayi bulunamadi.');
  if (branchId && !(await db.one('SELECT id FROM branches WHERE id = $1 AND dealer_id = $2', [branchId, dealerId]))) {
    fail(400, 'Secilen sube bu bayiye ait degil.');
  }
}

// Rol + kapsam: olusturan kullanicinin kapsamina gore bayi/sube zorlanir.
function placementFor(actor, body, current = {}) {
  const role = String(body.role ?? current.role ?? '');
  let dealerId = actor.role === 'super_admin'
    ? (body.dealerId !== undefined ? optionalId(body.dealerId, 'Bayi') : current.dealer_id ?? null)
    : actor.dealer_id;
  let branchId = actor.branch_id
    || (body.branchId !== undefined ? optionalId(body.branchId, 'Sube') : current.branch_id ?? null);
  if (CENTRAL_ROLES.includes(role)) { dealerId = null; branchId = null; }
  if (role === 'dealer_admin') branchId = null;
  return { role, dealerId, branchId };
}

api.get('/users', requireView, async (req, res) => {
  const params = [];
  const conds = [scopeSql(req.user, 'u', params)];
  const dealerId = optionalId(req.query.dealerId, 'Bayi');
  if (dealerId) { params.push(dealerId); conds.push(`u.dealer_id = $${params.length}`); }
  const branchId = optionalId(req.query.branchId, 'Sube');
  if (branchId) { params.push(branchId); conds.push(`u.branch_id = $${params.length}`); }
  if (req.query.central === '1') conds.push('u.dealer_id IS NULL');
  const rows = await db.many(`${USER_SELECT} WHERE ${conds.join(' AND ')} ORDER BY d.name NULLS FIRST, b.name NULLS FIRST, lower(coalesce(u.full_name, u.email, u.username))`, params);
  res.json(rows.map(view));
});

async function loadTargetUser(req, forManage = true) {
  const id = parseId(req.params.id);
  const target = id && await db.one(`${USER_SELECT} WHERE u.id = $1`, [id]);
  if (!target) fail(404, 'Kullanici bulunamadi.');
  const params = [];
  const visible = await db.one(`SELECT 1 FROM users u WHERE u.id = $${params.push(id)} AND ${scopeSql(req.user, 'u', params)}`, params);
  if (!visible) fail(404, 'Kullanici bulunamadi.');
  if (forManage) {
    const denied = checkUserManagement(req.user, target.role, target.dealer_id, target.branch_id);
    if (denied) fail(403, denied);
  }
  return target;
}

api.get('/users/:id', requireView, async (req, res) => {
  res.json(view(await loadTargetUser(req, false)));
});

api.post('/users', requireManage, async (req, res) => {
  const actor = req.user;
  const b = req.body;
  const email = auth.normalizeEmail(b.email);
  if (!auth.EMAIL_RE.test(email)) fail(400, 'Gecerli bir e-posta adresi girin (giris e-posta ile yapilir).');
  const { role, dealerId, branchId } = placementFor(actor, b);
  const denied = checkUserManagement(actor, role, dealerId, branchId);
  if (denied) fail(403, denied);
  await validatePlacement(dealerId, branchId);
  const { password, generated } = await resolvePassword(b);

  try {
    const id = await auth.createUser(db, {
      email, password, role, dealerId, branchId,
      fullName: text(b.fullName, 120), phone: text(b.phone, 40), title: text(b.title, 80), notes: text(b.notes, 2000),
      mustChangePassword: b.mustChangePassword !== undefined ? !!b.mustChangePassword : generated,
      createdBy: actor.id,
    });
    await audit.log(actor, 'user.created', { entityType: 'user', entityId: id, dealerId, branchId, message: `${email} (${ROLE_LABELS[role]})` });
    res.json({ ok: true, id, email, password: generated ? password : undefined });
  } catch (err) {
    if (err.code === '23505') fail(400, 'Bu e-posta adresi baska bir hesapta kullaniliyor.');
    throw err;
  }
});

// Duzenleme: ad, iletisim, e-posta, rol, bayi/sube. Hem mevcut hem yeni
// rol/kapsam, duzenleyenin yonetebilecegi aralikta olmali.
api.post('/users/:id', requireManage, async (req, res) => {
  const actor = req.user;
  const target = await loadTargetUser(req);
  const b = req.body;
  const { role, dealerId, branchId } = placementFor(actor, b, target);
  if (target.id === actor.id && (role !== target.role || dealerId !== target.dealer_id || branchId !== target.branch_id)) {
    fail(400, 'Kendi rolunuzu veya kapsaminizi degistiremezsiniz.');
  }
  const denied = checkUserManagement(actor, role, dealerId, branchId);
  if (denied) fail(403, denied);
  if (target.role === 'super_admin' && role !== 'super_admin') await ensureNotLastSuperAdmin(target);
  await validatePlacement(dealerId, branchId);

  let email = target.email;
  if (b.email !== undefined) {
    email = auth.normalizeEmail(b.email);
    if (!auth.EMAIL_RE.test(email)) fail(400, 'Gecerli bir e-posta adresi girin.');
  }
  const fields = {
    full_name: b.fullName !== undefined ? text(b.fullName, 120) : target.full_name,
    phone: b.phone !== undefined ? text(b.phone, 40) : target.phone,
    title: b.title !== undefined ? text(b.title, 80) : target.title,
    notes: b.notes !== undefined ? text(b.notes, 2000) : target.notes,
  };
  try {
    await db.query(
      `UPDATE users SET email = $2, full_name = $3, phone = $4, title = $5, notes = $6, role = $7, dealer_id = $8, branch_id = $9
        WHERE id = $1`,
      [target.id, email, fields.full_name, fields.phone, fields.title, fields.notes, role, dealerId, branchId],
    );
  } catch (err) {
    if (err.code === '23505') fail(400, 'Bu e-posta adresi baska bir hesapta kullaniliyor.');
    throw err;
  }
  const scopeChanged = role !== target.role || dealerId !== target.dealer_id || branchId !== target.branch_id;
  if (scopeChanged && target.id !== actor.id) await db.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
  await audit.log(actor, 'user.updated', {
    entityType: 'user', entityId: target.id, dealerId, branchId,
    details: {
      before: { email: target.email, role: target.role, dealer: target.dealer_id, branch: target.branch_id, name: target.full_name },
      after: { email, role, dealer: dealerId, branch: branchId, name: fields.full_name },
    },
  });
  res.json(view(await db.one(`${USER_SELECT} WHERE u.id = $1`, [target.id])));
});

async function ensureNotLastSuperAdmin(target) {
  if (target.role !== 'super_admin') return;
  const { n } = await db.one(`SELECT count(*)::int AS n FROM users WHERE role = 'super_admin' AND active AND id <> $1`, [target.id]);
  if (n === 0) fail(400, 'Son aktif merkezi yonetici silinemez, pasif yapilamaz veya rolu degistirilemez.');
}

// Sifre sifirlama: yonetici yeni sifre belirler veya sistem uretir.
// mustChangePassword (varsayilan: true) kullaniciyi ilk giriste degistirmeye zorlar.
api.post('/users/:id/password', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  if (target.id === req.user.id) fail(400, 'Kendi sifrenizi Profil sayfasindan degistirin.');
  const { password, generated } = await resolvePassword(req.body);
  const mustChange = req.body.mustChangePassword !== undefined ? !!req.body.mustChangePassword : true;
  await auth.setPassword(target.id, password, { mustChange });
  await audit.log(req.user, 'user.password_reset', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.email || target.username });
  res.json({ ok: true, password: generated ? password : undefined });
});

api.post('/users/:id/active', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  const active = !!req.body.active;
  if (target.id === req.user.id) fail(400, 'Kendi hesabinizi pasif yapamazsiniz.');
  if (!active) await ensureNotLastSuperAdmin(target);
  await db.query('UPDATE users SET active = $2 WHERE id = $1', [target.id, active]);
  if (!active) await db.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
  await audit.log(req.user, active ? 'user.activated' : 'user.deactivated', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.email || target.username });
  res.json({ ok: true });
});

api.post('/users/:id/unlock', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  await db.query('UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1', [target.id]);
  await audit.log(req.user, 'user.unlocked', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.email || target.username });
  res.json({ ok: true });
});

api.post('/users/:id/revoke-sessions', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  if (target.id === req.user.id) fail(400, 'Kendi oturumlarinizi Profil sayfasindan yonetin.');
  const r = await db.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
  await audit.log(req.user, 'user.sessions_revoked', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: `${r.rowCount} oturum` });
  res.json({ ok: true, revoked: r.rowCount });
});

api.delete('/users/:id', requireManage, async (req, res) => {
  const target = await loadTargetUser(req);
  if (target.id === req.user.id) fail(400, 'Kendi hesabinizi silemezsiniz.');
  await ensureNotLastSuperAdmin(target);
  await db.query('DELETE FROM users WHERE id = $1', [target.id]);
  await audit.log(req.user, 'user.deleted', { entityType: 'user', entityId: target.id, dealerId: target.dealer_id, branchId: target.branch_id, message: target.email || target.username });
  res.json({ ok: true });
});

module.exports = { api };
