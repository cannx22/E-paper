// Bayi ve sube yonetimi: kurum bilgileri, lisans limitleri, bayi acilis
// sihirbazi (bayi + ilk bayi yoneticisi tek adimda).
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { isCentral } = require('../permissions');
const { fail, parseId, optionalId, cleanName } = require('./util');

const api = express.Router();

function uniqueViolation(err) {
  return err && err.code === '23505';
}

// Metin alanlari: istek govdesindeki anahtar = kolon adi, en fazla uzunluk.
const DEALER_TEXT = { code: 20, legal_name: 200, tax_office: 80, tax_number: 20, contact_name: 120, phone: 40, email: 120, address: 400, city: 60, district: 60, postal_code: 10, notes: 2000 };
const BRANCH_TEXT = { code: 20, contact_name: 120, phone: 40, email: 120, address: 400, city: 60, district: 60, postal_code: 10, notes: 2000 };

function pickText(body, spec, current = {}) {
  const out = {};
  for (const [k, max] of Object.entries(spec)) {
    if (body[k] === undefined) out[k] = current[k] ?? null;
    else out[k] = String(body[k] == null ? '' : body[k]).trim().slice(0, max) || null;
  }
  if (out.email && !auth.EMAIL_RE.test(out.email)) fail(400, 'E-posta adresi gecersiz.');
  if (out.tax_number && !/^\d{10,11}$/.test(out.tax_number)) fail(400, 'Vergi / TC kimlik no 10 veya 11 haneli olmali.');
  return out;
}

function optionalLimit(v, current, label) {
  if (v === undefined) return current ?? null;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(400, `${label} 0 veya pozitif tam sayi olmali (bos = limitsiz).`);
  return n;
}

function optionalDate(v, current) {
  if (v === undefined) return current ?? null;
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) fail(400, 'Sozlesme bitis tarihi gecersiz.');
  return String(v);
}

const DEALER_SELECT = `
  SELECT d.*,
         (SELECT count(*)::int FROM branches b WHERE b.dealer_id = d.id) AS branch_count,
         (SELECT count(*)::int FROM gateways g WHERE g.dealer_id = d.id) AS gateway_count,
         (SELECT count(*)::int FROM devices dv WHERE dv.dealer_id = d.id) AS device_count,
         (SELECT count(*)::int FROM users u WHERE u.dealer_id = d.id) AS user_count
    FROM dealers d`;

// ---- Bayiler ----
// Merkez tum bayileri, diger roller sadece kendi bayisini gorur.
api.get('/dealers', auth.requireApi(), async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (!isCentral(req.user)) {
    params.push(req.user.dealer_id);
    where = 'd.id = $1';
  }
  res.json(await db.many(`${DEALER_SELECT} WHERE ${where} ORDER BY lower(d.name)`, params));
});

api.get('/dealers/:id', auth.requireApi(), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id || (!isCentral(req.user) && id !== req.user.dealer_id)) fail(404, 'Bayi bulunamadi.');
  const dealer = await db.one(`${DEALER_SELECT} WHERE d.id = $1`, [id]);
  if (!dealer) fail(404, 'Bayi bulunamadi.');
  res.json(dealer);
});

