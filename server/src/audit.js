// Islem logu: kullanici ve sistem eylemlerini audit_log tablosuna yazar.
// Log yazimi basarisiz olsa bile asil islemi bozmasin diye hatalar yutulur.
const db = require('./db');

async function log(user, action, opts = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, username, dealer_id, branch_id, action, entity_type, entity_id, success, message, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        user ? user.id : null,
        user ? user.username : (opts.username || 'sistem'),
        opts.dealerId !== undefined ? opts.dealerId : (user ? user.dealer_id : null),
        opts.branchId !== undefined ? opts.branchId : (user ? user.branch_id : null),
        action,
        opts.entityType || null,
        opts.entityId != null ? String(opts.entityId) : null,
        opts.success !== false,
        opts.message || null,
        opts.details ? JSON.stringify(opts.details) : null,
      ],
    );
  } catch (err) {
    console.error('audit log yazilamadi:', err.message);
  }
}

module.exports = { log };
