// Tum panel sayfalarinda ortak: yardimcilar, API istemcisi, bildirimler,
// onay/giris pencereleri, sol menu + ust bar (role gore) ve tema.
(function () {
  'use strict';

  // ---------- Yardimcilar ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function formatDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function formatRelative(iso) {
    if (!iso) return '-';
    var sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 45) return 'az önce';
    if (sec < 3600) return Math.round(sec / 60) + ' dk önce';
    if (sec < 86400) return Math.round(sec / 3600) + ' sa önce';
    if (sec < 86400 * 30) return Math.round(sec / 86400) + ' gün önce';
    return formatDate(iso);
  }
  function formatDuration(seconds) {
    if (seconds == null) return '-';
    var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + 'g ' + h + 'sa';
    if (h > 0) return h + 'sa ' + m + 'dk';
    return m + 'dk';
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function $(id) { return document.getElementById(id); }

  // JSON govdeli istek; hata durumunda sunucunun dondugu metni firlatir.
  function apiRequest(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Giriş yapmalısınız.'); }
      var ct = r.headers.get('content-type') || '';
      var p = ct.indexOf('application/json') !== -1 ? r.json() : r.text();
      return p.then(function (data) {
        if (!r.ok) {
          var msg = typeof data === 'string' ? data : 'HATA';
          if (r.status === 403 && msg.indexOf('sifrenizi degistirmelisiniz') !== -1) location.href = '/change-password';
          throw new Error(msg.replace(/^HATA:\s*/, ''));
        }
        return data;
      });
    });
  }

  // Select kutusunu doldurur: items [{id, name}], ilk secenek (bos) istege bagli.
  function fillSelect(sel, items, emptyLabel, selected) {
    if (typeof sel === 'string') sel = $(sel);
    var html = emptyLabel !== null && emptyLabel !== undefined ? '<option value="">' + escapeHtml(emptyLabel) + '</option>' : '';
    html += items.map(function (i) { return '<option value="' + escapeHtml(i.id) + '">' + escapeHtml(i.name) + '</option>'; }).join('');
    sel.innerHTML = html;
    if (selected !== null && selected !== undefined) sel.value = String(selected);
  }

  // Form alanlarini nesneye / nesneden (name="..." ile).
  function formData(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    });
    return out;
  }
  function fillForm(form, data) {
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !(el.name in data)) return;
      var v = data[el.name];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
  }

  // ---------- Etiketler ----------
  var STATUS_LABELS = { pending: 'Beklemede', registered: 'Kayıtlı', awaiting: 'Bağlantı Bekleniyor', active: 'Aktif', offline: 'Offline', error: 'Hata', disabled: 'Devre Dışı' };
  var ROLE_LABELS = { super_admin: 'Merkezi Yönetici', support: 'Merkez Destek', dealer_admin: 'Bayi Yöneticisi', branch_admin: 'Şube Yöneticisi', operator: 'Operatör' };
  var ROLE_COLORS = { super_admin: 'purple', support: 'indigo', dealer_admin: 'blue', branch_admin: 'cyan', operator: 'secondary' };
  var AUDIT_LABELS = {
    'label.send': 'Etiket gönderimi', 'user.login': 'Giriş', 'user.login_failed': 'Hatalı giriş', 'user.locked': 'Hesap kilitlendi',
    'user.created': 'Kullanıcı eklendi', 'user.updated': 'Kullanıcı güncellendi', 'user.deleted': 'Kullanıcı silindi',
    'user.activated': 'Kullanıcı aktif edildi', 'user.deactivated': 'Kullanıcı pasif edildi', 'user.unlocked': 'Hesap kilidi açıldı',
    'user.password_reset': 'Şifre sıfırlandı', 'user.password_changed': 'Şifre değiştirildi', 'user.profile_updated': 'Profil güncellendi',
    'user.sessions_revoked': 'Oturumlar kapatıldı',
    'dealer.created': 'Bayi oluşturuldu', 'dealer.updated': 'Bayi güncellendi', 'dealer.activated': 'Bayi aktif edildi', 'dealer.deactivated': 'Bayi pasif edildi',
    'branch.created': 'Şube oluşturuldu', 'branch.updated': 'Şube güncellendi', 'branch.deleted': 'Şube silindi',
    'gateway.first_seen': 'Yeni gateway bağlandı', 'gateway.registered': 'Gateway kaydedildi', 'gateway.claim_code_renewed': 'Sahiplenme kodu yenilendi',
    'gateway.claimed': 'Gateway sahiplenildi', 'gateway.claim_failed': 'Hatalı sahiplenme denemesi', 'gateway.assigned': 'Gateway atandı',
    'gateway.activated': 'Gateway aktif oldu', 'gateway.renamed': 'Gateway adı değişti', 'gateway.updated': 'Gateway güncellendi',
    'gateway.disabled': 'Gateway devre dışı', 'gateway.enabled': 'Gateway etkinleştirildi', 'gateway.key_reset': 'Gateway anahtarı sıfırlandı',
    'gateway.command': 'Gateway komutu', 'gateway.deleted': 'Gateway silindi', 'gateway.devices_moved': 'Cihazlar taşındı',
    'device.created': 'Cihaz eklendi', 'device.imported': 'Toplu cihaz ekleme', 'device.updated': 'Cihaz güncellendi', 'device.deleted': 'Cihaz silindi',
    'device.bulk_assign': 'Toplu cihaz atama', 'device.bulk_disable': 'Toplu devre dışı', 'device.bulk_enable': 'Toplu etkinleştirme', 'device.bulk_delete': 'Toplu cihaz silme',
    'inventory.imported': 'Havuza seri no eklendi', 'inventory.allocated': 'Seri no tahsis edildi', 'inventory.unallocated': 'Seri no tahsisi kaldırıldı', 'inventory.deleted': 'Havuzdan seri no silindi',
    'settings.updated': 'Ayarlar güncellendi',
    'update.batch_cancelled': 'Toplu iş iptal edildi', 'update.batch_retried': 'Toplu iş tekrar denendi', 'update.job_cancelled': 'Güncelleme iptal edildi'
  };
  var JOB_STATUS = {
    queued: ['Bekliyor', 'yellow', 'ti-clock'], sending: ['Gönderiliyor', 'blue', 'ti-loader-2'], received: ['Gateway aldı', 'cyan', 'ti-router'],
    success: ['Başarılı', 'green', 'ti-circle-check'], unreachable: ['Cihaz ulaşılamıyor', 'orange', 'ti-antenna-bars-off'],
    failed: ['Hata', 'red', 'ti-circle-x'], cancelled: ['İptal', 'secondary', 'ti-ban'], expired: ['Süresi doldu', 'secondary', 'ti-hourglass-off']
  };
  function jobBadge(status) {
    var s = JOB_STATUS[status] || [status, 'secondary', 'ti-point'];
    return '<span class="badge bg-' + s[1] + '-lt"><i class="ti ' + s[2] + ' me-1"></i>' + escapeHtml(s[0]) + '</span>';
  }
  // Toplu is ilerleme cubugu: counts {total, success, unreachable, failed, cancelled, sending, queued}
  function batchProgress(c, height) {
    var t = c.total || 1;
    var seg = function (n, color, title) { return n ? '<div class="progress-bar bg-' + color + '" style="width:' + (n * 100 / t) + '%" title="' + title + ': ' + n + '"></div>' : ''; };
    return '<div class="progress progress-separated" style="height:' + (height || '.55rem') + '">' +
      seg(c.success, 'green', 'Başarılı') + seg(c.unreachable, 'orange', 'Ulaşılamıyor') + seg(c.failed, 'red', 'Hata') +
      seg(c.cancelled, 'secondary', 'İptal') + seg(c.sending, 'blue', 'Gönderiliyor') + '</div>';
  }
  function statusBadge(status, label) {
    return '<span class="badge st st-' + escapeHtml(status) + '"><span class="status-dot"></span>' + escapeHtml(label || STATUS_LABELS[status] || status) + '</span>';
  }
  function roleBadge(role) {
    return '<span class="badge bg-' + (ROLE_COLORS[role] || 'secondary') + '-lt">' + escapeHtml(ROLE_LABELS[role] || role) + '</span>';
  }
  function activeBadge(active, onText, offText) {
    return active ? '<span class="badge bg-green-lt">' + (onText || 'Aktif') + '</span>' : '<span class="badge bg-secondary-lt">' + (offText || 'Pasif') + '</span>';
  }

  // ---------- Bildirim, onay, giris pencereleri ----------
  function toast(message, type) {
    var stack = $('toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.id = 'toast-stack'; document.body.appendChild(stack); }
    var icons = { success: 'ti-circle-check', danger: 'ti-alert-triangle', warning: 'ti-alert-circle', info: 'ti-info-circle' };
    type = type || 'success';
    var el = document.createElement('div');
    el.className = 'alert alert-' + type + ' alert-dismissible shadow mb-0';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="d-flex"><i class="ti ' + (icons[type] || icons.info) + ' me-2 fs-2"></i><div class="text-pre">' + escapeHtml(message) + '</div></div>' +
      '<a class="btn-close" aria-label="Kapat"></a>';
    el.querySelector('.btn-close').addEventListener('click', function () { el.remove(); });
    stack.appendChild(el);
    setTimeout(function () { el.remove(); }, type === 'danger' ? 9000 : 4500);
  }

  var dialogEl = null;
  function dialog(opts) {
    // opts: {title, html, okText, cancelText, danger, onOk(bodyEl) -> value|false|Promise}
    return new Promise(function (resolve) {
      if (!dialogEl) {
        dialogEl = document.createElement('div');
        dialogEl.className = 'modal modal-blur fade';
        dialogEl.tabIndex = -1;
        dialogEl.innerHTML = '<div class="modal-dialog modal-dialog-centered" role="document"><div class="modal-content">' +
          '<div class="modal-status"></div><div class="modal-header"><h5 class="modal-title"></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
          '<form><div class="modal-body"></div><div class="modal-footer"><button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal"></button>' +
          '<button type="submit" class="btn"></button></div></form></div></div>';
        document.body.appendChild(dialogEl);
      }
      var modal = tabler.Modal.getOrCreateInstance(dialogEl);
      var done = false, result = null;
      dialogEl.querySelector('.modal-status').className = 'modal-status ' + (opts.danger ? 'bg-danger' : 'bg-primary');
      dialogEl.querySelector('.modal-title').textContent = opts.title || '';
      dialogEl.querySelector('.modal-body').innerHTML = opts.html || '';
      dialogEl.querySelector('.modal-footer [data-bs-dismiss]').textContent = opts.cancelText || 'Vazgeç';
      var ok = dialogEl.querySelector('.modal-footer [type=submit]');
      ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      ok.textContent = opts.okText || 'Tamam';
      var form = dialogEl.querySelector('form');
      form.onsubmit = function (e) {
        e.preventDefault();
        var v = opts.onOk ? opts.onOk(dialogEl.querySelector('.modal-body')) : true;
        Promise.resolve(v).then(function (val) {
          if (val === false) return;
          done = true; result = val; modal.hide();
        });
      };
      // Sonuc pencere tamamen kapaninca doner - ardindan acilacak pencere cakismasin.
      dialogEl.addEventListener('hidden.bs.modal', function onHide() {
        dialogEl.removeEventListener('hidden.bs.modal', onHide);
        resolve(done ? result : null);
      });
      dialogEl.addEventListener('shown.bs.modal', function onShown() {
        dialogEl.removeEventListener('shown.bs.modal', onShown);
        var f = dialogEl.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
        if (f) f.focus(); else ok.focus();
      });
      modal.show();
    });
  }
  function confirmDialog(text, opts) {
    opts = opts || {};
    return dialog({
      title: opts.title || 'Emin misiniz?', danger: !!opts.danger, okText: opts.okText || 'Evet, devam et',
      html: '<div class="text-pre">' + escapeHtml(text) + '</div>', onOk: function () { return true; }
    }).then(function (v) { return v === true; });
  }
  function promptDialog(title, label, value, opts) {
    opts = opts || {};
    return dialog({
      title: title, okText: opts.okText || 'Kaydet',
      html: '<label class="form-label">' + escapeHtml(label) + '</label><input class="form-control" type="' + (opts.type || 'text') + '" value="' + escapeHtml(value || '') + '"' + (opts.required === false ? '' : ' required') + '>' +
        (opts.hint ? '<div class="form-hint mt-2">' + escapeHtml(opts.hint) + '</div>' : ''),
      onOk: function (body) { return body.querySelector('input').value.trim(); }
    });
  }
  // Tek seferlik gosterilen sifre vb. bilgiler icin (kopyalama butonlu).
  function secretDialog(title, lines) {
    var html = '<div class="alert alert-warning mb-3"><i class="ti ti-alert-triangle me-1"></i>Bu bilgi bir daha gösterilmeyecek. Kopyalayıp kullanıcıya güvenli şekilde iletin.</div>' +
      lines.map(function (l) {
        return '<label class="form-label">' + escapeHtml(l.label) + '</label><div class="input-group mb-2"><input class="form-control mono" readonly value="' + escapeHtml(l.value) + '">' +
          '<button class="btn" type="button" data-copy="' + escapeHtml(l.value) + '"><i class="ti ti-copy"></i></button></div>';
      }).join('');
    var p = dialog({ title: title, html: html, okText: 'Tamam', cancelText: 'Kapat', onOk: function () { return true; } });
    setTimeout(function () {
      document.querySelectorAll('[data-copy]').forEach(function (b) {
        b.onclick = function () { copyText(b.getAttribute('data-copy')); };
      });
    }, 50);
    return p;
  }
  function copyText(text) {
    var done = function () { toast('Panoya kopyalandı.', 'info'); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
    else {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      ta.remove();
    }
  }
  function showModal(id) { tabler.Modal.getOrCreateInstance($(id)).show(); }
  function hideModal(id) { tabler.Modal.getOrCreateInstance($(id)).hide(); }
  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('btn-loading', !!busy);
  }
  // Satir ici uyari kutusu (kalici mesajlar icin).
  function showMsg(id, ok, text) {
    var el = $(id);
    if (!el) return;
    el.className = 'alert ' + (ok ? 'alert-success' : 'alert-danger') + ' text-pre mt-3';
    el.textContent = text;
    el.hidden = false;
  }
  function hideMsg(id) { var el = $(id); if (el) el.hidden = true; }
  function emptyRow(cols, text, icon) {
    return '<tr><td colspan="' + cols + '"><div class="empty py-4"><div class="empty-icon"><i class="ti ' + (icon || 'ti-mood-empty') + ' fs-1"></i></div><p class="empty-title h4">' + escapeHtml(text) + '</p></div></td></tr>';
  }

  // ---------- Tema ----------
  function setTheme(t) {
    document.documentElement.setAttribute('data-bs-theme', t);
    try { localStorage.setItem('epaper-theme', t); } catch (e) {}
    document.querySelectorAll('[data-theme-toggle] .ti').forEach(function (i) { i.className = 'ti ' + (t === 'dark' ? 'ti-sun' : 'ti-moon'); });
  }
  function toggleTheme() { setTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'); }

  // ---------- Sol menu + ust bar ----------
  function menuItems(me) {
    var c = me.can;
    var items = [
      { href: '/dashboard', icon: 'ti-layout-dashboard', text: 'Genel Bakış' },
      c['label.send'] && { href: '/', icon: 'ti-send', text: 'Etiket Gönder' },
      c['audit.view'] && { href: '/updates', icon: 'ti-list-check', text: 'Güncellemeler', match: /^\/updates/ },
      { href: '/devices', icon: 'ti-tags', text: 'Cihazlar', match: /^\/devices/ },
      { href: '/gateways', icon: 'ti-router', text: 'Gateway\'ler', match: /^\/gateways/ },
      { section: 'Yönetim' },
      c['dealer.view'] && { href: '/dealers', icon: 'ti-building-store', text: 'Bayiler', match: /^\/dealers/ },
      !c['dealer.view'] && me.dealerId && c['branch.view'] && { href: '/dealers/' + me.dealerId, icon: 'ti-building-store', text: 'Bayi Bilgilerim', match: /^\/dealers/ },
      c['branch.view'] && { href: '/branches', icon: 'ti-building', text: 'Şubeler' },
      c['user.view'] && { href: '/users', icon: 'ti-users', text: 'Kullanıcılar' },
      c['inventory.manage'] && { href: '/inventory', icon: 'ti-barcode', text: 'Seri No Havuzu' },
      c['audit.view'] && { href: '/history', icon: 'ti-history', text: 'İşlem Geçmişi' },
      c['settings.manage'] && { href: '/settings', icon: 'ti-settings', text: 'Sistem Ayarları' }
    ];
    return items.filter(Boolean);
  }

  function renderShell(me) {
    var side = $('app-sidebar');
    if (!side) return;
    var path = location.pathname;
    var nav = menuItems(me).map(function (it) {
      if (it.section) return '<li class="nav-section">' + escapeHtml(it.section) + '</li>';
      var active = it.match ? it.match.test(path) : path === it.href;
      return '<li class="nav-item"><a class="nav-link' + (active ? ' active' : '') + '" href="' + it.href + '">' +
        '<span class="nav-link-icon d-md-none d-lg-inline-block"><i class="ti ' + it.icon + '"></i></span><span class="nav-link-title">' + escapeHtml(it.text) + '</span></a></li>';
    }).join('');
    var scope = me.branchName ? me.dealerName + ' / ' + me.branchName : (me.dealerName ? me.dealerName + ' (tüm şubeler)' : 'Merkez');
    var initials = (me.displayName || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(function (s) { return s[0].toUpperCase(); }).join('');
    var themeIcon = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'ti-sun' : 'ti-moon';

    side.outerHTML =
      '<aside class="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">' +
      '<div class="container-fluid">' +
      '<button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#sidebar-menu"><span class="navbar-toggler-icon"></span></button>' +
      '<a href="/dashboard" class="navbar-brand navbar-brand-autodark px-2"><span class="brand-mark"><i class="ti ti-tags"></i></span>' + escapeHtml(me.companyName || 'E-Paper') + '</a>' +
      '<div class="navbar-nav flex-row d-lg-none">' +
      '<a href="#" class="nav-link px-2" data-theme-toggle title="Tema"><i class="ti ' + themeIcon + '"></i></a>' +
      '<a href="/profile" class="nav-link px-2" title="Profil"><span class="avatar avatar-sm bg-primary-lt">' + escapeHtml(initials) + '</span></a></div>' +
      '<div class="collapse navbar-collapse" id="sidebar-menu">' +
      '<div class="scope-chip d-none d-lg-block"><i class="ti ti-map-pin me-1"></i>' + escapeHtml(scope) + '</div>' +
      '<ul class="navbar-nav pt-lg-1">' + nav + '</ul></div></div></aside>';

    var wrapper = document.querySelector('.page-wrapper');
    if (wrapper && !$('app-topbar')) {
      var top = document.createElement('header');
      top.id = 'app-topbar';
      top.className = 'navbar navbar-expand-md d-none d-lg-flex d-print-none';
      top.innerHTML = '<div class="container-xl"><div class="navbar-nav flex-row order-md-last ms-auto">' +
        '<a href="#" class="nav-link px-3" data-theme-toggle title="Koyu / açık tema"><i class="ti ' + themeIcon + ' fs-2"></i></a>' +
        '<div class="nav-item dropdown"><a href="#" class="nav-link d-flex lh-1 text-reset p-0 ms-2" data-bs-toggle="dropdown">' +
        '<span class="avatar avatar-sm bg-primary-lt">' + escapeHtml(initials) + '</span>' +
        '<div class="d-none d-xl-block ps-2"><div>' + escapeHtml(me.displayName) + '</div><div class="mt-1 small text-secondary">' + escapeHtml(me.roleLabel) + ' · ' + escapeHtml(scope) + '</div></div></a>' +
        '<div class="dropdown-menu dropdown-menu-end dropdown-menu-arrow">' +
        '<a href="/profile" class="dropdown-item"><i class="ti ti-user-circle me-2"></i>Profilim</a>' +
        '<a href="/profile#sessions" class="dropdown-item"><i class="ti ti-devices me-2"></i>Oturumlarım</a>' +
        '<div class="dropdown-divider"></div><a href="/logout" class="dropdown-item text-danger"><i class="ti ti-logout me-2"></i>Çıkış Yap</a>' +
        '</div></div></div></div>';
      wrapper.insertBefore(top, wrapper.firstChild);
    }
    document.querySelectorAll('[data-theme-toggle]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); toggleTheme(); });
    });
    document.title = document.title.replace(/·.*$/, '').trim() + ' · ' + (me.companyName || 'E-Paper');
  }

  var meReady = apiRequest('GET', '/api/me').then(function (me) {
    window.currentUser = me;
    renderShell(me);
    document.querySelectorAll('[data-can]').forEach(function (el) {
      if (!me.can[el.getAttribute('data-can')]) el.hidden = true;
    });
    return me;
  });

  window.App = {
    escapeHtml: escapeHtml, formatDate: formatDate, formatRelative: formatRelative, formatDuration: formatDuration,
    apiRequest: apiRequest, fillSelect: fillSelect, formData: formData, fillForm: fillForm, qs: qs,
    STATUS_LABELS: STATUS_LABELS, ROLE_LABELS: ROLE_LABELS, AUDIT_LABELS: AUDIT_LABELS, JOB_STATUS: JOB_STATUS,
    jobBadge: jobBadge, batchProgress: batchProgress,
    statusBadge: statusBadge, roleBadge: roleBadge, activeBadge: activeBadge, emptyRow: emptyRow,
    toast: toast, dialog: dialog, confirm: confirmDialog, prompt: promptDialog, secret: secretDialog, copyText: copyText,
    showModal: showModal, hideModal: hideModal, setBusy: setBusy, showMsg: showMsg, hideMsg: hideMsg,
    setTheme: setTheme, meReady: meReady
  };
  // Eski sayfa kodlariyla uyumluluk (etiket editoru).
  window.escapeHtml = escapeHtml;
  window.formatDate = formatDate;
  window.apiRequest = apiRequest;
  window.fillSelect = fillSelect;
  window.showMsg = showMsg;
  window.hideMsg = hideMsg;
  window.meReady = meReady;
  window.auditActionLabel = function (a) { return AUDIT_LABELS[a] || a; };
})();