async function insertDealer(c, body) {
  const name = cleanName(body.name, 'Bayi adi', 120);
  const t = pickText(body, DEALER_TEXT);
  const r = await c.query(
    `INSERT INTO dealers (name, code, legal_name, tax_office, tax_number, contact_name, phone, email, address,
                          city, district, postal_code, notes, max_gateways, max_devices, contract_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [name, t.code, t.legal_name, t.tax_office, t.tax_number, t.contact_name, t.phone, t.email, t.address,
      t.city, t.district, t.postal_code, t.notes,
      optionalLimit(body.max_gateways, null, 'Gateway limiti'), optionalLimit(body.max_devices, null, 'Cihaz limiti'),
      optionalDate(body.contract_end, null)],
  );
  return r.rows[0];
}

// Bayi olusturma. body.admin verilirse ({email, password, fullName, phone,
// title, mustChangePassword}) ilk bayi yoneticisi ayni transaction'da acilir.
api.post('/dealers', auth.requireApi('dealer.manage'), async (req, res) => {
  const admin = req.body.admin;
  if (admin) {
    const email = auth.normalizeEmail(admin.email);
    if (!auth.EMAIL_RE.test(email)) fail(400, 'Bayi yoneticisi icin gecerli bir e-posta girin.');
    const policy = await auth.checkPasswordPolicy(String(admin.password || ''));
    if (policy) fail(400, 'Bayi yoneticisi sifresi: ' + policy);
  }
  try {
    const result = await db.tx(async (c) => {
      const dealer = await insertDealer(c, req.body);
      let adminId = null;
      if (admin) {
        adminId = await auth.createUser(c, {
          email: admin.email, password: String(admin.password), fullName: String(admin.fullName || '').trim().slice(0, 120),
          phone: String(admin.phone || '').trim().slice(0, 40), title: String(admin.title || '').trim().slice(0, 80),
          role: 'dealer_admin', dealerId: dealer.id, mustChangePassword: !!admin.mustChangePassword, createdBy: req.user.id,
        });
      }
      return { dealer, adminId };
    });
    await audit.log(req.user, 'dealer.created', { entityType: 'dealer', entityId: result.dealer.id, dealerId: result.dealer.id, branchId: null, message: result.dealer.name });
    if (result.adminId) {
      await audit.log(req.user, 'user.created', { entityType: 'user', entityId: result.adminId, dealerId: result.dealer.id, branchId: null, message: `${auth.normalizeEmail(admin.email)} (Bayi Yöneticisi)` });
    }
    res.json(result.dealer);
  } catch (err) {
    if (uniqueViolation(err)) {
      if (String(err.constraint).includes('email')) fail(400, 'Bu e-posta adresi baska bir hesapta kullaniliyor.');
      if (String(err.constraint).includes('code')) fail(400, 'Bu bayi kodu baska bir bayide kullaniliyor.');
      fail(400, 'Bu isimde bir bayi zaten var.');
    }
    throw err;
  }
});

// Bilgi guncelleme ve aktif/pasif. Pasif bayinin kullanicilari giris
// yapamaz, acik oturumlari gecersiz olur, etiket gonderimi durur.
api.post('/dealers/:id', auth.requireApi('dealer.manage'), async (req, res) => {
  const id = parseId(req.params.id);
  const dealer = id && await db.one('SELECT * FROM dealers WHERE id = $1', [id]);
  if (!dealer) fail(404, 'Bayi bulunamadi.');
  const name = req.body.name !== undefined ? cleanName(req.body.name, 'Bayi adi', 120) : dealer.name;
  const active = req.body.active !== undefined ? !!req.body.active : dealer.active;
  const t = pickText(req.body, DEALER_TEXT, dealer);
  const maxGw = optionalLimit(req.body.max_gateways, dealer.max_gateways, 'Gateway limiti');
  const maxDev = optionalLimit(req.body.max_devices, dealer.max_devices, 'Cihaz limiti');
  const contractEnd = optionalDate(req.body.contract_end, dealer.contract_end);
  try {
    const row = await db.one(
      `UPDATE dealers SET name = $2, active = $3, code = $4, legal_name = $5, tax_office = $6, tax_number = $7,
                          contact_name = $8, phone = $9, email = $10, address = $11, city = $12, district = $13,
                          postal_code = $14, notes = $15, max_gateways = $16, max_devices = $17, contract_end = $18
        WHERE id = $1 RETURNING *`,
      [id, name, active, t.code, t.legal_name, t.tax_office, t.tax_number, t.contact_name, t.phone, t.email,
        t.address, t.city, t.district, t.postal_code, t.notes, maxGw, maxDev, contractEnd],
    );
    if (dealer.active && !active) {
      await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE dealer_id = $1)', [id]);
    }
    await audit.log(req.user, active === dealer.active ? 'dealer.updated' : (active ? 'dealer.activated' : 'dealer.deactivated'), {
      entityType: 'dealer', entityId: id, dealerId: id, branchId: null,
      details: { before: { name: dealer.name, active: dealer.active, max_gateways: dealer.max_gateways, max_devices: dealer.max_devices }, after: { name, active, max_gateways: maxGw, max_devices: maxDev } },
    });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, String(err.constraint).includes('code') ? 'Bu bayi kodu baska bir bayide kullaniliyor.' : 'Bu isimde bir bayi zaten var.');
    throw err;
  }
});

// ---- Subeler (opsiyonel) ----
const BRANCH_SELECT = `
  SELECT b.*, d.name AS dealer_name,
         (SELECT count(*)::int FROM gateways g WHERE g.branch_id = b.id) AS gateway_count,
         (SELECT count(*)::int FROM devices dv WHERE dv.branch_id = b.id) AS device_count,
         (SELECT count(*)::int FROM users u WHERE u.branch_id = b.id) AS user_count
    FROM branches b JOIN dealers d ON d.id = b.dealer_id`;

api.get('/branches', auth.requireApi(), async (req, res) => {
  const params = [];
  const conds = [];
  if (!isCentral(req.user)) {
    params.push(req.user.dealer_id);
    conds.push(`b.dealer_id = $${params.length}`);
    if (req.user.branch_id) {
      params.push(req.user.branch_id);
      conds.push(`b.id = $${params.length}`);
    }
  }
  const dealerFilter = optionalId(req.query.dealerId, 'Bayi');
  if (dealerFilter) {
    params.push(dealerFilter);
    conds.push(`b.dealer_id = $${params.length}`);
  }
  res.json(await db.many(`${BRANCH_SELECT} WHERE ${conds.length ? conds.join(' AND ') : 'TRUE'} ORDER BY lower(d.name), lower(b.name)`, params));
});

async function loadBranch(req, forManage) {
  const id = parseId(req.params.id);
  const branch = id && await db.one(`${BRANCH_SELECT} WHERE b.id = $1`, [id]);
  if (!branch) fail(404, 'Sube bulunamadi.');
  const u = req.user;
  const visible = isCentral(u) || (branch.dealer_id === u.dealer_id && (!u.branch_id || u.branch_id === branch.id));
  if (!visible) fail(404, 'Sube bulunamadi.');
  // branch.manage sadece merkez ve bayi yoneticisinde: bayi kapsami yeterli.
  if (forManage && u.role !== 'super_admin' && branch.dealer_id !== u.dealer_id) fail(404, 'Sube bulunamadi.');
  return branch;
}

api.get('/branches/:id', auth.requireApi(), async (req, res) => {
  res.json(await loadBranch(req, false));
});

api.post('/branches', auth.requireApi('branch.manage'), async (req, res) => {
  const dealerId = req.user.role === 'super_admin' ? optionalId(req.body.dealerId ?? req.body.dealer_id, 'Bayi') : req.user.dealer_id;
  if (!dealerId) fail(400, 'Bayi secilmeli.');
  const dealer = await db.one('SELECT id FROM dealers WHERE id = $1', [dealerId]);
  if (!dealer) fail(404, 'Bayi bulunamadi.');
  const name = cleanName(req.body.name, 'Sube adi', 120);
  const t = pickText(req.body, BRANCH_TEXT);
  try {
    const row = await db.one(
      `INSERT INTO branches (dealer_id, name, code, contact_name, phone, email, address, city, district, postal_code, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [dealerId, name, t.code, t.contact_name, t.phone, t.email, t.address, t.city, t.district, t.postal_code, t.notes],
    );
    await audit.log(req.user, 'branch.created', { entityType: 'branch', entityId: row.id, dealerId, branchId: row.id, message: name });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, String(err.constraint).includes('code') ? 'Bu sube kodu bu bayide kullaniliyor.' : 'Bu bayide bu isimde bir sube zaten var.');
    throw err;
  }
});

