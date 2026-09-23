// Kullanici girisi ve oturumlar. Sifreler tuzlu scrypt hash, oturumlar
// veritabaninda (sessions tablosu, token'in SHA-256 ozeti) tutulur.
const crypto = require('crypto');
const db = require('./db');
const { can } = require('./permissions');

const SESSION_COOKIE = 'gwsession';
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 saat hareketsizlik
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;  // last_activity en fazla dakikada bir yazilir

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(user, password) {
  const { hash } = hashPassword(password, user.password_salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.password_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createUser(client, { username, password, role, dealerId = null, branchId = null }) {
  const { salt, hash } = hashPassword(password);
  const r = await client.query(
    `INSERT INTO users (username, password_salt, password_hash, role, dealer_id, branch_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [username, salt, hash, role, dealerId, branchId],
  );
  return r.rows[0].id;
}

async function setPassword(userId, password) {
  const { salt, hash } = hashPassword(password);
  await db.query('UPDATE users SET password_salt = $1, password_hash = $2 WHERE id = $3', [salt, hash, userId]);
  // Sifresi degisen kullanicinin acik oturumlarini kapat.
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Hic kullanici yoksa ilk merkezi yonetici hesabini olustur. Sunucu internete
// acik oldugu icin sabit sifre yerine ADMIN_PASSWORD kullanilir; verilmemisse
// rastgele bir sifre uretilip loglara yazilir.
async function ensureDefaultAdmin() {
  const row = await db.one('SELECT count(*)::int AS n FROM users');
  if (row.n > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.log('==================================================');
    console.log(' Ilk merkezi yonetici hesabi olusturuldu');
    console.log(`   kullanici: ${username}`);
    console.log(`   sifre    : ${password}`);
    console.log(' (ADMIN_PASSWORD ortam degiskeni ile belirleyebilirsiniz)');
    console.log('==================================================');
  }
  await createUser(db, { username, password, role: 'super_admin' });
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

async function createSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [sha256(token), user.id]);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Gecerli oturumun kullanicisini doner. Kullanici, bayisi veya subesi pasif
// yapildiysa oturum gecersiz sayilir.
async function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = await db.one(
    `SELECT s.last_activity, u.id, u.username, u.role, u.dealer_id, u.branch_id, u.active,
            d.name AS dealer_name, d.active AS dealer_active,
            b.name AS branch_name, b.active AS branch_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN dealers d ON d.id = u.dealer_id
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  if (!row) return null;
  const idleMs = Date.now() - new Date(row.last_activity).getTime();
  const blocked = !row.active || row.dealer_active === false || row.branch_active === false;
  if (idleMs > SESSION_TIMEOUT_MS || blocked) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return null;
  }
  if (idleMs > ACTIVITY_WRITE_INTERVAL_MS) {
    await db.query('UPDATE sessions SET last_activity = now() WHERE token_hash = $1', [tokenHash]);
  }
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    dealer_id: row.dealer_id,
    branch_id: row.branch_id,
    dealer_name: row.dealer_name,
    branch_name: row.branch_name,
  };
}

// Sayfa istekleri icin: giris yoksa /login'e (donus adresiyle) yonlendirir.
function requirePage(action) {
  return async (req, res, next) => {
    const user = await getSession(req);
    if (!user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (action && !can(user, action)) {
      return res.status(403).type('text').send('HATA: Bu sayfa icin yetkiniz yok.');
    }
    req.user = user;
    next();
  };
}

// fetch ile cagrilan /api/* istekleri icin: yonlendirme yerine 401/403 metni.
function requireApi(action) {
  return async (req, res, next) => {
    const user = await getSession(req);
    if (!user) return res.status(401).type('text').send('HATA: Giris yapmalisiniz.');
    if (action && !can(user, action)) {
      return res.status(403).type('text').send('HATA: Bu islem icin yetkiniz yok.');
    }
    req.user = user;
    next();
  };
}

// Kaba kuvvet denemelerine karsi anahtar (IP veya kullanici) basina deneme siniri.
function createLimiter(maxAttempts, windowMs) {
  const attempts = new Map(); // key -> { count, resetAt }
  return {
    allowed(key) {
      const a = attempts.get(key);
      return !a || a.resetAt < Date.now() || a.count < maxAttempts;
    },
    fail(key) {
      const now = Date.now();
      const a = attempts.get(key);
      if (!a || a.resetAt < now) attempts.set(key, { count: 1, resetAt: now + windowMs });
      else a.count++;
    },
    clear(key) { attempts.delete(key); },
  };
}

// Eski oturumlari periyodik olarak temizle.
setInterval(() => {
  db.query(`DELETE FROM sessions WHERE last_activity < now() - interval '1 day'`).catch(() => {});
}, 60 * 60 * 1000).unref();

module.exports = {
  sha256, hashPassword, verifyPassword, createUser, setPassword, ensureDefaultAdmin,
  createSession, destroySession, getSession, requirePage, requireApi, createLimiter,
};
