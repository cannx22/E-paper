// PostgreSQL baglantisi ve migration calistirici. Migration'lar
// src/db/migrations/NNN_*.sql dosyalaridir; sirayla, her biri tek bir
// transaction icinde ve sadece bir kez calistirilir (schema_migrations).
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// BIGINT (id'ler) JS number olarak gelsin - 2^53'e kadar guvenli.
types.setTypeParser(20, (v) => parseInt(v, 10));

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

if (!process.env.DATABASE_URL) {
  console.error('HATA: DATABASE_URL ortam degiskeni tanimli degil (ornek: postgres://kullanici:sifre@host:5432/veritabani).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
pool.on('error', (err) => console.error('PostgreSQL havuz hatasi:', err.message));

function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

// fn(client) icindeki tum sorgular tek transaction'da calisir.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await many('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`Migration uygulandi: ${file}`);
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, one, many, tx, migrate, close };
