// ESP32 gateway baglanti merkezi.
//
// Gateway'ler NAT/modem arkasinda oldugu icin sunucu onlara ulasamaz; bunun
// yerine her gateway WiFi'ye baglaninca wss://<sunucu>/ws/gateway adresine
// kendisi baglanir ve baglantiyi acik tutar. Sunucu etiket verisini bu
// kanaldan gonderir, gateway nRF24 ile ekrana iletip sonucu geri bildirir.
//
// Mesajlar (JSON, tek satir):
//   gw  -> srv  {type:"hello", id, secret, fw, nrf}
//   srv -> gw   {type:"hello_ack", status:"pending"|"approved", name}
//   srv -> gw   {type:"status", status, name}          (onay/isim degisince)
//   srv -> gw   {type:"send", reqId, board, fields:{...}}
//   gw  -> srv  {type:"result", reqId, ok, message}
//   srv -> gw   {type:"command", command:"restart"|"wifi_reset"}
//   srv -> gw   {type:"error", error}                   (ardindan baglanti kapanir)
//
// Kimlik: id = gateway'in MAC adresi (12 hex), secret = gateway'in ilk
// acilista urettigi ve flash'ta sakladigi rastgele anahtar. Sunucu sadece
// secret'in SHA-256 ozetini saklar; ilk goruldugu anda kaydedilir (TOFU),
// sonraki baglantilarda eslesmeyen secret reddedilir.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');

const WS_PATH = '/ws/gateway';
const HELLO_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 20000;
const PING_INTERVAL_MS = 25000;

const connections = new Map(); // id -> Connection

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
    this.info = info; // { ip, fw, nrf, connectedAt }
    this.queue = [];  // sirada bekleyen gonderimler
    this.current = null; // { reqId, resolve, timer }
    this.nextReqId = 1;
  }

  sendJson(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  // Gateway ayni anda tek etiket gonderebildigi icin (nRF tek radyo) istekler
  // sirayla, bir oncekinin sonucu gelince gonderilir.
  enqueueSend(board, fields) {
    return new Promise((resolve) => {
      this.queue.push({ board, fields, resolve });
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
      this.sendJson({ type: 'send', reqId, board: job.board, fields: job.fields });
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

function handleHello(ws, req, msg) {
  const id = String(msg.id || '').toUpperCase();
  const secret = String(msg.secret || '');
  if (!/^[0-9A-F]{12}$/.test(id) || !/^[0-9a-f]{32,64}$/.test(secret)) {
    ws.send(JSON.stringify({ type: 'error', error: 'bad_hello' }));
    ws.close(4000, 'bad hello');
    return null;
  }

  let gw = db.findGateway(id);
  if (!gw) {
    gw = db.addGateway({
      id,
      name: 'Gateway ' + id.slice(-6),
      status: 'pending',
      secretHash: sha256(secret),
      createdAt: new Date().toISOString(),
    });
    console.log(`[gw ${id}] yeni gateway, onay bekliyor`);
  } else if (!gw.secretHash) {
    // Admin elle ekledi veya anahtari sifirladi: ilk gelen anahtari kabul et.
    gw.secretHash = sha256(secret);
    db.save();
    console.log(`[gw ${id}] anahtar kaydedildi`);
  } else if (!secretMatches(gw.secretHash, secret)) {
    console.log(`[gw ${id}] REDDEDILDI: anahtar eslesmiyor (${clientIp(req)})`);
    ws.send(JSON.stringify({ type: 'error', error: 'bad_secret' }));
    ws.close(4001, 'bad secret');
    return null;
  }

  const old = connections.get(id);
  if (old) {
    old.failAll('HATA: Gateway yeniden baglandi.');
    old.ws.close(4002, 'replaced');
  }

  const info = {
    ip: clientIp(req),
    fw: String(msg.fw || ''),
    nrf: !!msg.nrf,
    connectedAt: new Date().toISOString(),
  };
  const conn = new Connection(ws, id, info);
  connections.set(id, conn);

  gw.lastSeen = info.connectedAt;
  gw.lastIp = info.ip;
  gw.fw = info.fw;
  db.save();

  conn.sendJson({ type: 'hello_ack', status: gw.status, name: gw.name });
  console.log(`[gw ${id}] baglandi (${info.ip}, fw ${info.fw}, nrf ${info.nrf ? 'hazir' : 'YOK'}, ${gw.status})`);
  return conn;
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
        if (msg.type === 'hello') {
          clearTimeout(helloTimer);
          conn = handleHello(ws, req, msg);
        }
        return;
      }
      if (msg.type === 'result') {
        conn.finish(String(msg.reqId), {
          ok: !!msg.ok,
          message: String(msg.message || (msg.ok ? 'OK' : 'HATA')),
        });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      conn.failAll('HATA: Gateway baglantisi koptu.');
      if (connections.get(conn.id) === conn) {
        connections.delete(conn.id);
        const gw = db.findGateway(conn.id);
        if (gw) {
          gw.lastSeen = new Date().toISOString();
          db.save();
        }
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

function connectionInfo(id) {
  const c = connections.get(id);
  return c ? c.info : null;
}

async function sendLabel(id, board, fields) {
  const gw = db.findGateway(id);
  if (!gw) return { ok: false, status: 404, message: 'HATA: Gateway bulunamadi.' };
  if (gw.status !== 'approved') return { ok: false, status: 409, message: 'HATA: Gateway henuz onaylanmadi.' };
  const conn = connections.get(id);
  if (!conn) return { ok: false, status: 503, message: 'HATA: Gateway cevrimdisi (sunucuya bagli degil).' };
  const result = await conn.enqueueSend(board, fields);
  return { ...result, status: result.ok ? 200 : 502 };
}

function notifyStatus(id) {
  const gw = db.findGateway(id);
  const conn = connections.get(id);
  if (gw && conn) conn.sendJson({ type: 'status', status: gw.status, name: gw.name });
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

module.exports = { attach, isOnline, connectionInfo, sendLabel, notifyStatus, sendCommand, disconnect };
