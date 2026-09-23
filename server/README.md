# E-Paper Yönetim Sunucusu

ESP32 gateway'ler WiFi'ye bağlanınca bu sunucuya WebSocket ile bağlanır (`/ws/gateway`).
Etiketler tarayıcıdan bu sunucu üzerinden gönderilir:

```
Tarayıcı ──HTTPS──> Sunucu (Coolify) ──wss──> ESP32 Gateway ──nRF24──> E-paper etiket
                         │
                     PostgreSQL
```

## Kavramlar

- **Bayi:** Sistemin kiracısıdır. Her gateway ve kullanıcı bir bayiye aittir.
- **Şube:** Opsiyoneldir. Şube kullanmayan bayi doğrudan bayi seviyesinde çalışır.
- **Roller:**

  | Rol | Yetki |
  |---|---|
  | Merkezi Yönetici | Her şey |
  | Bayi Yöneticisi | Kendi bayisi, şubeleri, gateway'leri ve kullanıcıları |
  | Şube Yöneticisi | Sadece kendi şubesi |
  | Operatör | Etiket gönderir ve geçmişi görür, ayarlara erişemez |

- **Gateway durumları:**

  | Durum | Anlamı |
  |---|---|
  | Beklemede | Sunucuya bağlandı ama merkezde kaydı yok |
  | Kayıtlı | Merkezde kayıtlı, sahiplenme kodu var |
  | Bağlantı Bekleniyor | Bayiye atandı, henüz doğrulanmış bağlantı kurmadı |
  | Aktif | Bayiye atanmış ve bağlantısı doğrulanmış |
  | Offline | Aktif ama şu an bağlı değil |
  | Hata | Bağlı ama nRF veya donanım hatası bildiriyor |
  | Devre Dışı | Elle kapatıldı, etiket gönderilemez |

## Coolify'a kurulum

1. **PostgreSQL:** Coolify'da **+ New → Database → PostgreSQL** ile bir veritabanı oluşturup
   başlatın. Veritabanı sayfasındaki **Postgres URL (internal)** değerini kopyalayın
   (`postgres://...@<isim>:5432/postgres` gibi).
2. **Uygulama:** **+ New → Resource → Public Repository**. Repo
   `https://github.com/cannx22/E-paper`, dal `master`.
   - **Build Pack:** `Dockerfile`
   - **Base Directory:** `/server`
   - **Ports Exposes:** `3000`
   - **Domain:** `https://etiket.<sunucu-ip>.sslip.io`
3. **Environment Variables:**

   | Değişken | Açıklama |
   |---|---|
   | `DATABASE_URL` | 1. adımda kopyalanan internal URL (zorunlu) |
   | `ADMIN_PASSWORD` | İlk merkezi yönetici şifresi, kullanıcı adı `admin`. Sadece veritabanında hiç kullanıcı yokken kullanılır. |
   | `PUBLIC_URL` | İsteğe bağlı. QR kodlarındaki adres, örneğin `https://etiket.<sunucu-ip>.sslip.io`. Verilmezse isteğin geldiği adres kullanılır. |

4. **Persistent Storage:** `/app/data` volume'unu koruyun. Önceki sürümden kalan
   `db.json` ilk açılışta PostgreSQL'e otomatik aktarılır ve dosyanın adı
   `db.json.imported` olarak değiştirilir.
5. **Deploy**'a basın. `https://.../healthz` adresi `ok` dönmeli; bu kontrol veritabanı
   bağlantısını da doğrular.

Veritabanı şeması `src/db/migrations/` altındaki SQL dosyalarıyla yönetilir. Sunucu her
açılışta uygulanmamış migration'ları sırayla çalıştırır. Yeni fazlar yeni dosya olarak
eklenir, mevcut dosyalar değiştirilmez.

## Gateway'i sisteme ekleme

1. **Merkez:** Gateway'i bir kez elektriğe ve internete bağlayın. Gateway'ler sayfasında
   **Beklemede** olarak görünür; **Kaydet**'e basın. Gateway'i henüz bağlamadan kaydetmek
   isterseniz **Merkezde Elle Kaydet** alanına MAC adresini yazın.
2. **Merkez:** **QR Etiket**'e basın, çıkan etiketi yazdırıp gateway'in üzerine yapıştırın.
3. **Bayi yöneticisi:** QR'ı telefon kamerasıyla okutun. Sahiplenme sayfası açılır;
   isim ve şube seçip onaylayın. QR yoksa Gateway'ler → **Gateway Ekle** alanına kimliği
   ve kodu yazın.
4. Gateway internete bağlıysa hemen **Aktif** olur. Bağlı değilse **Bağlantı Bekleniyor**
   durumunda kalır ve ilk bağlantıda Aktif olur.

Merkez, **Bayiye Ata** ile QR kullanmadan da doğrudan atama yapabilir.

## E-paper cihazlar

Her e-paper etiket, 8 haneli seri numarasıyla (örnek `80156767`) kayıtlı bir cihazdır.
Cihazlar **Cihazlar** sayfasından eklenir ve yönetilir:

- **Tek cihaz:** Seri numarası elle yazılabilir, USB barkod okuyucuyla okutulabilir veya
  telefon kamerasıyla okunabilir. **Hızlı tarama** açıkken her okutmadan sonra alan
  temizlenir, böylece cihazlar arka arkaya eklenebilir.
- **Toplu ekleme:** Excel/CSV dosyası (sütunlar: Seri No, İsim, Model, Gateway, Şube) ya
  da yapıştırılmış seri no listesiyle yapılır. Önce kontrol raporu çıkar: geçersiz,
  tekrar eden ve zaten kayıtlı satırlar gösterilir. Ardından sadece geçerli satırlar
  eklenir.
- **Toplu işlemler:** Seçilen cihazlara gateway/şube atanabilir, cihazlar devre dışı
  bırakılabilir, etkinleştirilebilir veya silinebilir.

Etiket gönderirken hedef seri numarasıdır. Kayıtlı cihazın gateway'i otomatik kullanılır.
Sunucu gateway'e `{type:"send", reqId, serial:"80156767", fields:{...}}` gönderir; seri
numarasını nRF24 adresine (BCD) çevirme işi gateway ile alıcıda yapılır.

## Yerel geliştirme

```
cd server
npm install
set DATABASE_URL=postgres://postgres:sifre@localhost:5432/etiket
set ADMIN_PASSWORD=admin123
npm start          # http://localhost:3000
```

Gateway'in yereldeki sunucuya bağlanması için kurulum sayfasındaki sunucu adresine
`ws://<bilgisayarın-yerel-ip>:3000` yazın.

## Yol haritası

| Faz | Kapsam | Durum |
|---|---|---|
| 1 | PostgreSQL, bayi/şube, roller, gateway yaşam döngüsü, QR sahiplenme, telemetri, işlem logu, özet | ✅ |
| 2 | E-paper cihaz kaydı (8 haneli seri no, barkod/QR, Excel toplu ekleme), ekran modelleri, `serial` protokolü | ✅ |
| 3 | Kalıcı güncelleme kuyruğu (offline bekletme, tekrar deneme, toplu güncelleme, durum adımları) | |
| 4 | Ürün/içerik yönetimi ve cihaz ↔ ürün eşleştirme | |
| 5 | Şablon motoru, dinamik alanlar, sunucuda bitmap üretimi | |
| 6 | Tasarım editörü | |
| 7 | Zamanlama | |
| 8 | Dış API, ERP entegrasyonu, stok uyarıları | |
| 9 | Gelişmiş dashboard, gateway OTA güncelleme | |
