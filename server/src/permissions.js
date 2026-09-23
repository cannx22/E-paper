// Rol ve kapsam (scope) kurallari tek yerde. Her kaynak (gateway, kullanici,
// sube, ileride cihaz/urun/sablon) bir bayiye ve istege bagli bir subeye
// aittir; kullanici sadece kendi kapsamindaki kaynaklari gorur/yonetir.
const ROLES = ['super_admin', 'dealer_admin', 'branch_admin', 'operator'];

const ROLE_LABELS = {
  super_admin: 'Merkezi Yönetici',
  dealer_admin: 'Bayi Yöneticisi',
  branch_admin: 'Şube Yöneticisi',
  operator: 'Operatör',
};

// Yetki seviyesi: bir kullanici sadece kendinden dusuk (veya esit, super
// haric) seviyedeki rolleri olusturabilir/yonetebilir.
const ROLE_LEVEL = { super_admin: 4, dealer_admin: 3, branch_admin: 2, operator: 1 };

// Eylem -> izin verilen roller. Yeni eylemler buraya eklenir.
const ACTIONS = {
  'label.send':        ['super_admin', 'dealer_admin', 'branch_admin', 'operator'],
  'gateway.view':      ['super_admin', 'dealer_admin', 'branch_admin', 'operator'],
  'gateway.manage':    ['super_admin', 'dealer_admin', 'branch_admin'], // isim, komut
  'gateway.claim':     ['super_admin', 'dealer_admin'],
  'gateway.assign':    ['super_admin', 'dealer_admin'],                 // subeye atama
  'gateway.disable':   ['super_admin', 'dealer_admin'],
  'gateway.register':  ['super_admin'],                                 // kayit, bayiye atama, QR, silme
  'device.view':       ['super_admin', 'dealer_admin', 'branch_admin', 'operator'],
  'device.manage':     ['super_admin', 'dealer_admin', 'branch_admin'],   // ekleme, toplu ekleme, atama, silme
  'dealer.manage':     ['super_admin'],
  'branch.manage':     ['super_admin', 'dealer_admin'],
  'user.manage':       ['super_admin', 'dealer_admin', 'branch_admin'],
  'audit.view':        ['super_admin', 'dealer_admin', 'branch_admin', 'operator'],
};

function can(user, action) {
  const roles = ACTIONS[action];
  if (!roles) throw new Error('Bilinmeyen eylem: ' + action);
  return roles.includes(user.role);
}

// Kaynagin (dealer_id, branch_id) kullanicinin kapsaminda olup olmadigi.
function inScope(user, resource) {
  if (user.role === 'super_admin') return true;
  if (!resource || resource.dealer_id !== user.dealer_id) return false;
  if (user.branch_id) return resource.branch_id === user.branch_id;
  return true;
}

// Liste sorgulari icin SQL kosulu. alias: tablo takma adi, params: mevcut
// parametre dizisi (yeni degerler eklenir).
function scopeSql(user, alias, params) {
  if (user.role === 'super_admin') return 'TRUE';
  params.push(user.dealer_id);
  let sql = `${alias}.dealer_id = $${params.length}`;
  if (user.branch_id) {
    params.push(user.branch_id);
    sql += ` AND ${alias}.branch_id = $${params.length}`;
  }
  return sql;
}

// actor, role rolunde bir kullaniciyi (dealerId/branchId kapsaminda)
// olusturabilir/yonetebilir mi? Hata varsa aciklama metni, yoksa null doner.
function checkUserManagement(actor, role, dealerId, branchId) {
  if (!ROLES.includes(role)) return 'Gecersiz rol.';
  if (!can(actor, 'user.manage')) return 'Kullanici yonetme yetkiniz yok.';
  if (actor.role !== 'super_admin' && ROLE_LEVEL[role] > ROLE_LEVEL[actor.role]) {
    return 'Kendi rolunuzden yuksek bir rol atayamazsiniz.';
  }
  if (role === 'super_admin') {
    return actor.role === 'super_admin' ? null : 'Merkezi yonetici sadece merkezi yonetici tarafindan olusturulabilir.';
  }
  if (!dealerId) return 'Bayi secilmeli.';
  if (role === 'branch_admin' && !branchId) return 'Sube yoneticisi icin sube secilmeli.';
  if (role === 'dealer_admin' && branchId) return 'Bayi yoneticisi bir subeye baglanamaz.';
  if (!inScope(actor, { dealer_id: dealerId, branch_id: branchId })) return 'Bu bayi/sube sizin kapsaminizda degil.';
  return null;
}

module.exports = { ROLES, ROLE_LABELS, ROLE_LEVEL, can, inScope, scopeSql, checkUserManagement };
