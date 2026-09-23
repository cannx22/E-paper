// Giris/cikis ve oturum sahibinin kendi bilgileri.
const express = require('express');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { ROLE_LABELS, can } = require('../permissions');
const { fail } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const loginLimiter = auth.createLimiter(10, 15 * 60 * 1000);

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
  if (!loginLimiter.allowed(ip)) return back('limit');

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = await db.one(
    `SELECT u.*, d.active AS dealer_active, b.active AS branch_active
       FROM users u
       LEFT JOIN dealers d ON d.id = u.dealer_id
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE lower(u.username) = lower($1)`,
    [username],
  );
  if (!user || !auth.verifyPassword(user, password)) {
    loginLimiter.fail(ip);
    await audit.log(null, 'user.login_failed', { username: username.slice(0, 64), success: false, message: ip, dealerId: user ? user.dealer_id : null, branchId: null });
    return back('1');
  }
  if (!user.active || user.dealer_active === false || user.branch_active === false) return back('inactive');
  loginLimiter.clear(ip);
  await auth.createSession(res, req, user);
  await audit.log(user, 'user.login', { entityType: 'user', entityId: user.id, message: ip });
  res.redirect(next);
});

pages.get('/logout', async (req, res) => {
  await auth.destroySession(req, res);
  res.redirect('/login');
});

const api = express.Router();

api.get('/me', auth.requireApi(), (req, res) => {
  const u = req.user;
  const actions = ['label.send', 'gateway.manage', 'gateway.claim', 'gateway.assign', 'gateway.disable',
    'gateway.register', 'dealer.manage', 'branch.manage', 'user.manage', 'audit.view'];
  res.json({
    id: u.id,
    username: u.username,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    dealerId: u.dealer_id,
    dealerName: u.dealer_name,
    branchId: u.branch_id,
    branchName: u.branch_name,
    can: Object.fromEntries(actions.map((a) => [a, can(u, a)])),
  });
});

api.post('/me/password', auth.requireApi(), async (req, res) => {
  const user = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!auth.verifyPassword(user, current)) fail(400, 'Mevcut sifre hatali.');
  if (next.length < 6) fail(400, 'Yeni sifre en az 6 karakter olmali.');
  await auth.setPassword(user.id, next);
  await audit.log(req.user, 'user.password_changed', { entityType: 'user', entityId: user.id });
  res.type('text').send('Sifre degistirildi, tekrar giris yapin.');
});

module.exports = { pages, api };
