-- Faz 3: kalici guncelleme kuyrugu.
--
-- Her etiket gonderimi bir "is" (update_jobs) olarak kaydedilir; toplu
-- gonderimler bir "toplu is" (update_batches) altinda gruplanir. Dagitici
-- (src/queue.js) isleri gateway basina sirayla gonderir; gateway
-- cevrimdisiyken is bekler, basarisiz isler artan aralikla yeniden denenir.
--
-- Is durumlari:
--   queued      Bekliyor (sirada veya gateway cevrimdisi)
--   sending     Gonderiliyor (gateway'e iletildi)
--   received    Gateway aldi (gateway alindi onayi verdi)
--   success     Basarili (cihaz tum paketleri aldi)
--   unreachable Cihaz ulasilamiyor (nRF cevap yok, denemeler bitti)
--   failed      Hata (diger hatalar, denemeler bitti)
--   cancelled   Iptal (kullanici veya daha yeni icerik)
--   expired     Suresi doldu (cok uzun sure gonderilemedi)

CREATE TABLE update_batches (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dealer_id     BIGINT REFERENCES dealers(id) ON DELETE CASCADE,
  branch_id     BIGINT REFERENCES branches(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bulk', 'excel', 'api', 'schedule')),
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  username      TEXT,
  total         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX update_batches_dealer_idx ON update_batches (dealer_id, created_at DESC);

CREATE TABLE update_jobs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id         BIGINT REFERENCES update_batches(id) ON DELETE CASCADE,
  dealer_id        BIGINT REFERENCES dealers(id) ON DELETE CASCADE,
  branch_id        BIGINT REFERENCES branches(id) ON DELETE SET NULL,
  serial           TEXT NOT NULL CHECK (serial ~ '^[0-9]{8}$'),
  gateway_id       TEXT REFERENCES gateways(id) ON DELETE SET NULL,
  fixed_gateway    BOOLEAN NOT NULL DEFAULT FALSE,  -- kayitsiz seri no: gateway istekte verildi
  fields           JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sending', 'received', 'success', 'unreachable', 'failed', 'cancelled', 'expired')),
  priority         INTEGER NOT NULL DEFAULT 0,      -- yuksek once (tekli gonderim > toplu)
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  last_message     TEXT,
  created_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  username         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dagitici: gateway basina siradaki is
CREATE INDEX update_jobs_dispatch_idx ON update_jobs (gateway_id, priority DESC, id) WHERE status = 'queued';
CREATE INDEX update_jobs_active_idx ON update_jobs (status) WHERE status IN ('queued', 'sending', 'received');
CREATE INDEX update_jobs_batch_idx ON update_jobs (batch_id, id);
CREATE INDEX update_jobs_serial_idx ON update_jobs (serial, id DESC);
CREATE INDEX update_jobs_dealer_idx ON update_jobs (dealer_id, id DESC);

INSERT INTO settings (key, value) VALUES
  ('queue_max_attempts', '3'),
  ('queue_ttl_hours', '72')
ON CONFLICT (key) DO NOTHING;
