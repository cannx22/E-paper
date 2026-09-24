// Kalici guncelleme kuyrugu ve dagitici.
//
// - Isler update_jobs tablosunda durur; sunucu yeniden baslasa da kaybolmaz.
// - Dagitici her cevrimici gateway icin ayni anda tek is gonderir (nRF tek
//   radyo). Siradaki is: en yuksek oncelik, sonra en eski.
// - Gateway cevrimdisiyken is bekler; gateway baglaninca hemen devam eder.
// - Basarisiz is artan aralikla yeniden denenir; denemeler bitince cihaza
//   ulasilamadiysa "unreachable", diger durumlarda "failed" olur.
// - Ayni cihaza yeni is gelince henuz gonderilmemis eski is iptal edilir.
// - Kayitli cihazin gateway'i degisirse bekleyen isler yeni gateway'e gecer.
//
// Tek sunucu orneginde calisir; is secimi FOR UPDATE SKIP LOCKED ile yapildigi
// icin birden fazla ornege gecildiginde de ayni is iki kez gonderilmez.
const db = require('./db');
const hub = require('./gateways');
const audit = require('./audit');
const settings = require('./settings');

// Yeniden deneme bekleme sureleri (sn). QUEUE_RETRY_DELAYS="1,2" ile (test icin) degistirilebilir.
const RETRY_DELAYS_S = (process.env.QUEUE_RETRY_DELAYS || '30,120,600,1800').split(',').map(Number).filter((n) => n > 0);
const INTER_JOB_DELAY_MS = 150;
const TICK_MS = 2000;
const ACTIVE = ['queued', 'sending', 'received'];
const FINAL = ['success', 'unreachable', 'failed', 'cancelled', 'expired'];

const STATUS_LABELS = {
  queued: 'Bekliyor', sending: 'Gönderiliyor', received: 'Gateway aldı', success: 'Başarılı',
  unreachable: 'Cihaz ulaşılamıyor', failed: 'Hata', cancelled: 'İptal', expired: 'Süresi doldu',
};

const busy = new Set();       // su an is gonderen gateway'ler
const waiters = new Map();    // jobId -> [fn(update)]
let timer = null;
let stopping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isUnreachable(message) {
  return /MAX_RT|karsilik yok|karşılık yok|ulasilamiyor|ulaşılamıyor/i.test(message || '');
}

function notify(jobId, update) {
  const list = waiters.get(jobId);
  if (!list) return;
  waiters.delete(jobId);
  for (const fn of list) fn(update);
}

// Tekli gonderimde ilk denemenin sonucunu bekler (veya zaman asimi).
function waitForAttempt(jobId, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const list = waiters.get(jobId) || [];
      waiters.set(jobId, list.filter((f) => f !== done));
      resolve({ status: 'queued', timeout: true });
    }, timeoutMs);
    const done = (u) => { clearTimeout(t); resolve(u); };
    const list = waiters.get(jobId) || [];
    list.push(done);
    waiters.set(jobId, list);
  });
}

// ---- Kuyruga ekleme ----
// items: [{ serial, dealerId, branchId, gatewayId, fixedGateway, fields }]
// opts: { batchId, priority, user }
async function enqueue(client, items, opts = {}) {
  if (!items.length) return [];
  const s = await settings.all();
  const maxAttempts = Math.max(1, Math.min(10, Number(s.queue_max_attempts) || 3));
  const ttlHours = Math.max(1, Number(s.queue_ttl_hours) || 72);
  const serials = items.map((i) => i.serial);
  // Ayni cihaza giden, henuz gonderilmemis eski isler gecersiz.
  const sup = await client.query(
    `UPDATE update_jobs SET status = 'cancelled', finished_at = now(), updated_at = now(),
                            last_message = 'Daha yeni bir güncelleme ile değiştirildi'
      WHERE serial = ANY($1) AND status = 'queued' RETURNING batch_id`,
    [serials],
  );
  const r = await client.query(
    `INSERT INTO update_jobs (batch_id, dealer_id, branch_id, serial, gateway_id, fixed_gateway, fields,
                              priority, max_attempts, expires_at, created_by, username)
     SELECT $1, t.d, t.b, t.s, t.g, t.f, t.j::jsonb, $2, $3, now() + ($4 || ' hours')::interval, $5, $6
       FROM unnest($7::text[], $8::bigint[], $9::bigint[], $10::text[], $11::boolean[], $12::text[]) AS t(s, d, b, g, f, j)
     RETURNING id, serial`,
    [
      opts.batchId || null, opts.priority || 0, maxAttempts, String(ttlHours),
      opts.user ? opts.user.id : null, opts.user ? opts.user.username : null,
      serials, items.map((i) => i.dealerId || null), items.map((i) => i.branchId || null),
      items.map((i) => i.gatewayId || null), items.map((i) => !!i.fixedGateway), items.map((i) => JSON.stringify(i.fields)),
    ],
  );
  const batchIds = [...new Set(sup.rows.map((x) => x.batch_id).filter(Boolean))];
  if (batchIds.length) setImmediate(() => closeBatches(batchIds).catch(() => {}));
  return r.rows;
}

