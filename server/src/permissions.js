// Rol ve kapsam (scope) kurallari tek yerde. Her kaynak (gateway, cihaz,
// kullanici, sube, ileride urun/sablon) bir bayiye ve istege bagli bir subeye
// aittir; kullanici sadece kendi kapsamindaki kaynaklari gorur/yonetir.
//
//   Merkez rolleri (bayisiz): super_admin (her sey), support (her seyi
//   gorur, hicbir seyi degistiremez - destek ekibi icin)
//   Bayi rolleri: dealer_admin (bayi + tum subeleri), branch_admin (tek
//   sube), operator (bayi veya tek sube kapsaminda etiket gonderir)
const ROLES = ['super_admin', 'support', 'dealer_admin', 'branch_admin', 'operator'];
const CENTRAL_ROLES = ['super_admin', 'support'];

const ROLE_LABELS = {
  super_admin: 'Merkezi Yönetici',
  support: 'Merkez Destek',
  dealer_admin: 'Bayi Yöneticisi',
  branch_admin: 'Şube Yöneticisi',
  operator: 'Operatör',
};

const ROLE_DESCRIPTIONS = {
  super_admin: 'Tüm sistemi yönetir: bayiler, gateway kaydı, seri no havuzu, ayarlar, tüm kullanıcılar.',
  support: 'Tüm bayileri, gateway ve cihazları görüntüler; değişiklik yapamaz (destek ekibi).',
  dealer_admin: 'Kendi bayisini ve tüm şubelerini yönetir: şube, kullanıcı, gateway ve cihazlar.',
  branch_admin: 'Sadece kendi şubesindeki kullanıcıları, gateway ve cihazları yönetir.',
  operator: 'Etiket gönderir ve geçmişi görür; ayarlara erişemez. Şubeye bağlıysa sadece o şubeyi görür.',
};

// Yetki seviyesi: bir kullanici sadece kendinden dusuk seviyedeki rolleri
// (merkezi yonetici icin hepsini) olusturabilir/yonetebilir.
const ROLE_LEVEL = { super_admin: 5, support: 4, dealer_admin: 3, branch_admin: 2, operator: 1 };

const ALL = ROLES;
const MANAGERS = ['super_admin', 'dealer_admin', 'branch_admin'];

// Eylem -> izin verilen roller. Yeni eylemler buraya eklenir.
const ACTIONS = {
  'label.send':        ['super_admin', 'dealer_admin', 'branch_admin', 'operator'],
  'gateway.view':      ALL,
  'gateway.manage':    MANAGERS,                                         // isim, konum, komut
  'gateway.claim':     ['super_admin', 'dealer_admin'],
  'gateway.assign':    ['super_admin', 'dealer_admin'],                  // subeye atama, cihaz tasima
  'gateway.disable':   ['super_admin', 'dealer_admin'],
  'gateway.register':  ['super_admin'],                                  // kayit, bayiye atama, QR, silme
  'device.view':       ALL,
  'device.manage':     MANAGERS,                                         // ekleme, toplu ekleme, atama, silme
  'inventory.manage':  ['super_admin'],                                  // seri no havuzu
  'design.view':       ALL,
  'design.manage':     MANAGERS,                                         // bayi tasarimlari (merkez kutuphanesi: sadece merkezi yonetici)
  'dealer.view':       ['super_admin', 'support'],
  'dealer.manage':     ['super_admin'],
  'branch.view':       ['super_admin', 'support', 'dealer_admin'],
  'branch.manage':     ['super_admin', 'dealer_admin'],
  'user.view':         ['super_admin', 'support', 'dealer_admin', 'branch_admin'],
  'user.manage':       MANAGERS,
  'audit.view':        ALL,
  'settings.manage':   ['super_admin'],
};

function isCentral(user) {
  return CENTRAL_ROLES.includes(user.role);
}

function can(user, action) {
  const roles = ACTIONS[action];
  if (!roles) throw new Error('Bilinmeyen eylem: ' + action);
  return roles.includes(user.role);
}

// Kaynagin (dealer_id, branch_id) kullanicinin kapsaminda olup olmadigi.
function inScope(user, resource) {
  if (isCentral(user)) return true;
  if (!resource || resource.dealer_id !== user.dealer_id) return false;
  if (user.branch_id) return resource.branch_id === user.branch_id;
  return true;
}

// Liste sorgulari icin SQL kosulu. alias: tablo takma adi, params: mevcut
// parametre dizisi (yeni degerler eklenir).
function scopeSql(user, alias, params) {
  if (isCentral(user)) return 'TRUE';
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
  if (actor.role !== 'super_admin' && ROLE_LEVEL[role] >= ROLE_LEVEL[actor.role] && role !== actor.role) {
    return 'Kendi rolunuzden yuksek bir rol atayamazsiniz.';
  }
  if (CENTRAL_ROLES.includes(role)) {
    return actor.role === 'super_admin' ? null : 'Merkez rolleri sadece merkezi yonetici tarafindan atanabilir.';
  }
  if (!dealerId) return 'Bayi secilmeli.';
  if (role === 'branch_admin' && !branchId) return 'Sube yoneticisi icin sube secilmeli.';
  if (role === 'dealer_admin' && branchId) return 'Bayi yoneticisi bir subeye baglanamaz.';
  if (!inScope(actor, { dealer_id: dealerId, branch_id: branchId })) return 'Bu bayi/sube sizin kapsaminizda degil.';
  return null;
}

module.exports = {
  ROLES, CENTRAL_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_LEVEL, ACTIONS,
  isCentral, can, inScope, scopeSql, checkUserManagement,
};
