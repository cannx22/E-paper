-- Faz 2.5: hesap yonetimi (e-posta ile giris, profil, sifre politikasi,
-- hesap kilidi), bayi/sube kurum bilgileri ve lisans limitleri, merkez
-- destek rolu, gateway konum/baglanti gecmisi, seri no havuzu, ayarlar.

-- ---- Roller: merkez destek (salt okunur, tum bayiler) ----
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'support', 'dealer_admin', 'branch_admin', 'operator'));
ALTER TABLE users DROP CONSTRAINT users_check;
ALTER TABLE users ADD CONSTRAINT users_central_no_dealer
  CHECK ((role IN ('super_admin', 'support')) = (dealer_id IS NULL));

-- ---- Kullanici profili ve giris guvenligi ----
-- Giris e-posta ile yapilir. Faz 1'den kalan kullanicilarin e-postasi bos
-- olabilir; bunlar e-posta ekleyene kadar kullanici adiyla girebilir.
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN email                 TEXT,
  ADD COLUMN full_name             TEXT,
  ADD COLUMN phone                 TEXT,
  ADD COLUMN title                 TEXT,
  ADD COLUMN notes                 TEXT,
  ADD COLUMN must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN password_changed_at   TIMESTAMPTZ,
  ADD COLUMN failed_login_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN locked_until          TIMESTAMPTZ,
  ADD COLUMN created_by            BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
-- Eski e-posta bicimli kullanici adlarini e-posta alanina tasi.
UPDATE users SET email = lower(username) WHERE email IS NULL AND username ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';

ALTER TABLE sessions
  ADD COLUMN ip          TEXT,
  ADD COLUMN user_agent  TEXT;

-- ---- Bayi kurum bilgileri ve lisans limitleri ----
ALTER TABLE dealers
  ADD COLUMN code          TEXT,
  ADD COLUMN legal_name    TEXT,
  ADD COLUMN tax_office    TEXT,
  ADD COLUMN tax_number    TEXT,
  ADD COLUMN contact_name  TEXT,
  ADD COLUMN phone         TEXT,
  ADD COLUMN email         TEXT,
  ADD COLUMN address       TEXT,
  ADD COLUMN city          TEXT,
  ADD COLUMN district      TEXT,
  ADD COLUMN postal_code   TEXT,
  ADD COLUMN notes         TEXT,
  ADD COLUMN max_gateways  INTEGER CHECK (max_gateways IS NULL OR max_gateways >= 0),
  ADD COLUMN max_devices   INTEGER CHECK (max_devices IS NULL OR max_devices >= 0),
  ADD COLUMN contract_end  DATE;
CREATE UNIQUE INDEX dealers_code_uq ON dealers (lower(code)) WHERE code IS NOT NULL;

-- ---- Sube bilgileri ----
ALTER TABLE branches
  ADD COLUMN code          TEXT,
  ADD COLUMN contact_name  TEXT,
  ADD COLUMN phone         TEXT,
  ADD COLUMN email         TEXT,
  ADD COLUMN address       TEXT,
  ADD COLUMN city          TEXT,
  ADD COLUMN district      TEXT,
  ADD COLUMN postal_code   TEXT,
  ADD COLUMN notes         TEXT;
CREATE UNIQUE INDEX branches_code_uq ON branches (dealer_id, lower(code)) WHERE code IS NOT NULL;

-- ---- Gateway konum/not ve baglanti gecmisi ----
ALTER TABLE gateways
  ADD COLUMN location  TEXT,
  ADD COLUMN notes     TEXT;

CREATE TABLE gateway_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_id  TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  event       TEXT NOT NULL CHECK (event IN ('connected', 'disconnected', 'rejected')),
  ip          TEXT,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gateway_events_gw_idx ON gateway_events (gateway_id, created_at DESC);

-- ---- Cihaz: son basarili iletisim ----
ALTER TABLE devices ADD COLUMN last_ok_at TIMESTAMPTZ;
UPDATE devices SET last_ok_at = last_update_at WHERE last_update_ok;

-- ---- Seri no havuzu (uretilen cihazlar) ----
-- Merkez uretilen seri numaralarini yukler. "Seri no havuzu zorunlu" ayari
-- aciksa bayiler sadece havuzdaki (ve kendilerine veya kimseye tahsis
-- edilmemis) numaralari cihaz olarak ekleyebilir.
CREATE TABLE device_inventory (
  serial      TEXT PRIMARY KEY CHECK (serial ~ '^[0-9]{8}$'),
  model_id    BIGINT REFERENCES screen_models(id),
  batch       TEXT,
  dealer_id   BIGINT REFERENCES dealers(id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_inventory_dealer_idx ON device_inventory (dealer_id);

-- ---- Sistem ayarlari ----
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('company_name', '"E-Paper Yönetim"'),
  ('inventory_required', 'false'),
  ('password_min_length', '8');
