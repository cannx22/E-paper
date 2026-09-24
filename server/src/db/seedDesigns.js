// Merkez kutuphanesine hazir baslangic sablonlari (bir kez). Bayiler bunlari
// kopyalayip kendi tasarimlarina donusturebilir.
const db = require('./index');
const settings = require('../settings');

let n = 0;
const id = () => 's' + (++n);
const T = (x, y, w, h, text, o = {}) => ({ id: id(), type: 'text', x, y, w, h, text, font: 'Inter', size: 14, weight: 400, align: 'left', valign: 'top', color: 'black', fit: 'shrink', maxLines: 1, lineHeight: 1.15, ...o });
const R = (x, y, w, h, o = {}) => ({ id: id(), type: 'rect', x, y, w, h, fill: 'black', stroke: null, strokeWidth: 1, radius: 0, ...o });
const L = (x, y, w, h, o = {}) => ({ id: id(), type: 'line', x, y, w, h, color: 'black', dashed: false, ...o });
const B = (x, y, w, h, o = {}) => ({ id: id(), type: 'barcode', x, y, w, h, format: 'EAN13', value: '{{barkod}}', showText: true, color: 'black', ...o });
const Q = (x, y, w, h, value, o = {}) => ({ id: id(), type: 'qr', x, y, w, h, value, color: 'black', ...o });

