-- Faz 6: tasarimi etikete resim olarak gonderme (resim modu).
--
-- Sunucu tasarimi panelin cozunurlugunde cizer, panelin kendi RAM bicimine
-- (bit duzlemleri / 2 bit renk kodu) cevirir, RLE ile sikistirir ve isin
-- icinde saklar. Gateway bu veriyi anlamadan parcalayip nRF24 ile gonderir.
-- Ayrintili protokol: docs/resim-modu.md

-- 4 renkli paneller (siyah-beyaz-kirmizi-sari)
ALTER TABLE screen_models DROP CONSTRAINT IF EXISTS screen_models_colors_check;
ALTER TABLE screen_models ADD CONSTRAINT screen_models_colors_check
  CHECK (colors IN ('bw', 'bwr', 'bwy', 'bwry', 'color'));

-- Tasarim tuvali ile panelin fiziksel tarama yonu farkli olabilir (ornek:
-- yatay 648x480 panel dikey kullaniliyor). rotation: tuvali panele
-- yazarken saat yonunde kac derece dondurulecegi.
ALTER TABLE screen_models
  ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270));

INSERT INTO screen_models (code, name, diagonal_in, width_px, height_px, colors, rotation) VALUES
  ('EPD583-BWRY-V', '5.83" 4 Renk Dikey (GDEY0583F41)', 5.83, 480, 648, 'bwry', 90),
  ('EPD583-BWRY-H', '5.83" 4 Renk Yatay (GDEY0583F41)', 5.83, 648, 480, 'bwry', 0)
ON CONFLICT (code) DO NOTHING;

-- Is turu: 'fields' = eski alan modu (399 byte'lik metin paketi),
-- 'image' = resim modu (image sutununda gateway'e gidecek ikili veri).
ALTER TABLE update_jobs
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'fields' CHECK (kind IN ('fields', 'image')),
  ADD COLUMN design_id BIGINT REFERENCES designs(id) ON DELETE SET NULL,
  ADD COLUMN design_version INTEGER,
  ADD COLUMN image BYTEA,
  ADD COLUMN image_hash TEXT;

-- Cihazin son gosterdigi tasarim (cihaz detayinda "ekrandaki goruntu").
ALTER TABLE devices
  ADD COLUMN design_id BIGINT REFERENCES designs(id) ON DELETE SET NULL,
  ADD COLUMN last_image_job_id BIGINT REFERENCES update_jobs(id) ON DELETE SET NULL;
