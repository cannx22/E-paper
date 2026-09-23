-- Faz 1: cok kiracili temel yapi (bayi -> sube -> gateway), roller, oturumlar,
-- islem logu. Sonraki fazlar (cihazlar, is kuyrugu, urunler, sablonlar) yeni
-- migration dosyalari olarak eklenir; bu dosya degistirilmez.

-- Bayi: sistemin kiraci (tenant) birimi. Her kaynak bir bayiye aittir.
CREATE TABLE dealers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dealers_name_uq ON dealers (lower(name));

-- Sube: opsiyonel. Sube kullanmayan bayide kaynaklarin branch_id'si NULL kalir.
CREATE TABLE branches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dealer_id   BIGINT NOT NULL REFERENCES dealers(id),
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_dealer_name_uq ON branches (dealer_id, lower(name));

-- Roller: super_admin (merkez, bayisiz), dealer_admin (bayi), branch_admin
-- (sube), operator (bayi veya sube kapsaminda, ayarlara erisemez).
CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('super_admin', 'dealer_admin', 'branch_admin', 'operator')),
  dealer_id      BIGINT REFERENCES dealers(id),
  branch_id      BIGINT REFERENCES branches(id),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  CHECK ((role = 'super_admin') = (dealer_id IS NULL)),
  CHECK (role <> 'branch_admin' OR branch_id IS NOT NULL),
  CHECK (role IN ('branch_admin', 'operator') OR branch_id IS NULL)
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

-- Oturumlar veritabaninda: deploy/yeniden baslatma sonrasi da gecerli kalir.
-- Token'in kendisi degil SHA-256 ozeti saklanir.
CREATE TABLE sessions (
  token_hash     TEXT PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Gateway yasam dongusu (state):
--   pending     Beklemede: sunucuya baglandi ama merkezde kaydi yok
--   registered  Kayitli: merkezde kayitli, bayiye atanmadi (QR ile sahiplenilebilir)
--   awaiting    Baglanti Bekleniyor: bayiye atandi, dogrulanmis baglanti bekleniyor
--   active      Aktif: bayiye atanmis ve dogrulanmis baglanti kurmus
--   disabled    Devre Disi
-- Offline / Hata durumlari calisma anindaki baglanti ve telemetriden hesaplanir.
CREATE TABLE gateways (
  id               TEXT PRIMARY KEY CHECK (id ~ '^[0-9A-F]{12}$'),
  name             TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending', 'registered', 'awaiting', 'active', 'disabled')),
  dealer_id        BIGINT REFERENCES dealers(id),
  branch_id        BIGINT REFERENCES branches(id) ON DELETE SET NULL,
  secret_hash      TEXT,
  claim_code       TEXT,
  fw_version       TEXT,
  last_ip          TEXT,
  nrf_ok           BOOLEAN,
  wifi_ssid        TEXT,
  wifi_rssi        INTEGER,
  uptime_s         BIGINT,
  free_heap        INTEGER,
  last_error       TEXT,
  first_seen_at    TIMESTAMPTZ,
  connected_at     TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ,
  last_message_at  TIMESTAMPTZ,
  activated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('awaiting', 'active') OR dealer_id IS NOT NULL)
);
CREATE INDEX gateways_dealer_idx ON gateways (dealer_id);
CREATE INDEX gateways_branch_idx ON gateways (branch_id);

-- Islem logu: kim, ne zaman, hangi kaynakta, ne yapti, sonuc. Etiket
-- gonderimleri de burada (action = 'label.send', details icinde icerik).
CREATE TABLE audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  username     TEXT,
  dealer_id    BIGINT,
  branch_id    BIGINT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  success      BOOLEAN NOT NULL DEFAULT TRUE,
  message      TEXT,
  details      JSONB
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_dealer_idx ON audit_log (dealer_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
