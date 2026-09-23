// ESP32 gateway baglanti merkezi.
//
// Gateway'ler NAT/modem arkasinda oldugu icin sunucu onlara ulasamaz; bunun
// yerine her gateway WiFi'ye baglaninca wss://<sunucu>/ws/gateway adresine
// kendisi baglanir ve baglantiyi acik tutar. Sunucu etiket verisini bu
// kanaldan gonderir, gateway nRF24 ile ekrana iletip sonucu geri bildirir.
//
// Mesajlar (JSON, tek satir):
//   gw  -> srv  {type:"hello", id, secret, fw, nrf}
//   srv -> gw   {type:"hello_ack", status, name}
//   srv -> gw   {type:"status", status, name}          (durum/isim degisince)
//   gw  -> srv  {type:"telemetry", uptime, rssi, ssid, heap, nrf, error}
//   srv -> gw   {type:"send", reqId, serial:"12345678", fields:{...}}
//               serial: hedef e-paper cihazin 8 haneli seri numarasi; nRF24
//               adresine (BCD) cevirme gateway ve alici tarafinda yapilir.
//   gw  -> srv  {type:"result", reqId, ok, message}
//   srv -> gw   {type:"command", command:"restart"|"wifi_reset"}
//   srv -> gw   {type:"error", error}                   (ardindan baglanti kapanir)
//
// Kimlik: id = gateway'in MAC adresi (12 hex), secret = gateway'in ilk
// acilista urettigi ve flash'ta sakladigi rastgele anahtar. Sunucu sadece
// secret'in SHA-256 ozetini saklar; ilk goruldugu anda kaydedilir (TOFU),
// sonraki baglantilarda eslesmeyen secret reddedilir.
//
// Not: acik baglantilar bu surecin belleginde tutulur (tek sunucu ornegi).
// Birden fazla sunucu ornegine gecildiginde (yatay olcekleme) baglanti
// yonlendirmesi Redis gibi ortak bir kanala tasinmali.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const audit = require('./audit');

const WS_PATH = '/ws/gateway';
const HELLO_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 20000;
const PING_INTERVAL_MS = 25000;

const connections = new Map(); // id -> Connection

// ---- Gateway durumu (panelde gosterilen) ----
// Kalici yasam dongusu (state) + calisma anindaki baglanti/telemetri.
const STATUS_LABELS = {
  pending: 'Beklemede',
  registered: 'Kayıtlı',
  awaiting: 'Bağlantı Bekleniyor',
  active: 'Aktif',
  offline: 'Offline',
  error: 'Hata',
  disabled: 'Devre Dışı',
};

