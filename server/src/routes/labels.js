// Etiket gonderimi. Form alanlari firmware'deki LabelFields ile ayni;
// paketleme (399 byte, Turkce kodlama) gateway tarafinda PackLabelPayload()
// ile yapilir. Hedef, cihazin 8 haneli seri numarasidir.
//
// Seri no kayitli bir cihaza aitse gateway cihaz kaydindan alinir (istekte
// gatewayId verilirse o kullanilir); kayitli degilse gatewayId zorunludur.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const hub = require('../gateways');
const { inScope } = require('../permissions');
const { fail } = require('./util');
const { loadGateway } = require('./gateways');
const { loadDevice, SERIAL_RE, normalizeSerial } = require('./devices');

const api = express.Router();

const TEXT_FIELDS = ['business', 'name', 'subtitle', 'price', 'oldPrice', 'unit',
  'bottomCode', 'campaignText', 'barcode', 'ingredients', 'allergens'];

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

api.post('/send', auth.requireApi('label.send'), async (req, res) => {
  const b = req.body || {};
  const serial = normalizeSerial(b.serial);
  if (!SERIAL_RE.test(serial)) fail(400, 'Seri numarası 8 haneli olmalı.');

  const device = await loadDevice(serial);
  if (device) {
    if (!inScope(req.user, device)) fail(404, 'Cihaz bulunamadi.');
    if (device.state === 'disabled') fail(409, 'Cihaz devre disi.');
  }
  const gatewayId = b.gatewayId || (device && device.gateway_id);
  if (!gatewayId) {
    fail(400, device ? 'Cihaz bir gateway\'e atanmamis. Cihazlar sayfasindan gateway secin.' : 'Gateway secilmedi.');
  }
  const gw = await loadGateway(gatewayId);
  if (!gw || !inScope(req.user, gw)) fail(404, 'Gateway bulunamadi.');
  if (device && gw.dealer_id !== device.dealer_id) fail(400, 'Gateway ile cihaz ayni bayiye ait degil.');

  const fields = {
    templateID: parseInt(b.templateID, 10) || 1,
    discountEnabled: truthy(b.discountEnabled) ? 1 : 0,
    campaignEnabled: truthy(b.campaignEnabled) ? 1 : 0,
  };
  for (const f of TEXT_FIELDS) fields[f] = String(b[f] == null ? '' : b[f]).slice(0, 100);

  const result = await hub.sendLabel(gw, serial, fields);

  let before = null;
  if (device) {
    before = device.last_content;
    await db.query(
      `UPDATE devices SET last_update_at = now(), last_update_ok = $2, last_update_message = $3,
                          last_content = CASE WHEN $2 THEN $4::jsonb ELSE last_content END
        WHERE id = $1`,
      [serial, result.ok, result.message, JSON.stringify(fields)],
    );
  }
  await audit.log(req.user, 'label.send', {
    entityType: 'device', entityId: serial,
    dealerId: device ? device.dealer_id : gw.dealer_id,
    branchId: device ? device.branch_id : gw.branch_id,
    success: result.ok, message: result.message,
    details: { serial, gatewayId: gw.id, gatewayName: gw.name, deviceName: device ? device.name : null, fields, before },
  });
  res.status(result.status).type('text').send(result.message);
});

module.exports = { api };