const TEMPLATES = [
  {
    name: 'Standart Fiyat Etiketi', category: 'market', model: 'EPD213-BW', description: 'İşletme, ürün adı, büyük fiyat kutusu ve barkod.',
    elements: () => [
      T(6, 4, 150, 16, '{{isletme}}', { size: 13, weight: 700 }),
      L(6, 22, 150, 1),
      T(6, 26, 150, 46, '{{urun_adi}}', { font: 'Roboto Condensed', size: 20, weight: 700, maxLines: 2 }),
      R(162, 0, 88, 78),
      T(165, 6, 82, 50, '{{fiyat}}', { font: 'Oswald', size: 34, weight: 700, color: 'white', align: 'center', valign: 'middle' }),
      T(165, 56, 82, 18, '{{birim}}', { size: 12, color: 'white', align: 'center' }),
      B(6, 82, 150, 38),
      T(162, 84, 84, 16, '{{alt_kod}}', { size: 10, align: 'center' }),
      T(162, 102, 84, 16, '{{tarih}}', { font: 'Roboto Condensed', size: 11, weight: 700, align: 'center' }),
    ],
  },
  {
    name: 'İndirimli Fiyat (Kırmızı)', category: 'market', model: 'EPD213-BWR', description: 'Üstü çizili eski fiyat ve kırmızı indirimli fiyat.',
    elements: () => [
      R(0, 0, 250, 20, { fill: 'accent' }),
      T(6, 2, 238, 16, 'İNDİRİM · {{isletme}}', { size: 12, weight: 700, color: 'white', align: 'center', valign: 'middle' }),
      T(6, 24, 238, 40, '{{urun_adi}}', { font: 'Roboto Condensed', size: 18, weight: 700, maxLines: 2, align: 'center' }),
      T(8, 68, 90, 22, '{{eski_fiyat}} {{birim}}', { font: 'Oswald', size: 16, align: 'center', valign: 'middle' }),
      L(14, 79, 78, 2),
      T(100, 62, 145, 40, '{{fiyat}}', { font: 'Oswald', size: 36, weight: 700, color: 'accent', align: 'center', valign: 'middle' }),
      T(100, 100, 145, 16, '{{birim}}', { size: 12, weight: 700, color: 'accent', align: 'center' }),
      B(8, 94, 88, 26, { showText: false }),
    ],
  },
  {
    name: 'Kampanya Etiketi', category: 'market', model: 'EPD29-BWR', description: 'Üstte kampanya bandı, ürün ve fiyat.',
    elements: () => [
      R(0, 0, 296, 26, { fill: 'accent' }),
      T(6, 3, 284, 20, '{{kampanya}}', { font: 'Oswald', size: 18, weight: 700, color: 'white', align: 'center', valign: 'middle' }),
      T(8, 32, 180, 50, '{{urun_adi}}', { font: 'Roboto Condensed', size: 20, weight: 700, maxLines: 2 }),
      T(8, 84, 180, 16, '{{alt_baslik}}', { size: 11 }),
      R(194, 32, 96, 70, { fill: null, stroke: 'black', strokeWidth: 2, radius: 8 }),
      T(198, 36, 88, 46, '{{fiyat}}', { font: 'Oswald', size: 30, weight: 700, align: 'center', valign: 'middle' }),
      T(198, 80, 88, 18, '{{birim}}', { size: 11, weight: 700, align: 'center' }),
      B(8, 104, 180, 22, { format: 'CODE128', showText: false }),
      T(194, 108, 96, 16, '{{isletme}}', { size: 10, align: 'center' }),
    ],
  },
  {
    name: 'Kare Fiyat Etiketi', category: 'market', model: 'EPD154-BW', description: '1.54" kare ekran için fiyat etiketi.',
    elements: () => [
      T(10, 8, 180, 18, '{{isletme}}', { size: 13, weight: 700, align: 'center' }),
      L(10, 30, 180, 1),
      T(10, 36, 180, 52, '{{urun_adi}}', { font: 'Roboto Condensed', size: 20, weight: 700, maxLines: 2, align: 'center' }),
      R(10, 92, 180, 60, { radius: 10 }),
      T(14, 94, 140, 56, '{{fiyat}}', { font: 'Oswald', size: 40, weight: 700, color: 'white', align: 'center', valign: 'middle' }),
      T(150, 118, 36, 18, '{{birim}}', { size: 12, weight: 700, color: 'white' }),
      B(20, 158, 160, 38),
    ],
  },
  {
    name: 'Günün Menüsü', category: 'restoran', model: 'EPD42-BW', description: 'Yemekhane / büfe tezgahı için günlük menü.',
    elements: () => [
      R(0, 0, 400, 56),
      T(16, 8, 280, 40, 'GÜNÜN MENÜSÜ', { font: 'Oswald', size: 30, weight: 700, color: 'white', valign: 'middle' }),
      T(280, 12, 108, 32, '{{tarih}}', { font: 'Roboto Condensed', size: 18, weight: 700, color: 'white', align: 'right', valign: 'middle' }),
      T(16, 66, 368, 24, '{{urun_adi}}', { size: 18, weight: 700 }),
      L(16, 94, 368, 2),
      T(16, 104, 368, 150, '{{icerik}}', { font: 'Roboto Condensed', size: 24, maxLines: 6, fit: 'shrink', lineHeight: 1.3 }),
      L(16, 262, 368, 1, { dashed: true }),
      T(16, 268, 260, 24, '{{isletme}}', { size: 14, weight: 700, valign: 'middle' }),
      T(276, 268, 108, 24, '{{fiyat}} {{birim}}', { font: 'Oswald', size: 20, weight: 700, align: 'right', valign: 'middle' }),
    ],
  },
  {
    name: 'Toplantı Salonu', category: 'otel', model: 'EPD75-BW', description: 'Salon kapısı için etkinlik ekranı, QR ile rezervasyon.',
    elements: () => [
      T(40, 30, 560, 40, '{{isletme}}', { size: 26, weight: 700 }),
      T(600, 30, 160, 40, '{{saat}}', { font: 'Roboto Mono', size: 30, weight: 700, align: 'right' }),
      L(40, 84, 720, 3),
      T(40, 110, 720, 90, '{{urun_adi}}', { font: 'Oswald', size: 72, weight: 700 }),
      T(40, 210, 720, 60, '{{alt_baslik}}', { size: 32, maxLines: 2 }),
      R(40, 300, 480, 130, { fill: null, stroke: 'black', strokeWidth: 3, radius: 16 }),
      T(64, 318, 440, 40, 'Bugün · {{tarih}}', { size: 26, weight: 700 }),
      T(64, 362, 440, 56, '{{icerik}}', { size: 22, maxLines: 2 }),
      Q(600, 290, 160, 160, 'https://ornek.com/rezervasyon'),
    ],
  },
  {
    name: 'Oda Bilgilendirme', category: 'otel', model: 'EPD29-BW', description: 'Otel odası kapısı: oda no, durum, tarih.',
    elements: () => [
      R(0, 0, 96, 128),
      T(4, 18, 88, 70, '101', { name: 'Oda no', font: 'Oswald', size: 54, weight: 700, color: 'white', align: 'center', valign: 'middle' }),
      T(4, 92, 88, 20, 'ODA', { size: 14, weight: 700, color: 'white', align: 'center' }),
      T(106, 10, 182, 20, '{{isletme}}', { size: 13, weight: 700 }),
      L(106, 34, 182, 1),
      T(106, 42, 182, 44, '{{alt_baslik}}', { font: 'Roboto Condensed', size: 22, weight: 700, maxLines: 2 }),
      T(106, 96, 182, 24, '{{tarih}} · {{saat}}', { font: 'Roboto Condensed', size: 13, weight: 700 }),
    ],
  },
];

async function seedDesigns() {
  if (await settings.get('designs_seeded')) return;
  const models = Object.fromEntries((await db.many('SELECT id, code, width_px, height_px, colors FROM screen_models')).map((m) => [m.code, m]));
  for (const t of TEMPLATES) {
    const m = models[t.model];
    if (!m) continue;
    const doc = { version: 1, width: m.width_px, height: m.height_px, colors: m.colors, elements: t.elements() };
    await db.query(
      'INSERT INTO designs (dealer_id, name, category, description, screen_model_id, doc) VALUES (NULL, $1, $2, $3, $4, $5)',
      [t.name, t.category, t.description, m.id, JSON.stringify(doc)],
    );
  }
  await settings.set('designs_seeded', true);
  console.log(`Tasarım kütüphanesine ${TEMPLATES.length} hazır şablon eklendi.`);
}

module.exports = { seedDesigns, TEMPLATES };
