-- Faz 2: E-paper cihaz kaydi ve ekran modelleri.

-- Ekran modelleri: sablon/tasarim sistemi (Faz 5-6) cozunurluk ve renk
-- destegini buradan okur.
CREATE TABLE screen_models (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  diagonal_in  NUMERIC(4, 2),
  width_px     INTEGER NOT NULL CHECK (width_px > 0),
  height_px    INTEGER NOT NULL CHECK (height_px > 0),
  colors       TEXT NOT NULL DEFAULT 'bw' CHECK (colors IN ('bw', 'bwr', 'bwy', 'color')),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO screen_models (code, name, diagonal_in, width_px, height_px, colors) VALUES
  ('EPD213-BW', '2.13" Siyah/Beyaz (GDEY0213B74)', 2.13, 250, 122, 'bw'),
  ('EPD154-BW', '1.54" Siyah/Beyaz', 1.54, 200, 200, 'bw'),
  ('EPD29-BW',  '2.9" Siyah/Beyaz', 2.90, 296, 128, 'bw'),
  ('EPD42-BW',  '4.2" Siyah/Beyaz', 4.20, 400, 300, 'bw'),
  ('EPD75-BW',  '7.5" Siyah/Beyaz', 7.50, 800, 480, 'bw'),
  ('EPD102-BW', '10.2" Siyah/Beyaz', 10.20, 960, 640, 'bw');

-- E-paper cihaz: kimligi 8 haneli seri numarasidir ve hic degismez.
-- Seri no'dan nRF24 adresine cevirme (BCD) gateway ve alici tarafinda
-- yapilir; sunucu seri no'yu oldugu gibi "send" mesajinda iletir.
-- Son guncelleme bilgileri Faz 3'teki is kuyrugu gelene kadar burada tutulur.
CREATE TABLE devices (
  id                   TEXT PRIMARY KEY CHECK (id ~ '^[0-9]{8}$'),
  name                 TEXT,
  model_id             BIGINT REFERENCES screen_models(id),
  dealer_id            BIGINT NOT NULL REFERENCES dealers(id),
  branch_id            BIGINT REFERENCES branches(id) ON DELETE SET NULL,
  gateway_id           TEXT REFERENCES gateways(id) ON DELETE SET NULL,
  state                TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  notes                TEXT,
  last_update_at       TIMESTAMPTZ,
  last_update_ok       BOOLEAN,
  last_update_message  TEXT,
  last_content         JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_dealer_idx ON devices (dealer_id);
CREATE INDEX devices_branch_idx ON devices (branch_id);
CREATE INDEX devices_gateway_idx ON devices (gateway_id);
