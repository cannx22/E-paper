// Resim modu: cizilmis tasarimi panelin kendi RAM bicimine cevirir,
// sikistirir ve gateway'e gidecek ikili veriyi (blob) uretir. Ters yonde
// (blob -> PNG) onizleme icin de kullanilir; boylece "etikete giden" ile
// "ekranda gorunen" ayni veriden uretilir.
//
// Protokolun tamami (gateway ve STM32 icin): docs/resim-modu.md
//
// Blob = 24 byte baslik + veri (little endian):
//   0  version     (1)
//   1  format      1 = BW 1 bit, 2 = iki duzlem (BW + kirmizi/sari), 3 = BWRY 2 bit
//   2  compression 0 = yok, 1 = RLE
//   3  flags       (0, ileride kullanilacak)
//   4  width       panelin fiziksel genisligi (uint16)
//   6  height      panelin fiziksel yuksekligi (uint16)
//   8  rawLength   acilmis veri uzunlugu (uint32)
//   12 dataLength  blob'daki veri uzunlugu (uint32)
//   16 crc32       acilmis verinin CRC32'si (IEEE, zlib ile ayni)
//   20 reserved    (0)
const FORMAT = { BW: 1, TWO_PLANE: 2, BWRY: 3 };
const FORMAT_NAMES = { 1: 'Siyah-beyaz (1 bit)', 2: 'İki düzlem (siyah + renk)', 3: '4 renk (2 bit)' };
const COMPRESSION = { NONE: 0, RLE: 1 };
const HEADER_LEN = 24;
const VERSION = 1;
// nRF24 paketi en fazla 32 byte: 1 byte tip + 2 byte sira no + 29 byte veri.
const PACKET_DATA_LEN = 29;
// Gateway blob'u bellekte tutar (ESP32); bunun ustu reddedilir.
const MAX_BLOB_LEN = 96 * 1024;

// BWRY (JD79665) 2 bit renk kodlari
const BWRY_CODE = { black: 0, white: 1, yellow: 2, red: 3 };

// ---- CRC32 (IEEE 802.3, zlib.crc32 ile ayni sonuc) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- RLE (PackBits benzeri) ----
// Kontrol byte'i c:
//   0x00-0x7F: ardindan gelen (c + 1) byte oldugu gibi kopyalanir (1-128)
//   0x80-0xFF: ardindan gelen tek byte (c - 126) kez tekrarlanir (2-129)
function rleEncode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 129 && src[i + run] === src[i]) run++;
    if (run >= 3) {
      out.push(0x80 + run - 2, src[i]);
      i += run;
      continue;
    }
    // Duz (literal) blok: bir sonraki 3+ tekrar baslayana kadar
    const start = i;
    while (i < n && i - start < 128) {
      if (i + 2 < n && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
      i++;
    }
    out.push(i - start - 1);
    for (let k = start; k < i; k++) out.push(src[k]);
  }
  return Buffer.from(out);
}

function rleDecode(src, rawLength) {
  const out = Buffer.alloc(rawLength);
  let o = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i++];
    if (c < 0x80) {
      const len = c + 1;
      if (i + len > src.length || o + len > rawLength) throw new Error('RLE: veri tasiyor');
      src.copy(out, o, i, i + len);
      i += len; o += len;
    } else {
      const len = c - 126;
      if (i >= src.length || o + len > rawLength) throw new Error('RLE: veri tasiyor');
      out.fill(src[i++], o, o + len);
      o += len;
    }
  }
  if (o !== rawLength) throw new Error('RLE: uzunluk tutmuyor');
  return out;
}

// ---- Yon ----
// Panelin fiziksel (nx, ny) pikseline karsilik gelen tuval pikseli.
function nativeSize(w, h, rotation) {
  return rotation === 90 || rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}
