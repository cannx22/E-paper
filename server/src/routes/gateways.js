// Gateway kayit, sahiplenme (QR), atama ve uzaktan yonetim.
//
// Yasam dongusu:
//   bilinmeyen gateway baglanir         -> pending (Beklemede)
//   merkez kaydeder / elle ekler         -> registered (Kayitli, sahiplenme kodu uretilir)
//   bayi QR/kod ile sahiplenir veya
//   merkez bir bayiye atar               -> awaiting (Baglanti Bekleniyor) ya da
//                                           o an bagliysa dogrudan active
//   atanmis gateway dogrulanmis baglanti -> active (Aktif)
//   devre disi / tekrar etkinlestir      -> disabled <-> active/awaiting
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const hub = require('../gateways');
const { can, inScope, scopeSql } = require('../permissions');
const { fail, optionalId, cleanName } = require('./util');

const api = express.Router();
const claimLimiter = auth.createLimiter(10, 15 * 60 * 1000);

// Karistirilmasi kolay karakterler (0/O, 1/I/L) yok.
const CLAIM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newClaimCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]).join('');
}
function normalizeCode(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
function formatCode(c) {
  return c ? c.slice(0, 4) + '-' + c.slice(4) : null;
}
function normalizeGatewayId(v) {
  return String(v || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function claimUrl(req, gw) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/claim?gw=${gw.id}&code=${formatCode(gw.claim_code)}`;
}

function view(gw, user) {
  const online = hub.isOnline(gw.id);
  const status = hub.displayStatus(gw, online);
  const v = {
    id: gw.id,
    name: gw.name,
    location: gw.location,
    notes: gw.notes,
    state: gw.state,
    status,
    statusLabel: hub.STATUS_LABELS[status],
    online,
    dealerId: gw.dealer_id,
    dealerName: gw.dealer_name || null,
    dealerActive: gw.dealer_active !== false,
    branchId: gw.branch_id,
    branchName: gw.branch_name || null,
    fw: gw.fw_version,
    ip: gw.last_ip,
    nrf: gw.nrf_ok,
    wifiSsid: gw.wifi_ssid,
    wifiRssi: gw.wifi_rssi,
    uptime: gw.uptime_s,
    freeHeap: gw.free_heap,
    lastError: gw.nrf_ok === false && !gw.last_error ? 'nRF24 modulu hazir degil' : gw.last_error,
    connectedAt: online ? gw.connected_at : null,
    lastSeen: gw.last_seen_at,
    lastMessage: gw.last_message_at,
    activatedAt: gw.activated_at,
    createdAt: gw.created_at,
    hasKey: !!gw.secret_hash,
    deviceCount: gw.device_count != null ? gw.device_count : null,
  };
  if (user.role === 'super_admin') v.claimCode = formatCode(gw.claim_code);
  return v;
}

const SELECT_GW = `SELECT g.*, d.name AS dealer_name, d.active AS dealer_active, b.name AS branch_name,
                          (SELECT count(*)::int FROM devices dv WHERE dv.gateway_id = g.id) AS device_count
                     FROM gateways g
                     LEFT JOIN dealers d ON d.id = g.dealer_id
                     LEFT JOIN branches b ON b.id = g.branch_id`;

async function loadGateway(id) {
  return db.one(`${SELECT_GW} WHERE g.id = $1`, [normalizeGatewayId(id)]);
}

// UPDATE ... RETURNING bayi/sube adlarini icermez; yaniti tam haliyle dondur.
async function freshView(gw, user) {
  return view(await loadGateway(gw.id), user);
}

// Kapsam disindaki gateway'ler "bulunamadi" gibi davranir (varligi sizmasin).
async function loadScoped(req, action) {
  const gw = await loadGateway(req.params.id);
  if (!gw || !inScope(req.user, gw)) fail(404, 'Gateway bulunamadi.');
  if (action && !can(req.user, action)) fail(403, 'Bu islem icin yetkiniz yok.');
  return gw;
}

async function logGw(user, action, gw, extra = {}) {
  await audit.log(user, action, { entityType: 'gateway', entityId: gw.id, dealerId: gw.dealer_id, branchId: gw.branch_id, ...extra });
}

// Bayiye atanmis bir gateway'in durumu: o an bagliysa (dogrulanmis) aktif,
// daha once hic aktif olmadiysa baglanti bekleniyor.
function assignedState(gw) {
  return hub.isOnline(gw.id) || gw.activated_at ? 'active' : 'awaiting';
}

async function validateBranch(branchId, dealerId) {
  if (!branchId) return;
  const b = await db.one('SELECT id FROM branches WHERE id = $1 AND dealer_id = $2', [branchId, dealerId]);
  if (!b) fail(400, 'Secilen sube bu bayiye ait degil.');
}

// Bayinin lisansli gateway sayisi (max_gateways) asilmasin.
async function ensureGatewayQuota(dealerId, excludeId) {
  const d = await db.one(
    'SELECT max_gateways, (SELECT count(*)::int FROM gateways WHERE dealer_id = $1 AND id <> $2) AS used FROM dealers WHERE id = $1',
    [dealerId, excludeId || ''],
  );
  if (d && d.max_gateways != null && d.used >= d.max_gateways) {
    fail(400, `Bayinin gateway limiti dolu (${d.used}/${d.max_gateways}). Limit icin merkezle iletisime gecin.`);
  }
}

// ?dealerId= ?branchId= filtreleri (kapsam her zaman uygulanir)
api.get('/gateways', auth.requireApi('gateway.view'), async (req, res) => {
  const params = [];
  const conds = [scopeSql(req.user, 'g', params)];
  const dealerId = optionalId(req.query.dealerId, 'Bayi');
  if (dealerId) { params.push(dealerId); conds.push(`g.dealer_id = $${params.length}`); }
  const branchId = optionalId(req.query.branchId, 'Sube');
  if (branchId) { params.push(branchId); conds.push(`g.branch_id = $${params.length}`); }
  const rows = await db.many(`${SELECT_GW} WHERE ${conds.join(' AND ')} ORDER BY d.name NULLS FIRST, lower(g.name)`, params);
  res.json(rows.map((g) => view(g, req.user)));
});

// Detay: gateway bilgisi + son baglanti olaylari.
api.get('/gateways/:id', auth.requireApi('gateway.view'), async (req, res) => {
  const gw = await loadScoped(req);
  const events = await db.many(
    'SELECT event, ip, detail, created_at FROM gateway_events WHERE gateway_id = $1 ORDER BY id DESC LIMIT 100',
    [gw.id],
  );
  res.json({ ...view(gw, req.user), events });
});

// Isim, konum ve not.
api.post('/gateways/:id/info', auth.requireApi('gateway.manage'), async (req, res) => {
  const gw = await loadScoped(req);
  const name = req.body.name !== undefined ? cleanName(req.body.name, 'Isim') : gw.name;
  const location = req.body.location !== undefined ? (String(req.body.location).trim().slice(0, 200) || null) : gw.location;
  const notes = req.body.notes !== undefined ? (String(req.body.notes).trim().slice(0, 2000) || null) : gw.notes;
  const row = await db.one('UPDATE gateways SET name = $2, location = $3, notes = $4 WHERE id = $1 RETURNING *', [gw.id, name, location, notes]);
  await logGw(req.user, 'gateway.updated', row, { details: { before: { name: gw.name, location: gw.location }, after: { name, location } } });
  if (name !== gw.name) await hub.notifyStatus(gw.id);
  res.json(await freshView(row, req.user));
});

// Ariza/degisim: bu gateway'e bagli tum cihazlari baska bir gateway'e tasi.
api.post('/gateways/:id/move-devices', auth.requireApi('gateway.assign'), async (req, res) => {
  const gw = await loadScoped(req);
  const target = await loadGateway(req.body.targetGatewayId);
  if (!target || !inScope(req.user, target)) fail(400, 'Hedef gateway bulunamadi.');
  if (target.id === gw.id) fail(400, 'Hedef gateway ayni olamaz.');
  if (target.dealer_id !== gw.dealer_id) fail(400, 'Cihazlar sadece ayni bayideki bir gateway\'e tasinabilir.');
  const r = await db.query(
    'UPDATE devices SET gateway_id = $2, branch_id = COALESCE($3, branch_id) WHERE gateway_id = $1 RETURNING id',
    [gw.id, target.id, target.branch_id],
  );
  await logGw(req.user, 'gateway.devices_moved', gw, { message: `${r.rowCount} cihaz -> ${target.name}`, details: { target: target.id, serials: r.rows.map((x) => x.id).slice(0, 1000) } });
  res.json({ ok: true, moved: r.rowCount });
});

// Merkez: MAC ile elle kayit (gateway henuz hic baglanmamis olabilir).
api.post('/gateways', auth.requireApi('gateway.register'), async (req, res) => {
  const id = normalizeGatewayId(req.body.id);
  if (id.length !== 12) fail(400, 'Gateway kimligi 12 haneli MAC adresi olmali (ornek: A1B2C3D4E5F6).');
  const name = String(req.body.name || '').trim().slice(0, 60) || 'Gateway ' + id.slice(-6);
  const existing = await db.one('SELECT id FROM gateways WHERE id = $1', [id]);
  if (existing) fail(400, 'Bu gateway zaten kayitli.');
  const gw = await db.one(
    `INSERT INTO gateways (id, name, state, claim_code) VALUES ($1, $2, 'registered', $3) RETURNING *`,
    [id, name, newClaimCode()],
  );
  await logGw(req.user, 'gateway.registered', gw);
  res.json(await freshView(gw, req.user));
});

// Merkez: kendiliginden baglanmis (Beklemede) gateway'i kaydet.
api.post('/gateways/:id/register', auth.requireApi('gateway.register'), async (req, res) => {
  const gw = await loadScoped(req);
  if (gw.state !== 'pending') fail(400, 'Sadece beklemedeki gateway kaydedilebilir.');
  const row = await db.one(`UPDATE gateways SET state = 'registered', claim_code = $2 WHERE id = $1 RETURNING *`, [gw.id, newClaimCode()]);
  await logGw(req.user, 'gateway.registered', row);
  await hub.notifyStatus(gw.id);
  res.json(await freshView(row, req.user));
});

api.post('/gateways/:id/claim-code', auth.requireApi('gateway.register'), async (req, res) => {
  const gw = await loadScoped(req);
  if (gw.state !== 'registered') fail(400, 'Sahiplenme kodu sadece kayitli (bayiye atanmamis) gateway icin uretilir.');
  const row = await db.one('UPDATE gateways SET claim_code = $2 WHERE id = $1 RETURNING *', [gw.id, newClaimCode()]);
  await logGw(req.user, 'gateway.claim_code_renewed', row);
  res.json(await freshView(row, req.user));
});

// QR etiket icerigi: telefon kamerasiyla okutulunca sahiplenme sayfasini
// (kimlik ve kod dolu olarak) acan adres.
api.get('/gateways/:id/qr.svg', auth.requireApi('gateway.register'), async (req, res) => {
  const gw = await loadScoped(req);
  if (!gw.claim_code) fail(400, 'Bu gateway icin gecerli bir sahiplenme kodu yok.');
  const svg = await QRCode.toString(claimUrl(req, gw), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

api.get('/gateways/:id/label-info', auth.requireApi('gateway.register'), async (req, res) => {
  const gw = await loadScoped(req);
  res.json({ id: gw.id, name: gw.name, claimCode: formatCode(gw.claim_code), claimUrl: gw.claim_code ? claimUrl(req, gw) : null });
});

// Bayi yoneticisi: gateway uzerindeki QR/kod ile kendi bayisine ekler.
api.post('/gateways/claim', auth.requireApi('gateway.claim'), async (req, res) => {
  const user = req.user;
  if (user.role === 'super_admin') fail(400, 'Merkezi yonetici gateway\'i "Bayiye Ata" ile dogrudan atar.');
  const key = 'u' + user.id;
  if (!claimLimiter.allowed(key)) fail(429, 'Cok fazla hatali deneme. 15 dakika sonra tekrar deneyin.');

  const id = normalizeGatewayId(req.body.id);
  const code = normalizeCode(req.body.code);
  const gw = id.length === 12 ? await db.one('SELECT * FROM gateways WHERE id = $1', [id]) : null;
  const valid = gw && gw.state === 'registered' && gw.claim_code && code.length === gw.claim_code.length &&
    crypto.timingSafeEqual(Buffer.from(code), Buffer.from(gw.claim_code));
  if (!valid) {
    claimLimiter.fail(key);
    await audit.log(user, 'gateway.claim_failed', { entityType: 'gateway', entityId: id || null, success: false });
    fail(400, 'Gateway kimligi veya sahiplenme kodu hatali (ya da gateway zaten sahiplenilmis).');
  }
  claimLimiter.clear(key);

  const branchId = user.branch_id || optionalId(req.body.branchId, 'Sube');
  await validateBranch(branchId, user.dealer_id);
  await ensureGatewayQuota(user.dealer_id, gw.id);
  const name = String(req.body.name || '').trim().slice(0, 60) || gw.name;
  const row = await db.one(
    `UPDATE gateways SET dealer_id = $2, branch_id = $3, name = $4, state = $5, claim_code = NULL,
                         activated_at = CASE WHEN $5 = 'active' THEN now() ELSE activated_at END
      WHERE id = $1 RETURNING *`,
    [gw.id, user.dealer_id, branchId, name, assignedState(gw)],
  );
  await logGw(user, 'gateway.claimed', row);
  await hub.notifyStatus(gw.id);
  res.json(await freshView(row, user));
});

// Atama. Merkez: bayi + sube (bayi bos -> gateway serbest birakilir, yeni
// sahiplenme kodu uretilir). Bayi yoneticisi: sadece sube degistirir.
api.post('/gateways/:id/assign', auth.requireApi('gateway.assign'), async (req, res) => {
  const user = req.user;
  const gw = await loadScoped(req);
  let dealerId = gw.dealer_id;
  if (user.role === 'super_admin' && req.body.dealerId !== undefined) dealerId = optionalId(req.body.dealerId, 'Bayi');
  const branchId = dealerId ? optionalId(req.body.branchId, 'Sube') : null;

  // Bayi degisirse (veya gateway serbest birakilirsa) eski bayinin cihazlari
  // bu gateway'den ayrilir; cihaz kayitlari bayide kalir.
  let detached = 0;
  const detachForeignDevices = async () => {
    const r = await db.query('UPDATE devices SET gateway_id = NULL WHERE gateway_id = $1 AND dealer_id IS DISTINCT FROM $2', [gw.id, dealerId]);
    detached = r.rowCount;
  };

  let row;
  if (!dealerId) {
    await detachForeignDevices();
    row = await db.one(
      `UPDATE gateways SET dealer_id = NULL, branch_id = NULL, activated_at = NULL,
                           state = CASE WHEN state = 'disabled' THEN 'disabled' ELSE 'registered' END,
                           claim_code = $2
        WHERE id = $1 RETURNING *`,
      [gw.id, newClaimCode()],
    );
  } else {
    if (!(await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]))) fail(404, 'Bayi bulunamadi.');
    await validateBranch(branchId, dealerId);
    const dealerChanged = dealerId !== gw.dealer_id;
    if (dealerChanged) {
      await ensureGatewayQuota(dealerId, gw.id);
      await detachForeignDevices();
    }
    const state = gw.state === 'disabled' ? 'disabled' : (dealerChanged || gw.state === 'pending' || gw.state === 'registered') ? assignedState({ ...gw, activated_at: null }) : gw.state;
    row = await db.one(
      `UPDATE gateways SET dealer_id = $2, branch_id = $3, state = $4, claim_code = NULL,
                           activated_at = CASE WHEN $5 THEN (CASE WHEN $4 = 'active' THEN now() ELSE NULL END) ELSE activated_at END
        WHERE id = $1 RETURNING *`,
      [gw.id, dealerId, branchId, state, dealerChanged],
    );
  }
  await logGw(user, 'gateway.assigned', row, {
    message: detached ? `${detached} cihaz gateway'den ayrildi` : null,
    details: { before: { dealerId: gw.dealer_id, branchId: gw.branch_id }, after: { dealerId: row.dealer_id, branchId: row.branch_id } },
  });
  await hub.notifyStatus(gw.id);
  res.json({ ...(await freshView(row, user)), detachedDevices: detached });
});

