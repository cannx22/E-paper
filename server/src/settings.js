// Sistem ayarlari (settings tablosu). Degerler kisa sureli bellekte tutulur.
const db = require('./db');

const DEFAULTS = {
  company_name: 'E-Paper Yönetim',
  inventory_required: false,
  password_min_length: 8,
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30 * 1000;

async function all() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const rows = await db.many('SELECT key, value FROM settings');
  cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  cacheAt = Date.now();
  return cache;
}

async function get(key) {
  return (await all())[key];
}

async function set(key, value) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  cache = null;
}

module.exports = { DEFAULTS, all, get, set };
