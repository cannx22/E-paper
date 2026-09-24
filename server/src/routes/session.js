// Giris/cikis, zorunlu sifre degistirme, oturum sahibinin profili ve oturumlari.
const express = require('express');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const settings = require('../settings');
const { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, ACTIONS, can } = require('../permissions');
const { fail } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const ipLimiter = auth.createLimiter(20, 15 * 60 * 1000);

// Sadece site ici, goreli bir donus adresine izin ver (acik yonlendirme olmasin).
function safeNext(v) {
  const s = String(v || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

const pages = express.Router();

pages.get('/login', async (req, res) => {
  if (await auth.getSession(req)) return res.redirect(safeNext(req.query.next));
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

pages.post('/login', async (req, res) => {
  const ip = req.ip;
  const next = safeNext(req.body.next);
  const back = (err) => res.redirect(`/login?err=${err}&next=${encodeURIComponent(next)}`);
  if (!ipLimiter.allowed(ip)) return back('limit');

  const login = String(req.body.email || req.body.username || '').trim();
  const result = await auth.authenticate(login, String(req.body.password || ''));
  if (result.error) {
    if (result.error !== 'inactive') ipLimiter.fail(ip);
    const u = result.user;
    await audit.log(null, result.justLocked ? 'user.locked' : 'user.login_failed', {
      username: login.slice(0, 120), success: false, message: `${ip} (${result.error})`,
      entityType: u ? 'user' : null, entityId: u ? u.id : null,
      dealerId: u ? u.dealer_id : null, branchId: u ? u.branch_id : null,
    });
    return back(result.error === 'invalid' ? '1' : result.error);
  }
  ipLimiter.clear(ip);
  const user = result.user;
  await auth.createSession(res, req, user);
  await audit.log({ ...user, username: user.email || user.username }, 'user.login', { entityType: 'user', entityId: user.id, message: ip });
  res.redirect(user.must_change_password ? '/change-password' : next);
});

pages.get('/logout', async (req, res) => {
  await auth.destroySession(req, res);
  res.redirect('/login');
});

pages.get('/change-password', auth.requirePage(), (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'change-password.html'));
});

const api = express.Router();

api.get('/me', auth.requireApi(), async (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.full_name,
    displayName: u.full_name || u.email || u.username,
    phone: u.phone,
    title: u.title,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    dealerId: u.dealer_id,
    dealerName: u.dealer_name,
    branchId: u.branch_id,
    branchName: u.branch_name,
    mustChangePassword: u.must_change_password,
    companyName: await settings.get('company_name'),
    inventoryRequired: !!(await settings.get('inventory_required')),
    can: Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, can(u, a)])),
  });
});

// Profil: ad, telefon, unvan. E-posta degisikligi mevcut sifreyi ister.
api.post('/me', auth.requireApi(), async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const fullName = String(req.body.fullName ?? u.full_name ?? '').trim().slice(0, 120) || null;
  const phone = String(req.body.phone ?? u.phone ?? '').trim().slice(0, 40) || null;
  const title = String(req.body.title ?? u.title ?? '').trim().slice(0, 80) || null;
  let email = u.email;
  if (req.body.email !== undefined && auth.normalizeEmail(req.body.email) !== (u.email || '')) {
    email = auth.normalizeEmail(req.body.email);
    if (!auth.EMAIL_RE.test(email)) fail(400, 'Gecerli bir e-posta adresi girin.');
    if (!auth.verifyPassword(u, String(req.body.currentPassword || ''))) fail(400, 'E-posta degistirmek icin mevcut sifrenizi girin.');
  }
  try {
    await db.query('UPDATE users SET full_name = $2, phone = $3, title = $4, email = $5 WHERE id = $1', [u.id, fullName, phone, title, email]);
  } catch (err) {
    if (err.code === '23505') fail(400, 'Bu e-posta adresi baska bir hesapta kullaniliyor.');
    throw err;
  }
  await audit.log(req.user, 'user.profile_updated', {
    entityType: 'user', entityId: u.id,
    details: { before: { fullName: u.full_name, phone: u.phone, title: u.title, email: u.email }, after: { fullName, phone, title, email } },
  });
  res.json({ ok: true });
});

api.post('/me/password', auth.requireApi(), async (req, res) => {
  const user = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!auth.verifyPassword(user, current)) fail(400, 'Mevcut sifre hatali.');
  const policy = await auth.checkPasswordPolicy(next);
  if (policy) fail(400, policy);
  if (next === current) fail(400, 'Yeni sifre mevcut sifreyle ayni olamaz.');
  await auth.setPassword(user.id, next, { keepSessionHash: req.user.token_hash });
  await audit.log(req.user, 'user.password_changed', { entityType: 'user', entityId: user.id });
  res.type('text').send('Sifreniz degistirildi. Diger cihazlardaki oturumlariniz kapatildi.');
});

// Oturumlar: id olarak token ozetinin ilk 16 karakteri kullanilir.
api.get('/me/sessions', auth.requireApi(), async (req, res) => {
  const rows = await db.many(
    'SELECT token_hash, created_at, last_activity, ip, user_agent FROM sessions WHERE user_id = $1 ORDER BY last_activity DESC',
    [req.user.id],
  );
  res.json(rows.map((s) => ({
    id: s.token_hash.slice(0, 16), createdAt: s.created_at, lastActivity: s.last_activity,
    ip: s.ip, userAgent: s.user_agent, current: s.token_hash === req.user.token_hash,
  })));
});

api.post('/me/sessions/revoke-others', auth.requireApi(), async (req, res) => {
  const r = await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.user.token_hash]);
  await audit.log(req.user, 'user.sessions_revoked', { entityType: 'user', entityId: req.user.id, message: `${r.rowCount} oturum` });
  res.json({ ok: true, revoked: r.rowCount });
});

api.delete('/me/sessions/:id', auth.requireApi(), async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{16}$/.test(id)) fail(400, 'Gecersiz oturum.');
  if (req.user.token_hash.startsWith(id)) fail(400, 'Mevcut oturumu buradan kapatamazsiniz; cikis yapin.');
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash LIKE $2', [req.user.id, id + '%']);
  res.json({ ok: true });
});

// Arayuzde rol aciklamalari ve yetki matrisi icin.
api.get('/roles', auth.requireApi(), (req, res) => {
  res.json(ROLES.map((r) => ({
    id: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r],
    actions: Object.keys(ACTIONS).filter((a) => ACTIONS[a].includes(r)),
  })));
});

module.exports = { pages, api };