function displayStatus(gw, online) {
  if (gw.state !== 'active') return gw.state;
  if (!online) return 'offline';
  if (gw.nrf_ok === false || gw.last_error) return 'error';
  return 'active';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function secretMatches(storedHash, secret) {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(sha256(secret), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress;
}

class Connection {
  constructor(ws, gatewayId, info) {
    this.ws = ws;
    this.id = gatewayId;
    this.info = info; // { ip, connectedAt }
    this.queue = [];  // sirada bekleyen gonderimler
    this.current = null; // { reqId, resolve, timer }
    this.nextReqId = 1;
  }

  sendJson(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  // Gateway ayni anda tek etiket gonderebildigi icin (nRF tek radyo) istekler
  // sirayla, bir oncekinin sonucu gelince gonderilir.
  enqueueSend(serial, fields) {
    return new Promise((resolve) => {
      this.queue.push({ serial, fields, resolve });
      this.pump();
    });
  }

  pump() {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift();
    const reqId = String(this.nextReqId++);
    const timer = setTimeout(() => {
      this.finish(reqId, { ok: false, message: 'HATA: Gateway zamaninda cevap vermedi.' });
    }, SEND_TIMEOUT_MS);
    this.current = { reqId, resolve: job.resolve, timer };
    try {
      this.sendJson({ type: 'send', reqId, serial: job.serial, fields: job.fields });
    } catch (err) {
      this.finish(reqId, { ok: false, message: 'HATA: Gateway\'e gonderilemedi: ' + err.message });
    }
  }

  finish(reqId, result) {
    if (!this.current || this.current.reqId !== reqId) return;
    clearTimeout(this.current.timer);
    const { resolve } = this.current;
    this.current = null;
    resolve(result);
    this.pump();
  }

  failAll(message) {
    if (this.current) this.finish(this.current.reqId, { ok: false, message });
    for (const job of this.queue.splice(0)) job.resolve({ ok: false, message });
  }
}

async function handleHello(ws, req, msg) {
  const id = String(msg.id || '').toUpperCase();
  const secret = String(msg.secret || '');
  if (!/^[0-9A-F]{12}$/.test(id) || !/^[0-9a-f]{32,64}$/.test(secret)) {
    ws.send(JSON.stringify({ type: 'error', error: 'bad_hello' }));
    ws.close(4000, 'bad hello');
    return null;
  }
  const ip = clientIp(req);

  let gw = await db.one('SELECT * FROM gateways WHERE id = $1', [id]);
  if (!gw) {
    gw = await db.one(
      `INSERT INTO gateways (id, name, state, secret_hash, first_seen_at)
       VALUES ($1, $2, 'pending', $3, now()) RETURNING *`,
      [id, 'Gateway ' + id.slice(-6), sha256(secret)],
    );
    console.log(`[gw ${id}] yeni gateway, kayit bekliyor`);
    await audit.log(null, 'gateway.first_seen', { entityType: 'gateway', entityId: id, dealerId: null, branchId: null, message: ip });
  } else if (!gw.secret_hash) {
    // Merkez elle kaydetti veya anahtari sifirladi: ilk gelen anahtari kabul et.
    await db.query('UPDATE gateways SET secret_hash = $2 WHERE id = $1', [id, sha256(secret)]);
    console.log(`[gw ${id}] anahtar kaydedildi`);
  } else if (!secretMatches(gw.secret_hash, secret)) {
    console.log(`[gw ${id}] REDDEDILDI: anahtar eslesmiyor (${ip})`);
    ws.send(JSON.stringify({ type: 'error', error: 'bad_secret' }));
    ws.close(4001, 'bad secret');
    return null;
  }

  if (ws.readyState !== ws.OPEN) return null; // hello islenirken baglanti koptu

  const old = connections.get(id);
  if (old) {
    old.failAll('HATA: Gateway yeniden baglandi.');
    old.ws.close(4002, 'replaced');
  }

  // Bayiye atanmis ve dogrulanmis baglanti kuran gateway aktif olur.
  const activating = gw.state === 'awaiting';
  gw = await db.one(
    `UPDATE gateways
        SET state = CASE WHEN state = 'awaiting' THEN 'active' ELSE state END,
            activated_at = CASE WHEN state = 'awaiting' THEN now() ELSE activated_at END,
            first_seen_at = COALESCE(first_seen_at, now()),
            connected_at = now(), last_seen_at = now(), last_message_at = now(),
            last_ip = $2, fw_version = $3, nrf_ok = $4
      WHERE id = $1 RETURNING *`,
    [id, ip, String(msg.fw || '').slice(0, 32), !!msg.nrf],
  );
  if (activating) {
    await audit.log(null, 'gateway.activated', { entityType: 'gateway', entityId: id, dealerId: gw.dealer_id, branchId: gw.branch_id });
  }

  const conn = new Connection(ws, id, { ip, connectedAt: gw.connected_at });
  connections.set(id, conn);
  conn.sendJson({ type: 'hello_ack', status: gw.state, name: gw.name });
  console.log(`[gw ${id}] baglandi (${ip}, fw ${gw.fw_version}, nrf ${gw.nrf_ok ? 'hazir' : 'YOK'}, ${gw.state})`);
  return conn;
}

async function handleTelemetry(conn, msg) {
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  await db.query(
    `UPDATE gateways
        SET uptime_s = $2, wifi_rssi = $3, wifi_ssid = $4, free_heap = $5, nrf_ok = $6,
            last_error = $7, last_seen_at = now(), last_message_at = now()
      WHERE id = $1`,
    [
      conn.id, num(msg.uptime), num(msg.rssi), msg.ssid ? String(msg.ssid).slice(0, 64) : null,
      num(msg.heap), !!msg.nrf, msg.error ? String(msg.error).slice(0, 200) : null,
    ],
  );
}

function attach(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let conn = null;
    let helloStarted = false;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const helloTimer = setTimeout(() => {
      if (!conn) ws.close(4003, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!conn) {
        if (msg.type === 'hello' && !helloStarted) {
          helloStarted = true;
          clearTimeout(helloTimer);
          handleHello(ws, req, msg)
            .then((c) => { conn = c; })
            .catch((err) => {
              console.error('hello islenemedi:', err.message);
              ws.close(1011, 'server error');
            });
        }
        return;
      }
      if (msg.type === 'result') {
        db.query('UPDATE gateways SET last_message_at = now(), last_seen_at = now() WHERE id = $1', [conn.id]).catch(() => {});
        conn.finish(String(msg.reqId), {
          ok: !!msg.ok,
          message: String(msg.message || (msg.ok ? 'OK' : 'HATA')),
        });
      } else if (msg.type === 'telemetry') {
        handleTelemetry(conn, msg).catch((err) => console.error('telemetri yazilamadi:', err.message));
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      conn.failAll('HATA: Gateway baglantisi koptu.');
      if (connections.get(conn.id) === conn) {
        connections.delete(conn.id);
        db.query('UPDATE gateways SET last_seen_at = now() WHERE id = $1', [conn.id]).catch(() => {});
        console.log(`[gw ${conn.id}] baglanti kapandi`);
      }
    });

    ws.on('error', () => {});
  });

  // Olu baglantilari (elektrigi kesilen, WiFi'si kopan gateway'ler) temizle.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
}

// ---- HTTP rotalarinin kullandigi islemler ----

function isOnline(id) { return connections.has(id); }

// Etiketi gateway'e iletir. Kapsam/yetki kontrolu cagiran tarafta yapilir;
// burada sadece gateway'in gonderime uygun durumda olup olmadigina bakilir.
async function sendLabel(gw, serial, fields) {
  if (gw.state === 'disabled') return { ok: false, status: 409, message: 'HATA: Gateway devre disi.' };
  if (gw.state !== 'active') return { ok: false, status: 409, message: 'HATA: Gateway henuz aktif degil.' };
  const conn = connections.get(gw.id);
  if (!conn) return { ok: false, status: 503, message: 'HATA: Gateway cevrimdisi (sunucuya bagli degil).' };
  const result = await conn.enqueueSend(serial, fields);
  return { ...result, status: result.ok ? 200 : 502 };
}

async function notifyStatus(id) {
  const conn = connections.get(id);
  if (!conn) return;
  const gw = await db.one('SELECT state, name FROM gateways WHERE id = $1', [id]);
  if (gw) conn.sendJson({ type: 'status', status: gw.state, name: gw.name });
}

function sendCommand(id, command) {
  const conn = connections.get(id);
  if (!conn) return false;
  conn.sendJson({ type: 'command', command });
  return true;
}

function disconnect(id) {
  const conn = connections.get(id);
  if (!conn) return;
  conn.failAll('HATA: Gateway baglantisi sunucu tarafindan kapatildi.');
  conn.ws.close(4004, 'removed');
}

module.exports = {
  STATUS_LABELS, displayStatus,
  attach, isOnline, sendLabel, notifyStatus, sendCommand, disconnect,
};
