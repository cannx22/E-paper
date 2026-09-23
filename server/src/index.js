const http = require('http');
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const gateways = require('./gateways');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

db.load();
auth.ensureDefaultAdmin();

const app = express();
// Coolify (Traefik) ters vekil arkasinda: HTTPS bilgisi ve gercek IP
// X-Forwarded-* basliklarindan gelir.
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use('/static', express.static(path.join(PUBLIC_DIR, 'static')));

const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---- Giris / cikis ----
app.get('/login', (req, res) => {
  if (auth.getSession(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  if (!auth.loginAllowed(ip)) return res.redirect('/login?err=limit');
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  const user = db.findUser(username);
  if (!user || !auth.verifyPassword(user, password)) {
    auth.recordLoginFailure(ip);
    return res.redirect('/login?err=1');
  }
  auth.clearLoginFailures(ip);
  auth.createSession(res, req, user);
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/login');
});

// ---- Sayfalar ----
app.get('/', auth.requirePage(auth.ROLE_USER), page('index.html'));
app.get('/history', auth.requirePage(auth.ROLE_USER), page('history.html'));
app.get('/gateways', auth.requirePage(auth.ROLE_ADMIN), page('gateways.html'));
app.get('/users', auth.requirePage(auth.ROLE_ADMIN), page('users.html'));

// ---- API: oturum ----
const api = express.Router();
const requireUser = auth.requireApi(auth.ROLE_USER);
const requireAdmin = auth.requireApi(auth.ROLE_ADMIN);

api.get('/me', requireUser, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

api.post('/me/password', requireUser, (req, res) => {
  const user = db.findUser(req.user.username);
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!auth.verifyPassword(user, current)) return res.status(400).type('text').send('HATA: Mevcut sifre hatali.');
  if (next.length < 6) return res.status(400).type('text').send('HATA: Yeni sifre en az 6 karakter olmali.');
  auth.setPassword(user.username, next);
  res.type('text').send('Sifre degistirildi, tekrar giris yapin.');
});

// ---- API: gateway'ler ----
function gatewayView(gw) {
  const info = gateways.connectionInfo(gw.id);
  return {
    id: gw.id,
    name: gw.name,
    status: gw.status,
    online: !!info,
    nrf: info ? info.nrf : null,
    ip: info ? info.ip : gw.lastIp || null,
    fw: gw.fw || null,
    lastSeen: gw.lastSeen || null,
    hasKey: !!gw.secretHash,
    createdAt: gw.createdAt,
  };
}

function findGatewayOr404(req, res) {
  const gw = db.findGateway(String(req.params.id).toUpperCase());
  if (!gw) res.status(404).type('text').send('HATA: Gateway bulunamadi.');
  return gw;
}

api.get('/gateways', requireUser, (req, res) => {
  let list = db.listGateways();
  if (req.user.role !== auth.ROLE_ADMIN) list = list.filter((g) => g.status === 'approved');
  res.json(list.map(gatewayView));
});

// Elle ekleme: MAC adresi girilen gateway onayli olarak olusturulur, anahtari
// ilk baglandiginda kaydedilir.
api.post('/gateways', requireAdmin, (req, res) => {
  const id = String(req.body.id || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (id.length !== 12) return res.status(400).type('text').send('HATA: Gateway kimligi 12 haneli MAC adresi olmali (ornek: A1B2C3D4E5F6).');
  if (db.findGateway(id)) return res.status(400).type('text').send('HATA: Bu gateway zaten kayitli.');
  db.addGateway({
    id,
    name: name || 'Gateway ' + id.slice(-6),
    status: 'approved',
    secretHash: null,
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true });
});

api.post('/gateways/:id/approve', requireAdmin, (req, res) => {
  const gw = findGatewayOr404(req, res);
  if (!gw) return;
  gw.status = 'approved';
  db.save();
  gateways.notifyStatus(gw.id);
  res.json({ ok: true });
});

api.post('/gateways/:id/rename', requireAdmin, (req, res) => {
  const gw = findGatewayOr404(req, res);
  if (!gw) return;
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).type('text').send('HATA: Isim bos olamaz.');
  gw.name = name;
  db.save();
  gateways.notifyStatus(gw.id);
  res.json({ ok: true });
});

// Gateway'in flash'i silinip yeni anahtar uretildiyse eski anahtar artik
// eslesmez - sifirlayinca bir sonraki baglantidaki anahtar kabul edilir.
api.post('/gateways/:id/reset-key', requireAdmin, (req, res) => {
  const gw = findGatewayOr404(req, res);
  if (!gw) return;
  gw.secretHash = null;
  db.save();
  gateways.disconnect(gw.id);
  res.json({ ok: true });
});

api.post('/gateways/:id/command', requireAdmin, (req, res) => {
  const gw = findGatewayOr404(req, res);
  if (!gw) return;
  const command = String(req.body.command || '');
  if (!['restart', 'wifi_reset'].includes(command)) return res.status(400).type('text').send('HATA: Bilinmeyen komut.');
  if (!gateways.sendCommand(gw.id, command)) return res.status(503).type('text').send('HATA: Gateway cevrimdisi.');
  res.json({ ok: true });
});

api.delete('/gateways/:id', requireAdmin, (req, res) => {
  const gw = findGatewayOr404(req, res);
  if (!gw) return;
  db.deleteGateway(gw.id);
  gateways.disconnect(gw.id);
  res.json({ ok: true });
});

// ---- API: etiket gonderimi ----
// Form alanlari firmware'deki LabelFields ile ayni; paketleme (399 byte,
// Turkce kodlama) gateway tarafinda PackLabelPayload() ile yapilir.
const TEXT_FIELDS = ['business', 'name', 'subtitle', 'price', 'oldPrice', 'unit',
  'bottomCode', 'campaignText', 'barcode', 'ingredients', 'allergens'];

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

api.post('/send', requireUser, async (req, res) => {
  const b = req.body || {};
  const gatewayId = String(b.gatewayId || '').toUpperCase();
  if (!gatewayId) return res.status(400).type('text').send('HATA: Gateway secilmedi.');
  const board = b.board === 'ESB' ? 'ESB' : 'ESA';
  const fields = {
    templateID: parseInt(b.templateID, 10) || 1,
    discountEnabled: truthy(b.discountEnabled) ? 1 : 0,
    campaignEnabled: truthy(b.campaignEnabled) ? 1 : 0,
  };
  for (const f of TEXT_FIELDS) fields[f] = String(b[f] == null ? '' : b[f]).slice(0, 100);

  const result = await gateways.sendLabel(gatewayId, board, fields);
  db.addHistory({
    ts: new Date().toISOString(),
    user: req.user.username,
    gatewayId,
    board,
    name: fields.name,
    price: fields.price,
    ok: result.ok,
    message: result.message,
  });
  res.status(result.status).type('text').send(result.message);
});

api.get('/history', requireUser, (req, res) => {
  const names = Object.fromEntries(db.listGateways().map((g) => [g.id, g.name]));
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json(db.listHistory(limit).map((h) => ({ ...h, gatewayName: names[h.gatewayId] || h.gatewayId })));
});

// ---- API: kullanicilar ----
api.get('/users', requireAdmin, (req, res) => {
  res.json(db.listUsers().map((u) => ({ username: u.username, role: u.role, createdAt: u.createdAt })));
});

api.post('/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === auth.ROLE_ADMIN ? auth.ROLE_ADMIN : auth.ROLE_USER;
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) return res.status(400).type('text').send('HATA: Kullanici adi 2-32 karakter (harf, rakam, . _ -) olmali.');
  if (password.length < 6) return res.status(400).type('text').send('HATA: Sifre en az 6 karakter olmali.');
  if (db.findUser(username)) return res.status(400).type('text').send('HATA: Bu kullanici adi zaten kayitli.');
  auth.createUser(username, password, role);
  res.json({ ok: true });
});

api.post('/users/:username/password', requireAdmin, (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).type('text').send('HATA: Sifre en az 6 karakter olmali.');
  if (!auth.setPassword(req.params.username, password)) return res.status(404).type('text').send('HATA: Kullanici bulunamadi.');
  res.json({ ok: true });
});

api.delete('/users/:username', requireAdmin, (req, res) => {
  const target = db.findUser(req.params.username);
  if (!target) return res.status(404).type('text').send('HATA: Kullanici bulunamadi.');
  if (target.username === req.user.username) return res.status(400).type('text').send('HATA: Kendi hesabinizi silemezsiniz.');
  const adminCount = db.listUsers().filter((u) => u.role === auth.ROLE_ADMIN).length;
  if (target.role === auth.ROLE_ADMIN && adminCount <= 1) return res.status(400).type('text').send('HATA: Son admin hesabi silinemez.');
  db.deleteUser(target.username);
  res.json({ ok: true });
});

app.use('/api', api);

const server = http.createServer(app);
gateways.attach(server);
server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda calisiyor (gateway WebSocket: /ws/gateway)`);
});

function shutdown() {
  db.flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