api.post('/gateways/:id/rename', auth.requireApi('gateway.manage'), async (req, res) => {
  const gw = await loadScoped(req);
  const name = cleanName(req.body.name, 'Isim');
  const row = await db.one('UPDATE gateways SET name = $2 WHERE id = $1 RETURNING *', [gw.id, name]);
  await logGw(req.user, 'gateway.renamed', row, { details: { before: gw.name, after: name } });
  await hub.notifyStatus(gw.id);
  res.json(await freshView(row, req.user));
});

api.post('/gateways/:id/disable', auth.requireApi('gateway.disable'), async (req, res) => {
  const gw = await loadScoped(req);
  const row = await db.one(`UPDATE gateways SET state = 'disabled' WHERE id = $1 RETURNING *`, [gw.id]);
  await logGw(req.user, 'gateway.disabled', row);
  await hub.notifyStatus(gw.id);
  res.json(await freshView(row, req.user));
});

api.post('/gateways/:id/enable', auth.requireApi('gateway.disable'), async (req, res) => {
  const gw = await loadScoped(req);
  if (gw.state !== 'disabled') fail(400, 'Gateway zaten etkin.');
  const state = gw.dealer_id ? assignedState(gw) : 'registered';
  const row = await db.one(
    `UPDATE gateways SET state = $2,
                         claim_code = CASE WHEN $2 = 'registered' THEN COALESCE(claim_code, $3) ELSE claim_code END,
                         activated_at = CASE WHEN $2 = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END
      WHERE id = $1 RETURNING *`,
    [gw.id, state, newClaimCode()],
  );
  await logGw(req.user, 'gateway.enabled', row);
  await hub.notifyStatus(gw.id);
  res.json(await freshView(row, req.user));
});

