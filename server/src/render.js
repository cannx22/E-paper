// Sunucu tarafi tasarim cizimi: tarayicidaki ile ayni motor
// (public/static/design-render.js) @napi-rs/canvas uzerinde calisir.
// Fontlar TTF olarak hem buraya kaydedilir hem tarayiciya (/fonts/...) sunulur;
// boylece harf olculeri iki tarafta aynidir.
const path = require('path');
const QRCode = require('qrcode');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const DesignRender = require('../public/static/design-render');

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

// 2. asama (resim modu) icin panel bit duzlemleri.
async function renderPlanes(doc, data) {
  const { ctx } = await renderDoc(doc, data);
  return DesignRender.pack(ctx, doc.width, doc.height, doc.colors);
}

module.exports = { FONT_FILES, fontRoutes, qrMatrix, renderDoc, renderPng, renderPlanes, DesignRender };