api.post('/branches/:id', auth.requireApi('branch.manage'), async (req, res) => {
  const branch = await loadBranch(req, true);
  const name = req.body.name !== undefined ? cleanName(req.body.name, 'Sube adi', 120) : branch.name;
  const active = req.body.active !== undefined ? !!req.body.active : branch.active;
  const t = pickText(req.body, BRANCH_TEXT, branch);
  try {
    const row = await db.one(
      `UPDATE branches SET name = $2, active = $3, code = $4, contact_name = $5, phone = $6, email = $7,
                           address = $8, city = $9, district = $10, postal_code = $11, notes = $12
        WHERE id = $1 RETURNING *`,
      [branch.id, name, active, t.code, t.contact_name, t.phone, t.email, t.address, t.city, t.district, t.postal_code, t.notes],
    );
    if (branch.active && !active) {
      await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE branch_id = $1)', [branch.id]);
    }
    await audit.log(req.user, 'branch.updated', {
      entityType: 'branch', entityId: branch.id, dealerId: branch.dealer_id, branchId: branch.id,
      details: { before: { name: branch.name, active: branch.active }, after: { name, active } },
    });
    res.json(row);
  } catch (err) {
    if (uniqueViolation(err)) fail(400, String(err.constraint).includes('code') ? 'Bu sube kodu bu bayide kullaniliyor.' : 'Bu bayide bu isimde bir sube zaten var.');
    throw err;
  }
});

// Silinen subenin gateway ve cihazlari bayi seviyesine duser (branch_id =
// NULL); subeye bagli kullanici varsa silme reddedilir.
api.delete('/branches/:id', auth.requireApi('branch.manage'), async (req, res) => {
  const branch = await loadBranch(req, true);
  if (branch.user_count > 0) fail(400, `Bu subeye bagli ${branch.user_count} kullanici var; once onlari silin veya baska subeye tasiyin.`);
  await db.tx(async (c) => {
    await c.query('UPDATE devices SET branch_id = NULL WHERE branch_id = $1', [branch.id]);
    await c.query('DELETE FROM branches WHERE id = $1', [branch.id]);
  });
  await audit.log(req.user, 'branch.deleted', { entityType: 'branch', entityId: branch.id, dealerId: branch.dealer_id, branchId: null, message: branch.name });
  res.json({ ok: true });
});

module.exports = { api };
