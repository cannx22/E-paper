// Kullanici girisi ve oturumlar. Giris e-posta ile yapilir (Faz 1'den kalan,
// e-postasi olmayan hesaplar kullanici adiyla). Sifreler tuzlu scrypt hash,
// oturumlar veritabaninda (sessions tablosu, token'in SHA-256 ozeti).
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const { can } = require('./permissions');

const SESSION_COOKIE = 'gwsession';
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 saat hareketsizlik
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;  // last_activity en fazla dakikada bir yazilir
const LOCK_AFTER_FAILURES = 5;                 // bu kadar hatali denemeden sonra hesap kilitlenir
const LOCK_MINUTES = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// Sifre kurali: en az N karakter (ayarlardan), en az bir harf ve bir rakam.
// Uygunsa null, degilse aciklama doner.
async function checkPasswordPolicy(password) {
  const min = Number(await settings.get('password_min_length')) || 8;
  if (typeof password !== 'string' || password.length < min) return `Sifre en az ${min} karakter olmali.`;
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(password) || !/\d/.test(password)) return 'Sifre en az bir harf ve bir rakam icermeli.';
  return null;
}

function generatePassword() {
  // Okunmasi/soylenmesi kolay: karisan karakterler yok, harf + rakam garantili.
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const chars = [letters[crypto.randomInt(letters.length)], digits[crypto.randomInt(digits.length)]];
  while (chars.length < 10) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

async function createUser(client, u) {
  const { salt, hash } = hashPassword(u.password);
  const r = await client.query(
    `INSERT INTO users (username, email, full_name, phone, title, notes, password_salt, password_hash,
                        role, dealer_id, branch_id, must_change_password, password_changed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13) RETURNING id`,
    [
      u.username || null, u.email ? normalizeEmail(u.email) : null, u.fullName || null, u.phone || null,
      u.title || null, u.notes || null, salt, hash, u.role, u.dealerId || null, u.branchId || null,
      !!u.mustChangePassword, u.createdBy || null,
    ],
  );
  return r.rows[0].id;
}

// Sifreyi degistirir. keepSessionHash verilirse o oturum acik kalir (kendi
// sifresini degistiren kullanici cikis yapmak zorunda kalmasin).
async function setPassword(userId, password, { mustChange = false, keepSessionHash = null } = {}) {
  const { salt, hash } = hashPassword(password);
  await db.query(
    `UPDATE users SET password_salt = $1, password_hash = $2, password_changed_at = now(),
                      must_change_password = $4, failed_login_count = 0, locked_until = NULL
      WHERE id = $3`,
    [salt, hash, userId, mustChange],
  );
  if (keepSessionHash) await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keepSessionHash]);
  else await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Hic kullanici yoksa ilk merkezi yonetici hesabini olustur. ADMIN_EMAIL
// verilirse e-posta ile, verilmezse "admin" kullanici adiyla giris yapilir.
async function ensureDefaultAdmin() {
  const row = await db.one('SELECT count(*)::int AS n FROM users');
  if (row.n > 0) return;
  const email = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : null;
  const username = email ? null : (process.env.ADMIN_USERNAME || 'admin');
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = generatePassword();
    console.log('==================================================');
    console.log(' Ilk merkezi yonetici hesabi olusturuldu');
    console.log(`   giris : ${email || username}`);
    console.log(`   sifre : ${password}`);
    console.log(' (ADMIN_EMAIL / ADMIN_PASSWORD ortam degiskenleri ile belirleyebilirsiniz)');
    console.log('==================================================');
  }
  await createUser(db, { username, email, fullName: 'Merkezi Yönetici', password, role: 'super_admin' });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // bozuk cerez degeri - yok say
    }
  }
  return out;
}

function currentTokenHash(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token ? sha256(token) : null;
}

// Giris dogrulama: hesap kilidi ve hatali deneme sayaci dahil.
// { user } veya { error: 'invalid' | 'locked' | 'inactive', until } doner.
async function authenticate(login, password) {
  const key = String(login || '').trim().toLowerCase();
  if (!key) return { error: 'invalid' };
  const user = await db.one(
    `SELECT u.*, d.active AS dealer_active, b.active AS branch_active
       FROM users u
       LEFT JOIN dealers d ON d.id = u.dealer_id
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE lower(u.email) = $1 OR (u.email IS NULL AND lower(u.username) = $1)`,
    [key],
  );
  if (!user) return { error: 'invalid' };
  if (user.locked_until && new Date(user.locked_until) > new Date()) return { error: 'locked', until: user.locked_until, user };
  if (!verifyPassword(user, password)) {
    const r = await db.one(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
                        locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1 RETURNING failed_login_count, locked_until`,
      [user.id, LOCK_AFTER_FAILURES, String(LOCK_MINUTES)],
    );
    if (r.failed_login_count >= LOCK_AFTER_FAILURES) {
      await db.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [user.id]);
      return { error: 'locked', until: r.locked_until, user, justLocked: true };
    }
    return { error: 'invalid', user };
  }
  if (!user.active || user.dealer_active === false || user.branch_active === false) return { error: 'inactive', user };
  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  return { user };
}

async function createSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    'INSERT INTO sessions (token_hash, user_id, ip, user_agent) VALUES ($1, $2, $3, $4)',
    [sha256(token), user.id, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)],
  );
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

async function destroySession(req, res) {
  const tokenHash = currentTokenHash(req);
  if (tokenHash) await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Gecerli oturumun kullanicisini doner. Kullanici, bayisi veya subesi pasif
// yapildiysa oturum gecersiz sayilir.
async function getSession(req) {
  const tokenHash = currentTokenHash(req);
  if (!tokenHash) return null;
  const row = await db.one(
    `SELECT s.last_activity, u.id, u.username, u.email, u.full_name, u.phone, u.title, u.role,
            u.dealer_id, u.branch_id, u.active, u.must_change_password,
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
    username: row.email || row.username, // loglarda ve ekranda gorunen giris kimligi
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    title: row.title,
    role: row.role,
    dealer_id: row.dealer_id,
    branch_id: row.branch_id,
    dealer_name: row.dealer_name,
    branch_name: row.branch_name,
    must_change_password: row.must_change_password,
    token_hash: tokenHash,
  };
}

// Sifresini degistirmesi gereken kullanici sadece sifre degistirme sayfasina
// ve ilgili API'lere erisebilir.
const PASSWORD_CHANGE_ALLOWED = ['/api/me', '/api/me/password', '/change-password', '/logout'];
function passwordChangeBlocks(req, user) {
  return user.must_change_password && !PASSWORD_CHANGE_ALLOWED.includes(req.originalUrl.split('?')[0]);
}

// Sayfa istekleri icin: giris yoksa /login'e (donus adresiyle) yonlendirir.
function requirePage(action) {
  return async (req, res, next) => {
    const user = await getSession(req);
    if (!user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (passwordChangeBlocks(req, user)) return res.redirect('/change-password');
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
    if (passwordChangeBlocks(req, user)) return res.status(403).type('text').send('HATA: Devam etmeden once sifrenizi degistirmelisiniz.');
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
  EMAIL_RE, sha256, hashPassword, verifyPassword, checkPasswordPolicy, generatePassword, normalizeEmail,
  createUser, setPassword, ensureDefaultAdmin, authenticate,
  createSession, destroySession, getSession, requirePage, requireApi, createLimiter,
};
