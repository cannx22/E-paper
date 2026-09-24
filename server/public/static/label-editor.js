// Etiket gonderme sayfasi: hedef secimi, form, e-paper onizleme, kayitli
// urunler ve Excel ile toplu gonderim.
// ---- Gateway secimi: onayli gateway'ler, cevrimici durumu 10 sn'de bir
// yenilenir. Son secilen gateway tarayicida hatirlanir. ----
var GATEWAY_KEY = 'esp32_nrf_gateway_selected_v1';
var gatewaySelect = document.getElementById('gatewaySelect');
var gatewayList = [];

function updateGatewayStatus(){
  var el = document.getElementById('gatewayStatus');
  var g = gatewayList.filter(function(x){ return x.id === gatewaySelect.value; })[0];
  if (!g){ el.className = 'form-hint'; el.textContent = ''; return; }
  var scope = g.dealerName ? ' · ' + g.dealerName + (g.branchName ? ' / ' + g.branchName : '') : '';
  if (!g.online){
    el.className = 'form-hint text-danger';
    el.textContent = '○ Çevrimdışı - son görülme: ' + formatDate(g.lastSeen) + scope;
  } else if (g.status === 'error'){
    el.className = 'form-hint text-warning';
    el.textContent = '● Çevrimiçi ama hata var: ' + (g.lastError || 'nRF24 modülü hazır değil') + scope;
  } else {
    el.className = 'form-hint text-success';
    el.textContent = '● Çevrimiçi' + scope;
  }
}

function loadGateways(){
  return apiRequest('GET', '/api/gateways').then(function(list){
    // Etiket gonderilebilen gateway'ler: aktif olanlar (cevrimdisi/hatali
    // olsa da listede kalir, durumu altta gosterilir).
    gatewayList = list.filter(function(g){ return g.state === 'active'; });
    var selected = gatewaySelect.value || localStorage.getItem(GATEWAY_KEY) || '';
    if (!gatewayList.length){
      gatewaySelect.innerHTML = '<option value="">(aktif gateway yok)</option>';
    } else {
      gatewaySelect.innerHTML = gatewayList.map(function(g){
        return '<option value="' + escapeHtml(g.id) + '">' + (g.online ? '● ' : '○ ') +
          escapeHtml(g.name) + ' (' + escapeHtml(g.id.slice(-6)) + ')</option>';
      }).join('');
      if (gatewayList.some(function(g){ return g.id === selected; })) gatewaySelect.value = selected;
    }
    updateGatewayStatus();
  }).catch(function(){});
}
gatewaySelect.addEventListener('change', function(){
  localStorage.setItem(GATEWAY_KEY, gatewaySelect.value);
  updateGatewayStatus();
});
setInterval(loadGateways, 10000);

// ---- Hedef cihaz (8 haneli seri no). Kayitli cihazlarda gateway cihaz
// kaydindan otomatik secilir; kayitli olmayan seri no icin secili gateway
// kullanilir. ?serial=12345678 ile sayfa hedefi dolu acilir (Cihazlar
// sayfasindaki "Etiket Gonder"). ----
var serialInput = document.getElementById('serialInput');
var deviceMap = {};

function isValidSerial(s){ return /^\d{8}$/.test(s); }

function updateDeviceInfo(){
  var el = document.getElementById('deviceInfo');
  var s = serialInput.value.trim();
  var d = deviceMap[s];
  if (!s){ el.textContent = ''; return; }
  if (!isValidSerial(s)){ el.className = 'form-hint text-danger'; el.textContent = 'Seri no 8 haneli rakam olmalı.'; return; }
  if (!d){ el.className = 'form-hint'; el.textContent = 'Kayıtlı olmayan cihaz - seçili gateway üzerinden gönderilir.'; return; }
  el.className = 'form-hint ' + (d.state === 'active' ? 'text-success' : 'text-danger');
  el.textContent = (d.name || 'Kayıtlı cihaz') + (d.modelName ? ' · ' + d.modelName : '') +
    (d.state !== 'active' ? ' · DEVRE DIŞI' : '') + (d.gatewayName ? '' : ' · gateway atanmamış');
  if (d.gatewayId && gatewayList.some(function(g){ return g.id === d.gatewayId; })){
    gatewaySelect.value = d.gatewayId;
    updateGatewayStatus();
  }
}
serialInput.addEventListener('input', function(){
  serialInput.value = serialInput.value.replace(/\D/g, '').slice(0, 8);
  updateDeviceInfo();
});

function loadDevices(){
  return apiRequest('GET', '/api/devices?limit=2000').then(function(r){
    deviceMap = {};
    r.devices.forEach(function(d){ deviceMap[d.serial] = d; });
    document.getElementById('deviceOptions').innerHTML = r.devices.map(function(d){
      return '<option value="' + escapeHtml(d.serial) + '">' + escapeHtml((d.name || '') + (d.gatewayName ? ' · ' + d.gatewayName : '')) + '</option>';
    }).join('');
    updateDeviceInfo();
  }).catch(function(){});
}
var initialSerial = new URLSearchParams(location.search).get('serial');
if (initialSerial) serialInput.value = initialSerial.replace(/\D/g, '').slice(0, 8);
Promise.all([loadGateways(), loadDevices()]).then(updateDeviceInfo);

