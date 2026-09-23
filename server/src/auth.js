// Kullanici girisi / rol tabanli erisim. Firmware'deki eski yerel paneldeki
// mantigin sunucu karsiligi: sifreler tuzlu scrypt hash olarak db.json'da,
// oturumlar sadece RAM'de (sunucu yeniden baslarsa herkes tekrar giris yapar).
const crypto = require('crypto');
const db = require('./db');

const ROLE_USER = 'user';
const ROLE_ADMIN = 'admin';
const SESSION_COOKIE = 'gwsession';
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 saat hareketsizlik

const sessions = new Map(); // token -> { username, role, lastActivity }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function createUser(username, password, role) {
  const { salt, hash } = hashPassword(password);
  return db.addUser({ username, salt, hash, role, createdAt: new Date().toISOString() });
}

function setPassword(username, password) {
  const user = db.findUser(username);
  if (!user) return false;
  Object.assign(user, hashPassword(password));
  db.save();
  // Sifresi degisen kullanicinin acik oturumlarini kapat.
  for (const [token, s] of sessions) {
    if (s.username === username) sessions.delete(token);
  }
  return true;
}

// Hic kullanici yoksa ilk admin hesabini olustur. Sunucu internete acik
// oldugu icin sabit "admin123" yerine ADMIN_PASSWORD ortam degiskeni
// kullanilir; verilmemisse rastgele bir sifre uretilip loglara yazilir.
function ensureDefaultAdmin() {
  if (db.listUsers().length > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.log('==================================================');
    console.log(' Ilk admin hesabi olusturuldu');
    console.log(`   kullanici: ${username}`);
    console.log(`   sifre    : ${password}`);
    console.log(' (ADMIN_PASSWORD ortam degiskeni ile belirleyebilirsiniz)');
    console.log('==================================================');
  }
  createUser(username, password, ROLE_ADMIN);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function createSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, role: user.role, lastActivity: Date.now() });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(token);
    return null;
  }
  // Silinen kullanicinin oturumu gecersiz; rol degistiyse guncel rolu kullan.
  const user = db.findUser(s.username);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  s.role = user.role;
  s.lastActivity = Date.now();
  return s;
}

// Sayfa istekleri icin: giris yoksa /login'e yonlendirir.
function requirePage(minRole) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s) return res.redirect('/login');
    if (minRole === ROLE_ADMIN && s.role !== ROLE_ADMIN) {
      return res.status(403).type('text').send('HATA: Bu sayfa icin yetkiniz yok.');
    }
    req.user = s;
    next();
  };
}

// fetch ile cagrilan /api/* istekleri icin: yonlendirme yerine 401/403 metni.
function requireApi(minRole) {
  return (req, res, next) => {
    const s = getSession(req);
    if (!s) return res.status(401).type('text').send('HATA: Giris yapmalisiniz.');
    if (minRole === ROLE_ADMIN && s.role !== ROLE_ADMIN) {
      return res.status(403).type('text').send('HATA: Bu islem icin yetkiniz yok.');
    }
    req.user = s;
    next();
  };
}

// Kaba kuvvet denemelerine karsi IP basina basit giris denemesi siniri.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function loginAllowed(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (!a || a.resetAt < now) return true;
  return a.count < LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (!a || a.resetAt < now) loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else a.count++;
}
function clearLoginFailures(ip) { loginAttempts.delete(ip); }

module.exports = {
  ROLE_USER, ROLE_ADMIN,
  createUser, setPassword, verifyPassword, ensureDefaultAdmin,
  createSession, destroySession, getSession,
  requirePage, requireApi,
  loginAllowed, recordLoginFailure, clearLoginFailures,
};
