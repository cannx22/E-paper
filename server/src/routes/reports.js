// Islem gecmisi (audit log) ve ozet paneli.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const hub = require('../gateways');
const { scopeSql } = require('../permissions');
const { optionalId } = require('./util');

const api = express.Router();

// ?type=labels -> sadece etiket gonderimleri; ?type=failed -> sadece hatalar
// ?before=<id> -> sayfalama (bu id'den eskiler)
api.get('/audit', auth.requireApi('audit.view'), async (req, res) => {
  const params = [];
  const conds = [scopeSql(req.user, 'a', params)];
  if (req.query.type === 'labels') conds.push(`a.action = 'label.send'`);
  else if (req.query.type === 'failed') conds.push('NOT a.success');
  else if (req.query.type === 'admin') conds.push(`a.action <> 'label.send'`);
  const before = optionalId(req.query.before, 'before');
  if (before) {
    params.push(before);
    conds.push(`a.id < $${params.length}`);
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  params.push(limit);
  const rows = await db.many(
    `SELECT a.id, a.created_at, a.username, a.action, a.entity_type, a.entity_id, a.success, a.message, a.details,
            d.name AS dealer_name, b.name AS branch_name,
            CASE WHEN a.entity_type = 'gateway' THEN g.name END AS gateway_name
       FROM audit_log a
       LEFT JOIN dealers d ON d.id = a.dealer_id
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN gateways g ON a.entity_type = 'gateway' AND g.id = a.entity_id
      WHERE ${conds.join(' AND ')}
      ORDER BY a.id DESC
      LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
});

api.get('/dashboard', auth.requireApi(), async (req, res) => {
  const user = req.user;
  const gwParams = [];
  const gateways = await db.many(
    `SELECT g.id, g.name, g.state, g.nrf_ok, g.last_error, g.last_seen_at, d.name AS dealer_name, b.name AS branch_name
       FROM gateways g
       LEFT JOIN dealers d ON d.id = g.dealer_id
       LEFT JOIN branches b ON b.id = g.branch_id
      WHERE ${scopeSql(user, 'g', gwParams)}`,
    gwParams,
  );
  const byStatus = { pending: 0, registered: 0, awaiting: 0, active: 0, offline: 0, error: 0, disabled: 0 };
  const problems = [];
  for (const g of gateways) {
    const status = hub.displayStatus(g, hub.isOnline(g.id));
    byStatus[status]++;
    if (status === 'offline' || status === 'error') {
      problems.push({ id: g.id, name: g.name, status, statusLabel: hub.STATUS_LABELS[status], dealerName: g.dealer_name, branchName: g.branch_name, lastSeen: g.last_seen_at, lastError: g.last_error });
    }
  }
  problems.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));

  const counts = {};
  if (user.role === 'super_admin') {
    counts.dealers = (await db.one('SELECT count(*)::int AS n FROM dealers')).n;
  }
  // Subelerin kendisi icin kapsam: sube kullanicisi sadece kendi subesini sayar.
  let branchScope = 'TRUE';
  const bParams = [];
  if (user.role !== 'super_admin') {
    bParams.push(user.dealer_id);
    branchScope = 'dealer_id = $1';
    if (user.branch_id) {
      bParams.push(user.branch_id);
      branchScope += ' AND id = $2';
    }
  }
  counts.branches = (await db.one(`SELECT count(*)::int AS n FROM branches WHERE ${branchScope}`, bParams)).n;
  const uParams = [];
  counts.users = (await db.one(`SELECT count(*)::int AS n FROM users u WHERE ${scopeSql(user, 'u', uParams)}`, uParams)).n;
  counts.gateways = gateways.length;

  const aParams = [];
  const sends = await db.one(
    `SELECT count(*) FILTER (WHERE success)::int AS ok, count(*) FILTER (WHERE NOT success)::int AS failed
       FROM audit_log a
      WHERE a.action = 'label.send' AND a.created_at > now() - interval '24 hours' AND ${scopeSql(user, 'a', aParams)}`,
    aParams,
  );

  res.json({ counts, gatewaysByStatus: byStatus, statusLabels: hub.STATUS_LABELS, sends24h: sends, problemGateways: problems.slice(0, 20) });
});

module.exports = { api };