// ---- Turkce kodlama (label_payload.cpp / protocol.py ile birebir) ----
var TURKISH_CODES = {'Ç':1,'ç':2,'Ğ':3,'ğ':4,'İ':5,'ı':6,
                      'Ö':7,'ö':8,'Ş':9,'ş':10,'Ü':11,'ü':12};
function encodedLength(s){
  var n = 0;
  for (var i = 0; i < s.length; i++) n += 1;
  return n;
}
function bindCounter(inputEl, counterEl, max){
  function update(){
    var len = encodedLength(inputEl.value);
    if (len > max){
      var v = inputEl.value;
      while (encodedLength(v) > max && v.length > 0) v = v.slice(0, -1);
      inputEl.value = v;
      len = encodedLength(v);
    }
    counterEl.textContent = len + '/' + max;
    counterEl.classList.toggle('over', len >= max);
  }
  inputEl.addEventListener('input', update);
  update();
}
bindCounter(document.getElementById('businessInput'), document.getElementById('cnt-business'), 16);
bindCounter(document.getElementById('productInput'), document.getElementById('cnt-name'), 34);
bindCounter(document.getElementById('subtitleInput'), document.getElementById('cnt-subtitle'), 16);
bindCounter(document.getElementById('priceInput'), document.getElementById('cnt-price'), 6);
bindCounter(document.getElementById('oldPriceInput'), document.getElementById('cnt-oldPrice'), 6);
bindCounter(document.getElementById('bottomCodeInput'), document.getElementById('cnt-bottomCode'), 14);

// ---- Sablon secimine gore barkod alanini gizle/goster (Basic'te barkod yok) ----
var templateSelect = document.getElementById('templateSelect');
var barcodeWrap = document.getElementById('barcodeWrap');
function updateBarcodeVisibility(){
  barcodeWrap.style.display = (templateSelect.value === '4') ? 'none' : 'block';
}
templateSelect.addEventListener('change', function(){ updateBarcodeVisibility(); scheduleRender(); });

// ---- Kategoriye gore onerilen sablon/birim (mevcut 3 sabit sablonu
// kategoriye esler - receiver tarafinda degisiklik gerektirmez) ----
var CATEGORY_DEFAULTS = {
  manav:     { templateID: '1', unit: 'KG' },
  kasap:     { templateID: '1', unit: 'KG' },
  sarkuteri: { templateID: '3', unit: 'KG' },
  kozmetik:  { templateID: '4', unit: 'ADET' }
};
document.getElementById('categorySelect').addEventListener('change', function(e){
  var def = CATEGORY_DEFAULTS[e.target.value];
  if (!def) return;
  templateSelect.value = def.templateID;
  document.getElementById('unitInput').value = def.unit;
  updateBarcodeVisibility();
  scheduleRender();
});
updateBarcodeVisibility();

document.getElementById('randomBarcodeBtn').addEventListener('click', function(){
  var digits = '';
  for (var i = 0; i < 12; i++) digits += Math.floor(Math.random() * 10);
  document.getElementById('barcodeInput').value = digits;
  scheduleRender();
});

// ---- Kayitli urunler (tarayici localStorage'inda, cihaza gore degil) ----
var PRESET_KEY = 'esp32_nrf_gateway_presets_v1';
function loadPresets(){
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch(e) { return {}; }
}
function savePresets(obj){ localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); }
function refreshPresetSelect(selectName){
  var presets = loadPresets();
  var sel = document.getElementById('presetSelect');
  sel.innerHTML = '';
  var names = Object.keys(presets);
  if (names.length === 0){
    sel.innerHTML = '<option value="">(kayıtlı ürün yok)</option>';
    return;
  }
  names.sort().forEach(function(n){
    var opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    sel.appendChild(opt);
  });
  if (selectName && presets[selectName]) sel.value = selectName;
}
function collectFormValues(){
  return {
    serial: serialInput.value.trim(),
    templateID: templateSelect.value,
    discountEnabled: document.getElementById('discountEnabled').checked,
    campaignEnabled: document.getElementById('campaignEnabled').checked,
    business: document.getElementById('businessInput').value,
    name: document.getElementById('productInput').value,
    subtitle: document.getElementById('subtitleInput').value,
    price: document.getElementById('priceInput').value,
    oldPrice: document.getElementById('oldPriceInput').value,
    unit: document.getElementById('unitInput').value,
    bottomCode: document.getElementById('bottomCodeInput').value,
    barcode: document.getElementById('barcodeInput').value
  };
}
// Kayitli urun yuklenirken hedef seri no degistirilmez (urun baska
// etikete de basilabilir).
function applyFormValues(v){
  templateSelect.value = v.templateID || '1';
  document.getElementById('discountEnabled').checked = !!v.discountEnabled;
  document.getElementById('campaignEnabled').checked = !!v.campaignEnabled;
  document.getElementById('businessInput').value = v.business || '';
  document.getElementById('productInput').value = v.name || '';
  document.getElementById('subtitleInput').value = v.subtitle || '';
  document.getElementById('priceInput').value = v.price || '';
  document.getElementById('oldPriceInput').value = v.oldPrice || '';
  document.getElementById('unitInput').value = v.unit || '';
  document.getElementById('bottomCodeInput').value = v.bottomCode || '';
  document.getElementById('barcodeInput').value = v.barcode || '';
  updateBarcodeVisibility();
  scheduleRender();
}
document.getElementById('presetSaveBtn').addEventListener('click', function(){
  var name = document.getElementById('productInput').value.trim() ||
             document.getElementById('presetSelect').value.trim();
  App.prompt('Ürünü Kaydet', 'Kaydedilecek ürün adı', name).then(function(n){
    if (!n) return;
    var presets = loadPresets();
    presets[n] = collectFormValues();
    savePresets(presets);
    refreshPresetSelect(n);
    App.toast('"' + n + '" kayıtlı ürünlere eklendi.');
  });
});
document.getElementById('presetLoadBtn').addEventListener('click', function(){
  var name = document.getElementById('presetSelect').value;
  if (!name) return;
  var presets = loadPresets();
  if (presets[name]) applyFormValues(presets[name]);
});
document.getElementById('presetDeleteBtn').addEventListener('click', function(){
  var name = document.getElementById('presetSelect').value;
  if (!name) return;
  App.confirm("'" + name + "' kayıtlı ürün silinsin mi?", {danger: true, okText: 'Sil'}).then(function(ok){
    if (!ok) return;
    var presets = loadPresets();
    delete presets[name];
    savePresets(presets);
    refreshPresetSelect();
  });
});
refreshPresetSelect();

