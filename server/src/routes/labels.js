// Etiket gonderimi. Form alanlari firmware'deki LabelFields ile ayni;
// paketleme (399 byte, Turkce kodlama) gateway tarafinda PackLabelPayload()
// ile yapilir.
const express = require('express');
const auth = require('../auth');
const audit = require('../audit');
const hub = require('../gateways');
const { inScope } = require('../permissions');
const { fail } = require('./util');
const { loadGateway } = require('./gateways');

const api = express.Router();

const TEXT_FIELDS = ['business', 'name', 'subtitle', 'price', 'oldPrice', 'unit',
  'bottomCode', 'campaignText', 'barcode', 'ingredients', 'allergens'];

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

api.post('/send', auth.requireApi('label.send'), async (req, res) => {
  const b = req.body || {};
  if (!b.gatewayId) fail(400, 'Gateway secilmedi.');
  const gw = await loadGateway(b.gatewayId);
  if (!gw || !inScope(req.user, gw)) fail(404, 'Gateway bulunamadi.');

  const board = b.board === 'ESB' ? 'ESB' : 'ESA';
  const fields = {
    templateID: parseInt(b.templateID, 10) || 1,
    discountEnabled: truthy(b.discountEnabled) ? 1 : 0,
    campaignEnabled: truthy(b.campaignEnabled) ? 1 : 0,
  };
  for (const f of TEXT_FIELDS) fields[f] = String(b[f] == null ? '' : b[f]).slice(0, 100);

  const result = await hub.sendLabel(gw, board, fields);
  await audit.log(req.user, 'label.send', {
    entityType: 'gateway', entityId: gw.id, dealerId: gw.dealer_id, branchId: gw.branch_id,
    success: result.ok, message: result.message, details: { board, fields },
  });
  res.status(result.status).type('text').send(result.message);
});

module.exports = { api };
