// Etiket tasarim cizim motoru - tarayicida (editor/onizleme) ve sunucuda
// (src/render.js, @napi-rs/canvas) AYNI kod calisir; boylece editorde
// gorulen ile etikete giden birebir aynidir.
//
// Belge semasi:
//   { version: 1, width, height, colors: 'bw'|'bwr'|'bwy', elements: [El] }
//   El ortak: { id, type, x, y, w, h, hidden?, locked?, name? }
//     text    : text ({{alan}} icerebilir), font, size, weight(400|700), italic,
//               align(left|center|right), valign(top|middle|bottom), color,
//               fit(shrink|wrap|none), maxLines, lineHeight, bg(renk|null)
//     rect    : fill(renk|null), stroke(renk|null), strokeWidth, radius
//     ellipse : fill, stroke, strokeWidth
//     line    : color, dashed  (kutu: yatay cizgi icin h = kalinlik)
//     image   : src (data URL), fit(contain|cover|stretch), dither(bool), threshold
//     barcode : format(EAN13|CODE128), value, showText, color
//     qr      : value, color
//   Renkler: 'black' | 'white' | 'accent' (bwr: kirmizi, bwy: sari; bw'de siyah)
//
// env (ortama gore saglanir):
//   loadImage(src) -> Promise<Image>, createCanvas(w, h) -> Canvas,
//   qrMatrix(text) -> Promise<{ size, modules: boolean[] }>
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DesignRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FONTS = [
    { family: 'Inter', label: 'Inter', weights: [400, 700] },
    { family: 'Roboto Condensed', label: 'Roboto Condensed (dar)', weights: [400, 700] },
    { family: 'Oswald', label: 'Oswald (fiyat / başlık)', weights: [400, 700] },
    { family: 'Roboto Mono', label: 'Roboto Mono (sabit genişlik)', weights: [400, 700] },
  ];

  // Dinamik alanlar: etiket gonderim alanlari (LabelFields) ile eslesir.
  var FIELDS = [
    { key: 'isletme', label: 'İşletme adı', field: 'business', sample: 'ABC Market' },
    { key: 'urun_adi', label: 'Ürün adı', field: 'name', sample: 'Çaykur Rize Turist Çay 1 kg' },
    { key: 'alt_baslik', label: 'Alt başlık', field: 'subtitle', sample: 'Yerli üretim' },
    { key: 'fiyat', label: 'Fiyat', field: 'price', sample: '189,90' },
    { key: 'eski_fiyat', label: 'Eski fiyat', field: 'oldPrice', sample: '219,90' },
    { key: 'birim', label: 'Birim', field: 'unit', sample: 'TL' },
    { key: 'barkod', label: 'Barkod', field: 'barcode', sample: '869000000012' },
    { key: 'alt_kod', label: 'Alt kod', field: 'bottomCode', sample: 'KOD-1042' },
    { key: 'kampanya', label: 'Kampanya metni', field: 'campaignText', sample: '2 AL 1 ÖDE' },
    { key: 'icerik', label: 'İçindekiler / menü', field: 'ingredients', sample: 'Mercimek Çorbası\nPilav\nTavuk Sote\nMevsim Salata' },
    { key: 'tarih', label: 'Tarih (otomatik)', auto: true },
    { key: 'saat', label: 'Saat (otomatik)', auto: true },
  ];

  var PALETTES = {
    bw: { black: [0, 0, 0], white: [255, 255, 255] },
    bwr: { black: [0, 0, 0], white: [255, 255, 255], accent: [210, 30, 30] },
    bwy: { black: [0, 0, 0], white: [255, 255, 255], accent: [230, 180, 0] },
  };

  function css(color, colors) {
    if (!color || color === 'none') return null;
    var p = PALETTES[colors] || PALETTES.bw;
    var c = p[color] || (color === 'accent' ? p.black : p.black);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function autoValue(key, now) {
    now = now || new Date();
    if (key === 'tarih') return pad2(now.getDate()) + '.' + pad2(now.getMonth() + 1) + '.' + now.getFullYear();
    if (key === 'saat') return pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    return '';
  }
  // {{alan}} yer tutucularini doldurur. data: { urun_adi: '...', ... }
  function resolve(text, data, now) {
    return String(text == null ? '' : text).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, function (_, k) {
      k = k.toLowerCase();
      if (data && data[k] != null && data[k] !== '') return String(data[k]);
      return autoValue(k, now);
    });
  }
  function sampleData() {
    var d = {};
    FIELDS.forEach(function (f) { if (f.sample) d[f.key] = f.sample; });
    return d;
  }
  // Etiket gonderim alanlarindan (business, name, price...) tasarim verisine.
  function dataFromLabelFields(f) {
    var d = {};
    FIELDS.forEach(function (x) { if (x.field && f && f[x.field] != null) d[x.key] = f[x.field]; });
    return d;
  }

  // ---------------- Metin ----------------
  function fontStr(el, size) {
    return (el.italic ? 'italic ' : '') + (el.weight || 400) + ' ' + size + 'px "' + (el.font || 'Inter') + '"';
  }
  function wrapLines(ctx, text, maxWidth) {
    var out = [];
    String(text).split('\n').forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); return; }
      var line = '';
      words.forEach(function (w) {
        var test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width <= maxWidth || !line) {
          // tek kelime bile sigmiyorsa harf harf bol
          if (!line && ctx.measureText(w).width > maxWidth) {
            var part = '';
            for (var i = 0; i < w.length; i++) {
              if (ctx.measureText(part + w[i]).width > maxWidth && part) { out.push(part); part = ''; }
              part += w[i];
            }
            line = part;
          } else line = test;
        } else { out.push(line); line = w; }
      });
      out.push(line);
    });
    return out;
  }
  function layoutText(ctx, el, text) {
    var fit = el.fit || 'shrink';
    var maxLines = Math.max(1, el.maxLines || 1);
    var lh = el.lineHeight || 1.15;
    var size = Math.max(4, el.size || 16);
    var lines;
    // Satir sinirindan fazla paragraf varsa kuculterek cozulemez; akan metne cevir.
    if (fit !== 'wrap' && maxLines > 1 && String(text).split('\n').length > maxLines) text = String(text).replace(/\s*\n+\s*/g, ' · ');
    for (;;) {
      ctx.font = fontStr(el, size);
      lines = maxLines > 1 || fit === 'wrap' ? wrapLines(ctx, text, el.w) : [String(text).replace(/\n/g, ' ')];
      if (fit === 'wrap') break;
      var tooWide = lines.some(function (l) { return ctx.measureText(l).width > el.w + 0.5; });
      var tooMany = lines.length > maxLines;
      var tooTall = lines.length * size * lh > el.h + 0.5;
      if (fit !== 'shrink' || (!tooWide && !tooMany && !tooTall) || size <= 6) break;
      size -= size > 24 ? 2 : 1;
    }
    if (lines.length > maxLines && fit !== 'wrap') lines = lines.slice(0, maxLines);
    return { size: size, lines: lines, lineHeight: size * lh };
  }
  function drawText(ctx, el, data, colors, now) {
    var text = resolve(el.text, data, now);
    if (el.bg) { ctx.fillStyle = css(el.bg, colors); ctx.fillRect(el.x, el.y, el.w, el.h); }
    if (!text) return;
    var L = layoutText(ctx, el, text);
    ctx.save();
    ctx.beginPath(); ctx.rect(el.x, el.y, el.w, el.h); ctx.clip();
    ctx.font = fontStr(el, L.size);
    ctx.fillStyle = css(el.color || 'black', colors);
    ctx.textBaseline = 'alphabetic';
    var total = L.lines.length * L.lineHeight;
    var y0 = el.valign === 'bottom' ? el.y + el.h - total : el.valign === 'middle' ? el.y + (el.h - total) / 2 : el.y;
    L.lines.forEach(function (line, i) {
      var m = ctx.measureText(line);
      var x = el.align === 'center' ? el.x + (el.w - m.width) / 2 : el.align === 'right' ? el.x + el.w - m.width : el.x;
      // satir kutusu icinde yazi yuksekligini ortala (ascent ~ 0.8 * size)
      var baseline = y0 + i * L.lineHeight + (L.lineHeight - L.size) / 2 + L.size * 0.82;
      ctx.fillText(line, Math.round(x), Math.round(baseline));
    });
    ctx.restore();
  }

  // ---------------- Sekiller ----------------
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
  function drawRect(ctx, el, colors) {
    var sw = el.stroke ? Math.max(1, el.strokeWidth || 1) : 0;
    if (el.fill) { roundRectPath(ctx, el.x, el.y, el.w, el.h, el.radius); ctx.fillStyle = css(el.fill, colors); ctx.fill(); }
    if (sw) {
      roundRectPath(ctx, el.x + sw / 2, el.y + sw / 2, el.w - sw, el.h - sw, Math.max(0, (el.radius || 0) - sw / 2));
      ctx.lineWidth = sw; ctx.strokeStyle = css(el.stroke, colors); ctx.stroke();
    }
  }
  function drawEllipse(ctx, el, colors) {
    var sw = el.stroke ? Math.max(1, el.strokeWidth || 1) : 0;
    ctx.beginPath();
    ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.max(0.5, el.w / 2 - sw / 2), Math.max(0.5, el.h / 2 - sw / 2), 0, 0, Math.PI * 2);
    if (el.fill) { ctx.fillStyle = css(el.fill, colors); ctx.fill(); }
    if (sw) { ctx.lineWidth = sw; ctx.strokeStyle = css(el.stroke, colors); ctx.stroke(); }
  }
  function drawLine(ctx, el, colors) {
    ctx.fillStyle = css(el.color || 'black', colors);
    if (!el.dashed) { ctx.fillRect(el.x, el.y, el.w, el.h); return; }
    var horizontal = el.w >= el.h;
    var len = horizontal ? el.w : el.h, t = horizontal ? el.h : el.w, dash = Math.max(3, t * 3);
    for (var p = 0; p < len; p += dash * 2) {
      var l = Math.min(dash, len - p);
      if (horizontal) ctx.fillRect(el.x + p, el.y, l, t); else ctx.fillRect(el.x, el.y + p, t, l);
    }
  }

  // ---------------- Barkodlar ----------------
  var EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  var EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  var EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  var EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  function ean13(value) {
    var s = String(value || '').replace(/\D/g, '').slice(0, 12);
    while (s.length < 12) s += '0';
    var d = s.split('').map(Number), sum = 0;
    for (var i = 0; i < 12; i++) sum += d[i] * (i % 2 ? 3 : 1);
    d.push((10 - (sum % 10)) % 10);
    var par = EAN_PARITY[d[0]], bits = '101';
    for (i = 1; i <= 6; i++) bits += par[i - 1] === 'L' ? EAN_L[d[i]] : EAN_G[d[i]];
    bits += '01010';
    for (i = 7; i <= 12; i++) bits += EAN_R[d[i]];
    return { bits: bits + '101', text: d.join('') };
  }
  var C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
  function code128(value) {
    var text = String(value || '').replace(/[^\x20-\x7e]/g, '');
    var codes = [104]; // Start B
    for (var i = 0; i < text.length; i++) codes.push(text.charCodeAt(i) - 32);
    var sum = 104;
    for (i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103, 106);
    var bits = '';
    codes.forEach(function (c) {
      var p = C128[c];
      for (var j = 0; j < p.length; j++) bits += (j % 2 ? '0' : '1').repeat(Number(p[j]));
    });
    return { bits: bits + '11', text: text };
  }
  function drawBarcode(ctx, el, data, colors, now) {
    var value = resolve(el.value, data, now);
    var code = el.format === 'CODE128' ? code128(value) : ean13(value);
    var textH = el.showText !== false ? Math.max(10, Math.min(16, Math.floor(el.h * 0.24))) : 0;
    var module = Math.max(1, Math.floor(el.w / code.bits.length));
    var bw = module * code.bits.length;
    var x0 = el.x + Math.floor((el.w - bw) / 2);
    var barH = Math.max(4, el.h - (textH ? textH + 2 : 0));
    ctx.fillStyle = css(el.color || 'black', colors);
    for (var i = 0; i < code.bits.length; i++) if (code.bits[i] === '1') ctx.fillRect(x0 + i * module, el.y, module, barH);
    if (textH) {
      // Roboto Mono'nun cizgili sifiri kucuk boyutta 8'e benziyor; duz sifirli font.
      ctx.font = '700 ' + textH + 'px "Roboto Condensed"';
      ctx.textBaseline = 'alphabetic';
      var m = ctx.measureText(code.text);
      ctx.fillText(code.text, Math.round(el.x + (el.w - m.width) / 2), Math.round(el.y + barH + 2 + textH * 0.85));
    }
  }
  async function drawQr(ctx, el, data, colors, env, now) {
    var value = resolve(el.value, data, now);
    if (!value || !env.qrMatrix) return;
    var q = await env.qrMatrix(value);
    if (!q) return;
    var scale = Math.max(1, Math.floor(Math.min(el.w, el.h) / q.size));
    var sz = scale * q.size, x0 = el.x + Math.floor((el.w - sz) / 2), y0 = el.y + Math.floor((el.h - sz) / 2);
    ctx.fillStyle = css(el.color || 'black', colors);
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.modules[y * q.size + x]) ctx.fillRect(x0 + x * scale, y0 + y * scale, scale, scale);
  }

  // ---------------- Gorsel ----------------
  // Gorseli kutuya yerlestirir ve siyah-beyaza (istenirse Floyd-Steinberg
  // titreklestirme ile) cevirir; e-paper'da gri ton yok.
  async function drawImage(ctx, el, colors, env) {
    if (!el.src || !env.loadImage || !env.createCanvas) return;
    var img = await env.loadImage(el.src);
    if (!img) return;
    var w = Math.max(1, Math.round(el.w)), h = Math.max(1, Math.round(el.h));
    var tmp = env.createCanvas(w, h), t = tmp.getContext('2d');
    t.fillStyle = '#fff'; t.fillRect(0, 0, w, h);
    var iw = img.width, ih = img.height, fit = el.fit || 'contain';
    var sx = w / iw, sy = h / ih, s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    var dw = fit === 'stretch' ? w : iw * s, dh = fit === 'stretch' ? h : ih * s;
    t.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    var id = t.getImageData(0, 0, w, h), px = id.data, thr = el.threshold || 128;
    var lum = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var a = px[i * 4 + 3] / 255;
      lum[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) * a + 255 * (1 - a);
    }
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var k = y * w + x, old = lum[k], nv = old < thr ? 0 : 255, err = old - nv;
      lum[k] = nv;
      if (el.dither !== false) {
        if (x + 1 < w) lum[k + 1] += err * 7 / 16;
        if (y + 1 < h) {
          if (x > 0) lum[k + w - 1] += err * 3 / 16;
          lum[k + w] += err * 5 / 16;
          if (x + 1 < w) lum[k + w + 1] += err / 16;
        }
      }
    }
    var ink = PALETTES[colors] ? (PALETTES[colors][el.color] || PALETTES[colors].black) : [0, 0, 0];
    for (i = 0; i < w * h; i++) {
      var black = lum[i] < 128;
      px[i * 4] = black ? ink[0] : 255; px[i * 4 + 1] = black ? ink[1] : 255; px[i * 4 + 2] = black ? ink[2] : 255; px[i * 4 + 3] = black ? 255 : 0;
    }
    t.putImageData(id, 0, 0);
    ctx.drawImage(tmp, Math.round(el.x), Math.round(el.y));
  }

  // ---------------- Ana cizim ----------------
  async function render(ctx, doc, data, env, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var colors = doc.colors || 'bw';
    ctx.save();
    ctx.fillStyle = css(doc.background || 'white', colors) || '#fff';
    ctx.fillRect(0, 0, doc.width, doc.height);
    for (var i = 0; i < (doc.elements || []).length; i++) {
      var el = doc.elements[i];
      if (el.hidden) continue;
      try {
        if (el.type === 'text') drawText(ctx, el, data, colors, now);
        else if (el.type === 'rect') drawRect(ctx, el, colors);
        else if (el.type === 'ellipse') drawEllipse(ctx, el, colors);
        else if (el.type === 'line') drawLine(ctx, el, colors);
        else if (el.type === 'barcode') drawBarcode(ctx, el, data, colors, now);
        else if (el.type === 'qr') await drawQr(ctx, el, data, colors, env, now);
        else if (el.type === 'image') await drawImage(ctx, el, colors, env);
      } catch (e) {
        if (opts.onError) opts.onError(el, e);
      }
    }
    ctx.restore();
    if (opts.quantize !== false) quantize(ctx, doc.width, doc.height, colors);
  }

  // Her pikseli panelin paletindeki en yakin renge indirger (e-paper'da ara
  // ton yok). Metin kenar yumusatmasi da boylece net siyah/beyaza doner.
  function quantize(ctx, w, h, colors) {
    var id = ctx.getImageData(0, 0, w, h), p = id.data;
    var acc = PALETTES[colors] && PALETTES[colors].accent;
    for (var i = 0; i < p.length; i += 4) {
      var r = p[i], g = p[i + 1], b = p[i + 2];
      var out = null;
      if (acc) {
        var isAccent = colors === 'bwr' ? (r > 120 && r - g > 60 && r - b > 60) : (r > 150 && g > 110 && b < 90 && r - b > 80);
        if (isAccent) out = acc;
      }
      // Esik 50%'nin biraz ustunde: ince harf cizgileri (kenar yumusatmali gri) kaybolmasin.
      if (!out) out = (0.299 * r + 0.587 * g + 0.114 * b) < 175 ? [0, 0, 0] : [255, 255, 255];
      p[i] = out[0]; p[i + 1] = out[1]; p[i + 2] = out[2]; p[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  // Panele gonderilecek bit duzlemleri (2. asama - resim modu): satir satir,
  // her bayt 8 piksel (MSB solda); 1 = murekkep. { black, accent|null, stride }
  function pack(ctx, w, h, colors) {
    var p = ctx.getImageData(0, 0, w, h).data, stride = Math.ceil(w / 8);
    var black = new Uint8Array(stride * h), accent = PALETTES[colors] && PALETTES[colors].accent ? new Uint8Array(stride * h) : null;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4, bit = 0x80 >> (x & 7), o = y * stride + (x >> 3);
      var r = p[i], g = p[i + 1], b = p[i + 2];
      if (r === 0 && g === 0 && b === 0) black[o] |= bit;
      else if (accent && !(r === 255 && g === 255 && b === 255)) accent[o] |= bit;
    }
    return { black: black, accent: accent, stride: stride, width: w, height: h };
  }

  function newId() { return 'e' + Math.random().toString(36).slice(2, 9); }
  function emptyDoc(model) {
    return { version: 1, width: model.width_px, height: model.height_px, colors: model.colors || 'bw', elements: [] };
  }
  // Belgeyi baska bir ekran boyutuna olcekler (kopyala -> baska boyut).
  function scaleDoc(doc, width, height, colors) {
    var sx = width / doc.width, sy = height / doc.height, sf = Math.min(sx, sy);
    var out = JSON.parse(JSON.stringify(doc));
    out.width = width; out.height = height; out.colors = colors || doc.colors;
    out.elements.forEach(function (el) {
      el.x = Math.round(el.x * sx); el.y = Math.round(el.y * sy);
      el.w = Math.max(1, Math.round(el.w * sx)); el.h = Math.max(1, Math.round(el.h * sy));
      if (el.size) el.size = Math.max(6, Math.round(el.size * sf));
      if (el.strokeWidth) el.strokeWidth = Math.max(1, Math.round(el.strokeWidth * sf));
      if (el.radius) el.radius = Math.round(el.radius * sf);
      if (out.colors === 'bw') ['color', 'fill', 'stroke', 'bg'].forEach(function (k) { if (el[k] === 'accent') el[k] = 'black'; });
    });
    return out;
  }
  // Belge dogrulama (sunucu kaydederken de kullanir).
  var TYPES = ['text', 'rect', 'ellipse', 'line', 'image', 'barcode', 'qr'];
  function validate(doc) {
    if (!doc || typeof doc !== 'object') return 'Belge geçersiz.';
    if (!(doc.width > 0 && doc.height > 0 && doc.width <= 2000 && doc.height <= 2000)) return 'Tuval boyutu geçersiz.';
    if (!Array.isArray(doc.elements)) return 'Eleman listesi geçersiz.';
    if (doc.elements.length > 300) return 'En fazla 300 eleman olabilir.';
    for (var i = 0; i < doc.elements.length; i++) {
      var el = doc.elements[i];
      if (!el || TYPES.indexOf(el.type) === -1) return 'Bilinmeyen eleman türü.';
      if (['x', 'y', 'w', 'h'].some(function (k) { return typeof el[k] !== 'number' || !isFinite(el[k]); })) return 'Eleman konumu geçersiz.';
      if (el.type === 'image' && el.src && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(el.src)) return 'Görsel sadece gömülü PNG/JPEG olabilir.';
    }
    return null;
  }
  // Belgede kullanilan dinamik alanlar
  function usedFields(doc) {
    var set = {};
    (doc.elements || []).forEach(function (el) {
      String((el.text || '') + ' ' + (el.value || '')).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, function (_, k) { set[k.toLowerCase()] = true; });
    });
    return Object.keys(set);
  }

  return {
    FONTS: FONTS, FIELDS: FIELDS, PALETTES: PALETTES,
    render: render, quantize: quantize, pack: pack, resolve: resolve, sampleData: sampleData, dataFromLabelFields: dataFromLabelFields,
    emptyDoc: emptyDoc, scaleDoc: scaleDoc, validate: validate, usedFields: usedFields, newId: newId, css: css,
    ean13: ean13, code128: code128,
  };
});
