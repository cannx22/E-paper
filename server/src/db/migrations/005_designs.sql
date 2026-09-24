-- Faz 5 (1. asama): etiket tasarim editoru ve tasarim kutuphanesi.
--
-- Bir tasarim bir ekran modeline (cozunurluk + renk) goredir. Belge (doc)
-- kendi semamizdir: { version, width, height, colors, elements: [...] }.
-- Ayni cizim motoru (public/static/design-render.js) tarayicidaki
-- onizlemede ve sunucuda (src/render.js) kullanilir.
--
-- dealer_id NULL = merkez kutuphanesi (tum bayiler gorur/kopyalar).

-- Uc renkli paneller (siyah-beyaz-kirmizi / siyah-beyaz-sari)
INSERT INTO screen_models (code, name, diagonal_in, width_px, height_px, colors) VALUES
  ('EPD213-BWR', '2.13" Siyah/Beyaz/Kırmızı', 2.13, 250, 122, 'bwr'),
  ('EPD29-BWR',  '2.9" Siyah/Beyaz/Kırmızı', 2.90, 296, 128, 'bwr'),
  ('EPD29-BWY',  '2.9" Siyah/Beyaz/Sarı', 2.90, 296, 128, 'bwy'),
  ('EPD42-BWR',  '4.2" Siyah/Beyaz/Kırmızı', 4.20, 400, 300, 'bwr'),
  ('EPD75-BWR',  '7.5" Siyah/Beyaz/Kırmızı', 7.50, 800, 480, 'bwr')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE designs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dealer_id        BIGINT REFERENCES dealers(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'genel' CHECK (category IN ('market', 'otel', 'restoran', 'genel')),
  description      TEXT,
  screen_model_id  BIGINT NOT NULL REFERENCES screen_models(id),
  doc              JSONB NOT NULL,
  thumbnail        TEXT,                    -- kucuk PNG (data URL), listede gosterilir
  version          INTEGER NOT NULL DEFAULT 1,
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX designs_dealer_idx ON designs (dealer_id) WHERE NOT archived;
CREATE INDEX designs_model_idx ON designs (screen_model_id) WHERE NOT archived;

-- Her kaydetmede onceki surum saklanir (geri alma icin).
CREATE TABLE design_versions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  design_id   BIGINT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  doc         JSONB NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (design_id, version)
);
