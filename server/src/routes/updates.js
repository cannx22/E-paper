// Guncelleme kuyrugu gorunumleri ve islemleri: toplu isler (batch), tekil
// isler (job), iptal ve yeniden deneme.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const queue = require('../queue');
const settings = require('../settings');
const hub = require('../gateways');
const { scopeSql } = require('../permissions');
const { fail, parseId, optionalId } = require('./util');

const api = express.Router();
const requireView = auth.requireApi('audit.view');
const requireManage = auth.requireApi('label.send');

const COUNTS = `
  count(*)::int AS total,
  count(*) FILTER (WHERE j.status = 'queued')::int AS queued,
  count(*) FILTER (WHERE j.status IN ('sending', 'received'))::int AS sending,
  count(*) FILTER (WHERE j.status = 'success')::int AS success,
  count(*) FILTER (WHERE j.status = 'unreachable')::int AS unreachable,
  count(*) FILTER (WHERE j.status = 'failed')::int AS failed,
  count(*) FILTER (WHERE j.status IN ('cancelled', 'expired'))::int AS cancelled`;

function jobView(j) {
  return {
    id: j.id, batchId: j.batch_id, serial: j.serial, deviceName: j.device_name || null,
    gatewayId: j.gateway_id, gatewayName: j.gateway_name || null, dealerName: j.dealer_name || null, branchName: j.branch_name || null,
    status: j.status, statusLabel: queue.STATUS_LABELS[j.status], attempts: j.attempts, maxAttempts: j.max_attempts,
    priority: j.priority, nextAttemptAt: j.status === 'queued' ? j.next_attempt_at : null, message: j.last_message,
    fields: j.fields, username: j.username, createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at,
    gatewayOnline: j.gateway_online,
  };
}

const JOB_SELECT = `
  SELECT j.*, dv.name AS device_name, g.name AS gateway_name, d.name AS dealer_name, b.name AS branch_name
    FROM update_jobs j
    LEFT JOIN devices dv ON dv.id = j.serial
    LEFT JOIN gateways g ON g.id = j.gateway_id
    LEFT JOIN dealers d ON d.id = j.dealer_id
    LEFT JOIN branches b ON b.id = j.branch_id`;

function withOnline(rows) {
  return rows.map((r) => ({ ...r, gateway_online: r.gateway_id ? hub.isOnline(r.gateway_id) : false }));
}

// ---- Ozet ----
api.get('/updates/summary', requireView, async (req, res) => {
  const params = [];
  const scope = scopeSql(req.user, 'j', params);
  const active = await db.one(`SELECT ${COUNTS} FROM update_jobs j WHERE ${scope} AND j.status IN ('queued', 'sending', 'received')`, params);
  const day = await db.one(`SELECT ${COUNTS} FROM update_jobs j WHERE ${scope} AND j.created_at > now() - interval '24 hours'`, params);
  const waitingOffline = await db.one(
    `SELECT count(*)::int AS n FROM update_jobs j WHERE ${scope} AND j.status = 'queued' AND (j.gateway_id IS NULL OR j.gateway_id <> ALL($${params.length + 1}::text[]))`,
    [...params, hub.onlineIds()],
  );
  res.json({ active, last24h: day, waitingOffline: waitingOffline.n });
});

// ---- Toplu isler ----
api.get('/updates/batches', requireView, async (req, res) => {
  const params = [];
  const conds = [scopeSql(req.user, 'bt', params)];
  const before = optionalId(req.query.before, 'before');
  if (before) { params.push(before); conds.push(`bt.id < $${params.length}`); }
  if (req.query.active === '1') conds.push('bt.finished_at IS NULL');
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = await db.many(
    `SELECT bt.*, d.name AS dealer_name, br.name AS branch_name, c.*
       FROM update_batches bt
       LEFT JOIN dealers d ON d.id = bt.dealer_id
       LEFT JOIN branches br ON br.id = bt.branch_id
       CROSS JOIN LATERAL (SELECT ${COUNTS} FROM update_jobs j WHERE j.batch_id = bt.id) c
      WHERE ${conds.join(' AND ')}
      ORDER BY bt.id DESC LIMIT ${limit}`,
    params,
  );
  res.json(rows);
});

async function loadBatch(req) {
  const id = parseId(req.params.id);
  const params = [id];
  const batch = id && await db.one(
    `SELECT bt.*, d.name AS dealer_name, br.name AS branch_name FROM update_batches bt
       LEFT JOIN dealers d ON d.id = bt.dealer_id LEFT JOIN branches br ON br.id = bt.branch_id
      WHERE bt.id = $1 AND ${scopeSql(req.user, 'bt', params)}`,
    params,
  );
  if (!batch) fail(404, 'Toplu iş bulunamadı.');
  return batch;
}

api.get('/updates/batches/:id', requireView, async (req, res) => {
  const batch = await loadBatch(req);
  const counts = await db.one(`SELECT ${COUNTS} FROM update_jobs j WHERE j.batch_id = $1`, [batch.id]);
  const params = [batch.id];
  let cond = '';
  if (req.query.status) {
    const map = { active: "('queued','sending','received')", failed: "('failed','unreachable')", done: "('success')", cancelled: "('cancelled','expired')" };
    if (map[req.query.status]) cond = ` AND j.status IN ${map[req.query.status]}`;
  }
  const jobs = await db.many(`${JOB_SELECT} WHERE j.batch_id = $1${cond} ORDER BY j.id LIMIT 5000`, params);
  res.json({ ...batch, counts, jobs: withOnline(jobs).map(jobView) });
});

