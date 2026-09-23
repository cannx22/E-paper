const http = require('http');
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const gateways = require('./gateways');
const { importLegacyJson } = require('./db/importLegacy');
const { HttpError } = require('./routes/util');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const app = express();
// Coolify (Traefik) ters vekil arkasinda: HTTPS bilgisi ve gercek IP
// X-Forwarded-* basliklarindan gelir.
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(path.join(PUBLIC_DIR, 'static')));

app.get('/healthz', async (req, res) => {
  await db.query('SELECT 1');
  res.type('text').send('ok');
});

// ---- Sayfalar ----
const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
const session = require('./routes/session');
app.use(session.pages);
app.get('/', auth.requirePage('label.send'), page('index.html'));
app.get('/dashboard', auth.requirePage(), page('dashboard.html'));
app.get('/history', auth.requirePage('audit.view'), page('history.html'));
app.get('/gateways', auth.requirePage('gateway.view'), page('gateways.html'));
app.get('/gateways/:id/label', auth.requirePage('gateway.register'), page('gateway-label.html'));
app.get('/claim', auth.requirePage('gateway.claim'), page('claim.html'));
app.get('/dealers', auth.requirePage('dealer.manage'), page('dealers.html'));
app.get('/branches', auth.requirePage('branch.manage'), page('branches.html'));
app.get('/users', auth.requirePage('user.manage'), page('users.html'));

// ---- API ----
app.use('/api', session.api);
app.use('/api', require('./routes/org').api);
app.use('/api', require('./routes/users').api);
app.use('/api', require('./routes/gateways').api);
app.use('/api', require('./routes/labels').api);
app.use('/api', require('./routes/reports').api);
app.use('/api', (req, res) => res.status(404).type('text').send('HATA: Bulunamadi.'));

// HttpError -> kendi durum kodu ve metni; digerleri 500 (ayrinti loglara).
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).type('text').send(err.message);
  if (err.type === 'entity.parse.failed') return res.status(400).type('text').send('HATA: Gecersiz istek govdesi.');
  console.error(`${req.method} ${req.originalUrl} hatasi:`, err);
  res.status(500).type('text').send('HATA: Sunucu hatasi.');
});

async function start() {
  await db.migrate();
  await importLegacyJson(DATA_DIR);
  await auth.ensureDefaultAdmin();

  const server = http.createServer(app);
  gateways.attach(server);
  server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda calisiyor (gateway WebSocket: /ws/gateway)`);
  });

  const shutdown = () => {
    server.close();
    db.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Sunucu baslatilamadi:', err);
  process.exit(1);
});
