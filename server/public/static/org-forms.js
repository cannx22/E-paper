// Bayi, sube ve kullanici formlari (ekleme/duzenleme pencereleri). Bayiler,
// Bayi detayi, Subeler ve Kullanicilar sayfalari ortak kullanir.
(function () {
  'use strict';
  var e = App.escapeHtml;

  function field(name, label, opts) {
    opts = opts || {};
    var col = opts.col || 'col-md-6';
    var input = opts.textarea
      ? '<textarea class="form-control" name="' + name + '" rows="' + (opts.rows || 2) + '" maxlength="' + (opts.max || 2000) + '"></textarea>'
      : '<input class="form-control' + (opts.mono ? ' mono' : '') + '" name="' + name + '" type="' + (opts.type || 'text') + '"' +
        (opts.max ? ' maxlength="' + opts.max + '"' : '') + (opts.placeholder ? ' placeholder="' + e(opts.placeholder) + '"' : '') +
        (opts.required ? ' required' : '') + (opts.min !== undefined ? ' min="' + opts.min + '"' : '') + (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') + '>';
    return '<div class="' + col + '"><label class="form-label' + (opts.required ? ' required' : '') + '">' + label + '</label>' + input +
      (opts.hint ? '<div class="form-hint">' + opts.hint + '</div>' : '') + '</div>';
  }
  function section(title, icon) {
    return '<div class="col-12"><div class="hr-text hr-text-left my-2"><i class="ti ' + icon + ' me-1"></i>' + title + '</div></div>';
  }

  // Iletisim + adres alanlari (bayi ve sube ortak).
  function contactFields() {
    return section('İletişim', 'ti-address-book') +
      field('contact_name', 'Yetkili Kişi', { max: 120 }) + field('phone', 'Telefon', { max: 40, type: 'tel', placeholder: '0 5xx xxx xx xx' }) +
      field('email', 'E-posta', { max: 120, type: 'email', col: 'col-md-12' }) +
      section('Adres', 'ti-map-pin') +
      field('address', 'Adres', { textarea: true, max: 400, col: 'col-12' }) +
      field('city', 'İl', { max: 60, col: 'col-md-4' }) + field('district', 'İlçe', { max: 60, col: 'col-md-4' }) + field('postal_code', 'Posta Kodu', { max: 10, col: 'col-md-4', inputmode: 'numeric' });
  }

  function dealerFieldsHtml(withLimits) {
    return '<div class="row g-3">' +
      section('Genel', 'ti-building-store') +
      field('name', 'Bayi Adı', { required: true, max: 120, col: 'col-md-8', placeholder: 'ABC Market' }) +
      field('code', 'Bayi Kodu', { max: 20, col: 'col-md-4', mono: true, placeholder: 'ABC01' }) +
      section('Fatura / Vergi', 'ti-receipt') +
      field('legal_name', 'Ticari Ünvan', { max: 200, col: 'col-12', placeholder: 'ABC Gıda San. ve Tic. Ltd. Şti.' }) +
      field('tax_office', 'Vergi Dairesi', { max: 80 }) + field('tax_number', 'Vergi / TC Kimlik No', { max: 11, mono: true, inputmode: 'numeric' }) +
      contactFields() +
      (withLimits ? section('Lisans', 'ti-license') +
        field('max_gateways', 'Gateway Limiti', { type: 'number', min: 0, col: 'col-md-4', hint: 'Boş = limitsiz' }) +
        field('max_devices', 'Cihaz Limiti', { type: 'number', min: 0, col: 'col-md-4', hint: 'Boş = limitsiz' }) +
        field('contract_end', 'Sözleşme Bitişi', { type: 'date', col: 'col-md-4' }) : '') +
      section('Not', 'ti-note') + field('notes', 'Dahili not', { textarea: true, col: 'col-12', max: 2000 }) +
      '</div>';
  }

  function branchFieldsHtml(dealerSelect) {
    return '<div class="row g-3">' +
      (dealerSelect ? '<div class="col-12"><label class="form-label required">Bayi</label><select class="form-select" name="dealerId" required></select></div>' : '') +
      field('name', 'Şube Adı', { required: true, max: 120, col: 'col-md-8', placeholder: 'Kayseri Şube' }) +
      field('code', 'Şube Kodu', { max: 20, col: 'col-md-4', mono: true }) +
      contactFields() +
      section('Not', 'ti-note') + field('notes', 'Dahili not', { textarea: true, col: 'col-12', max: 2000 }) +
      '</div>';
  }

  // Dinamik pencere: form alanlari + kaydet. onSubmit(data) Promise doner.
  function formModal(id, title, bodyHtml, size) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'modal modal-blur fade';
      el.id = id;
      el.tabIndex = -1;
      el.innerHTML = '<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ' + (size || 'modal-lg') + '"><div class="modal-content">' +
        '<div class="modal-header"><h5 class="modal-title"></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
        '<form><div class="modal-body"></div><div class="modal-footer"><button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal">Vazgeç</button>' +
        '<button type="submit" class="btn btn-primary">Kaydet</button></div></form></div></div>';
      document.body.appendChild(el);
    }
    el.querySelector('.modal-title').innerHTML = title;
    el.querySelector('.modal-body').innerHTML = bodyHtml;
    return el;
  }
  function runModal(el, onSubmit) {
    var form = el.querySelector('form');
    var btn = form.querySelector('[type=submit]');
    return new Promise(function (resolve) {
      var saved = null;
      form.onsubmit = function (ev) {
        ev.preventDefault();
        App.setBusy(btn, true);
        Promise.resolve(onSubmit(App.formData(form), form)).then(function (r) {
          saved = r || true;
          App.setBusy(btn, false);
          App.hideModal(el.id);
        }).catch(function (err) {
          App.setBusy(btn, false);
          App.toast(err.message, 'danger');
        });
      };
      // Kaydedilen sonucta _after varsa (ornegin sifreyi gosteren pencere)
      // bu pencere tamamen kapandiktan sonra calistirilir.
      el.addEventListener('hidden.bs.modal', function onHide() {
        el.removeEventListener('hidden.bs.modal', onHide);
        if (saved && typeof saved._after === 'function') saved._after();
        resolve(saved);
      });
      App.showModal(el.id);
    });
  }

  function nullIfEmpty(data, keys) {
    keys.forEach(function (k) { if (data[k] === '') data[k] = null; });
    return data;
  }

  // ---- Bayi ----
  // dealer verilirse duzenleme, verilmezse bayi acilis sihirbazi (ilk yonetici dahil).
  function openDealer(dealer) {
    var isNew = !dealer;
    var adminHtml = isNew ? '<div class="row g-3 mt-1"><div class="col-12"><div class="hr-text hr-text-left my-2"><i class="ti ti-user-shield me-1"></i>İlk Bayi Yöneticisi</div></div>' +
      '<div class="col-12"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="withAdmin" checked><span class="form-check-label">Bayi yöneticisi hesabını şimdi oluştur</span></label></div>' +
      '<div class="col-md-6 admin-f"><label class="form-label required">Ad Soyad</label><input class="form-control" name="adminFullName" maxlength="120"></div>' +
      '<div class="col-md-6 admin-f"><label class="form-label required">E-posta (giriş)</label><input class="form-control" name="adminEmail" type="email" maxlength="120"></div>' +
      '<div class="col-md-6 admin-f"><label class="form-label">Telefon</label><input class="form-control" name="adminPhone" type="tel" maxlength="40"></div>' +
      '<div class="col-md-6 admin-f"><label class="form-label">Ünvan</label><input class="form-control" name="adminTitle" maxlength="80" placeholder="Mağaza Müdürü"></div>' +
      '<div class="col-md-6 admin-f"><label class="form-label required">Şifre</label><div class="input-group"><input class="form-control mono" name="adminPassword" type="text" autocomplete="new-password">' +
      '<button class="btn" type="button" data-gen><i class="ti ti-refresh me-1"></i>Üret</button></div><div class="form-hint">En az 8 karakter, harf ve rakam.</div></div>' +
      '<div class="col-md-6 admin-f d-flex align-items-end"><label class="form-check"><input class="form-check-input" type="checkbox" name="adminMustChange"><span class="form-check-label">İlk girişte şifresini değiştirsin</span></label></div></div>' : '';
    var el = formModal('dealerModal', isNew ? '<i class="ti ti-building-store me-2"></i>Yeni Bayi' : '<i class="ti ti-pencil me-2"></i>Bayi Bilgileri', dealerFieldsHtml(true) + adminHtml, 'modal-xl');
    var form = el.querySelector('form');
    if (dealer) App.fillForm(form, dealer);
    if (isNew) {
      var toggle = form.querySelector('[name=withAdmin]');
      var sync = function () { form.querySelectorAll('.admin-f').forEach(function (x) { x.hidden = !toggle.checked; }); };
      toggle.onchange = sync; sync();
      form.querySelector('[data-gen]').onclick = function () { form.querySelector('[name=adminPassword]').value = generatePassword(); };
    }
    return runModal(el, function (data) {
      var body = nullIfEmpty(data, ['max_gateways', 'max_devices', 'contract_end']);
      var admin = null;
      if (isNew && data.withAdmin) {
        admin = { fullName: data.adminFullName, email: data.adminEmail, phone: data.adminPhone, title: data.adminTitle, password: data.adminPassword, mustChangePassword: data.adminMustChange };
        if (!admin.fullName || !admin.email || !admin.password) throw new Error('Bayi yöneticisi için ad soyad, e-posta ve şifre girin.');
      }
      ['withAdmin', 'adminFullName', 'adminEmail', 'adminPhone', 'adminTitle', 'adminPassword', 'adminMustChange'].forEach(function (k) { delete body[k]; });
      if (admin) body.admin = admin;
      return App.apiRequest('POST', isNew ? '/api/dealers' : '/api/dealers/' + dealer.id, body).then(function (r) {
        App.toast(isNew ? r.name + ' bayisi oluşturuldu' + (admin ? '\nYönetici: ' + admin.email : '') : 'Bayi bilgileri kaydedildi.');
        if (admin) r._after = function () { App.secret('Bayi yöneticisi giriş bilgileri', [{ label: 'E-posta', value: admin.email }, { label: 'Şifre', value: admin.password }]); };
        return r;
      });
    });
  }

  // ---- Sube ----
  // ctx: { dealers: [...] (merkez icin bayi secimi), dealerId: sabit bayi }
  function openBranch(branch, ctx) {
    ctx = ctx || {};
    var isNew = !branch;
    var chooseDealer = isNew && !ctx.dealerId && ctx.dealers;
    var el = formModal('branchModal', isNew ? '<i class="ti ti-building me-2"></i>Yeni Şube' : '<i class="ti ti-pencil me-2"></i>Şube Bilgileri', branchFieldsHtml(chooseDealer));
    var form = el.querySelector('form');
    if (chooseDealer) App.fillSelect(form.querySelector('[name=dealerId]'), ctx.dealers, 'Bayi seçin');
    if (branch) App.fillForm(form, branch);
    return runModal(el, function (data) {
      if (isNew && ctx.dealerId) data.dealerId = ctx.dealerId;
      return App.apiRequest('POST', isNew ? '/api/branches' : '/api/branches/' + branch.id, data).then(function (r) {
        App.toast(isNew ? r.name + ' şubesi oluşturuldu.' : 'Şube bilgileri kaydedildi.');
        return r;
      });
    });
  }

  // ---- Kullanici ----
  var ROLE_HINTS = {
    super_admin: 'Tüm sistemi yönetir.',
    support: 'Tüm bayileri görüntüler, değişiklik yapamaz.',
    dealer_admin: 'Bayiyi ve tüm şubelerini yönetir.',
    branch_admin: 'Sadece seçilen şubeyi yönetir.',
    operator: 'Etiket gönderir; şube seçilirse sadece o şubeyi, seçilmezse tüm bayiyi görür.'
  };
  var ROLE_LEVEL = { super_admin: 5, support: 4, dealer_admin: 3, branch_admin: 2, operator: 1 };

  function generatePassword() {
    var letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', digits = '23456789', all = letters + digits;
    var rnd = function (n) { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
    var out = [letters[rnd(letters.length)], digits[rnd(digits.length)]];
    while (out.length < 10) out.push(all[rnd(all.length)]);
    for (var i = out.length - 1; i > 0; i--) { var j = rnd(i + 1); var t = out[i]; out[i] = out[j]; out[j] = t; }
    return out.join('');
  }

  // ctx: { dealers, branches, dealerId (sabit), branchId (sabit) }
  function openUser(user, ctx) {
    ctx = ctx || {};
    var me = window.currentUser;
    var isNew = !user;
    var isSuper = me.role === 'super_admin';
    var roles = Object.keys(App.ROLE_LABELS).filter(function (r) {
      if (isSuper) return true;
      if (r === 'super_admin' || r === 'support') return false;
      if (me.branchId && r === 'dealer_admin') return false;
      return ROLE_LEVEL[r] <= ROLE_LEVEL[me.role];
    });
    var html = '<div class="row g-3">' +
      '<div class="col-md-6"><label class="form-label required">Ad Soyad</label><input class="form-control" name="fullName" maxlength="120" required></div>' +
      '<div class="col-md-6"><label class="form-label required">E-posta (giriş)</label><input class="form-control" name="email" type="email" maxlength="120" required></div>' +
      '<div class="col-md-6"><label class="form-label">Telefon</label><input class="form-control" name="phone" type="tel" maxlength="40"></div>' +
      '<div class="col-md-6"><label class="form-label">Ünvan / Görev</label><input class="form-control" name="title" maxlength="80" placeholder="Kasiyer"></div>' +
      '<div class="col-12"><div class="hr-text hr-text-left my-2"><i class="ti ti-shield me-1"></i>Rol ve Kapsam</div></div>' +
      '<div class="col-md-4"><label class="form-label required">Rol</label><select class="form-select" name="role"></select></div>' +
      '<div class="col-md-4 u-dealer"><label class="form-label required">Bayi</label><select class="form-select" name="dealerId"></select></div>' +
      '<div class="col-md-4 u-branch"><label class="form-label">Şube</label><select class="form-select" name="branchId"></select></div>' +
      '<div class="col-12"><div class="form-hint" data-role-hint></div></div>' +
      (isNew ? '<div class="col-12"><div class="hr-text hr-text-left my-2"><i class="ti ti-key me-1"></i>Şifre</div></div>' +
        '<div class="col-md-7"><label class="form-label required">Şifre</label><div class="input-group"><input class="form-control mono" name="password" type="text" autocomplete="new-password" required>' +
        '<button class="btn" type="button" data-gen><i class="ti ti-refresh me-1"></i>Üret</button></div><div class="form-hint">En az 8 karakter, harf ve rakam.</div></div>' +
        '<div class="col-md-5 d-flex align-items-end"><label class="form-check"><input class="form-check-input" type="checkbox" name="mustChangePassword"><span class="form-check-label">İlk girişte şifresini değiştirsin</span></label></div>' : '') +
      '<div class="col-12"><label class="form-label">Not</label><textarea class="form-control" name="notes" rows="2" maxlength="2000"></textarea></div>' +
      '</div>';
    var el = formModal('userModal', isNew ? '<i class="ti ti-user-plus me-2"></i>Yeni Kullanıcı' : '<i class="ti ti-user-edit me-2"></i>' + e(user.full_name || user.login), html);
    var form = el.querySelector('form');
    var roleSel = form.querySelector('[name=role]'), dealerSel = form.querySelector('[name=dealerId]'), branchSel = form.querySelector('[name=branchId]');
    App.fillSelect(roleSel, roles.map(function (r) { return { id: r, name: App.ROLE_LABELS[r] }; }), null, user ? user.role : (ctx.role || 'operator'));
    if (!roleSel.value) roleSel.value = roles.indexOf('operator') !== -1 ? 'operator' : roles[roles.length - 1];
    if (isSuper) App.fillSelect(dealerSel, ctx.dealers || [], 'Bayi seçin', user ? user.dealer_id : ctx.dealerId);
    var sync = function () {
      var role = roleSel.value;
      var central = role === 'super_admin' || role === 'support';
      form.querySelector('.u-dealer').hidden = !isSuper || central || !!ctx.dealerId;
      var dealerId = isSuper ? (ctx.dealerId || dealerSel.value) : me.dealerId;
      var showBranch = (role === 'branch_admin' || role === 'operator') && !me.branchId && !ctx.branchId;
      form.querySelector('.u-branch').hidden = !showBranch;
      branchSel.required = role === 'branch_admin';
      form.querySelector('.u-branch .form-label').classList.toggle('required', role === 'branch_admin');
      if (showBranch) {
        var prev = branchSel.value || (user ? user.branch_id : ctx.branchPreset);
        App.fillSelect(branchSel, (ctx.branches || []).filter(function (b) { return String(b.dealer_id) === String(dealerId); }).map(function (b) { return { id: b.id, name: b.name }; }),
          role === 'branch_admin' ? 'Şube seçin' : '(tüm bayi)', prev);
      }
      form.querySelector('[data-role-hint]').textContent = ROLE_HINTS[role] || '';
    };
    roleSel.onchange = sync; dealerSel.onchange = function () { branchSel.value = ''; sync(); };
    if (user) App.fillForm(form, { fullName: user.full_name, email: user.email, phone: user.phone, title: user.title, notes: user.notes });
    sync();
    if (isNew) form.querySelector('[data-gen]').onclick = function () { form.querySelector('[name=password]').value = generatePassword(); };
    if (user && user.id === me.id) { roleSel.disabled = true; dealerSel.disabled = true; branchSel.disabled = true; }

    return runModal(el, function (data) {
      var body = { fullName: data.fullName, email: data.email, phone: data.phone, title: data.title, notes: data.notes };
      if (!(user && user.id === me.id)) {
        body.role = data.role;
        if (isSuper) body.dealerId = ctx.dealerId || data.dealerId || null;
        body.branchId = ctx.branchId || (form.querySelector('.u-branch').hidden ? null : (data.branchId || null));
      }
      if (isNew) { body.password = data.password; body.mustChangePassword = !!data.mustChangePassword; }
      return App.apiRequest('POST', isNew ? '/api/users' : '/api/users/' + user.id, body).then(function (r) {
        if (isNew) r._after = function () { App.secret('Kullanıcı oluşturuldu', [{ label: 'E-posta', value: body.email }, { label: 'Şifre', value: body.password }]); };
        else App.toast('Kullanıcı güncellendi.');
        return r;
      });
    });
  }

  // Sifre sifirlama: yonetici yeni sifre belirler veya uretir.
  function resetPassword(user) {
    var html = '<p class="text-secondary">' + e(user.full_name || user.login) + ' için yeni şifre belirleyin. Açık oturumları kapatılır.</p>' +
      '<label class="form-label">Yeni şifre</label><div class="input-group mb-2"><input class="form-control mono" type="text" required value="' + generatePassword() + '">' +
      '<button class="btn" type="button" data-gen><i class="ti ti-refresh"></i></button></div>' +
      '<label class="form-check"><input class="form-check-input" type="checkbox" checked><span class="form-check-label">İlk girişte şifresini değiştirsin</span></label>';
    var p = App.dialog({
      title: 'Şifre Sıfırla', okText: 'Şifreyi Değiştir', html: html,
      onOk: function (body) {
        var pw = body.querySelector('input[type=text]').value, must = body.querySelector('input[type=checkbox]').checked;
        return App.apiRequest('POST', '/api/users/' + user.id + '/password', { password: pw, mustChangePassword: must })
          .then(function () { return pw; })
          .catch(function (err) { App.toast(err.message, 'danger'); return false; });
      }
    });
    setTimeout(function () {
      var b = document.querySelector('.modal.show [data-gen]');
      if (b) b.onclick = function () { b.parentNode.querySelector('input').value = generatePassword(); };
    }, 300);
    return p.then(function (pw) {
      if (pw) App.secret('Yeni şifre', [{ label: 'E-posta', value: user.email || user.login }, { label: 'Şifre', value: pw }]);
      return pw;
    });
  }

  window.OrgForms = { openDealer: openDealer, openBranch: openBranch, openUser: openUser, resetPassword: resetPassword, generatePassword: generatePassword };
})();