// ---- Bakim: suresi dolan, devre disi cihaz, gateway degisimi ----
async function maintenance() {
  await db.query(
    `UPDATE update_jobs j SET gateway_id = d.gateway_id, branch_id = COALESCE(d.branch_id, j.branch_id), updated_at = now()
       FROM devices d
      WHERE j.status = 'queued' AND NOT j.fixed_gateway AND d.id = j.serial AND j.gateway_id IS DISTINCT FROM d.gateway_id`,
  );
  const ended = await db.query(
    `UPDATE update_jobs j SET status = CASE WHEN j.expires_at < now() THEN 'expired' ELSE 'cancelled' END,
                              last_message = CASE WHEN j.expires_at < now() THEN 'Süresi doldu (gönderilemedi)' ELSE 'Cihaz devre dışı' END,
                              finished_at = now(), updated_at = now()
      WHERE j.status = 'queued'
        AND (j.expires_at < now() OR EXISTS (SELECT 1 FROM devices d WHERE d.id = j.serial AND d.state = 'disabled'))
      RETURNING id, batch_id, status`,
  );
  for (const row of ended.rows) notify(row.id, { status: row.status, final: true });
  const batchIds = [...new Set(ended.rows.map((x) => x.batch_id).filter(Boolean))];
  if (batchIds.length) await closeBatches(batchIds);
}

async function closeBatches(batchIds) {
  await db.query(
    `UPDATE update_batches b SET finished_at = now()
      WHERE b.id = ANY($1) AND b.finished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM update_jobs j WHERE j.batch_id = b.id AND j.status IN ('queued', 'sending', 'received'))`,
    [batchIds],
  );
}

// ---- Dagitim ----
async function claimNext(gatewayId) {
  return db.one(
    `UPDATE update_jobs SET status = 'sending', attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = (
        SELECT j.id FROM update_jobs j
          JOIN gateways g ON g.id = j.gateway_id
          LEFT JOIN dealers dl ON dl.id = j.dealer_id
         WHERE j.status = 'queued' AND j.gateway_id = $1 AND j.next_attempt_at <= now()
           AND g.state = 'active' AND dl.active IS NOT FALSE
         ORDER BY j.priority DESC, j.id
         LIMIT 1
         FOR UPDATE OF j SKIP LOCKED)
      RETURNING *`,
    [gatewayId],
  );
}

