// Etiket tasarimlari: kutuphane (merkez + bayi), editor kaydi, surum gecmisi,
// baska ekran boyutuna kopyalama, sunucuda PNG cizimi.
//
// Gorunurluk: merkez kutuphanesi (dealer_id NULL) herkese; bayi tasarimi
// sadece o bayiye (merkez hepsini gorur). Duzenleme: merkez kutuphanesini
// sadece merkezi yonetici, bayi tasarimini o bayinin yoneticileri.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { can, isCentral } = require('../permissions');
const { fail, parseId, optionalId, cleanName } = require('./util');
const R = require('../render');

const api = express.Router();
const requireView = auth.requireApi('design.view');
const requireManage = auth.requireApi('design.manage');
const CATEGORIES = ['market', 'otel', 'restoran', 'genel'];
const MAX_VERSIONS = 50;

function canEdit(user, d) {
  if (!can(user, 'design.manage')) return false;
  if (d.dealer_id === null) return user.role === 'super_admin';
  return user.role === 'super_admin' || d.dealer_id === user.dealer_id;
}

function listView(d, user) {
  return {
    id: d.id, name: d.name, category: d.category, description: d.description,
    scope: d.dealer_id ? 'dealer' : 'global', dealerId: d.dealer_id, dealerName: d.dealer_name || null,
    screenModelId: d.screen_model_id, modelName: d.model_name, modelCode: d.model_code,
    width: d.width_px, height: d.height_px, colors: d.colors,
    thumbnail: d.thumbnail, version: d.version, updatedAt: d.updated_at, updatedBy: d.updated_by_name || null,
    elementCount: d.element_count, editable: canEdit(user, d),
  };
}

const LIST_SELECT = `
  SELECT ds.id, ds.name, ds.category, ds.description, ds.dealer_id, ds.screen_model_id, ds.thumbnail, ds.version, ds.updated_at,
         jsonb_array_length(ds.doc->'elements') AS element_count,
         m.name AS model_name, m.code AS model_code, m.width_px, m.height_px, m.colors,
         d.name AS dealer_name, coalesce(u.full_name, u.email, u.username) AS updated_by_name
    FROM designs ds
    JOIN screen_models m ON m.id = ds.screen_model_id
    LEFT JOIN dealers d ON d.id = ds.dealer_id
    LEFT JOIN users u ON u.id = ds.updated_by`;

function visibleSql(user, params) {
  if (isCentral(user)) return 'TRUE';
  params.push(user.dealer_id);
  return `(ds.dealer_id IS NULL OR ds.dealer_id = $${params.length})`;
}

async function loadDesign(req, forEdit) {
  const id = parseId(req.params.id);
  const params = [id];
  const d = id && await db.one(`${LIST_SELECT.replace('ds.thumbnail,', 'ds.thumbnail, ds.doc,')} WHERE ds.id = $1 AND NOT ds.archived AND ${visibleSql(req.user, params)}`, params);
  if (!d) fail(404, 'Tasarım bulunamadı.');
  if (forEdit && !canEdit(req.user, d)) fail(403, d.dealer_id ? 'Bu tasarımı düzenleme yetkiniz yok.' : 'Merkez kütüphanesindeki tasarımları sadece merkezi yönetici düzenleyebilir. Kopyalayıp kendi tasarımınız olarak düzenleyebilirsiniz.');
  return d;
}

async function loadModel(id) {
  const m = await db.one('SELECT * FROM screen_models WHERE id = $1', [id]);
  if (!m) fail(400, 'Ekran modeli bulunamadı.');
  return m;
}

// Belgeyi modele uydurur (boyut/renk) ve dogrular.
function normalizeDoc(doc, model) {
  const out = doc && typeof doc === 'object' ? doc : R.DesignRender.emptyDoc(model);
  out.version = 1;
  out.width = model.width_px;
  out.height = model.height_px;
  out.colors = model.colors;
  const err = R.DesignRender.validate(out);
  if (err) fail(400, err);
  return out;
}

function thumb(v) {
  if (!v) return null;
  const s = String(v);
  if (!/^data:image\/png;base64,/.test(s) || s.length > 300000) fail(400, 'Önizleme görseli geçersiz.');
  return s;
}

// Hedef bayi: merkez icin istekten (bos = merkez kutuphanesi), digerleri kendi bayisi.
function targetDealer(user, body) {
  if (user.role === 'super_admin') return optionalId(body.dealerId, 'Bayi');
  return user.dealer_id;
}

