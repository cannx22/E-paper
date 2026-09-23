// Rotalarda ortak yardimcilar. HttpError firlatildiginda index.js'deki hata
// yakalayici durum kodunu ve metni dondurur (Express 5 async hatalari yakalar).
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, 'HATA: ' + message);
}

function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

// Istege bagli id alani: bos/null -> null, gecersiz -> hata.
function optionalId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseId(v);
  if (!n) fail(400, `${label} gecersiz.`);
  return n;
}

function cleanName(v, label, max = 60) {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  if (!s) fail(400, `${label} bos olamaz.`);
  return s;
}

module.exports = { HttpError, fail, parseId, optionalId, cleanName };
