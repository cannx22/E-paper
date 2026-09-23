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

var currentUser = null;
var meReady = apiRequest('GET', '/api/me').then(function(me){
  currentUser = me;
  var nav = document.getElementById('nav');
  if (!nav) return me;
  var links = [['/', '&#127991;&#65039; Etiket G&ouml;nder'], ['/history', '&#128196; Ge&ccedil;mi&#351;']];
  if (me.role === 'admin'){
    links.push(['/gateways', '&#128225; Gateway\'ler']);
    links.push(['/users', '&#128101; Kullan&#305;c&#305;lar']);
  }
  links.push(['/logout', '&#128274; &Ccedil;&#305;k&#305;&#351; (' + escapeHtml(me.username) + ')']);
  nav.innerHTML = links.map(function(l){
    var active = location.pathname === l[0] ? ' active' : '';
    return '<a href="' + l[0] + '" class="wifi-link' + active + '">' + l[1] + '</a>';
  }).join('');
  return me;
});