api.get('/designs', requireView, async (req, res) => {
  const params = [];
  const conds = ['NOT ds.archived', visibleSql(req.user, params)];
  const modelId = optionalId(req.query.modelId, 'Model');
  if (modelId) { params.push(modelId); conds.push(`ds.screen_model_id = $${params.length}`); }
  if (CATEGORIES.includes(req.query.category)) { params.push(req.query.category); conds.push(`ds.category = $${params.length}`); }
  if (req.query.scope === 'global') conds.push('ds.dealer_id IS NULL');
  if (req.query.scope === 'dealer') conds.push('ds.dealer_id IS NOT NULL');
  if (req.query.q) { params.push('%' + String(req.query.q).toLowerCase() + '%'); conds.push(`lower(ds.name) LIKE $${params.length}`); }
  const rows = await db.many(`${LIST_SELECT} WHERE ${conds.join(' AND ')} ORDER BY ds.dealer_id NULLS FIRST, ds.updated_at DESC LIMIT 500`, params);
  res.json(rows.map((d) => listView(d, req.user)));
});

api.get('/designs/:id', requireView, async (req, res) => {
  const d = await loadDesign(req, false);
  res.json({ ...listView(d, req.user), doc: d.doc });
});

// Olusturma: bos, verilen belgeyle veya baska bir tasarimdan (fromDesignId) kopya.
api.post('/designs', requireManage, async (req, res) => {
  const user = req.user;
  const b = req.body || {};
  const name = cleanName(b.name, 'Tasarım adı', 120);
  const category = CATEGORIES.includes(b.category) ? b.category : 'genel';
  const model = await loadModel(optionalId(b.screenModelId, 'Ekran modeli'));
  const dealerId = targetDealer(user, b);
  let doc = b.doc;
  if (b.fromDesignId) {
    const params = [parseId(b.fromDesignId)];
    const src = await db.one(`SELECT ds.doc FROM designs ds WHERE ds.id = $1 AND NOT ds.archived AND ${visibleSql(user, params)}`, params);
    if (!src) fail(404, 'Kopyalanacak tasarım bulunamadı.');
    doc = R.DesignRender.scaleDoc(src.doc, model.width_px, model.height_px, model.colors);
  }
  doc = normalizeDoc(doc, model);
  const row = await db.one(
    `INSERT INTO designs (dealer_id, name, category, description, screen_model_id, doc, thumbnail, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
    [dealerId, name, category, String(b.description || '').slice(0, 500) || null, model.id, JSON.stringify(doc), thumb(b.thumbnail), user.id],
  );
  await audit.log(user, 'design.created', { entityType: 'design', entityId: row.id, dealerId, branchId: null, message: `${name} (${model.name})` });
  res.json({ id: row.id });
});

// Kaydetme: onceki surum gecmise yazilir.
api.post('/designs/:id', requireManage, async (req, res) => {
  const user = req.user;
  const d = await loadDesign(req, true);
  const b = req.body || {};
  const model = await loadModel(d.screen_model_id);
  const name = b.name !== undefined ? cleanName(b.name, 'Tasarım adı', 120) : d.name;
  const category = CATEGORIES.includes(b.category) ? b.category : d.category;
  const description = b.description !== undefined ? (String(b.description).slice(0, 500) || null) : d.description;
  const doc = b.doc !== undefined ? normalizeDoc(b.doc, model) : d.doc;
  const docChanged = b.doc !== undefined && JSON.stringify(doc) !== JSON.stringify(d.doc);
  const updated = await db.tx(async (c) => {
    if (docChanged) {
      await c.query('INSERT INTO design_versions (design_id, version, doc, created_by, username) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [d.id, d.version, JSON.stringify(d.doc), user.id, user.username]);
      await c.query(`DELETE FROM design_versions WHERE design_id = $1 AND version <= $2`, [d.id, d.version - MAX_VERSIONS]);
    }
    return (await c.query(
      `UPDATE designs SET name = $2, category = $3, description = $4, doc = $5, thumbnail = COALESCE($6, thumbnail),
                          version = version + $7, updated_by = $8, updated_at = now()
        WHERE id = $1 RETURNING version, updated_at`,
      [d.id, name, category, description, JSON.stringify(doc), thumb(b.thumbnail), docChanged ? 1 : 0, user.id],
    )).rows[0];
  });
  await audit.log(user, 'design.updated', { entityType: 'design', entityId: d.id, dealerId: d.dealer_id, branchId: null, message: `${name} v${updated.version}` });
  res.json({ ok: true, version: updated.version, updatedAt: updated.updated_at });
});

// Kopyala (istege bagli baska ekran boyutuna olcekleyerek, merkezden bayiye vb.)
api.post('/designs/:id/duplicate', requireManage, async (req, res) => {
  const user = req.user;
  const d = await loadDesign(req, false);
  const b = req.body || {};
  const model = await loadModel(optionalId(b.screenModelId, 'Ekran modeli') || d.screen_model_id);
  const dealerId = targetDealer(user, b);
  const name = cleanName(b.name || `${d.name} (kopya)`, 'Tasarım adı', 120);
  const doc = normalizeDoc(model.id === d.screen_model_id ? d.doc : R.DesignRender.scaleDoc(d.doc, model.width_px, model.height_px, model.colors), model);
  const row = await db.one(
    `INSERT INTO designs (dealer_id, name, category, description, screen_model_id, doc, thumbnail, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
    [dealerId, name, d.category, d.description, model.id, JSON.stringify(doc), model.id === d.screen_model_id ? d.thumbnail : null, user.id],
  );
  await audit.log(user, 'design.created', { entityType: 'design', entityId: row.id, dealerId, branchId: null, message: `${name} (${d.name} tasarımından kopya)` });
  res.json({ id: row.id, scaled: model.id !== d.screen_model_id });
});

api.delete('/designs/:id', requireManage, async (req, res) => {
  const d = await loadDesign(req, true);
  await db.query('UPDATE designs SET archived = TRUE, updated_at = now(), updated_by = $2 WHERE id = $1', [d.id, req.user.id]);
  await audit.log(req.user, 'design.deleted', { entityType: 'design', entityId: d.id, dealerId: d.dealer_id, branchId: null, message: d.name });
  res.json({ ok: true });
});

api.get('/designs/:id/versions', requireView, async (req, res) => {
  const d = await loadDesign(req, false);
  const rows = await db.many('SELECT version, username, created_at FROM design_versions WHERE design_id = $1 ORDER BY version DESC', [d.id]);
  res.json(rows);
});

api.post('/designs/:id/versions/:version/restore', requireManage, async (req, res) => {
  const d = await loadDesign(req, true);
  const v = await db.one('SELECT doc FROM design_versions WHERE design_id = $1 AND version = $2', [d.id, parseInt(req.params.version, 10)]);
  if (!v) fail(404, 'Sürüm bulunamadı.');
  // Geri yukleme de yeni bir kayit gibi davranir (mevcut hali gecmise yazilir).
  const model = await loadModel(d.screen_model_id);
  const doc = normalizeDoc(v.doc, model);
  await db.tx(async (c) => {
    await c.query('INSERT INTO design_versions (design_id, version, doc, created_by, username) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [d.id, d.version, JSON.stringify(d.doc), req.user.id, req.user.username]);
    await c.query('UPDATE designs SET doc = $2, thumbnail = NULL, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1', [d.id, JSON.stringify(doc), req.user.id]);
  });
  await audit.log(req.user, 'design.restored', { entityType: 'design', entityId: d.id, dealerId: d.dealer_id, branchId: null, message: `v${req.params.version} geri yüklendi` });
  res.json({ ok: true });
});

// Sunucuda cizim (PNG). Kayitli tasarim: ornek veya ?data=<json> ile.
api.get('/designs/:id/render.png', requireView, async (req, res) => {
  const d = await loadDesign(req, false);
  let data = R.DesignRender.sampleData();
  if (req.query.data) { try { data = { ...data, ...JSON.parse(req.query.data) }; } catch { fail(400, 'Veri geçersiz.'); } }
  const scale = Math.min(Math.max(parseInt(req.query.scale, 10) || 1, 1), 6);
  const png = await R.renderPng(d.doc, data, { scale });
  res.type('image/png').setHeader('Content-Disposition', `inline; filename="tasarim-${d.id}.png"`);
  res.send(png);
});

// Kaydedilmemis belgeyi sunucuda ciz (editorde "PNG indir").
api.post('/designs-render', requireView, async (req, res) => {
  const doc = req.body && req.body.doc;
  const err = R.DesignRender.validate(doc);
  if (err) fail(400, err);
  const scale = Math.min(Math.max(parseInt(req.body.scale, 10) || 1, 1), 6);
  const png = await R.renderPng(doc, { ...R.DesignRender.sampleData(), ...(req.body.data || {}) }, { scale });
  res.type('image/png').send(png);
});

// Tarayicidaki onizleme icin QR matrisi (sunucuyla ayni kodlama).
api.get('/qr-matrix', requireView, (req, res) => {
  const text = String(req.query.text || '');
  if (!text) fail(400, 'Metin boş.');
  const m = R.qrMatrix(text);
  res.json({ size: m.size, modules: m.modules.map((v) => (v ? 1 : 0)).join('') });
});

module.exports = { api };
