// Etiket gonderimi: tekli (/api/send) ve toplu (/api/updates). Her gonderim
// kalici kuyruga (src/queue.js) is olarak eklenir.
//
// Form alanlari firmware'deki LabelFields ile ayni; paketleme (399 byte,
// Turkce kodlama) gateway tarafinda yapilir. Hedef, cihazin 8 haneli seri
// numarasidir: kayitli cihazda gateway cihaz kaydindan gelir (istekte
// gatewayId verilirse o kullanilir), kayitli olmayan seri no icin gatewayId
// zorunludur.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const queue = require('../queue');
const hub = require('../gateways');
const { inScope, isCentral } = require('../permissions');
const { fail, HttpError } = require('./util');
const { loadGateway } = require('./gateways');
const { SERIAL_RE, normalizeSerial, IMPORT_MAX_ROWS } = require('./devices');

const api = express.Router();
const TEXT_FIELDS = ['business', 'name', 'subtitle', 'price', 'oldPrice', 'unit',
  'bottomCode', 'campaignText', 'barcode', 'ingredients', 'allergens'];
const SINGLE_WAIT_MS = 25000;

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

function cleanFields(b) {
  const fields = {
    templateID: parseInt(b.templateID, 10) || 1,
    discountEnabled: truthy(b.discountEnabled) ? 1 : 0,
    campaignEnabled: truthy(b.campaignEnabled) ? 1 : 0,
  };
  for (const f of TEXT_FIELDS) fields[f] = String(b[f] == null ? '' : b[f]).slice(0, 100);
  return fields;
}

// Hedef dogrulama. Hata metni firlatir (HttpError); toplu gonderimde satir
// bazinda yakalanip rapora yazilir. gwCache: ayni istekte gateway tekrar yuklenmesin.
async function resolveTarget(user, rawSerial, rawGatewayId, cache) {
  const serial = normalizeSerial(rawSerial);
  if (!SERIAL_RE.test(serial)) fail(400, 'Seri numarası 8 haneli olmalı.');
  const device = cache.devices.get(serial) || await db.one(
    `SELECT dv.id, dv.name, dv.state, dv.dealer_id, dv.branch_id, dv.gateway_id, d.active AS dealer_active
       FROM devices dv JOIN dealers d ON d.id = dv.dealer_id WHERE dv.id = $1`,
    [serial],
  );
  if (device) {
    cache.devices.set(serial, device);
    if (!inScope(user, device)) fail(404, 'Cihaz bulunamadi.');
    if (device.state === 'disabled') fail(409, 'Cihaz devre disi.');
    if (device.dealer_active === false) fail(409, 'Cihazin bagli oldugu bayi pasif.');
  }
  const gatewayId = rawGatewayId ? String(rawGatewayId).toUpperCase() : (device && device.gateway_id);
  if (!gatewayId) fail(400, device ? 'Cihaz bir gateway\'e atanmamis. Cihazlar sayfasindan gateway secin.' : 'Gateway secilmedi.');
  let gw = cache.gateways.get(gatewayId);
  if (gw === undefined) {
    gw = await loadGateway(gatewayId);
    cache.gateways.set(gatewayId, gw || null);
  }
  if (!gw || !inScope(user, gw)) fail(404, 'Gateway bulunamadi.');
  if (device && gw.dealer_id !== device.dealer_id) fail(400, 'Gateway ile cihaz ayni bayiye ait degil.');
  if (gw.dealer_active === false) fail(409, 'Gateway\'in bagli oldugu bayi pasif.');
  if (gw.state === 'disabled') fail(409, 'Gateway devre disi.');
  if (gw.state !== 'active') fail(409, 'Gateway henuz aktif degil.');
  return {
    serial,
    dealerId: device ? device.dealer_id : gw.dealer_id,
    branchId: device ? device.branch_id : gw.branch_id,
    gatewayId: gw.id,
    gatewayName: gw.name,
    fixedGateway: !device || !!rawGatewayId,
  };
}

function newCache() {
  return { devices: new Map(), gateways: new Map() };
}

