// Etiket tasarim editoru: surukle-birak, boyutlandirma, hizalama cizgileri,
// katmanlar, geri al/yinele, ornek veri ile canli onizleme.
// Cizim DesignRender ile yapilir (sunucudakiyle ayni motor), boylece
// editorde gorulen ile etikete giden aynidir.
(function () {
  'use strict';
  var DR = window.DesignRender, e = App.escapeHtml;
  var $ = function (id) { return document.getElementById(id); };

  var designId = location.pathname.split('/')[2];
  var design = null, doc = null;
  var mode = 'view';           // edit | copy (kopya olarak kaydedilir) | view (salt okunur)
  var canModify = false;
  var sel = [];                // secili eleman id'leri
  var hoverId = null, guides = [], band = null, tip = null, action = null;
  var zoom = 1, epaper = true;
  var hist = [], hIndex = -1, savedJson = '', savedName = '';
  var clipboard = null;

  var ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
  var ICONS = { text: 'ti-typography', rect: 'ti-square', ellipse: 'ti-circle', line: 'ti-line', image: 'ti-photo', barcode: 'ti-barcode', qr: 'ti-qrcode' };
  var TYPE_LABELS = { text: 'Metin', rect: 'Kutu', ellipse: 'Elips', line: 'Çizgi', image: 'Görsel', barcode: 'Barkod', qr: 'QR kod' };
  var CATS = { market: 'Market', otel: 'Otel', restoran: 'Restoran', genel: 'Genel' };
  var COLOR_TYPES = { bw: 'Siyah-Beyaz', bwr: 'Siyah-Beyaz-Kırmızı', bwy: 'Siyah-Beyaz-Sarı', color: 'Renkli' };

  // ---------------- Ornek veri ----------------
  var DATA_KEY = 'epaper-design-data';
  var data = (function () {
    try { var d = JSON.parse(localStorage.getItem(DATA_KEY)); if (d && typeof d === 'object') return Object.assign(DR.sampleData(), d); } catch (x) {}
    return DR.sampleData();
  })();
  function saveData() { try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (x) {} }

  // ---------------- Cizim ortami (tarayici) ----------------
  var imgCache = {}, qrCache = {};
  var env = {
    createCanvas: function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    loadImage: function (src) {
      if (!imgCache[src]) imgCache[src] = new Promise(function (res) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { res(null); }; i.src = src; });
      return imgCache[src];
    },
    qrMatrix: function (text) {
      if (!qrCache[text]) {
        qrCache[text] = App.apiRequest('GET', '/api/qr-matrix?text=' + encodeURIComponent(text)).then(function (r) {
          return { size: r.size, modules: r.modules.split('').map(function (c) { return c === '1'; }) };
        }).catch(function () { delete qrCache[text]; return null; });
      }
      return qrCache[text];
    }
  };

  var cv = $('cv'), overlay = $('overlay'), stage = $('stage'), wrap = $('wrap');
  var rendering = false, renderAgain = false;
  function scheduleRender() {
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    requestAnimationFrame(doRender);
  }
  async function doRender() {
    try {
      // E-paper gorunumu: panel cozunurlugunde ciz, piksel piksel buyut.
      // Aksi halde yakinlastirmaya gore net (yumusatilmis) ciz.
      var scale = epaper ? 1 : Math.min(6, Math.max(1, zoom * (window.devicePixelRatio || 1)));
      var off = env.createCanvas(Math.round(doc.width * scale), Math.round(doc.height * scale));
      var ctx = off.getContext('2d');
      if (scale !== 1) ctx.scale(scale, scale);
      await DR.render(ctx, doc, data, env, { quantize: epaper });
      if (cv.width !== off.width || cv.height !== off.height) { cv.width = off.width; cv.height = off.height; }
      cv.getContext('2d').drawImage(off, 0, 0);
      cv.classList.toggle('pixelated', epaper);
    } catch (err) {
      console.error(err);
    } finally {
      rendering = false;
      if (renderAgain) { renderAgain = false; scheduleRender(); }
    }
  }

  // ---------------- Yardimcilar ----------------
  function byId(id) { for (var i = 0; i < doc.elements.length; i++) if (doc.elements[i].id === id) return doc.elements[i]; return null; }
  function selected() { return sel.map(byId).filter(Boolean); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function round(v) { return Math.round(v); }
  function bbox(els) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    els.forEach(function (el) { x1 = Math.min(x1, el.x); y1 = Math.min(y1, el.y); x2 = Math.max(x2, el.x + el.w); y2 = Math.max(y2, el.y + el.h); });
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function fieldLabel(key) { var f = DR.FIELDS.find(function (x) { return x.key === key; }); return f ? f.label : key; }
  function layerLabel(el) {
    if (el.name) return el.name;
    var raw = el.type === 'text' ? el.text : (el.type === 'barcode' || el.type === 'qr') ? el.value : '';
    if (raw) {
      var s = String(raw).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, function (_, k) { return '[' + fieldLabel(k.toLowerCase()) + ']'; }).replace(/\s+/g, ' ');
      return (el.type === 'text' ? '' : TYPE_LABELS[el.type] + ': ') + (s.length > 34 ? s.slice(0, 33) + '…' : s);
    }
    return TYPE_LABELS[el.type] || el.type;
  }
  function colorChoices() {
    var list = [['black', 'Siyah'], ['white', 'Beyaz']];
    if (doc.colors === 'bwr') list.push(['accent', 'Kırmızı']);
    if (doc.colors === 'bwy') list.push(['accent', 'Sarı']);
    return list;
  }
  function docPoint(ev) {
    var r = overlay.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
  }

  // ---------------- Gecmis (geri al / yinele) ----------------
  function snapshot() { return JSON.stringify(doc); }
  function commit() {
    var s = snapshot();
    if (hist[hIndex] === s) return;
    hist = hist.slice(0, hIndex + 1);
    hist.push(s);
    if (hist.length > 150) hist.shift();
    hIndex = hist.length - 1;
    updateState();
  }
  function restore(s) {
    doc = JSON.parse(s);
    sel = sel.filter(function (id) { return byId(id); });
    refreshAll();
  }
  function undo() { if (hIndex > 0) { hIndex--; restore(hist[hIndex]); } }
  function redo() { if (hIndex < hist.length - 1) { hIndex++; restore(hist[hIndex]); } }
  var nudgeTimer = null;
  function commitSoon() { clearTimeout(nudgeTimer); nudgeTimer = setTimeout(commit, 400); }

  function isDirty() { return metaDirty || snapshot() !== savedJson || $('dName').value.trim() !== savedName; }
  function updateState() {
    $('undoBtn').disabled = hIndex <= 0;
    $('redoBtn').disabled = hIndex >= hist.length - 1;
    $('dirtyBadge').classList.toggle('d-none', !isDirty() || mode === 'view');
  }

  // ---------------- Yakinlastirma ----------------
  function applyZoom() {
    var w = doc.width * zoom, h = doc.height * zoom;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
    $('zoomFit').textContent = Math.round(zoom * 100) + '%';
    drawOverlay();
    if (!epaper) scheduleRender();
  }
  function setZoom(z) { zoom = Math.max(0.1, Math.min(10, z)); applyZoom(); }
  function fitZoom() {
    var aw = stage.clientWidth - 64, ah = stage.clientHeight - 64;
    var z = Math.min(aw / doc.width, ah / doc.height);
    // tam sayi katlara yuvarla (piksel piksel net gorunum), kucukse serbest
    setZoom(z >= 1 ? Math.max(1, Math.floor(z * 2) / 2) : Math.max(0.1, z));
  }
  function stepZoom(dir) {
    var next = dir > 0 ? ZOOMS.find(function (z) { return z > zoom + 0.001; }) : ZOOMS.slice().reverse().find(function (z) { return z < zoom - 0.001; });
    if (next) setZoom(next);
  }

  // ---------------- Secim katmani ----------------
  var HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
  function boxHtml(cls, el) {
    return '<div class="' + cls + '" style="left:' + (el.x * zoom) + 'px;top:' + (el.y * zoom) + 'px;width:' + (el.w * zoom) + 'px;height:' + (el.h * zoom) + 'px"></div>';
  }
  function drawOverlay() {
    if (!doc) return;
    var html = '', els = selected();
    if (hoverId && sel.indexOf(hoverId) === -1) { var h = byId(hoverId); if (h && !h.hidden) html += boxHtml('dz-hover', h); }
    els.forEach(function (el) { html += boxHtml('dz-sel' + (els.length > 1 ? ' multi' : '') + (el.locked ? ' locked' : ''), el); });
    if (els.length > 1) html += boxHtml('dz-sel multi', bbox(els));
    if (els.length === 1 && canModify && !els[0].locked) {
      var el = els[0];
      Object.keys(HANDLES).forEach(function (k) {
        var hx = HANDLES[k][0], hy = HANDLES[k][1];
        // cok kucuk elemanlarda kenar orta tutamaclarini gizle
        if ((k === 'n' || k === 's') && el.w * zoom < 24) return;
        if ((k === 'e' || k === 'w') && el.h * zoom < 24) return;
        html += '<div class="dz-handle" data-h="' + k + '" style="left:' + ((el.x + el.w * hx) * zoom) + 'px;top:' + ((el.y + el.h * hy) * zoom) + 'px;cursor:' + k + '-resize"></div>';
      });
    }
    guides.forEach(function (g) {
      html += g.v !== undefined ? '<div class="dz-guide v" style="left:' + (g.v * zoom) + 'px"></div>' : '<div class="dz-guide h" style="top:' + (g.h * zoom) + 'px"></div>';
    });
    if (band) {
      var b = normRect(band);
      html += '<div class="dz-band" style="left:' + (b.x * zoom) + 'px;top:' + (b.y * zoom) + 'px;width:' + (b.w * zoom) + 'px;height:' + (b.h * zoom) + 'px"></div>';
    }
    if (tip) html += '<div class="dz-size-tip" style="left:' + (tip.x * zoom) + 'px;top:' + (tip.y * zoom) + 'px">' + e(tip.text) + '</div>';
    overlay.innerHTML = html;
  }
  function normRect(r) {
    return { x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2), w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) };
  }

  function hitTest(p) {
    var tol = 4 / zoom;
    for (var i = doc.elements.length - 1; i >= 0; i--) {
      var el = doc.elements[i];
      if (el.hidden || el.locked) continue;
      if (p.x >= el.x - tol && p.x <= el.x + el.w + tol && p.y >= el.y - tol && p.y <= el.y + el.h + tol) return el;
    }
    return null;
  }

  // Hizalama cizgileri: tuval kenar/ortasi ve diger elemanlarin kenar/ortalari.
  function snapLines(excludeIds) {
    var xs = [0, doc.width / 2, doc.width], ys = [0, doc.height / 2, doc.height];
    doc.elements.forEach(function (el) {
      if (el.hidden || excludeIds.indexOf(el.id) !== -1) return;
      xs.push(el.x, el.x + el.w / 2, el.x + el.w);
      ys.push(el.y, el.y + el.h / 2, el.y + el.h);
    });
    return { xs: xs, ys: ys };
  }
  function nearest(values, lines, thr) {
    var best = null;
    values.forEach(function (v, idx) {
      lines.forEach(function (l) {
        var d = l - v;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, line: l, idx: idx };
      });
    });
    return best;
  }

  // ---------------- Isaretci etkilesimi ----------------
  overlay.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0 || !doc) return;
    var p = docPoint(ev);
    var handle = ev.target.closest('.dz-handle');
    overlay.setPointerCapture(ev.pointerId);
    if (handle && canModify) {
      var el = selected()[0];
      action = { type: 'resize', handle: handle.dataset.h, start: p, orig: clone(el), id: el.id, moved: false };
      return;
    }
    var hit = hitTest(p);
    if (hit) {
      if (ev.shiftKey) {
        var i = sel.indexOf(hit.id);
        if (i === -1) sel.push(hit.id); else sel.splice(i, 1);
      } else if (sel.indexOf(hit.id) === -1) sel = [hit.id];
      var movable = selected().filter(function (x) { return !x.locked; });
      if (canModify && movable.length && sel.indexOf(hit.id) !== -1) {
        action = { type: 'move', start: p, origs: movable.map(clone), moved: false };
      }
    } else {
      if (!ev.shiftKey) sel = [];
      action = { type: 'band', base: ev.shiftKey ? sel.slice() : [] };
      band = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
    refreshSelection();
  });

  overlay.addEventListener('pointermove', function (ev) {
    if (!doc) return;
    var p = docPoint(ev);
    if (!action) {
      var h = hitTest(p), id = h ? h.id : null;
      overlay.style.cursor = h && canModify ? 'move' : 'default';
      if (id !== hoverId) { hoverId = id; drawOverlay(); }
      return;
    }
    var snap = !ev.altKey, thr = 5 / zoom;
    if (action.type === 'move') {
      var dx = p.x - action.start.x, dy = p.y - action.start.y;
      if (!action.moved && Math.abs(dx) * zoom < 2 && Math.abs(dy) * zoom < 2) return;
      action.moved = true;
      var bb = bbox(action.origs), nx = bb.x + dx, ny = bb.y + dy;
      guides = [];
      if (snap) {
        var lines = snapLines(action.origs.map(function (o) { return o.id; }));
        var sx = nearest([nx, nx + bb.w / 2, nx + bb.w], lines.xs, thr);
        var sy = nearest([ny, ny + bb.h / 2, ny + bb.h], lines.ys, thr);
        if (sx) { dx += sx.d; guides.push({ v: sx.line }); }
        if (sy) { dy += sy.d; guides.push({ h: sy.line }); }
      }
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      action.origs.forEach(function (o) { var el = byId(o.id); el.x = round(o.x + dx); el.y = round(o.y + dy); });
      var nb = bbox(selected());
      tip = { x: nb.x + nb.w / 2, y: nb.y + nb.h, text: 'x ' + nb.x + '  y ' + nb.y };
      scheduleRender(); drawOverlay(); renderGeometry();
    } else if (action.type === 'resize') {
      var o = action.orig, k = action.handle, el2 = byId(action.id);
      var ddx = p.x - action.start.x, ddy = p.y - action.start.y;
      action.moved = true;
      var x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (k.indexOf('w') !== -1) x1 += ddx;
      if (k.indexOf('e') !== -1) x2 += ddx;
      if (k.indexOf('n') !== -1) y1 += ddy;
      if (k.indexOf('s') !== -1) y2 += ddy;
      guides = [];
      if (snap) {
        var ln = snapLines([o.id]);
        var mx = k.indexOf('w') !== -1 ? 'x1' : k.indexOf('e') !== -1 ? 'x2' : null;
        var my = k.indexOf('n') !== -1 ? 'y1' : k.indexOf('s') !== -1 ? 'y2' : null;
        if (mx) { var s1 = nearest([mx === 'x1' ? x1 : x2], ln.xs, thr); if (s1) { if (mx === 'x1') x1 += s1.d; else x2 += s1.d; guides.push({ v: s1.line }); } }
        if (my) { var s2 = nearest([my === 'y1' ? y1 : y2], ln.ys, thr); if (s2) { if (my === 'y1') y1 += s2.d; else y2 += s2.d; guides.push({ h: s2.line }); } }
      }
      // Shift (veya gorsel/QR koseleri): en-boy orani korunur
      var keepRatio = k.length === 2 && (ev.shiftKey || el2.type === 'image' || el2.type === 'qr');
      if (keepRatio && o.w > 0 && o.h > 0) {
        var ratio = o.w / o.h, w = Math.max(1, x2 - x1), h2 = Math.max(1, y2 - y1);
        if (w / h2 > ratio) w = h2 * ratio; else h2 = w / ratio;
        if (k.indexOf('w') !== -1) x1 = x2 - w; else x2 = x1 + w;
        if (k.indexOf('n') !== -1) y1 = y2 - h2; else y2 = y1 + h2;
        guides = [];
      }
      if (x2 - x1 < 1) { if (k.indexOf('w') !== -1) x1 = x2 - 1; else x2 = x1 + 1; }
      if (y2 - y1 < 1) { if (k.indexOf('n') !== -1) y1 = y2 - 1; else y2 = y1 + 1; }
      el2.x = round(x1); el2.y = round(y1); el2.w = Math.max(1, round(x2) - round(x1)); el2.h = Math.max(1, round(y2) - round(y1));
      tip = { x: el2.x + el2.w / 2, y: el2.y + el2.h, text: el2.w + ' × ' + el2.h };
      scheduleRender(); drawOverlay(); renderGeometry();
    } else if (action.type === 'band') {
      band.x2 = p.x; band.y2 = p.y;
      var r = normRect(band), ids = action.base.slice();
      doc.elements.forEach(function (el) {
        if (el.hidden || el.locked) return;
        if (el.x < r.x + r.w && el.x + el.w > r.x && el.y < r.y + r.h && el.y + el.h > r.y && ids.indexOf(el.id) === -1) ids.push(el.id);
      });
      sel = ids;
      drawOverlay(); renderLayers();
    }
  });

  function endAction() {
    if (!action) return;
    var a = action;
    action = null; guides = []; band = null; tip = null;
    if ((a.type === 'move' || a.type === 'resize') && a.moved) commit();
    refreshSelection();
  }
  overlay.addEventListener('pointerup', endAction);
  overlay.addEventListener('pointercancel', endAction);
  overlay.addEventListener('pointerleave', function () { if (!action && hoverId) { hoverId = null; drawOverlay(); } });
  overlay.addEventListener('dblclick', function (ev) {
    var el = hitTest(docPoint(ev));
    if (!el) return;
    sel = [el.id]; refreshSelection();
    tabler.Tab.getOrCreateInstance(document.querySelector('.dz-tabs [href="#pProps"]')).show();
    var t = document.querySelector('#props [data-prop="text"], #props [data-prop="value"]');
    if (t) { t.focus(); t.select(); }
  });

  stage.addEventListener('wheel', function (ev) {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    stepZoom(ev.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  // bos alana tiklayinca secimi kaldir
  stage.addEventListener('pointerdown', function (ev) {
    if (ev.target === stage && sel.length) { sel = []; refreshSelection(); }
  });

  // ---------------- Eleman ekleme ----------------
  function base() { return Math.min(doc.width, doc.height); }
  function newElement(type, opts) {
    opts = opts || {};
    var b = base(), el = { id: DR.newId(), type: type };
    if (type === 'text') {
      Object.assign(el, { w: round(doc.width * 0.5), h: round(Math.max(16, b * 0.18)), text: 'Metin', font: 'Inter', size: round(Math.max(10, b * 0.12)), weight: 400,
        align: 'left', valign: 'top', color: 'black', fit: 'shrink', maxLines: 1, lineHeight: 1.15, bg: null });
    } else if (type === 'rect') {
      Object.assign(el, { w: round(doc.width * 0.3), h: round(doc.height * 0.3), fill: 'black', stroke: null, strokeWidth: 2, radius: 0 });
    } else if (type === 'ellipse') {
      var s = round(b * 0.35);
      Object.assign(el, { w: s, h: s, fill: null, stroke: 'black', strokeWidth: 2 });
    } else if (type === 'line') {
      Object.assign(el, { w: round(doc.width * 0.5), h: Math.max(1, round(b / 60)), color: 'black', dashed: false });
    } else if (type === 'barcode') {
      Object.assign(el, { w: Math.min(doc.width, Math.max(100, round(doc.width * 0.5))), h: Math.max(30, round(b * 0.3)), format: 'EAN13', value: '{{barkod}}', showText: true, color: 'black' });
    } else if (type === 'qr') {
      var q = Math.max(42, round(b * 0.5));
      Object.assign(el, { w: q, h: q, value: 'https://', color: 'black' });
    } else if (type === 'image') {
      Object.assign(el, { w: opts.w, h: opts.h, src: opts.src, fit: 'contain', dither: true, threshold: 128, color: 'black' });
    }
    if (opts.field) {
      var f = opts.field;
      el.text = '{{' + f + '}}';
      if (f === 'fiyat') Object.assign(el, { font: 'Oswald', weight: 700, size: round(Math.max(18, b * 0.3)), h: round(Math.max(24, b * 0.36)), w: round(doc.width * 0.4), align: 'center', valign: 'middle' });
      else if (f === 'urun_adi') Object.assign(el, { font: 'Roboto Condensed', weight: 700, maxLines: 2, h: round(Math.max(28, b * 0.3)) });
      else if (f === 'icerik') Object.assign(el, { maxLines: 8, h: round(doc.height * 0.4), lineHeight: 1.25 });
      else if (f === 'tarih' || f === 'saat') Object.assign(el, { font: 'Roboto Condensed', weight: 700, w: round(Math.max(60, doc.width * 0.25)) });
    }
    return el;
  }
  function placeAt(el, p) {
    var cx = p ? p.x : doc.width / 2, cy = p ? p.y : doc.height / 2;
    el.w = Math.min(el.w, doc.width); el.h = Math.min(el.h, doc.height);
    el.x = round(Math.max(0, Math.min(doc.width - el.w, cx - el.w / 2)));
    el.y = round(Math.max(0, Math.min(doc.height - el.h, cy - el.h / 2)));
  }
  function addElement(el, p) {
    if (!canModify) return;
    placeAt(el, p);
    doc.elements.push(el);
    sel = [el.id];
    commit(); refreshAll();
  }
  function addType(type, p) {
    if (type === 'image') { pendingImagePoint = p || null; $('imageFile').click(); return; }
    if (type.indexOf('field:') === 0) {
      var f = type.slice(6);
      if (f === 'barkod') addElement(newElement('barcode'), p);
      else addElement(newElement('text', { field: f }), p);
      return;
    }
    addElement(newElement(type), p);
  }

  $('fieldMenu').innerHTML = DR.FIELDS.map(function (f) {
    return '<a class="dropdown-item" href="#" draggable="true" data-add="field:' + f.key + '"><code class="me-2 small">{{' + f.key + '}}</code>' + e(f.label) + '</a>';
  }).join('');
  $('tools').addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-add]');
    if (!t) return;
    ev.preventDefault();
    addType(t.dataset.add);
  });
  document.addEventListener('dragstart', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-add]');
    if (t) { ev.dataTransfer.setData('text/x-dz-add', t.dataset.add); ev.dataTransfer.effectAllowed = 'copy'; }
  });
  overlay.addEventListener('dragover', function (ev) {
    if (!canModify) return;
    var types = Array.prototype.slice.call(ev.dataTransfer.types);
    if (types.indexOf('text/x-dz-add') !== -1 || types.indexOf('Files') !== -1) { ev.preventDefault(); overlay.classList.add('drag-over'); }
  });
  overlay.addEventListener('dragleave', function () { overlay.classList.remove('drag-over'); });
  overlay.addEventListener('drop', function (ev) {
    overlay.classList.remove('drag-over');
    if (!canModify) return;
    ev.preventDefault();
    var p = docPoint(ev), add = ev.dataTransfer.getData('text/x-dz-add');
    if (add) addType(add, p);
    else if (ev.dataTransfer.files && ev.dataTransfer.files[0]) { pendingImagePoint = p; readImage(ev.dataTransfer.files[0]); }
  });

  // Gorsel: tuvale gore kucultulur (gereksiz buyuk dosya kaydedilmez).
  var pendingImagePoint = null;
  $('imageFile').addEventListener('change', function () {
    if (this.files[0]) readImage(this.files[0]);
    this.value = '';
  });
  function readImage(file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { App.toast('Sadece PNG, JPEG, GIF veya WEBP görsel eklenebilir.', 'danger'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var maxW = Math.min(1200, doc.width * 2), maxH = Math.min(1200, doc.height * 2);
        var s = Math.min(1, maxW / img.width, maxH / img.height);
        var c = env.createCanvas(Math.max(1, round(img.width * s)), Math.max(1, round(img.height * s)));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var src = c.toDataURL('image/png');
        if (src.length > 1500000) src = c.toDataURL('image/jpeg', 0.85);
        if (src.length > 4000000) { App.toast('Görsel çok büyük.', 'danger'); return; }
        var fit = Math.min(doc.width * 0.5 / c.width, doc.height * 0.6 / c.height);
        addElement(newElement('image', { src: src, w: Math.max(8, round(c.width * fit)), h: Math.max(8, round(c.height * fit)) }), pendingImagePoint);
        pendingImagePoint = null;
      };
      img.onerror = function () { App.toast('Görsel okunamadı.', 'danger'); };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  // ---------------- Duzenleme islemleri ----------------
  function removeSelected() {
    if (!canModify || !sel.length) return;
    doc.elements = doc.elements.filter(function (el) { return sel.indexOf(el.id) === -1 || el.locked; });
    sel = sel.filter(function (id) { return byId(id); });
    commit(); refreshAll();
  }
  function copySelected() {
    var els = selected();
    if (!els.length) return;
    clipboard = { w: doc.width, els: clone(els) };
    try { localStorage.setItem('epaper-design-clip', JSON.stringify(clipboard)); } catch (x) {}
  }
  function paste(src, offset) {
    if (!canModify) return;
    if (!src) { try { src = JSON.parse(localStorage.getItem('epaper-design-clip')); } catch (x) {} }
    src = src || clipboard;
    if (!src || !src.els || !src.els.length) return;
    var off = offset === undefined ? Math.max(4, round(base() / 20)) : offset;
    var ids = [];
    src.els.forEach(function (o) {
      var el = clone(o);
      el.id = DR.newId(); el.locked = false;
      el.x = Math.min(doc.width - 1, el.x + off); el.y = Math.min(doc.height - 1, el.y + off);
      if (doc.colors === 'bw') ['color', 'fill', 'stroke', 'bg'].forEach(function (k) { if (el[k] === 'accent') el[k] = 'black'; });
      doc.elements.push(el); ids.push(el.id);
    });
    sel = ids;
    commit(); refreshAll();
  }
  function duplicateSelected() { var els = selected(); if (els.length) paste({ els: clone(els) }); }
  function nudge(dx, dy) {
    if (!canModify) return;
    var els = selected().filter(function (el) { return !el.locked; });
    if (!els.length) return;
    els.forEach(function (el) { el.x += dx; el.y += dy; });
    scheduleRender(); drawOverlay(); renderGeometry(); commitSoon();
  }
  function align(how) {
    var els = selected().filter(function (el) { return !el.locked; });
    if (!els.length) return;
    var ref = els.length === 1 ? { x: 0, y: 0, w: doc.width, h: doc.height } : bbox(els);
    els.forEach(function (el) {
      if (how === 'left') el.x = ref.x;
      if (how === 'hcenter') el.x = round(ref.x + (ref.w - el.w) / 2);
      if (how === 'right') el.x = ref.x + ref.w - el.w;
      if (how === 'top') el.y = ref.y;
      if (how === 'vcenter') el.y = round(ref.y + (ref.h - el.h) / 2);
      if (how === 'bottom') el.y = ref.y + ref.h - el.h;
    });
    if ((how === 'hdist' || how === 'vdist') && els.length > 2) {
      var hz = how === 'hdist', sorted = els.slice().sort(function (a, b) { return hz ? a.x - b.x : a.y - b.y; });
      var total = sorted.reduce(function (s, el) { return s + (hz ? el.w : el.h); }, 0);
      var span = hz ? ref.w : ref.h, gap = (span - total) / (sorted.length - 1), pos = hz ? ref.x : ref.y;
      sorted.forEach(function (el) { if (hz) { el.x = round(pos); pos += el.w + gap; } else { el.y = round(pos); pos += el.h + gap; } });
    }
    commit(); refreshAll();
  }
  function reorder(how) {
    var ids = sel.slice();
    if (!ids.length) return;
    var list = doc.elements, picked = list.filter(function (el) { return ids.indexOf(el.id) !== -1; });
    var rest = list.filter(function (el) { return ids.indexOf(el.id) === -1; });
    if (how === 'front') doc.elements = rest.concat(picked);
    else if (how === 'back') doc.elements = picked.concat(rest);
    else {
      var arr = list.slice(), step = how === 'forward' ? 1 : -1;
      var order = arr.map(function (el, i) { return i; }).filter(function (i) { return ids.indexOf(arr[i].id) !== -1; });
      if (step > 0) order.reverse();
      order.forEach(function (i) {
        var j = i + step;
        if (j < 0 || j >= arr.length || ids.indexOf(arr[j].id) !== -1) return;
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      });
      doc.elements = arr;
    }
    commit(); refreshAll();
  }

  // ---------------- Klavye ----------------
  document.addEventListener('keydown', function (ev) {
    if (!doc) return;
    var t = ev.target, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    var mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (mod && k === 's') { ev.preventDefault(); save(); return; }
    if (typing || document.querySelector('.modal.show')) return;
    if (mod && k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
    else if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) { ev.preventDefault(); redo(); }
    else if (mod && k === 'c') { copySelected(); }
    else if (mod && k === 'x') { copySelected(); removeSelected(); }
    else if (mod && k === 'v') { ev.preventDefault(); paste(); }
    else if (mod && k === 'd') { ev.preventDefault(); duplicateSelected(); }
    else if (mod && k === 'a') { ev.preventDefault(); sel = doc.elements.filter(function (el) { return !el.hidden && !el.locked; }).map(function (el) { return el.id; }); refreshSelection(); }
    else if (mod && k === '0') { ev.preventDefault(); fitZoom(); }
    else if (mod && (k === '+' || k === '=')) { ev.preventDefault(); stepZoom(1); }
    else if (mod && k === '-') { ev.preventDefault(); stepZoom(-1); }
    else if (k === 'delete' || k === 'backspace') { ev.preventDefault(); removeSelected(); }
    else if (k === 'escape') { sel = []; refreshSelection(); }
    else if (k.indexOf('arrow') === 0 && sel.length) {
      ev.preventDefault();
      var step = ev.shiftKey ? 10 : 1;
      nudge(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    }
  });

  // ---------------- Katmanlar ----------------
  var dragLayer = null;
  function renderLayers() {
    var els = doc.elements.slice().reverse();
    $('layerCount').textContent = els.length ? els.length + ' eleman' : '';
    $('layers').innerHTML = els.length ? els.map(function (el) {
      return '<div class="dz-layer' + (sel.indexOf(el.id) !== -1 ? ' sel' : '') + (el.hidden ? ' is-hidden' : '') + '" draggable="' + canModify + '" data-id="' + el.id + '">' +
        '<i class="ti ' + (ICONS[el.type] || 'ti-point') + '"></i><span class="dz-layer-name" title="' + e(layerLabel(el)) + '">' + e(layerLabel(el)) + '</span>' +
        (canModify ? '<button class="dz-layer-btn' + (el.hidden ? ' on' : '') + '" data-toggle="hidden" title="Gizle / göster"><i class="ti ' + (el.hidden ? 'ti-eye-off' : 'ti-eye') + '"></i></button>' +
        '<button class="dz-layer-btn' + (el.locked ? ' on' : '') + '" data-toggle="locked" title="Kilitle (tuvalde seçilmez, taşınmaz)"><i class="ti ' + (el.locked ? 'ti-lock' : 'ti-lock-open') + '"></i></button>' : '') +
        '</div>';
    }).join('') : '<div class="small text-secondary py-2">Henüz eleman yok. Yukarıdan ekleyin veya tuvale sürükleyin.</div>';
  }
  $('layers').addEventListener('click', function (ev) {
    var row = ev.target.closest('.dz-layer');
    if (!row) return;
    var id = row.dataset.id, tg = ev.target.closest('[data-toggle]');
    if (tg) {
      var el = byId(id);
      el[tg.dataset.toggle] = !el[tg.dataset.toggle];
      if (tg.dataset.toggle === 'hidden' && el.hidden) sel = sel.filter(function (x) { return x !== id; });
      commit(); refreshAll();
      return;
    }
    if (ev.shiftKey) { var i = sel.indexOf(id); if (i === -1) sel.push(id); else sel.splice(i, 1); } else sel = [id];
    refreshSelection();
  });
  $('layers').addEventListener('dragstart', function (ev) {
    var row = ev.target.closest('.dz-layer');
    if (!row) return;
    dragLayer = row.dataset.id;
    ev.dataTransfer.setData('text/x-dz-layer', dragLayer);
    ev.dataTransfer.effectAllowed = 'move';
  });
  $('layers').addEventListener('dragover', function (ev) {
    if (!dragLayer) return;
    var row = ev.target.closest('.dz-layer');
    document.querySelectorAll('.dz-layer.drop-before, .dz-layer.drop-after').forEach(function (r) { r.classList.remove('drop-before', 'drop-after'); });
    if (!row || row.dataset.id === dragLayer) return;
    ev.preventDefault();
    var r = row.getBoundingClientRect();
    row.classList.add(ev.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  $('layers').addEventListener('drop', function (ev) {
    var row = ev.target.closest('.dz-layer');
    if (!row || !dragLayer) return;
    ev.preventDefault();
    var before = row.classList.contains('drop-before');
    var moving = byId(dragLayer);
    doc.elements = doc.elements.filter(function (el) { return el.id !== dragLayer; });
    var ti = doc.elements.findIndex(function (el) { return el.id === row.dataset.id; });
    // liste ters sirali: ustte gorunen = dizide sonra
    doc.elements.splice(before ? ti + 1 : ti, 0, moving);
    dragLayer = null;
    commit(); refreshAll();
  });
  $('layers').addEventListener('dragend', function () {
    dragLayer = null;
    document.querySelectorAll('.dz-layer.drop-before, .dz-layer.drop-after').forEach(function (r) { r.classList.remove('drop-before', 'drop-after'); });
  });

  // ---------------- Ozellikler paneli ----------------
  function num(prop, label, val, opts) {
    opts = opts || {};
    return '<div class="dz-num" title="' + (opts.title || label) + '"><span>' + label + '</span><input class="form-control" type="number" data-prop="' + prop + '" data-type="num" value="' + e(val) + '"' +
      (opts.min !== undefined ? ' min="' + opts.min + '"' : '') + (opts.max !== undefined ? ' max="' + opts.max + '"' : '') + (opts.step ? ' step="' + opts.step + '"' : '') + '></div>';
  }
  function swatches(prop, value, allowNone, target) {
    var t = target === 'doc' ? ' data-doc="1"' : '';
    var html = colorChoices().map(function (c) {
      return '<button type="button" class="dz-swatch' + (value === c[0] ? ' on' : '') + '" title="' + c[1] + '" data-set="' + prop + '" data-val="' + c[0] + '"' + t + ' style="background:' + DR.css(c[0], doc.colors) + '"></button>';
    }).join('');
    if (allowNone) html += '<button type="button" class="dz-swatch none' + (!value ? ' on' : '') + '" title="Yok (şeffaf)" data-set="' + prop + '" data-val=""' + t + '></button>';
    return '<div class="dz-swatches">' + html + '</div>';
  }
  function seg(prop, value, items) {
    return '<div class="btn-group dz-seg">' + items.map(function (it) {
      return '<button type="button" class="btn btn-sm' + (value === it[0] ? ' on' : '') + '" data-set="' + prop + '" data-val="' + it[0] + '" title="' + it[2] + '"><i class="ti ' + it[1] + '"></i></button>';
    }).join('') + '</div>';
  }
  function section(title, body) { return '<div class="dz-section">' + (title ? '<div class="dz-panel-title">' + title + '</div>' : '') + body + '</div>'; }
  function fieldInsert(target) {
    return '<select class="form-select form-select-sm mt-1" data-insert="' + target + '"><option value="">+ Dinamik alan ekle…</option>' +
      DR.FIELDS.map(function (f) { return '<option value="' + f.key + '">' + e(f.label) + '  {{' + f.key + '}}</option>'; }).join('') + '</select>';
  }
  function alignTools(multi) {
    var b = function (a, icon, title) { return '<button type="button" class="btn btn-sm btn-icon" data-act="align" data-val="' + a + '" title="' + title + '"><i class="ti ' + icon + '"></i></button>'; };
    return '<div class="d-flex flex-wrap gap-1">' +
      b('left', 'ti-layout-align-left', 'Sola hizala') + b('hcenter', 'ti-layout-align-center', 'Yatay ortala') + b('right', 'ti-layout-align-right', 'Sağa hizala') +
      b('top', 'ti-layout-align-top', 'Üste hizala') + b('vcenter', 'ti-layout-align-middle', 'Dikey ortala') + b('bottom', 'ti-layout-align-bottom', 'Alta hizala') +
      (multi ? b('hdist', 'ti-layout-distribute-vertical', 'Yatay eşit dağıt') + b('vdist', 'ti-layout-distribute-horizontal', 'Dikey eşit dağıt') : '') +
      '</div><div class="form-hint mt-1">' + (multi ? 'Seçili elemanlar birbirine göre hizalanır.' : 'Tuvale göre hizalanır.') + '</div>';
  }
  function orderTools() {
    var b = function (a, icon, title) { return '<button type="button" class="btn btn-sm btn-icon" data-act="order" data-val="' + a + '" title="' + title + '"><i class="ti ' + icon + '"></i></button>'; };
    return '<div class="d-flex flex-wrap gap-1">' + b('front', 'ti-stack-front', 'En öne getir') + b('forward', 'ti-arrow-up', 'Bir öne') + b('backward', 'ti-arrow-down', 'Bir arkaya') + b('back', 'ti-stack-back', 'En arkaya gönder') +
      '<span class="ms-auto"></span><button type="button" class="btn btn-sm btn-icon" data-act="dup" title="Çoğalt (Ctrl+D)"><i class="ti ti-copy"></i></button>' +
      '<button type="button" class="btn btn-sm btn-icon btn-ghost-danger" data-act="del" title="Sil (Delete)"><i class="ti ti-trash"></i></button></div>';
  }

  function renderProps() {
    var els = selected(), html = '';
    if (!els.length) html = docProps();
    else if (els.length > 1) {
      html = section(els.length + ' eleman seçili', alignTools(true)) + section('Sıralama', orderTools());
    } else html = elementProps(els[0]);
    $('props').innerHTML = canModify ? html : '<fieldset disabled>' + html + '</fieldset>';
  }
  function docProps() {
    var used = DR.usedFields(doc);
    return section('Tasarım',
        '<label class="form-label">Kategori</label><select class="form-select mb-2" data-meta="category">' +
        Object.keys(CATS).map(function (k) { return '<option value="' + k + '"' + (design.category === k ? ' selected' : '') + '>' + CATS[k] + '</option>'; }).join('') + '</select>' +
        '<label class="form-label">Açıklama</label><textarea class="form-control" rows="2" maxlength="500" data-meta="description">' + e(design.description || '') + '</textarea>') +
      section('Ekran',
        '<div class="d-flex justify-content-between small mb-1"><span class="text-secondary">Model</span><span class="fw-bold">' + e(design.modelName) + '</span></div>' +
        '<div class="d-flex justify-content-between small mb-1"><span class="text-secondary">Çözünürlük</span><span class="mono">' + doc.width + ' × ' + doc.height + ' px</span></div>' +
        '<div class="d-flex justify-content-between small mb-2"><span class="text-secondary">Renkler</span><span>' + e(COLOR_TYPES[doc.colors] || doc.colors) + '</span></div>' +
        '<label class="form-label">Arka plan</label>' + swatches('background', doc.background || 'white', false, 'doc')) +
      section('Kullanılan dinamik alanlar', used.length ? '<div class="d-flex flex-wrap gap-1">' + used.map(function (k) { return '<span class="badge bg-blue-lt">' + e(fieldLabel(k)) + '</span>'; }).join('') + '</div>' :
        '<div class="small text-secondary">Henüz yok. "Dinamik Alan" ile ürün adı, fiyat gibi alanlar ekleyin; etiket gönderilirken gerçek verilerle dolar.</div>') +
      section('İpuçları', '<div class="small text-secondary lh-lg">Elemanları sürükleyin, köşelerden boyutlandırın. <b>Shift</b> ile çoklu seçim / oran koruma, <b>Alt</b> ile hizalama yakalamasını kapatın. Ok tuşları 1 px, Shift+ok 10 px taşır. Çift tıklama metni düzenler.</div>');
  }
  function elementProps(el) {
    var html = section(TYPE_LABELS[el.type] + ' · konum ve boyut',
      '<input class="form-control mb-2" data-prop="name" placeholder="Katman adı (isteğe bağlı)" value="' + e(el.name || '') + '">' +
      '<div class="dz-grid2 geom">' + num('x', 'X', el.x) + num('y', 'Y', el.y) + num('w', '↔', el.w, { min: 1, title: 'Genişlik' }) + num('h', '↕', el.h, { min: 1, title: 'Yükseklik' }) + '</div>' +
      '<div class="d-flex gap-3 mt-2"><label class="form-check mb-0"><input class="form-check-input" type="checkbox" data-prop="hidden"' + (el.hidden ? ' checked' : '') + '><span class="form-check-label small">Gizli</span></label>' +
      '<label class="form-check mb-0"><input class="form-check-input" type="checkbox" data-prop="locked"' + (el.locked ? ' checked' : '') + '><span class="form-check-label small">Kilitli</span></label></div>');

    if (el.type === 'text') {
      html += section('Yazı',
        '<textarea class="form-control" rows="3" data-prop="text">' + e(el.text || '') + '</textarea>' + fieldInsert('text') +
        '<div class="dz-grid2 mt-2"><div><label class="form-label">Yazı tipi</label><select class="form-select" data-prop="font">' +
        DR.FONTS.map(function (f) { return '<option value="' + e(f.family) + '"' + (el.font === f.family ? ' selected' : '') + '>' + e(f.label) + '</option>'; }).join('') + '</select></div>' +
        '<div><label class="form-label">Boyut (px)</label><input class="form-control" type="number" min="4" max="400" data-prop="size" data-type="num" value="' + (el.size || 16) + '"></div></div>' +
        '<div class="d-flex gap-2 mt-2 flex-wrap">' + seg('weight', el.weight === 700 ? 700 : 400, [[400, 'ti-letter-case', 'Normal'], [700, 'ti-bold', 'Kalın']]).replace(/data-val="(\d+)"/g, 'data-val="$1" data-type="num"') +
        seg('align', el.align || 'left', [['left', 'ti-align-left', 'Sola'], ['center', 'ti-align-center', 'Ortala'], ['right', 'ti-align-right', 'Sağa']]) +
        seg('valign', el.valign || 'top', [['top', 'ti-arrow-bar-to-up', 'Üst'], ['middle', 'ti-arrows-vertical', 'Orta'], ['bottom', 'ti-arrow-bar-to-down', 'Alt']]) + '</div>' +
        '<div class="dz-grid2 mt-2"><div><label class="form-label">Sığdırma</label><select class="form-select" data-prop="fit">' +
        [['shrink', 'Küçülterek sığdır'], ['wrap', 'Satır kaydır'], ['none', 'Sabit boyut']].map(function (o) { return '<option value="' + o[0] + '"' + ((el.fit || 'shrink') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
        '<div><label class="form-label">En fazla satır</label><input class="form-control" type="number" min="1" max="30" data-prop="maxLines" data-type="num" value="' + (el.maxLines || 1) + '"></div></div>' +
        '<label class="form-label mt-2">Satır aralığı</label><input type="range" class="form-range" min="0.8" max="2" step="0.05" data-prop="lineHeight" data-type="num" value="' + (el.lineHeight || 1.15) + '">' +
        '<label class="form-label mt-1">Yazı rengi</label>' + swatches('color', el.color || 'black') +
        '<label class="form-label mt-2">Arka plan</label>' + swatches('bg', el.bg || null, true) +
        '<div class="form-hint mt-2">"Küçülterek sığdır": uzun ürün adları kutuya sığana kadar otomatik küçülür.</div>');
    } else if (el.type === 'rect' || el.type === 'ellipse') {
      html += section('Görünüm',
        '<label class="form-label">Dolgu</label>' + swatches('fill', el.fill || null, true) +
        '<label class="form-label mt-2">Kenarlık</label>' + swatches('stroke', el.stroke || null, true) +
        '<div class="dz-grid2 mt-2"><div><label class="form-label">Kenarlık kalınlığı</label><input class="form-control" type="number" min="1" max="50" data-prop="strokeWidth" data-type="num" value="' + (el.strokeWidth || 1) + '"></div>' +
        (el.type === 'rect' ? '<div><label class="form-label">Köşe yarıçapı</label><input class="form-control" type="number" min="0" max="500" data-prop="radius" data-type="num" value="' + (el.radius || 0) + '"></div>' : '') + '</div>');
    } else if (el.type === 'line') {
      html += section('Çizgi ayarları',
        '<label class="form-label">Renk</label>' + swatches('color', el.color || 'black') +
        '<label class="form-check mt-2 mb-0"><input class="form-check-input" type="checkbox" data-prop="dashed"' + (el.dashed ? ' checked' : '') + '><span class="form-check-label">Kesikli</span></label>' +
        '<div class="form-hint mt-2">Kalınlık için yüksekliği (yatay çizgi) veya genişliği (dikey çizgi) değiştirin.</div>');
    } else if (el.type === 'image') {
      html += section('Görsel ayarları',
        '<button type="button" class="btn btn-sm w-100 mb-2" data-act="replace-image"><i class="ti ti-replace me-1"></i>Görseli değiştir</button>' +
        '<label class="form-label">Yerleşim</label><select class="form-select" data-prop="fit">' +
        [['contain', 'Sığdır'], ['cover', 'Doldur (kırp)'], ['stretch', 'Uzat']].map(function (o) { return '<option value="' + o[0] + '"' + ((el.fit || 'contain') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '<label class="form-check mt-2 mb-1"><input class="form-check-input" type="checkbox" data-prop="dither"' + (el.dither !== false ? ' checked' : '') + '><span class="form-check-label">Titreklestirme (fotoğraflar için)</span></label>' +
        '<label class="form-label">Eşik: <span id="thrVal">' + (el.threshold || 128) + '</span></label><input type="range" class="form-range" min="20" max="235" data-prop="threshold" data-type="num" value="' + (el.threshold || 128) + '">' +
        '<label class="form-label mt-1">Mürekkep rengi</label>' + swatches('color', el.color || 'black') +
        '<div class="form-hint mt-2">E-paper ekranda gri ton yoktur; görsel siyah-beyaza çevrilir. Logolar için titreklestirmeyi kapatıp eşiği ayarlayın.</div>');
    } else if (el.type === 'barcode') {
      html += section('Barkod ayarları',
        '<label class="form-label">Tür</label><select class="form-select" data-prop="format"><option value="EAN13"' + (el.format !== 'CODE128' ? ' selected' : '') + '>EAN-13 (market ürünleri)</option><option value="CODE128"' + (el.format === 'CODE128' ? ' selected' : '') + '>Code 128 (harf + rakam)</option></select>' +
        '<label class="form-label mt-2">Değer</label><input class="form-control mono" data-prop="value" value="' + e(el.value || '') + '">' + fieldInsert('value') +
        '<label class="form-check mt-2 mb-1"><input class="form-check-input" type="checkbox" data-prop="showText"' + (el.showText !== false ? ' checked' : '') + '><span class="form-check-label">Altında numarayı göster</span></label>' +
        '<label class="form-label">Renk</label>' + swatches('color', el.color || 'black') +
        '<div class="form-hint mt-2">Okunabilirlik için barkod genişliği en az ' + (el.format === 'CODE128' ? '~11 px/karakter' : '95 px') + ' olmalı; siyah renk önerilir.</div>');
    } else if (el.type === 'qr') {
      html += section('QR ayarları',
        '<label class="form-label">İçerik (bağlantı veya metin)</label><input class="form-control" data-prop="value" value="' + e(el.value || '') + '">' + fieldInsert('value') +
        '<label class="form-label mt-2">Renk</label>' + swatches('color', el.color || 'black') +
        '<div class="form-hint mt-2">Kısa içerik daha büyük ve okunaklı kare üretir.</div>');
    }
    html += section('Hizalama', alignTools(false)) + section('Sıralama', orderTools());
    return html;
  }
  // Suruklerken sadece konum/boyut kutularini guncelle (odak kaybolmasin)
  function renderGeometry() {
    var el = sel.length === 1 && byId(sel[0]);
    if (!el) return;
    ['x', 'y', 'w', 'h'].forEach(function (k) {
      var inp = document.querySelector('#props .geom [data-prop="' + k + '"]');
      if (inp && document.activeElement !== inp) inp.value = el[k];
    });
  }

  function readInput(inp) {
    if (inp.type === 'checkbox') return inp.checked;
    if (inp.dataset.type === 'num') { var n = Number(inp.value); return isFinite(n) && inp.value !== '' ? n : undefined; }
    return inp.value;
  }
  function setProp(el, prop, v) {
    if (v === undefined) return;
    if (['x', 'y', 'w', 'h', 'size', 'strokeWidth', 'radius', 'maxLines', 'threshold'].indexOf(prop) !== -1) v = round(v);
    if ((prop === 'w' || prop === 'h') && v < 1) v = 1;
    if (prop === 'name') v = String(v).slice(0, 60);
    el[prop] = v;
    if (prop === 'hidden' && v) sel = sel.filter(function (id) { return id !== el.id; });
  }
  var propsEl = $('props');
  propsEl.addEventListener('input', function (ev) {
    var inp = ev.target;
    if (inp.dataset.meta) { design[inp.dataset.meta] = inp.value; metaDirty = true; updateState(); return; }
    if (!inp.dataset.prop) return;
    var el = selected()[0];
    if (!el) return;
    setProp(el, inp.dataset.prop, readInput(inp));
    if (inp.dataset.prop === 'threshold' && $('thrVal')) $('thrVal').textContent = inp.value;
    scheduleRender(); drawOverlay(); renderLayers(); updateState();
  });
  propsEl.addEventListener('change', function (ev) {
    var inp = ev.target;
    if (inp.dataset.meta) { design[inp.dataset.meta] = inp.value; metaDirty = true; updateState(); return; }
    if (inp.dataset.insert) {
      var key = inp.value;
      inp.value = '';
      if (!key) return;
      var target = propsEl.querySelector('[data-prop="' + inp.dataset.insert + '"]'), el = selected()[0];
      var token = '{{' + key + '}}', pos = target.selectionStart != null ? target.selectionStart : target.value.length;
      var endPos = target.selectionEnd != null ? target.selectionEnd : pos;
      target.value = el.type === 'text' ? target.value.slice(0, pos) + token + target.value.slice(endPos) : token;
      setProp(el, inp.dataset.insert, target.value);
      commit(); refreshAll();
      return;
    }
    if (!inp.dataset.prop) return;
    if (inp.type === 'checkbox') {
      var el2 = selected()[0];
      if (el2) setProp(el2, inp.dataset.prop, inp.checked);
      commit(); refreshAll();
      return;
    }
    commit();
    if (['x', 'y', 'w', 'h'].indexOf(inp.dataset.prop) !== -1) inp.value = selected()[0] ? selected()[0][inp.dataset.prop] : inp.value;
  });
  propsEl.addEventListener('click', function (ev) {
    var s = ev.target.closest('[data-set]');
    if (s) {
      var v = s.dataset.type === 'num' ? Number(s.dataset.val) : (s.dataset.val === '' ? null : s.dataset.val);
      if (s.dataset.doc) doc[s.dataset.set] = v;
      else selected().forEach(function (el) { el[s.dataset.set] = v; });
      commit(); refreshAll();
      return;
    }
    var a = ev.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'align') align(a.dataset.val);
    else if (a.dataset.act === 'order') reorder(a.dataset.val);
    else if (a.dataset.act === 'dup') duplicateSelected();
    else if (a.dataset.act === 'del') removeSelected();
    else if (a.dataset.act === 'replace-image') { replaceImageId = sel[0]; $('imageFile2').click(); }
  });
  // Gorsel degistirme icin ayri dosya secici (mevcut elemanin yerine)
  var replaceImageId = null;
  var f2 = document.createElement('input');
  f2.type = 'file'; f2.accept = 'image/png,image/jpeg,image/gif,image/webp'; f2.id = 'imageFile2'; f2.hidden = true;
  document.body.appendChild(f2);
  f2.addEventListener('change', function () {
    var file = this.files[0], el = byId(replaceImageId);
    this.value = '';
    if (!file || !el) return;
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, Math.min(1200, doc.width * 2) / img.width, Math.min(1200, doc.height * 2) / img.height);
        var c = env.createCanvas(Math.max(1, round(img.width * s)), Math.max(1, round(img.height * s)));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var src = c.toDataURL('image/png');
        if (src.length > 1500000) src = c.toDataURL('image/jpeg', 0.85);
        el.src = src;
        commit(); refreshAll();
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });

  // ---------------- Ornek veri paneli ----------------
  function renderDataForm() {
    $('dataForm').innerHTML = DR.FIELDS.filter(function (f) { return !f.auto; }).map(function (f) {
      var v = data[f.key] == null ? '' : data[f.key];
      return '<div class="mb-2"><label class="form-label small mb-1">' + e(f.label) + ' <code class="small">{{' + f.key + '}}</code></label>' +
        (f.key === 'icerik' ? '<textarea class="form-control form-control-sm" rows="4" data-field="' + f.key + '">' + e(v) + '</textarea>'
          : '<input class="form-control form-control-sm" data-field="' + f.key + '" value="' + e(v) + '">') + '</div>';
    }).join('') + '<div class="small text-secondary">Tarih ve saat alanları otomatik doldurulur.</div>';
  }
  $('dataForm').addEventListener('input', function (ev) {
    var k = ev.target.dataset.field;
    if (!k) return;
    data[k] = ev.target.value;
    saveData(); scheduleRender();
  });
  $('dataReset').addEventListener('click', function () {
    data = DR.sampleData(); saveData(); renderDataForm(); scheduleRender();
  });

  // ---------------- Genel yenileme ----------------
  var metaDirty = false;
  function refreshSelection() { drawOverlay(); renderLayers(); renderProps(); }
  function refreshAll() { scheduleRender(); refreshSelection(); updateState(); }

  // ---------------- Kaydetme ----------------
  async function makeThumb() {
    var c = env.createCanvas(doc.width, doc.height);
    await DR.render(c.getContext('2d'), doc, DR.sampleData(), env, {});
    // kucuk paneller 2x (piksel piksel), buyukler en fazla 640 px genislige
    var s = doc.width <= 320 ? 2 : Math.min(1, 640 / doc.width);
    var t = env.createCanvas(Math.max(1, round(doc.width * s)), Math.max(1, round(doc.height * s)));
    var g = t.getContext('2d');
    g.imageSmoothingEnabled = s < 1;
    g.drawImage(c, 0, 0, t.width, t.height);
    var url = t.toDataURL('image/png');
    return url.length < 290000 ? url : null;
  }
  async function save() {
    if (!doc) return;
    if (mode === 'view') return;
    if (mode === 'copy') return saveAsCopy();
    var name = $('dName').value.trim();
    if (!name) { App.toast('Tasarım adı boş olamaz.', 'danger'); $('dName').focus(); return; }
    var btn = $('saveBtn');
    App.setBusy(btn, true);
    try {
      var thumb = await makeThumb();
      var r = await App.apiRequest('POST', '/api/designs/' + designId, { name: name, doc: doc, thumbnail: thumb, category: design.category, description: design.description || '' });
      savedJson = snapshot(); savedName = name; metaDirty = false;
      design.name = name; design.version = r.version;
      updateMeta(); updateState();
      App.toast('Tasarım kaydedildi (sürüm ' + r.version + ').');
    } catch (err) {
      App.toast(err.message, 'danger');
    } finally {
      App.setBusy(btn, false);
    }
  }
  function saveAsCopy() {
    var name = $('dName').value.trim() || design.name;
    return App.prompt('Kopya olarak kaydet', 'Yeni tasarımın adı', name + ' (kopya)', { okText: 'Kopyala ve Aç' }).then(function (newName) {
      if (!newName) return;
      return App.apiRequest('POST', '/api/designs/' + designId + '/duplicate', { name: newName }).then(function (r) {
        // mevcut (degistirilmis olabilecek) hali yeni tasarima yaz
        return makeThumb().then(function (thumb) {
          return App.apiRequest('POST', '/api/designs/' + r.id, { doc: doc, thumbnail: thumb });
        }).then(function () {
          savedJson = snapshot(); savedName = $('dName').value.trim(); metaDirty = false;
          location.href = '/designs/' + r.id + '/edit';
        });
      }).catch(function (err) { App.toast(err.message, 'danger'); });
    });
  }
  function downloadPng() {
    fetch('/api/designs-render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: doc, data: data, scale: 3 }) })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t.replace(/^HATA:\s*/, '')); }); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = ($('dName').value.trim() || 'tasarim') + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }).catch(function (err) { App.toast(err.message, 'danger'); });
  }
  function showHistory() {
    App.apiRequest('GET', '/api/designs/' + designId + '/versions').then(function (rows) {
      var html = '<div class="small text-secondary mb-2">Her kayıtta önceki hal saklanır (son 50 sürüm). Şu anki sürüm: <b>v' + design.version + '</b></div>' +
        (rows.length ? '<div class="list-group list-group-flush">' + rows.map(function (v) {
          return '<div class="list-group-item d-flex align-items-center px-0"><div class="flex-fill"><div class="fw-bold">Sürüm ' + v.version + '</div><div class="small text-secondary">' + App.formatDate(v.created_at) + ' · ' + e(v.username || '') + '</div></div>' +
            (mode === 'edit' ? '<button type="button" class="btn btn-sm" data-restore="' + v.version + '"><i class="ti ti-restore me-1"></i>Geri yükle</button>' : '') + '</div>';
        }).join('') + '</div>' : '<div class="empty py-3"><p class="empty-title">Henüz eski sürüm yok</p></div>');
      var p = App.dialog({ title: 'Sürüm Geçmişi', html: html, okText: 'Kapat', cancelText: 'Vazgeç', onOk: function () { return true; } });
      setTimeout(function () {
        document.querySelectorAll('[data-restore]').forEach(function (b) {
          b.onclick = function () {
            var v = b.dataset.restore;
            var go = function () {
              App.apiRequest('POST', '/api/designs/' + designId + '/versions/' + v + '/restore', {}).then(function () {
                savedJson = snapshot(); savedName = $('dName').value.trim(); metaDirty = false;
                location.reload();
              }).catch(function (err) { App.toast(err.message, 'danger'); });
            };
            if (isDirty() && !window.confirm('Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?')) return;
            go();
          };
        });
      }, 60);
      return p;
    }).catch(function (err) { App.toast(err.message, 'danger'); });
  }
  function showShortcuts() {
    var rows = [['Ctrl + S', 'Kaydet'], ['Ctrl + Z / Ctrl + Y', 'Geri al / yinele'], ['Ctrl + C / X / V', 'Kopyala / kes / yapıştır (tasarımlar arası da çalışır)'],
      ['Ctrl + D', 'Çoğalt'], ['Ctrl + A', 'Tümünü seç'], ['Delete', 'Seçileni sil'], ['Ok tuşları', '1 px taşı (Shift ile 10 px)'],
      ['Shift + tıklama', 'Çoklu seçim'], ['Shift + sürükleme', 'Tek eksende taşı / köşeden oranlı boyutlandır'], ['Alt + sürükleme', 'Hizalama yakalamasını kapat'],
      ['Ctrl + tekerlek', 'Yakınlaş / uzaklaş'], ['Ctrl + 0', 'Ekrana sığdır'], ['Çift tıklama', 'Metni düzenle'], ['Esc', 'Seçimi kaldır']];
    App.dialog({ title: 'Klavye Kısayolları', okText: 'Tamam', onOk: function () { return true; },
      html: '<table class="table table-sm mb-0">' + rows.map(function (r) { return '<tr><td class="text-nowrap"><kbd class="dz-kbd">' + e(r[0]) + '</kbd></td><td class="small">' + e(r[1]) + '</td></tr>'; }).join('') + '</table>' });
  }

  function updateMeta() {
    var scope = design.scope === 'global' ? 'Hazır şablon (merkez)' : (design.dealerName || 'Bayi');
    $('dMeta').textContent = design.modelName + ' · ' + doc.width + '×' + doc.height + ' · ' + (COLOR_TYPES[doc.colors] || doc.colors) + ' · ' + scope + ' · v' + design.version;
    document.title = (design.name || 'Tasarım') + ' · Tasarım Editörü';
  }

  // ---------------- Baslangic ----------------
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', function () { stepZoom(1); });
  $('zoomOut').addEventListener('click', function () { stepZoom(-1); });
  $('zoomFit').addEventListener('click', fitZoom);
  $('epaperView').addEventListener('change', function () { epaper = this.checked; scheduleRender(); });
  $('saveBtn').addEventListener('click', save);
  $('pngBtn').addEventListener('click', function (ev) { ev.preventDefault(); downloadPng(); });
  $('historyBtn').addEventListener('click', function (ev) { ev.preventDefault(); showHistory(); });
  $('copyBtn').addEventListener('click', function (ev) { ev.preventDefault(); saveAsCopy(); });
  $('readonlyCopy').addEventListener('click', function (ev) { ev.preventDefault(); saveAsCopy(); });
  $('shortcutsBtn').addEventListener('click', function (ev) { ev.preventDefault(); showShortcuts(); });
  $('dName').addEventListener('input', updateState);
  window.addEventListener('resize', function () { if (doc && zoom < 1) fitZoom(); });
  window.addEventListener('beforeunload', function (ev) {
    if (doc && mode === 'edit' && isDirty()) { ev.preventDefault(); ev.returnValue = ''; }
  });

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = [];
    DR.FONTS.forEach(function (f) { f.weights.forEach(function (w) { loads.push(document.fonts.load(w + ' 16px "' + f.family + '"')); }); });
    return Promise.all(loads).catch(function () {});
  }

  Promise.all([App.meReady, App.apiRequest('GET', '/api/designs/' + designId), fontsReady()]).then(function (res) {
    var me = res[0];
    design = res[1];
    doc = design.doc;
    doc.elements = doc.elements || [];
    mode = design.editable ? 'edit' : me.can['design.manage'] ? 'copy' : 'view';
    canModify = mode !== 'view';
    $('dName').value = design.name;
    $('dName').readOnly = mode !== 'edit';
    savedName = design.name;
    savedJson = snapshot();
    hist = [savedJson]; hIndex = 0;
    if (mode !== 'edit') {
      $('readonlyBar').hidden = false;
      $('readonlyText').textContent = design.scope === 'global'
        ? 'Bu bir hazır şablon (merkez kütüphanesi). Değişikliklerinizi kendi tasarımınız olarak kaydedebilirsiniz.'
        : 'Bu tasarımı düzenleme yetkiniz yok.';
      $('readonlyCopy').hidden = mode === 'view';
      $('historyBtn').hidden = false;
      if (mode === 'copy') $('saveBtn').innerHTML = '<i class="ti ti-copy me-1"></i>Kopya Olarak Kaydet';
      else { $('saveBtn').hidden = true; $('copyBtn').hidden = true; }
    }
    if (!canModify) document.querySelectorAll('.dz-tool').forEach(function (b) { b.disabled = true; });
    updateMeta();
    renderDataForm();
    fitZoom();
    refreshAll();
  }).catch(function (err) {
    $('dMeta').textContent = err.message;
    App.toast(err.message, 'danger');
  });
})();
