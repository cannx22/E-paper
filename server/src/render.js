// Sunucu tarafi tasarim cizimi: tarayicidaki ile ayni motor
// (public/static/design-render.js) @napi-rs/canvas uzerinde calisir.
// Fontlar TTF olarak hem buraya kaydedilir hem tarayiciya (/fonts/...) sunulur;
// boylece harf olculeri iki tarafta aynidir.
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const DesignRender = require('../public/static/design-render');
const EPD = require('./epd-image');

const NM = path.join(__dirname, '..', 'node_modules', '@expo-google-fonts');
// family -> { 400: dosya, 700: dosya }
const FONT_FILES = {
  'Inter': { 400: 'inter/400Regular/Inter_400Regular.ttf', 700: 'inter/700Bold/Inter_700Bold.ttf' },
  'Roboto Condensed': { 400: 'roboto-condensed/400Regular/RobotoCondensed_400Regular.ttf', 700: 'roboto-condensed/700Bold/RobotoCondensed_700Bold.ttf' },
  'Oswald': { 400: 'oswald/400Regular/Oswald_400Regular.ttf', 700: 'oswald/700Bold/Oswald_700Bold.ttf' },
  'Roboto Mono': { 400: 'roboto-mono/400Regular/RobotoMono_400Regular.ttf', 700: 'roboto-mono/700Bold/RobotoMono_700Bold.ttf' },
};

let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  for (const [family, files] of Object.entries(FONT_FILES)) {
    for (const rel of Object.values(files)) GlobalFonts.registerFromPath(path.join(NM, rel), family);
  }
  fontsReady = true;
}

// Tarayiciya sunulacak font dosyalari: /fonts/<slug>-<agirlik>.ttf
function fontRoutes() {
  const map = {};
  for (const [family, files] of Object.entries(FONT_FILES)) {
    const slug = family.toLowerCase().replace(/\s+/g, '-');
    for (const [weight, rel] of Object.entries(files)) map[`${slug}-${weight}.ttf`] = path.join(NM, rel);
  }
  return map;
}

const qrCache = new Map();
function qrMatrix(text) {
  const key = String(text).slice(0, 1000);
  if (qrCache.has(key)) return qrCache.get(key);
  const q = QRCode.create(key, { errorCorrectionLevel: 'M' });
  const m = { size: q.modules.size, modules: Array.from(q.modules.data, (v) => !!v) };
  if (qrCache.size > 500) qrCache.clear();
  qrCache.set(key, m);
  return m;
}

const env = {
  createCanvas: (w, h) => createCanvas(w, h),
  loadImage: async (src) => {
    const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(src || '');
    return m ? loadImage(Buffer.from(m[1], 'base64')) : null;
  },
  qrMatrix: async (text) => qrMatrix(text),
};

// Belgeyi cizer; canvas (paletine indirgenmis) doner.
async function renderDoc(doc, data, opts = {}) {
  registerFonts();
  const canvas = createCanvas(doc.width, doc.height);
  const ctx = canvas.getContext('2d');
  await DesignRender.render(ctx, doc, data || {}, env, opts);
  return { canvas, ctx };
}

async function renderPng(doc, data, { scale = 1 } = {}) {
  const { canvas } = await renderDoc(doc, data);
  if (scale === 1) return canvas.encode('png');
  const big = createCanvas(doc.width * scale, doc.height * scale);
  const g = big.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, 0, 0, big.width, big.height);
  return big.encode('png');
}

// Resim modu: tasarimi panelin RAM bicimine cevirip gateway'e gidecek blob'u
// uretir. model: { colors, rotation }. Doner: { blob, stats, hash }
async function renderPanel(doc, data, model, opts = {}) {
  const { ctx } = await renderDoc(doc, data, opts);
  const img = ctx.getImageData(0, 0, doc.width, doc.height);
  const panel = EPD.toPanel(img.data, doc.width, doc.height, model.colors || doc.colors, model.rotation || 0, DesignRender.PALETTES);
  const blob = EPD.buildBlob(panel);
  if (blob.length > EPD.MAX_BLOB_LEN) {
    throw new Error(`Tasarım sıkıştırılınca ${Math.round(blob.length / 1024)} KB tutuyor; en fazla ${EPD.MAX_BLOB_LEN / 1024} KB gönderilebilir. Büyük fotoğrafları küçültün veya görselde titrekleştirmeyi (dither) kapatın.`);
  }
  return { blob, stats: EPD.stats(blob), hash: crypto.createHash('sha256').update(blob).digest('hex') };
}

// Blob'dan (etikete giden veri) PNG onizleme: panel verisi geri acilip tuval
// yonune dondurulur. Boylece arayuzde gorulen, gonderilen veriyle aynidir.
function blobToPng(blob, model, { scale = 1 } = {}) {
  const { header, raw } = EPD.decodeBlob(blob);
  const img = EPD.fromPanel(raw, header.format, header.width, header.height, model.rotation || 0, model.colors, DesignRender.PALETTES);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(img.rgba);
  ctx.putImageData(id, 0, 0);
  if (scale === 1) return canvas.encode('png');
  const big = createCanvas(img.width * scale, img.height * scale);
  const g = big.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, 0, 0, big.width, big.height);
  return big.encode('png');
}

module.exports = { FONT_FILES, fontRoutes, qrMatrix, renderDoc, renderPng, renderPanel, blobToPng, DesignRender, EPD };