// Tekli gonderim: kuyruga oncelikli eklenir ve ilk denemenin sonucu beklenir.
//   200 basarili, 202 sirada (gateway cevrimdisi / tekrar denenecek),
//   502 denemeler bitti (hata / cihaz ulasilamiyor)
api.post('/send', auth.requireApi('label.send'), async (req, res) => {
  const target = await resolveTarget(req.user, req.body.serial, req.body.gatewayId, newCache());
  const fields = cleanFields(req.body || {});
  const [job] = await db.tx((c) => queue.enqueue(c, [{ ...target, fields }], { priority: 10, user: req.user }));
  res.setHeader('X-Job-Id', String(job.id));
  if (!hub.isOnline(target.gatewayId)) {
    queue.kick();
    return res.status(202).type('text').send('Gateway çevrimdışı; güncelleme sıraya alındı. Gateway bağlanınca otomatik gönderilecek.');
  }
  const wait = queue.waitForAttempt(job.id, SINGLE_WAIT_MS);
  queue.kick();
  const r = await wait;
  if (r.status === 'success') return res.status(200).type('text').send(r.message || 'OK');
  if (r.final) return res.status(502).type('text').send(r.message || 'HATA');
  if (r.timeout) return res.status(202).type('text').send('Güncelleme sırada; gateway meşgul. Güncellemeler sayfasından takip edebilirsiniz.');
  const retry = r.willRetry && r.retryIn
    ? `İlk deneme başarısız (${String(r.message || '').replace(/^HATA:\s*/, '')}). ${Math.round(r.retryIn)} sn sonra otomatik tekrar denenecek (deneme ${r.attempt}/${r.maxAttempts}).`
    : String(r.message || 'Güncelleme sırada.');
  res.status(202).type('text').send(retry);
});

// Toplu gonderim. Iki bicim:
//   { name, items: [{ serial, gatewayId?, fields }] }   satir bazli icerik (Excel)
//   { name, serials: [...], fields, gatewayId? }         ayni icerik birden cok cihaza
api.post('/updates', auth.requireApi('label.send'), async (req, res) => {
  const user = req.user;
  const b = req.body || {};
  let items = Array.isArray(b.items) ? b.items : null;
  if (!items && Array.isArray(b.serials)) items = b.serials.map((s) => ({ serial: s, gatewayId: b.gatewayId, fields: b.fields || {} }));
  if (!items || !items.length) fail(400, 'Gönderilecek cihaz yok.');
  if (items.length > IMPORT_MAX_ROWS) fail(400, `Tek seferde en fazla ${IMPORT_MAX_ROWS} cihaz güncellenebilir.`);

  const cache = newCache();
  const valid = [];
  const skipped = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const serial = normalizeSerial(it.serial);
    try {
      if (seen.has(serial)) fail(400, 'Listede tekrar ediyor (ilk satır kullanıldı).');
      const target = await resolveTarget(user, serial, it.gatewayId, cache);
      seen.add(serial);
      valid.push({ ...target, fields: cleanFields(it.fields || {}), row: i + 1 });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      skipped.push({ row: i + 1, serial, message: err.message.replace(/^HATA:\s*/, '') });
    }
  }
  if (!valid.length) {
    return res.status(400).json({ batchId: null, queued: 0, skipped });
  }

  const dealers = [...new Set(valid.map((v) => v.dealerId))];
  const name = String(b.name || '').trim().slice(0, 120) || `Toplu güncelleme (${valid.length} cihaz)`;
  const source = ['bulk', 'excel', 'api'].includes(b.source) ? b.source : 'bulk';
  const result = await db.tx(async (c) => {
    const batch = (await c.query(
      `INSERT INTO update_batches (dealer_id, branch_id, name, source, created_by, username, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [dealers.length === 1 ? dealers[0] : null, user.branch_id || null, name, source, user.id, user.username, valid.length],
    )).rows[0];
    await queue.enqueue(c, valid, { batchId: batch.id, priority: 0, user });
    return batch;
  });
  queue.kick();
  res.json({ batchId: result.id, queued: valid.length, skipped, crossDealer: dealers.length > 1 && isCentral(user) });
});

module.exports = { api };