// ---- Etiket onizlemesi: e-paper_nfc firmware'inin cizim mantiginin
// (LabelSenderApp/label_preview.py) JS'e portu - piksel-birebir degil ama
// yerlesim/kirilma/hizalama davranisi ayni. ----
var FONT8 = [5, 8], FONT12 = [7, 12], FONT16 = [11, 16], FONT20 = [14, 20], FONT24 = [17, 24];
var SCALE = 3, LW = 250, LH = 128;
var BLACK = '#000000', WHITE = '#ffffff';
var TEMPLATE_TICKET = 3, TEMPLATE_BASIC = 4;

function splitTwoLines(text, areaWidth, fontWidth){
  var maxChars = Math.max(1, Math.floor(areaWidth / fontWidth));
  if (text.length * fontWidth <= areaWidth) return [text, ''];
  var words = text.split(' ').filter(function(w){ return w.length > 0; });
  var line1 = '', line2 = '', onLine2 = false;
  for (var i = 0; i < words.length; i++){
    var word = words[i], wlen = word.length;
    if (!onLine2 && line1 === '' && wlen > maxChars){
      line1 = word.slice(0, maxChars);
      line2 = word.slice(maxChars);
      onLine2 = true;
    } else if (!onLine2 && (line1 === '' || line1.length + 1 + wlen <= maxChars)){
      line1 = line1 ? (line1 + ' ' + word) : word;
    } else {
      onLine2 = true;
      if (line2 === '' || line2.length + 1 + wlen <= maxChars) line2 = line2 ? (line2 + ' ' + word) : word;
    }
  }
  return [line1, line2];
}

var ctx = document.getElementById('labelCanvas').getContext('2d');

function rectFill(x0,y0,x1,y1,fill){
  ctx.fillStyle = fill;
  ctx.fillRect(x0*SCALE, y0*SCALE, (x1-x0)*SCALE, (y1-y0)*SCALE);
}
function hline(x0,y,x1,fill){
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1, Math.floor(SCALE/2));
  ctx.beginPath();
  ctx.moveTo(x0*SCALE, y*SCALE);
  ctx.lineTo(x1*SCALE, y*SCALE);
  ctx.stroke();
}
function drawText(x,y,text,fm,fill,bold){
  if (!text) return;
  var fw = fm[0], fh = fm[1];
  var cellW = fw*SCALE;
  ctx.fillStyle = fill;
  ctx.font = (bold ? 'bold ' : '') + Math.round(fh*SCALE*0.8) + 'px Consolas, "Courier New", monospace';
  ctx.textBaseline = 'top';
  for (var i = 0; i < text.length; i++) ctx.fillText(text[i], x*SCALE + i*cellW, y*SCALE);
}
function drawTextCentered(x0,x1,y,text,fm,fill,bold,bg){
  var fw = fm[0], fh = fm[1];
  var textWidth = text.length*fw, boxWidth = x1-x0;
  var x = textWidth < boxWidth ? x0 + Math.floor((boxWidth-textWidth)/2) : x0;
  if (bg) rectFill(x,y,x+textWidth,y+fh,bg);
  drawText(x,y,text,fm,fill,bold);
}

