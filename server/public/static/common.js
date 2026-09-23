// Tum sayfalarda ortak: ust menu (role gore) ve kucuk yardimcilar.
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso){
  if (!iso) return '-';
  var d = new Date(iso);
  return d.toLocaleString('tr-TR');
}

// JSON govdeli istek; hata durumunda sunucunun dondugu metni firlatir.
function apiRequest(method, url, body){
  var opts = {method: method, headers: {}};
  if (body !== undefined){
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts).then(function(r){
    if (r.status === 401){ location.href = '/login'; throw new Error('Giris yapmalisiniz.'); }
    var ct = r.headers.get('content-type') || '';
    var p = ct.indexOf('application/json') !== -1 ? r.json() : r.text();
    return p.then(function(data){
      if (!r.ok) throw new Error(typeof data === 'string' ? data : 'HATA');
      return data;
    });
  });
}

function formatDuration(seconds){
  if (seconds == null) return '-';
  var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'g ' + h + 's';
  if (h > 0) return h + 's ' + m + 'dk';
  return m + 'dk';
}

// Select kutusunu doldurur: items [{id, name}], ilk secenek (bos) istege bagli.
function fillSelect(sel, items, emptyLabel, selected){
  var html = emptyLabel !== null ? '<option value="">' + escapeHtml(emptyLabel) + '</option>' : '';
  html += items.map(function(i){
    return '<option value="' + escapeHtml(i.id) + '">' + escapeHtml(i.name) + '</option>';
  }).join('');
  sel.innerHTML = html;
  if (selected != null) sel.value = String(selected);
}

function showMsg(id, ok, text){
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}
function hideMsg(id){
  var el = document.getElementById(id);
  if (el) el.className = 'msg';
}

var currentUser = null;
var meReady = apiRequest('GET', '/api/me').then(function(me){
  currentUser = me;
  var nav = document.getElementById('nav');
  if (!nav) return me;
  var links = [];
  if (me.can['label.send']) links.push(['/', '&#127991;&#65039; Etiket G&ouml;nder']);
  links.push(['/dashboard', '&#128202; &Ouml;zet']);
  links.push(['/gateways', '&#128225; Gateway\'ler']);
  if (me.can['dealer.manage']) links.push(['/dealers', '&#127970; Bayiler']);
  if (me.can['branch.manage']) links.push(['/branches', '&#127980; &#350;ubeler']);
  if (me.can['user.manage']) links.push(['/users', '&#128101; Kullan&#305;c&#305;lar']);
  if (me.can['audit.view']) links.push(['/history', '&#128196; Ge&ccedil;mi&#351;']);
  var scope = me.branchName ? (me.dealerName + ' / ' + me.branchName) : (me.dealerName || me.roleLabel);
  links.push(['/logout', '&#128274; &Ccedil;&#305;k&#305;&#351; (' + escapeHtml(me.username) + ' &middot; ' + escapeHtml(scope) + ')']);
  nav.innerHTML = links.map(function(l){
    var active = location.pathname === l[0] ? ' active' : '';
    return '<a href="' + l[0] + '" class="wifi-link' + active + '">' + l[1] + '</a>';
  }).join('');
  return me;
});
