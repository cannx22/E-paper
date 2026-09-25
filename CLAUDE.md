# E-Paper Etiket Sistemi

E-paper raf etiketleri (STM32 + nRF24L01 alıcı) bir ESP32 gateway üzerinden merkezi bir web
sunucusundan yönetilir. Gateway'ler farklı mağazalarda NAT arkasındadır. Her ESP32 sunucuya
dışarı doğru bir WebSocket bağlantısı açar. Cihazda yerel yönetim paneli yoktur; ESP32'de
sadece WiFi kurulum hotspot'u kalır. Yeni özellikler sunucu arayüzüne ve API'ye eklenir.

- Canlı: https://etiket.193.33.29.193.sslip.io (Coolify + PostgreSQL). Deploy, Coolify'da elle
  **Deploy** butonuyla yapılır.
- Repo: https://github.com/cannx22/E-paper.git, `master` dalı.
- Faz durumu ve kullanıcı kılavuzu: [server/README.md](server/README.md) (Yol haritası bölümü).

## Klasörler

| Yol | İçerik |
|---|---|
| `src/`, `include/`, `platformio.ini` | ESP32 gateway firmware'i (PlatformIO, Arduino, `esp32dev`) |
| `server/src/` | Node 22 + Express 5 + `ws` + PostgreSQL sunucu |
| `server/src/db/migrations/` | Sıralı SQL migration'ları (`00N_ad.sql`). Açılışta otomatik uygulanır. |
| `server/public/` | Sayfalar (düz HTML + JS, Tabler arayüz kütüphanesi, derleme adımı yok) |
| `server/public/static/design-render.js` | Tasarım çizim motoru. Tarayıcıda ve sunucuda (`src/render.js`, @napi-rs/canvas) aynı kod çalışır. |

STM32 alıcı firmware'i bu repoda **değil**; ayrı bir ekip geliştiriyor.

## Gateway protokolü (WebSocket `/ws/gateway`)

- Gateway → sunucu:
  - `hello {id, secret, fw, nrf}` (sunucu `hello_ack {status, name}` ile cevap verir)
  - `telemetry {uptime, rssi, ssid, heap, nrf, error}`
  - `ack {reqId}`
  - `result {reqId, ok, message}`
- Sunucu → gateway:
  - `send {reqId, serial, fields}`
  - `command restart | wifi_reset`
  - `error bad_secret`
- Kimlik doğrulama: gateway'in ilk bağlantıda gönderdiği secret kabul edilir ve SHA-256 özeti
  saklanır. Sonraki bağlantılar bu özetle doğrulanır.
- Cihaz kimliği 8 haneli seri numarasıdır (`/^\d{8}$/`). Seri numarasını nRF24 adresine (BCD)
  çevirme işi gateway ve alıcıda yapılır.
- nRF24 ayarları: 250 kbps, kanal 40, 3 byte adres (bayt sırası ters çevrilir, açıklaması
  `src/nrf_gateway.cpp` içinde).
- Etiket paketi 399 byte'tır. Parçalar 1 byte sıra numarası + 30 byte veriden oluşur.

## Kurallar

- **Yetkiler:**
  - Rol ve kapsam kuralları tek yerde toplanır: `server/src/permissions.js` (`can`,
    `inScope`, `scopeSql`).
  - Roller: `super_admin`, `support` (merkez, sadece okuma), `dealer_admin`, `branch_admin`,
    `operator`.
  - Yeni bir eylem eklenince buraya da eklenir.
- **Veritabanı:** Şema değişikliği her zaman **yeni** bir migration dosyasıyla yapılır; eski
  dosya düzenlenmez.
- **İşlem kaydı:** Önemli işlemler `audit.log(...)` ile kaydedilir. Her yeni işlem kodu için
  `public/static/app.js` içindeki `AUDIT_LABELS`'a Türkçe karşılık eklenir.
- **Metinler:**
  - Arayüz metinleri Türkçedir.
  - Kod yorumları Türkçedir ve Türkçe karakter kullanılmaz (ASCII).
  - API hata metinleri `HATA: ...` biçimindedir (`fail(status, mesaj)`).
- **Tasarım çizimi:** Çizim davranışını değiştirirken `design-render.js` hem tarayıcıda hem
  sunucuda çalışır. ES5 uyumlu UMD yapısı korunur.
- **Kullanıcıyla çalışma:**
  - Kullanıcı Türkçe yazar; cevaplar Türkçe verilir.
  - Kullanıcı eksik özellikleri sormadan ekleme yetkisi verdi. Donanımla ilgili bilinmeyen
    konular (MCU modeli, panel tipi) yine de sorulur.
- **Faz bitince:**
  1. Testler çalıştırılır.
  2. Ekran görüntüleri alınır ve **gerçekten incelenir**.
  3. Değişiklikler commit'lenip `master`'a push edilir.
  4. Kullanıcıya Coolify'da yapması gereken bir şey olup olmadığı söylenir.

## Komutlar

```
cd server
npm install
set DATABASE_URL=postgres://postgres:sifre@localhost:5432/etiket
set ADMIN_EMAIL=admin@ornek.com
set ADMIN_PASSWORD=Admin12345
npm start            # http://localhost:3000
```

Bu Windows makinede git, PlatformIO, Docker ve PostgreSQL PATH'te değil:

- **Git:** Taşınabilir MinGit kullanılır.
  - Commit için: `-c user.name="caneralemdar" -c user.email="caneralemdar@fnfteknoloji.com"`
  - Commit mesajı BOM'suz UTF-8 bir dosyaya yazılıp `-F` ile verilir.
- **Firmware derleme:** PlatformIO bir Python venv'e kurulur. Windows yol uzunluğu sınırı
  nedeniyle kısa bir yol kullanılır:
  `subst Q: <klasör>` + `PLATFORMIO_CORE_DIR=Q:\pio-core` → `python -m platformio run -e esp32dev`
- **Testler:**
  - `embedded-postgres` npm paketiyle geçici bir veritabanı açılır (port 55432).
    `initdbFlags ['--locale=C','--encoding=UTF8']` şarttır, çünkü Türkçe locale initdb'yi
    bozar.
  - E2E testleri `src/index.js`'i başlatır.
  - Ekran görüntüleri puppeteer-core ile headless Edge üzerinden alınır.

## Açık işler

- **Faz 5 · 2. aşama:** tasarımı etikete resim olarak gönderme.
  - Donanım değişikliği gerekmez. Kırmızı içerik için BWR (üç renkli) panel gerekir; şu anki
    paneller siyah-beyaz: 2.13" GDEY0213B74 ve 1.54".
  - Sunucu `render.renderPlanes` ile ekranın bit düzlemlerini üretir ve sıkıştırır (RLE).
  - Gateway'de parça sıra numarası 16 bit'e çıkarılır.
  - Alıcıya "resim modu" eklenir: gelen parçalar doğrudan panelin RAM'ine yazılır.
  - Kullanıcıdan beklenenler: STM32 modeli, alıcı kodu, sahadaki paneller.
- **Firmware:** Bu repodaki gateway firmware'i hâlâ `send` mesajındaki `board` alanını
  okuyor. Kullanıcının `serial` + BCD destekli güncel firmware'i başka yerde; paylaşınca
  buraya birleştirilecek.
- **Sonraki fazlar:**
  - Faz 4: ürünler ve cihaz ↔ ürün eşleştirme
  - Faz 7: zamanlama
  - Faz 8: API / ERP entegrasyonu
  - Faz 9: gelişmiş dashboard ve OTA güncelleme