var EAN_L=["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
var EAN_G=["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
var EAN_R=["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
var EAN_FIRST_PARITY=["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function ean13Checksum(digits12){
  var total = 0;
  for (var i = 0; i < digits12.length; i++) total += digits12[i] * ((i % 2 === 0) ? 1 : 3);
  var rem = total % 10;
  return rem === 0 ? 0 : 10 - rem;
}
function drawEan13(x,y,moduleW,height,barcodeStr){
  var s = (barcodeStr || '').slice(0, 12);
  while (s.length < 12) s += '0';
  var digits12 = [];
  for (var i = 0; i < 12; i++) digits12.push(parseInt(s[i], 10) || 0);
  var full = digits12.concat([ean13Checksum(digits12)]);
  var parity = EAN_FIRST_PARITY[full[0]];
  var bits = '101';
  for (i = 0; i < 6; i++) bits += (parity[i] === 'L') ? EAN_L[full[i+1]] : EAN_G[full[i+1]];
  bits += '01010';
  for (i = 0; i < 6; i++) bits += EAN_R[full[i+7]];
  bits += '101';
  var bx = x;
  for (i = 0; i < bits.length; i++){
    if (bits[i] === '1') rectFill(bx,y,bx+moduleW,y+height,BLACK);
    bx += moduleW;
  }
  var text = full.join('');
  var barcodeWidth = 95*moduleW, textWidth = 13*FONT12[0];
  var textX = barcodeWidth > textWidth ? x + Math.floor((barcodeWidth-textWidth)/2) : x;
  drawText(textX, y+height+4, text, FONT12, BLACK);
}

function priceBoxStandartKampanya(x,y,boxW,boxH,d){
  rectFill(x,y,x+boxW,y+boxH,BLACK);
  if (d.discountEnabled && d.oldPrice){
    var oldY = y+4, priceX = x+4;
    if (d.price.indexOf('.') === -1){
      var tw = d.price.length*FONT16[0];
      if (tw < boxW) priceX = x + Math.floor((boxW-tw)/2);
    }
    drawText(x+4, oldY, d.oldPrice, FONT16, WHITE);
    hline(x+3, oldY+8, x+boxW-4, WHITE);
    drawText(priceX, oldY+22, d.price, FONT16, WHITE);
    drawText(x+4, y+boxH-14, d.unit, FONT12, WHITE);
  } else {
    var priceX2 = x+4;
    if (d.price.indexOf('.') === -1){
      var tw2 = d.price.length*FONT20[0];
      if (tw2 < boxW) priceX2 = x + Math.floor((boxW-tw2)/2);
    }
    drawText(priceX2, y+Math.floor(boxH/2)-12, d.price, FONT20, WHITE);
    drawText(x+4, y+boxH-14, d.unit, FONT12, WHITE);
  }
}
function priceBoxTicket(x,y,boxW,boxH,d){
  rectFill(x,y,x+boxW,y+boxH,BLACK);
  if (d.discountEnabled && d.oldPrice){
    var oldY = y+4;
    var priceWidth = d.price.length*FONT16[0];
    var priceX = priceWidth < boxW ? x + Math.floor((boxW-priceWidth)/2) : x+4;
    drawText(x+4, oldY, d.oldPrice, FONT16, WHITE);
    hline(x+3, oldY+8, x+boxW-4, WHITE);
    drawText(priceX, oldY+22, d.price, FONT16, WHITE);
    var unitWidth = d.unit.length*FONT12[0];
    var unitX = unitWidth < boxW ? x + Math.floor((boxW-unitWidth)/2) : x+4;
    drawText(unitX, y+boxH-14, d.unit, FONT12, WHITE);
  } else {
    var priceWidth2 = d.price.length*FONT20[0];
    var priceX2 = priceWidth2 < boxW ? x + Math.floor((boxW-priceWidth2)/2) : x+4;
    var unitWidth2 = d.unit.length*FONT12[0];
    var unitX2 = unitWidth2 < boxW ? x + Math.floor((boxW-unitWidth2)/2) : x+4;
    drawText(priceX2, y+Math.floor(boxH/2)-12, d.price, FONT20, WHITE);
    drawText(unitX2, y+boxH-14, d.unit, FONT12, WHITE);
  }
}
function priceBarBasic(x,y,boxW,boxH,d){
  var priceWidth = d.price.length*FONT24[0];
  var unitWidth = d.unit.length*FONT12[0];
  var totalWidth = priceWidth+6+unitWidth;
  var startX = totalWidth < boxW ? x + Math.floor((boxW-totalWidth)/2) : x+4;
  if (d.discountEnabled && d.oldPrice){
    var oldWidth = d.oldPrice.length*FONT8[0];
    var oldX = oldWidth < boxW ? x + Math.floor((boxW-oldWidth)/2) : x+4;
    var oldY = y+2, priceY = y+8;
    drawText(oldX, oldY, d.oldPrice, FONT8, WHITE);
    hline(oldX-2, oldY+4, oldX+oldWidth+2, WHITE);
    drawText(startX, priceY, d.price, FONT24, WHITE);
    drawText(startX+priceWidth+6, priceY+(FONT24[1]-FONT12[1]), d.unit, FONT12, WHITE);
  } else {
    var priceY2 = y + Math.floor((boxH-FONT24[1])/2) - 4;
    drawText(startX, priceY2, d.price, FONT24, WHITE);
    drawText(startX+priceWidth+6, priceY2+(FONT24[1]-FONT12[1]), d.unit, FONT12, WHITE);
  }
}
function priceBoxStandart(x,y,boxW,boxH,d){
  rectFill(x,y,x+boxW,y+boxH,BLACK);
  if (d.discountEnabled && d.oldPrice){
    var oldY = y+4;
    var priceFont = FONT20;
    var tw = d.price.length*priceFont[0];
    if (tw >= boxW){ priceFont = FONT16; tw = d.price.length*priceFont[0]; }
    var priceX = tw < boxW ? x + Math.floor((boxW-tw)/2) : x+4;
    drawText(x+4, oldY, d.oldPrice, FONT16, WHITE);
    hline(x+3, oldY+9, x+boxW-4, WHITE);
    drawText(priceX, oldY+24, d.price, priceFont, WHITE);
    drawText(x+4, y+boxH-16, d.unit, FONT12, WHITE);
  } else {
    var priceX2 = x+4, priceFont2, priceY, tw2;
    if (d.price.indexOf('.') === -1){
      priceFont2 = FONT24; priceY = y+Math.floor(boxH/2)-18; tw2 = d.price.length*FONT24[0];
    } else {
      priceFont2 = FONT20; priceY = y+Math.floor(boxH/2)-15; tw2 = d.price.length*FONT20[0];
      if (tw2 >= boxW){ priceFont2 = FONT16; priceY = y+Math.floor(boxH/2)-12; tw2 = d.price.length*FONT16[0]; }
    }
    if (tw2 < boxW) priceX2 = x + Math.floor((boxW-tw2)/2);
    drawText(priceX2, priceY, d.price, priceFont2, WHITE);
    drawText(x+4, y+boxH-16, d.unit, FONT12, WHITE);
  }
}

function drawTicket(d){
  var hasSubtitle = !!d.subtitle;
  var gapToProduct = 16;
  var productFont = FONT20;
  var parts = splitTwoLines(d.name, 242, productFont[0]);
  var line1 = parts[0], line2 = parts[1];
  var prodLines = line2 ? 2 : 1;
  var contentH = gapToProduct + prodLines*productFont[1] + (hasSubtitle ? productFont[1] : 0);
  if (contentH > 50){
    productFont = FONT16;
    parts = splitTwoLines(d.name, 242, productFont[0]); line1 = parts[0]; line2 = parts[1];
    prodLines = line2 ? 2 : 1;
    contentH = gapToProduct + prodLines*productFont[1] + (hasSubtitle ? productFont[1] : 0);
    if (contentH > 50){
      productFont = FONT12;
      parts = splitTwoLines(d.name, 242, productFont[0]); line1 = parts[0]; line2 = parts[1];
      prodLines = line2 ? 2 : 1;
      contentH = gapToProduct + prodLines*productFont[1] + (hasSubtitle ? productFont[1] : 0);
    }
  }
  var topMargin = contentH < 50 ? Math.floor((50-contentH)/2) : 0;
  var businessY = topMargin;
  var productY = businessY + gapToProduct;

  drawTextCentered(4,246,businessY,d.business,FONT16,BLACK,true);
  drawTextCentered(4,246,productY,line1,productFont,BLACK,true);
  if (prodLines === 2) drawTextCentered(4,246,productY+productFont[1],line2,productFont,BLACK,true);
  if (hasSubtitle) drawTextCentered(4,246,productY+prodLines*productFont[1],d.subtitle,productFont,BLACK);

  priceBoxTicket(4,50,242,38,d);
  drawTextCentered(4,242,80,d.bottomCode,FONT8,BLACK,false,WHITE);
  drawEan13(20,90,2,12,d.barcode);
}
function drawBasic(d){
  rectFill(0,0,LW,LH,BLACK);
  var hasSubtitle = !!d.subtitle;
  var gap = 4;
  var productFont = FONT20;
  var parts = splitTwoLines(d.name, 250, productFont[0]);
  var line1 = parts[0], line2 = parts[1];
  var prodLines = line2 ? 2 : 1;
  var productLineH = productFont[1]+2;
  var contentH = FONT20[1]+gap+prodLines*productLineH+(hasSubtitle ? gap+productFont[1] : 0);
  var fallbacks = [FONT16, FONT12];
  for (var i = 0; i < fallbacks.length; i++){
    if (contentH <= 68) break;
    productFont = fallbacks[i];
    parts = splitTwoLines(d.name, 250, productFont[0]); line1 = parts[0]; line2 = parts[1];
    prodLines = line2 ? 2 : 1;
    productLineH = productFont[1]+2;
    contentH = FONT20[1]+gap+prodLines*productLineH+(hasSubtitle ? gap+productFont[1] : 0);
  }
  var topMargin = contentH < 68 ? Math.floor((68-contentH)/2) : 0;
  var businessY = topMargin;
  var productY = businessY + FONT20[1] + gap;

  drawTextCentered(0,250,businessY,d.business,FONT20,WHITE,true);
  drawTextCentered(0,250,productY,line1,productFont,WHITE,true);
  if (prodLines === 2) drawTextCentered(0,250,productY+productLineH,line2,productFont,WHITE,true);
  if (hasSubtitle) drawTextCentered(0,250,productY+prodLines*productLineH+gap,d.subtitle,productFont,WHITE);

  drawTextCentered(4,242,70,d.bottomCode,FONT12,WHITE);
  priceBarBasic(0,90,250,38,d);
}
function drawStandartKampanya(d){
  drawTextCentered(4,160,4,d.business,FONT16,BLACK,true);
  hline(4,21,164,BLACK);
  drawTextCentered(4,160,25,d.name,FONT16,BLACK,true);
  priceBoxStandartKampanya(170,4,76,70,d);
  rectFill(4,60,246,78,BLACK);
  drawTextCentered(4,246,63,'KAMPANYA',FONT12,WHITE);
  drawEan13(25,86,2,20,d.barcode);
}
function drawStandart(d){
  var productFont = FONT16;
  var hasSubtitle = !!d.subtitle;
  var gapToProduct = 21, gapToSubtitle = 3;
  var parts = splitTwoLines(d.name, 164, productFont[0]);
  var line1 = parts[0], line2 = parts[1];
  var prodLines = line2 ? 2 : 1;
  var productLineH = productFont[1]+2;
  var contentH = gapToProduct + prodLines*productLineH + (hasSubtitle ? gapToSubtitle+productFont[1] : 0);
  if (contentH > 76){
    productFont = FONT12;
    parts = splitTwoLines(d.name, 164, productFont[0]); line1 = parts[0]; line2 = parts[1];
    prodLines = line2 ? 2 : 1;
    productLineH = productFont[1]+2;
    contentH = gapToProduct + prodLines*productLineH + (hasSubtitle ? gapToSubtitle+productFont[1] : 0);
  }
  var topMargin = contentH < 76 ? Math.floor((76-contentH)/2) : 0;
  var businessY = topMargin;
  var dividerY = businessY + 17;
  var productY = businessY + gapToProduct;

  drawTextCentered(0,164,businessY,d.business,FONT16,BLACK,true);
  hline(0,dividerY,164,BLACK);
  drawTextCentered(0,164,productY,line1,productFont,BLACK,true);
  if (prodLines === 2) drawTextCentered(0,164,productY+productLineH,line2,productFont,BLACK,true);
  if (hasSubtitle) drawTextCentered(0,164,productY+prodLines*productLineH+gapToSubtitle,d.subtitle,productFont,BLACK);

  priceBoxStandart(166,0,84,76,d);
  hline(4,76,246,BLACK);
  drawTextCentered(4,246,77,d.bottomCode,FONT8,BLACK);
  drawEan13(25,86,2,20,d.barcode);
}

function renderPreview(){
  var d = collectFormValues();
  d.templateID = parseInt(d.templateID, 10) || 1;
  rectFill(0,0,LW,LH,WHITE);
  if (d.templateID === TEMPLATE_TICKET) drawTicket(d);
  else if (d.templateID === TEMPLATE_BASIC) drawBasic(d);
  else if (d.campaignEnabled) drawStandartKampanya(d);
  else drawStandart(d);
}
var renderPending = false;
function scheduleRender(){
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(function(){ renderPending = false; renderPreview(); });
}
document.getElementById('f').addEventListener('input', scheduleRender);
document.getElementById('f').addEventListener('change', scheduleRender);
renderPreview();

// ---- Gonderim ----
document.getElementById('f').addEventListener('submit', function(e){
  e.preventDefault();
  var res = document.getElementById('result');
  var btn = document.getElementById('sendBtn');
  var values = collectFormValues();
  res.hidden = false;
  if (multiTargets){
    App.setBusy(btn, true);
    var fields = Object.assign({}, values); delete fields.serial;
    App.apiRequest('POST', '/api/updates', {source: 'bulk', name: (values.name || 'Etiket') + ' → ' + multiTargets.length + ' cihaz', serials: multiTargets, fields: fields})
      .then(function(r){
        try { sessionStorage.removeItem('epaper-bulk-serials'); } catch (e) {}
        location.href = '/updates/' + r.batchId;
      })
      .catch(function(err){ App.setBusy(btn, false); res.className = 'alert alert-danger mt-3'; res.textContent = err.message; });
    return;
  }
  if (!isValidSerial(values.serial)){
    res.className = 'alert alert-danger mt-3';
    res.textContent = 'Seri numarası 8 haneli olmalı.';
    return;
  }
  res.className = 'alert alert-info mt-3'; res.textContent = 'Gönderiliyor...';
  App.setBusy(btn, true);
  sendLabelRequest(values, gatewaySelect.value)
    .then(function(result){
      // 200 basarili, 202 kuyrukta (gateway cevrimdisi / tekrar denenecek), digerleri hata
      var queued = result.status === 202;
      res.className = 'alert mt-3 ' + (result.ok && !queued ? 'alert-success' : queued ? 'alert-warning' : 'alert-danger');
      res.innerHTML = '<div>' + escapeHtml(result.txt.replace(/^HATA:\s*/, '')) +
        (queued ? ' <a href="/updates?serial=' + encodeURIComponent(values.serial) + '">Takip et</a>' : '') + '</div>';
      if (result.ok) loadDevices();
    })
    .catch(function(err){
      res.className = 'alert alert-danger mt-3';
      res.textContent = 'İstek başarısız: ' + err;
    })
    .then(function(){ App.setBusy(btn, false); });
});

// Etiket verisi sunucuya, sunucudan gateway'e (WebSocket) ve oradan nRF24
// ile seri numarasi verilen ekrana gider; cevap gateway'in gonderim
// sonucunu tasir. gatewayId bos ise sunucu cihaz kaydindaki gateway'i kullanir.
function sendLabelRequest(values, gatewayId){
  var body = Object.assign({}, values, {gatewayId: gatewayId || null});
  return fetch('/api/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  }).then(function(resp){
    return resp.text().then(function(txt){ return {ok: resp.ok, status: resp.status, txt: txt}; });
  });
}

// ---- Toplu guncelleme (Excel sablonu indir / yukle / sirayla gonder) ----
var BULK_HEADERS = ['Seri No','Şablon','İndirim','Kampanya','İşletme Adı','Ürün Adı','Alt Başlık','Fiyat','Eski Fiyat','Birim','Alt Kod','Barkod'];
var BULK_EXAMPLE_ROWS = [
  ['80156767','Standart','Hayır','Hayır','Cemil Market','Süt 1L','Yerli Üretim','24.90','','TL','',''],
  ['80156768','Ticket','Evet','Hayır','Cemil Market','Beyaz Peynir 500g','','45','60','TL','','8690000000127']
];

function requireXlsx(){
  if (typeof XLSX === 'undefined'){
    App.toast('Excel kütüphanesi yüklenemedi. Sayfayı yenileyip tekrar deneyin.', 'danger');
    return false;
  }
  return true;
}

document.getElementById('downloadTemplateBtn').addEventListener('click', function(){
  if (!requireXlsx()) return;
  var rows = [BULK_HEADERS].concat(BULK_EXAMPLE_ROWS);
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = BULK_HEADERS.map(function(h){ return {wch: Math.max(14, h.length + 2)}; });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Etiketler');
  XLSX.writeFile(wb, 'etiket_sablonu.xlsx');
});

function bulkGetField(row, names){
  var keys = Object.keys(row);
  for (var i = 0; i < names.length; i++){
    for (var j = 0; j < keys.length; j++){
      if (keys[j].trim().toLowerCase() === names[i].toLowerCase()) {
        return String(row[keys[j]] === undefined ? '' : row[keys[j]]).trim();
      }
    }
  }
  return '';
}
function bulkYesNo(v){
  v = (v || '').toLowerCase();
  return v === 'evet' || v === 'yes' || v === '1' || v === 'true' || v === 'doğru';
}
function normalizeBulkRow(row){
  var serial = bulkGetField(row, ['Seri No','Seri','serial','Cihaz ID']).replace(/\s+/g, '');
  var templateText = bulkGetField(row, ['Şablon','Sablon','template']).toLowerCase();
  var templateID = '1';
  if (templateText.indexOf('ticket') !== -1) templateID = '3';
  else if (templateText.indexOf('basic') !== -1) templateID = '4';
  return {
    serial: serial,
    templateID: templateID,
    discountEnabled: bulkYesNo(bulkGetField(row, ['İndirim','Indirim','discount'])),
    campaignEnabled: bulkYesNo(bulkGetField(row, ['Kampanya','campaign'])),
    business: bulkGetField(row, ['İşletme Adı','Isletme Adi','business']),
    name: bulkGetField(row, ['Ürün Adı','Urun Adi','product','name']),
    subtitle: bulkGetField(row, ['Alt Başlık','Alt Baslik','subtitle']),
    price: bulkGetField(row, ['Fiyat','price']),
    oldPrice: bulkGetField(row, ['Eski Fiyat','Eski fiyat','oldPrice']),
    unit: bulkGetField(row, ['Birim','unit']),
    bottomCode: bulkGetField(row, ['Alt Kod','bottomCode']),
    barcode: bulkGetField(row, ['Barkod','barcode'])
  };
}

var bulkRows = [];

function renderBulkTable(){
  var wrap = document.getElementById('bulkTableWrap');
  var tbody = document.querySelector('#bulkTable tbody');
  tbody.innerHTML = '';
  bulkRows.forEach(function(r, idx){
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (idx + 1) + '</td>' +
      '<td class="mono">' + escapeHtml(r.serial) + (deviceMap[r.serial] && deviceMap[r.serial].name ? '<br><small>' + escapeHtml(deviceMap[r.serial].name) + '</small>' : '') + '</td>' +
      '<td>' + escapeHtml(r.templateID === '3' ? 'Ticket' : (r.templateID === '4' ? 'Basic' : 'Standart')) + '</td>' +
      '<td>' + escapeHtml(r.business) + '</td>' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + escapeHtml(r.price) + '</td>' +
      '<td class="bulk-status">Bekliyor</td>';
    tbody.appendChild(tr);
  });
  wrap.style.display = bulkRows.length ? 'block' : 'none';
  document.getElementById('bulkLog').textContent = bulkRows.length
    ? (bulkRows.length + ' satır okundu, kontrol edip "Toplu Gönder" ile devam edin.')
    : 'Dosyada geçerli satır bulunamadı (İşletme Adı veya Ürün Adı dolu en az bir satır olmalı).';
}

document.getElementById('parseExcelBtn').addEventListener('click', function(){
  if (!requireXlsx()) return;
  var fileInput = document.getElementById('excelFileInput');
  if (!fileInput.files || fileInput.files.length === 0){
    App.toast('Önce bir Excel (.xlsx) veya CSV dosyası seçin.', 'warning');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e){
    try {
      var data = new Uint8Array(e.target.result);
      var wb = XLSX.read(data, {type:'array'});
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rawRows = XLSX.utils.sheet_to_json(ws, {defval:''});
      bulkRows = rawRows.map(normalizeBulkRow).filter(function(r){ return r.business || r.name; });
      renderBulkTable();
    } catch (err) {
      App.toast('Dosya okunamadı: ' + err, 'danger');
    }
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
});

// ---- Toplu gonderim: sunucuda bir "toplu is" olarak kuyruga alinir. Tekrar
// denemeler, gateway cevrimdisiyken bekleme ve siralama kuyrukta yapilir;
// sayfa kapansa da gonderim devam eder. Kayitli cihazlar kendi gateway'lerini
// kullanir, kayitli olmayan seri no'lar yukarida secili gateway'e gider. ----
var bulkPollTimer = null;
function fieldsOf(r){
  var f = {};
  ['templateID', 'discountEnabled', 'campaignEnabled', 'business', 'name', 'subtitle', 'price', 'oldPrice', 'unit', 'bottomCode', 'barcode'].forEach(function(k){ f[k] = r[k]; });
  return f;
}
function setRowStatus(serial, html, cls){
  document.querySelectorAll('#bulkTable tbody tr').forEach(function(tr, i){
    if (bulkRows[i] && bulkRows[i].serial === serial){
      var c = tr.querySelector('.bulk-status');
      c.innerHTML = html; c.className = 'bulk-status ' + (cls || '');
    }
  });
}
function pollBatch(batchId){
  clearTimeout(bulkPollTimer);
  App.apiRequest('GET', '/api/updates/batches/' + batchId).then(function(b){
    b.jobs.forEach(function(j){ setRowStatus(j.serial, App.jobBadge(j.status) + (j.message && j.status !== 'success' ? ' <span class="small text-secondary">' + escapeHtml(j.message.replace(/^HATA:\s*/, '')) + '</span>' : '')); });
    var c = b.counts, pending = c.queued + c.sending;
    document.getElementById('bulkLog').innerHTML = (b.finished_at ? '<b>Tamamlandı:</b> ' : '<b>Gönderiliyor:</b> ') +
      c.success + ' başarılı, ' + (c.unreachable + c.failed) + ' sorunlu, ' + pending + ' bekleyen. <a href="/updates/' + b.id + '">Toplu işi aç</a>';
    if (!b.finished_at) bulkPollTimer = setTimeout(function(){ pollBatch(batchId); }, 2000);
    else { document.getElementById('bulkSendBtn').disabled = false; loadDevices(); }
  }).catch(function(){ bulkPollTimer = setTimeout(function(){ pollBatch(batchId); }, 4000); });
}
document.getElementById('bulkSendBtn').addEventListener('click', function(){
  var btn = document.getElementById('bulkSendBtn');
  var items = bulkRows.map(function(r){
    var registered = deviceMap[r.serial];
    return {serial: r.serial, gatewayId: registered && registered.gatewayId ? null : (gatewaySelect.value || null), fields: fieldsOf(r)};
  });
  var fileInput = document.getElementById('excelFileInput');
  var name = 'Excel: ' + (fileInput.files && fileInput.files[0] ? fileInput.files[0].name : bulkRows.length + ' satır');
  btn.disabled = true;
  App.apiRequest('POST', '/api/updates', {source: 'excel', name: name, items: items}).then(function(r){
    r.skipped.forEach(function(s){ setRowStatus(s.serial, '<span class="text-danger">' + escapeHtml(s.message) + '</span>', 'err'); });
    App.toast(r.queued + ' satır kuyruğa alındı' + (r.skipped.length ? ', ' + r.skipped.length + ' satır atlandı' : '') + '.');
    pollBatch(r.batchId);
  }).catch(function(err){
    btn.disabled = false;
    App.toast(err.message, 'danger');
  });
});

// ---- Coklu hedef: Cihazlar sayfasinda secilen cihazlara ayni icerik ----
// Secim sessionStorage'da tasinir (?bulk=1). Gonderince toplu is olusur ve
// ilerleme sayfasina gecilir.
var multiTargets = null;
(function initMultiTarget(){
  if (new URLSearchParams(location.search).get('bulk') !== '1') return;
  try { multiTargets = JSON.parse(sessionStorage.getItem('epaper-bulk-serials') || 'null'); } catch (e) {}
  if (!multiTargets || !multiTargets.length) { multiTargets = null; return; }
  var card = serialInput.closest('.card-body');
  serialInput.required = false;
  serialInput.closest('.col-md-6').hidden = true;
  gatewaySelect.closest('.col-md-6').hidden = true;
  card.insertAdjacentHTML('afterbegin',
    '<div class="alert alert-info mb-0" id="multiInfo"><div class="d-flex w-100 align-items-center gap-2"><i class="ti ti-tags fs-2"></i><div class="flex-fill">' +
    '<b>' + multiTargets.length + ' cihaz seçildi.</b> Aynı içerik tüm seçili cihazlara toplu iş olarak gönderilecek; her cihaz kendi gateway\'ini kullanır.' +
    '<div class="small text-secondary mono mt-1">' + escapeHtml(multiTargets.slice(0, 12).join(', ')) + (multiTargets.length > 12 ? ' ... (+' + (multiTargets.length - 12) + ')' : '') + '</div></div>' +
    '<a href="/" class="btn btn-sm">Tekli gönderime dön</a></div></div>');
  document.getElementById('sendBtn').innerHTML = '<i class="ti ti-send me-2"></i>' + multiTargets.length + ' Cihaza Gönder';
})();