// Gateway'in flash'i silinip yeni anahtar uretildiyse eski anahtar artik
// eslesmez - sifirlayinca bir sonraki baglantidaki anahtar kabul edilir.
api.post('/gateways/:id/reset-key', auth.requireApi('gateway.register'), async (req, res) => {
  const gw = await loadScoped(req);
  await db.query('UPDATE gateways SET secret_hash = NULL WHERE id = $1', [gw.id]);
  hub.disconnect(gw.id);
  await logGw(req.user, 'gateway.key_reset', gw);
  res.json({ ok: true });
});

api.post('/gateways/:id/command', auth.requireApi('gateway.manage'), async (req, res) => {
  const gw = await loadScoped(req);
  const command = String(req.body.command || '');
  if (!['restart', 'wifi_reset'].includes(command)) fail(400, 'Bilinmeyen komut.');
  if (!hub.sendCommand(gw.id, command)) fail(503, 'Gateway cevrimdisi.');
  await logGw(req.user, 'gateway.command', gw, { message: command });
  res.json({ ok: true });
});

api.delete('/gateways/:id', auth.requireApi('gateway.register'), async (req, res) => {
  const gw = await loadScoped(req);
  await db.query('DELETE FROM gateways WHERE id = $1', [gw.id]);
  hub.disconnect(gw.id);
  await logGw(req.user, 'gateway.deleted', gw, { message: gw.name });
  res.json({ ok: true });
});

module.exports = { api, loadGateway };
