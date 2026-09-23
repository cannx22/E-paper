// Faz 0'daki JSON deposundan (DATA_DIR/db.json) PostgreSQL'e tek seferlik
// aktarim. Veritabaninda hic kullanici yokken ve db.json varsa calisir;
// basarili aktarimdan sonra dosya db.json.imported olarak yeniden adlandirilir.
//
// Eslestirme:
//   admin kullanicilar      -> super_admin
//   user kullanicilar       -> "Varsayilan Bayi" operatoru
//   onayli gateway'ler      -> "Varsayilan Bayi"ye atanmis, state = active
//   onay bekleyen gateway'ler -> state = pending
//   gonderim gecmisi        -> audit_log (action = label.send)
const fs = require('fs');
const path = require('path');
const db = require('./index');

const DEFAULT_DEALER_NAME = 'Varsayılan Bayi';

async function importLegacyJson(dataDir) {
  const file = path.join(dataDir, 'db.json');
  if (!fs.existsSync(file)) return;
  const { n } = await db.one('SELECT count(*)::int AS n FROM users');
  if (n > 0) return;

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = data.users || [];
  const gateways = data.gateways || [];
  const history = data.history || [];
  console.log(`Eski JSON verisi aktariliyor: ${users.length} kullanici, ${gateways.length} gateway, ${history.length} gecmis kaydi`);

  await db.tx(async (c) => {
    let dealerId = null;
    const needsDealer = users.some((u) => u.role !== 'admin') || gateways.some((g) => g.status === 'approved');
    if (needsDealer) {
      const r = await c.query('INSERT INTO dealers (name) VALUES ($1) RETURNING id', [DEFAULT_DEALER_NAME]);
      dealerId = r.rows[0].id;
    }

    const userIds = {};
    for (const u of users) {
      const isAdmin = u.role === 'admin';
      const r = await c.query(
        `INSERT INTO users (username, password_salt, password_hash, role, dealer_id, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING id`,
        [u.username, u.salt, u.hash, isAdmin ? 'super_admin' : 'operator', isAdmin ? null : dealerId, u.createdAt || null],
      );
      userIds[u.username] = r.rows[0].id;
    }

    for (const g of gateways) {
      const approved = g.status === 'approved';
      await c.query(
        `INSERT INTO gateways (id, name, state, dealer_id, secret_hash, fw_version, last_ip,
                               first_seen_at, last_seen_at, activated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, COALESCE($8::timestamptz, now()))`,
        [
          g.id, g.name, approved ? 'active' : 'pending', approved ? dealerId : null,
          g.secretHash || null, g.fw || null, g.lastIp || null,
          g.createdAt || null, g.lastSeen || null, approved ? (g.createdAt || null) : null,
        ],
      );
    }

    const gatewayDealer = Object.fromEntries(gateways.map((g) => [g.id, g.status === 'approved' ? dealerId : null]));
    for (const h of history) {
      await c.query(
        `INSERT INTO audit_log (created_at, user_id, username, dealer_id, action, entity_type, entity_id, success, message, details)
         VALUES ($1, $2, $3, $4, 'label.send', 'gateway', $5, $6, $7, $8)`,
        [
          h.ts, userIds[h.user] || null, h.user, gatewayDealer[h.gatewayId] || null, h.gatewayId,
          !!h.ok, h.message, JSON.stringify({ board: h.board, fields: { name: h.name, price: h.price } }),
        ],
      );
    }
  });

  fs.renameSync(file, file + '.imported');
  console.log('Eski JSON verisi aktarildi, dosya db.json.imported olarak yeniden adlandirildi.');
}

module.exports = { importLegacyJson };