async function finishJob(job, status, message, gatewayId) {
  const row = await db.one(
    `UPDATE update_jobs SET status = $2, last_message = $3, finished_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [job.id, status, message],
  );
  const ok = status === 'success';
  const device = await db.one('SELECT name, last_content AS before FROM devices WHERE id = $1', [job.serial]);
  if (device) {
    await db.query(
      `UPDATE devices SET last_update_at = now(), last_update_ok = $2, last_update_message = $3,
                          last_ok_at = CASE WHEN $2 THEN now() ELSE last_ok_at END,
                          last_content = CASE WHEN $2 THEN $4::jsonb ELSE last_content END
        WHERE id = $1`,
      [job.serial, ok, message, JSON.stringify(job.fields)],
    );
  }
  const gw = await db.one('SELECT name FROM gateways WHERE id = $1', [gatewayId]);
  await audit.log(job.created_by ? { id: job.created_by, username: job.username } : null, 'label.send', {
    username: job.username || 'sistem',
    entityType: 'device', entityId: job.serial, dealerId: job.dealer_id, branchId: job.branch_id,
    success: ok, message,
    details: {
      serial: job.serial, gatewayId, gatewayName: gw ? gw.name : null, deviceName: device ? device.name : null,
      fields: job.fields, before: device ? device.before : null, jobId: job.id, batchId: job.batch_id, attempts: job.attempts,
    },
  });
  if (job.batch_id) await closeBatches([job.batch_id]);
  notify(job.id, { status, message, final: true, job: row });
}

async function processJob(job, gatewayId) {
  const result = await hub.dispatch(gatewayId, job.serial, job.fields, () => {
    db.query(`UPDATE update_jobs SET status = 'received', updated_at = now() WHERE id = $1 AND status = 'sending'`, [job.id]).catch(() => {});
  });
  if (result.ok) {
    await finishJob(job, 'success', result.message, gatewayId);
    return;
  }
  if (result.offline || result.disconnected) {
    // Gateway'in hatasi degil baglanti: deneme sayilmadan siraya geri don.
    await db.query(
      `UPDATE update_jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0), last_message = $2, updated_at = now() WHERE id = $1`,
      [job.id, 'Gateway bağlantısı koptu, tekrar sıraya alındı'],
    );
    notify(job.id, { status: 'queued', message: 'Gateway bağlantısı koptu; bağlanınca gönderilecek.', willRetry: true });
    return;
  }
  if (job.attempts >= job.max_attempts) {
    await finishJob(job, isUnreachable(result.message) ? 'unreachable' : 'failed', result.message, gatewayId);
    return;
  }
  const delay = RETRY_DELAYS_S[Math.min(job.attempts - 1, RETRY_DELAYS_S.length - 1)];
  await db.query(
    `UPDATE update_jobs SET status = 'queued', last_message = $2, next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
    [job.id, result.message, String(delay)],
  );
  notify(job.id, { status: 'queued', message: result.message, willRetry: true, retryIn: delay, attempt: job.attempts, maxAttempts: job.max_attempts });
}

async function runGateway(gatewayId) {
  if (busy.has(gatewayId) || stopping) return;
  busy.add(gatewayId);
  try {
    while (!stopping && hub.isOnline(gatewayId)) {
      const job = await claimNext(gatewayId);
      if (!job) break;
      try {
        await processJob(job, gatewayId);
      } catch (err) {
        console.error(`[kuyruk] is ${job.id} islenemedi:`, err.message);
        await db.query(`UPDATE update_jobs SET status = 'queued', next_attempt_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1 AND status IN ('sending', 'received')`, [job.id]).catch(() => {});
      }
      await sleep(INTER_JOB_DELAY_MS);
    }
  } finally {
    busy.delete(gatewayId);
  }
}

let ticking = false;
async function tick() {
  if (ticking || stopping) return;
  ticking = true;
  try {
    await maintenance();
    for (const id of hub.onlineIds()) runGateway(id).catch((err) => console.error('[kuyruk]', err.message));
  } catch (err) {
    console.error('[kuyruk] tick hatasi:', err.message);
  } finally {
    ticking = false;
  }
}

function kick() { setImmediate(() => tick()); }

async function start() {
  // Onceki calismada yarim kalan isler (sunucu kapanirken gonderilmekte olan)
  // deneme sayilmadan siraya geri alinir.
  const r = await db.query(
    `UPDATE update_jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0), updated_at = now()
      WHERE status IN ('sending', 'received')`,
  );
  if (r.rowCount) console.log(`[kuyruk] yarim kalan ${r.rowCount} is tekrar siraya alindi`);
  hub.events.on('online', (id) => setTimeout(() => runGateway(id).catch(() => {}), 500));
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  kick();
}

function stop() {
  stopping = true;
  if (timer) clearInterval(timer);
}

module.exports = { STATUS_LABELS, ACTIVE, FINAL, enqueue, kick, waitForAttempt, start, stop, closeBatches };