function sourceIndex(nx, ny, w, h, rotation) {
  let x;
  let y;
  if (rotation === 90) { x = ny; y = h - 1 - nx; }
  else if (rotation === 180) { x = w - 1 - nx; y = h - 1 - ny; }
  else if (rotation === 270) { x = w - 1 - ny; y = nx; }
  else { x = nx; y = ny; }
  return y * w + x;
}

// ---- Renk siniflandirma ----
// Cizim motoru (design-render.js quantize) pikselleri zaten panel paletine
// indirgemistir; burada palet rengini mantiksal renge ceviriyoruz.
function classifier(colors, palettes) {
  const p = palettes[colors];
  if (!p) throw new Error('Bu renk tipi resim modunda desteklenmiyor: ' + colors);
  const entries = Object.keys(p).map((k) => [k, p[k]]);
  return (r, g, b) => {
    let best = 'white';
    let bestD = Infinity;
    for (const [name, c] of entries) {
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  };
}

function formatFor(colors) {
  if (colors === 'bw') return FORMAT.BW;
  if (colors === 'bwr' || colors === 'bwy') return FORMAT.TWO_PLANE;
  if (colors === 'bwry') return FORMAT.BWRY;
  throw new Error('Bu renk tipi resim modunda desteklenmiyor: ' + colors);
}

// rgba: tuval pikselleri (w x h). Doner: { format, width, height, raw }
function toPanel(rgba, w, h, colors, rotation, palettes) {
  const format = formatFor(colors);
  const cls = classifier(colors, palettes);
  const n = nativeSize(w, h, rotation);
  const color = (nx, ny) => {
    const i = sourceIndex(nx, ny, w, h, rotation) * 4;
    return cls(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  let raw;
  if (format === FORMAT.BWRY) {
    const stride = Math.ceil(n.width / 4);
    raw = Buffer.alloc(stride * n.height, 0x55); // 01010101 = beyaz
    for (let ny = 0; ny < n.height; ny++) {
      for (let nx = 0; nx < n.width; nx++) {
        const c = color(nx, ny);
        const code = c === 'black' ? BWRY_CODE.black : c === 'yellow' ? BWRY_CODE.yellow : c === 'accent' ? BWRY_CODE.red : BWRY_CODE.white;
        const o = ny * stride + (nx >> 2);
        const shift = 6 - (nx & 3) * 2;
        raw[o] = (raw[o] & ~(3 << shift)) | (code << shift);
      }
    }
  } else {
    // 1 bit, MSB solda. Siyah-beyaz duzlem: 1 = beyaz, 0 = siyah (SSD1680 0x24).
    // Renk duzlemi: 1 = renk (kirmizi/sari), 0 = yok (SSD1680 0x26).
    const stride = Math.ceil(n.width / 8);
    const plane = stride * n.height;
    raw = Buffer.alloc(format === FORMAT.TWO_PLANE ? plane * 2 : plane, 0);
    raw.fill(0xff, 0, plane);
    for (let ny = 0; ny < n.height; ny++) {
      for (let nx = 0; nx < n.width; nx++) {
        const c = color(nx, ny);
        const o = ny * stride + (nx >> 3);
        const bit = 0x80 >> (nx & 7);
        if (c === 'black') raw[o] &= ~bit;
        else if (c === 'accent' && format === FORMAT.TWO_PLANE) raw[plane + o] |= bit;
      }
    }
  }
  return { format, width: n.width, height: n.height, raw };
}

// Panel verisini tekrar tuval yonunde RGBA'ya cevirir (onizleme).
function fromPanel(raw, format, nw, nh, rotation, colors, palettes) {
  const p = palettes[colors] || palettes.bw;
  const w = rotation === 90 || rotation === 270 ? nh : nw;
  const h = rotation === 90 || rotation === 270 ? nw : nh;
  const out = new Uint8ClampedArray(w * h * 4);
  const stride1 = Math.ceil(nw / 8);
  const stride2 = Math.ceil(nw / 4);
  const plane = stride1 * nh;
  for (let ny = 0; ny < nh; ny++) {
    for (let nx = 0; nx < nw; nx++) {
      let c;
      if (format === FORMAT.BWRY) {
        const code = (raw[ny * stride2 + (nx >> 2)] >> (6 - (nx & 3) * 2)) & 3;
        c = code === BWRY_CODE.black ? p.black : code === BWRY_CODE.yellow ? (p.yellow || p.accent) : code === BWRY_CODE.red ? p.accent : p.white;
      } else {
        const o = ny * stride1 + (nx >> 3);
        const bit = 0x80 >> (nx & 7);
        if (format === FORMAT.TWO_PLANE && raw[plane + o] & bit) c = p.accent || p.black;
        else c = raw[o] & bit ? p.white : p.black;
      }
      const i = sourceIndex(nx, ny, w, h, rotation) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba: out };
}

function buildBlob({ format, width, height, raw }) {
  const rle = rleEncode(raw);
  const useRle = rle.length < raw.length;
  const data = useRle ? rle : raw;
  const h = Buffer.alloc(HEADER_LEN);
  h[0] = VERSION;
  h[1] = format;
  h[2] = useRle ? COMPRESSION.RLE : COMPRESSION.NONE;
  h[3] = 0;
  h.writeUInt16LE(width, 4);
  h.writeUInt16LE(height, 6);
  h.writeUInt32LE(raw.length, 8);
  h.writeUInt32LE(data.length, 12);
  h.writeUInt32LE(crc32(raw), 16);
  return Buffer.concat([h, data]);
}

function parseHeader(blob) {
  if (!blob || blob.length < HEADER_LEN) throw new Error('Blob cok kisa');
  const header = {
    version: blob[0], format: blob[1], compression: blob[2], flags: blob[3],
    width: blob.readUInt16LE(4), height: blob.readUInt16LE(6),
    rawLength: blob.readUInt32LE(8), dataLength: blob.readUInt32LE(12), crc32: blob.readUInt32LE(16),
  };
  if (header.version !== VERSION) throw new Error('Bilinmeyen surum');
  if (blob.length !== HEADER_LEN + header.dataLength) throw new Error('Blob uzunlugu tutmuyor');
  return header;
}

function decodeBlob(blob) {
  const header = parseHeader(blob);
  const data = blob.subarray(HEADER_LEN);
  const raw = header.compression === COMPRESSION.RLE ? rleDecode(data, header.rawLength) : Buffer.from(data);
  if (crc32(raw) !== header.crc32) throw new Error('CRC tutmuyor');
  return { header, raw };
}

// Gonderim istatistikleri (arayuzde gosterilir).
function stats(blob) {
  const h = parseHeader(blob);
  const dataPackets = Math.ceil(h.dataLength / PACKET_DATA_LEN);
  const packets = dataPackets + 3; // START + DATA... + END + STATUS
  return {
    format: h.format, formatName: FORMAT_NAMES[h.format], width: h.width, height: h.height,
    rawBytes: h.rawLength, dataBytes: h.dataLength, blobBytes: blob.length, compressed: h.compression === COMPRESSION.RLE,
    ratio: h.dataLength ? Math.round((h.rawLength / h.dataLength) * 10) / 10 : 0,
    packets,
    // ~3 ms/paket (250 kbps, otomatik ACK, paketler arasi kisa bekleme)
    estSeconds: Math.max(1, Math.round((packets * 3) / 100) / 10),
    crc32: h.crc32.toString(16).padStart(8, '0'),
  };
}

module.exports = {
  FORMAT, FORMAT_NAMES, COMPRESSION, HEADER_LEN, PACKET_DATA_LEN, MAX_BLOB_LEN, BWRY_CODE,
  crc32, rleEncode, rleDecode, nativeSize, sourceIndex, toPanel, fromPanel, buildBlob, parseHeader, decodeBlob, stats,
};