api.post('/updates/batches/:id/cancel', requireManage, async (req, res) => {
  const batch = await loadBatch(req);
  const r = await db.query(
    `UPDATE update_jobs SET status = 'cancelled', last_message = 'Toplu iş iptal edildi', finished_at = now(), updated_at = now()
      WHERE batch_id = $1 AND status = 'queued'`,
    [batch.id],
  );
  await queue.closeBatches([batch.id]);
  await audit.log(req.user, 'update.batch_cancelled', { entityType: 'batch', entityId: batch.id, dealerId: batch.dealer_id, branchId: batch.branch_id, message: `${r.rowCount} iş iptal edildi` });
  res.json({ ok: true, cancelled: r.rowCount });
});

// Basarisiz / ulasilamayan / suresi dolan isleri yeniden kuyruga al.
async function requeue(jobIds, user) {
  const s = await settings.all();
  const ttl = String(Math.max(1, Number(s.queue_ttl_hours) || 72));
  const r = await db.query(
    `UPDATE update_jobs j SET status = 'queued', attempts = 0, next_attempt_at = now(), finished_at = NULL,
                              expires_at = now() + ($2 || ' hours')::interval, last_message = 'Tekrar kuyruğa alındı', updated_at = now()
      WHERE j.id = ANY($1) AND j.status IN ('failed', 'unreachable', 'expired', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM update_jobs n WHERE n.serial = j.serial AND n.id > j.id AND n.status NOT IN ('cancelled', 'expired'))
        AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = j.serial AND d.state = 'disabled')
      RETURNING j.batch_id`,
    [jobIds, ttl],
  );
  const batchIds = [...new Set(r.rows.map((x) => x.batch_id).filter(Boolean))];
  if (batchIds.length) await db.query('UPDATE update_batches SET finished_at = NULL WHERE id = ANY($1)', [batchIds]);
  queue.kick();
  return r.rowCount;
}

api.post('/updates/batches/:id/retry', requireManage, async (req, res) => {
  const batch = await loadBatch(req);
  const ids = (await db.many(`SELECT id FROM update_jobs WHERE batch_id = $1 AND status IN ('failed', 'unreachable', 'expired')`, [batch.id])).map((r) => r.id);
  const n = ids.length ? await requeue(ids, req.user) : 0;
  await audit.log(req.user, 'update.batch_retried', { entityType: 'batch', entityId: batch.id, dealerId: batch.dealer_id, branchId: batch.branch_id, message: `${n} iş tekrar kuyruğa alındı` });
  res.json({ ok: true, requeued: n });
});

// ---- Tekil isler ----
// ?status=active|failed|done|cancelled ?serial= ?gatewayId= ?batchId= ?before=
api.get('/updates/jobs', requireView, async (req, res) => {
  const params = [];
  const conds = [scopeSql(req.user, 'j', params)];
  const map = { active: "('queued','sending','received')", failed: "('failed','unreachable')", done: "('success')", cancelled: "('cancelled','expired')" };
  if (map[req.query.status]) conds.push(`j.status IN ${map[req.query.status]}`);
  if (req.query.serial) { params.push(String(req.query.serial).replace(/\D/g, '')); conds.push(`j.serial = $${params.length}`); }
  if (req.query.gatewayId) { params.push(String(req.query.gatewayId).toUpperCase()); conds.push(`j.gateway_id = $${params.length}`); }
  const batchId = optionalId(req.query.batchId, 'Toplu iş');
  if (batchId) { params.push(batchId); conds.push(`j.batch_id = $${params.length}`); }
  if (req.query.single === '1') conds.push('j.batch_id IS NULL');
  const before = optionalId(req.query.before, 'before');
  if (before) { params.push(before); conds.push(`j.id < $${params.length}`); }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const rows = await db.many(`${JOB_SELECT} WHERE ${conds.join(' AND ')} ORDER BY j.id DESC LIMIT ${limit}`, params);
  res.json(withOnline(rows).map(jobView));
});

async function loadJob(req) {
  const id = parseId(req.params.id);
  const params = [id];
  const job = id && await db.one(`SELECT j.* FROM update_jobs j WHERE j.id = $1 AND ${scopeSql(req.user, 'j', params)}`, params);
  if (!job) fail(404, 'İş bulunamadı.');
  return job;
}

api.post('/updates/jobs/:id/cancel', requireManage, async (req, res) => {
  const job = await loadJob(req);
  if (job.status !== 'queued') fail(400, 'Sadece bekleyen işler iptal edilebilir.');
  await db.query(`UPDATE update_jobs SET status = 'cancelled', last_message = 'Kullanıcı iptal etti', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued'`, [job.id]);
  if (job.batch_id) await queue.closeBatches([job.batch_id]);
  await audit.log(req.user, 'update.job_cancelled', { entityType: 'device', entityId: job.serial, dealerId: job.dealer_id, branchId: job.branch_id, message: `İş #${job.id}` });
  res.json({ ok: true });
});

api.post('/updates/jobs/:id/retry', requireManage, async (req, res) => {
  const job = await loadJob(req);
  if (!['failed', 'unreachable', 'expired', 'cancelled'].includes(job.status)) fail(400, 'Bu iş zaten sırada veya başarılı.');
  const n = await requeue([job.id], req.user);
  if (!n) fail(400, 'Bu iş tekrar gönderilemez: cihaz için daha yeni bir güncelleme var veya cihaz devre dışı.');
  res.json({ ok: true });
});

module.exports = { api };
