# E-Paper Yönetim Sunucusu

ESP32 gateway'ler WiFi'ye bağlanınca bu sunucuya WebSocket ile bağlanır (`/ws/gateway`).
Etiketler tarayıcıdan bu sunucu üzerinden gönderilir:

```
Tarayıcı ──HTTPS──> Sunucu (Coolify) ──wss──> ESP32 Gateway ──nRF24──> E-paper etiket
                         │
                     PostgreSQL
```

## Kavramlar

- **Bayi:** Sistemin kiracısıdır. Her gateway, cihaz ve kullanıcı bir bayiye aittir. Şu
  bilgileri tutar:
  - Kurum bilgileri: bayi kodu, ticari ünvan, vergi dairesi ve numarası.
  - İletişim ve adres: yetkili kişi, telefon, e-posta, adres, il/ilçe.
  - Lisans: gateway ve cihaz limiti, sözleşme bitiş tarihi.
- **Şube:** Opsiyoneldir. Şube kullanmayan bayi doğrudan bayi seviyesinde çalışır. Şube de
  kod, yetkili, iletişim ve adres bilgisi tutar.
- **Kullanıcı:** Giriş e-posta ile yapılır. E-postayı ve şifreyi hesabı açan yönetici
  belirler; isterse şifreyi sisteme ürettirir. "İlk girişte şifresini değiştirsin"
  seçilirse kullanıcı ilk girişte yeni şifre belirlemeden panele giremez.
- **Roller:**

  | Rol | Kapsam | Yetki |
  |---|---|---|
  | Merkezi Yönetici | Tüm sistem | Her şey: bayiler, gateway kaydı, seri no havuzu, ayarlar |
  | Merkez Destek | Tüm sistem | Her şeyi görür, değişiklik yapamaz |
  | Bayi Yöneticisi | Bayi + tüm şubeleri | Şube, kullanıcı, gateway ve cihaz yönetimi |
  | Şube Yöneticisi | Tek şube | Şubesinin kullanıcı, gateway ve cihazları |
  | Operatör | Bayi veya tek şube | Etiket gönderir, geçmişi görür |

  Yöneticiler sadece kendi rollerine eşit veya daha düşük rolleri atayabilir. Panelde
  **Kullanıcılar → Roller ve Yetkiler** tablosu yetkilerin tamamını gösterir.
- **Güvenlik:**
  - Şifre en az 8 karakter olmalı ve harf ile rakam içermeli; uzunluk ayarlardan değişir.
  - Art arda 5 hatalı girişte hesap 15 dakika kilitlenir; yönetici kilidi açabilir.
  - Kullanıcı ya da bayi pasif yapılınca açık oturumları anında kapanır.
  - Oturumlar Profil sayfasından görülüp kapatılabilir.

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
   | `ADMIN_EMAIL` | İlk merkezi yöneticinin e-postası. Verilmezse `admin` kullanıcı adıyla girilir. |
   | `ADMIN_PASSWORD` | İlk merkezi yönetici şifresi. `ADMIN_EMAIL` ile birlikte sadece veritabanında hiç kullanıcı yokken kullanılır. |
   | `PUBLIC_URL` | İsteğe bağlı. QR kodlarındaki adres, örneğin `https://etiket.<sunucu-ip>.sslip.io`. Verilmezse isteğin geldiği adres kullanılır. |

4. **Persistent Storage:** `/app/data` volume'unu koruyun. Önceki sürümden kalan
   `db.json` ilk açılışta PostgreSQL'e otomatik aktarılır ve dosyanın adı
   `db.json.imported` olarak değiştirilir.
5. **Deploy**'a basın. `https://.../healthz` adresi `ok` dönmeli; bu kontrol veritabanı
   bağlantısını da doğrular.

Veritabanı şeması `src/db/migrations/` altındaki SQL dosyalarıyla yönetilir. Sunucu her
açılışta uygulanmamış migration'ları sırayla çalıştırır. Yeni fazlar yeni dosya olarak
eklenir, mevcut dosyalar değiştirilmez.

## Yeni bayi açma

1. **Bayiler → Yeni Bayi** penceresinde bayinin kurum, iletişim, adres ve lisans bilgilerini
   girin.
2. Aynı pencerede **İlk Bayi Yöneticisi**'nin ad soyad, e-posta ve şifresini belirleyin.
   Şifreyi **Üret** ile sisteme de ürettirebilirsiniz.
3. Kaydedince giriş bilgileri bir kez gösterilir. Bunları bayiye iletin.
4. Bayi yöneticisi kendi panelinden şube açar ve şubelere kullanıcı ekler. Merkez de
   **Bayiler → bayi detayı → Şubeler / Kullanıcılar** sekmelerinden aynı işlemleri yapabilir.

## Seri no havuzu

Merkez, üretilen cihazların seri numaralarını **Seri No Havuzu** sayfasından yükler. Yükleme
aralık olarak (örnek 80156700–80156799) ya da liste veya Excel olarak yapılabilir. Numaralar
bir bayiye önceden tahsis edilebilir.

- Başka bayiye tahsisli bir numara, hiçbir bayi tarafından cihaz olarak eklenemez.
- **Sistem Ayarları → Seri no havuzu zorunlu** açılırsa bayiler yalnızca havuzdaki
  numaraları ekleyebilir. Yanlış yazılmış numaralar böylece sisteme giremez.
- Eklenen cihazın havuz kaydı otomatik olarak o bayiye tahsis edilir.

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

## Güncelleme kuyruğu

Her etiket gönderimi veritabanında kalıcı bir **iş** olarak kaydedilir. Sunucu yeniden başlasa
da iş kaybolmaz. **Güncellemeler** sayfasında tüm işler ve toplu işler ilerlemeleriyle görünür.

| Durum | Anlamı |
|---|---|
| Bekliyor | Sırada ya da gateway çevrimdışı |
| Gönderiliyor | Gateway'e iletildi |
| Gateway aldı | Gateway alındığını onayladı (firmware 2.2+) |
| Başarılı | Cihaz tüm paketleri aldı |
| Cihaz ulaşılamıyor | nRF'e cevap yok, denemeler bitti |
| Hata | Diğer hatalar, denemeler bitti |
| İptal | Kullanıcı iptal etti, daha yeni içerik geldi ya da cihaz devre dışı |
| Süresi doldu | Belirlenen süre içinde gönderilemedi |

Kurallar:

- **Gateway çevrimdışıysa** iş bekler; gateway bağlanınca kendiliğinden gönderilir.
- **Başarısız işler** 30 sn, 2 dk, 10 dk aralıklarla tekrar denenir. Deneme sayısı ve bekleme
  süresi Sistem Ayarları'ndan değiştirilebilir.
- **Aynı cihaza yeni içerik gönderilirse** henüz gönderilmemiş eski içerik iptal edilir.
- **Tekli gönderim** öncelikli olarak toplu işlerin önüne geçer. Ekran ilk denemenin sonucunu
  bekler; gateway çevrimdışıysa "sıraya alındı" bilgisi döner.
- **Toplu gönderim** iki yolla yapılır:
  - Cihazlar sayfasında cihazları seçip **Etiket Gönder**: seçilen cihazların hepsine aynı içerik.
  - Etiket sayfasında **Excel ile Toplu**: her satıra farklı içerik.

  İkisinde de bir "toplu iş" oluşur. Toplu işin ilerlemesi takip edilebilir, bekleyen kısmı
  iptal edilebilir, başarısız olanlar tek tuşla tekrar denenebilir.
- **Kayıtlı bir cihazın gateway'i değişirse** bekleyen işleri yeni gateway'e geçer.

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
| 2.5 | E-posta ile giriş, bayi açılış sihirbazı, kurum/adres bilgileri, lisans limitleri, zorunlu şifre değişimi, hesap kilidi, merkez destek rolü, profil/oturumlar, seri no havuzu, gateway ve cihaz detay sayfaları, cihaz taşıma, yeni arayüz (Tabler, koyu tema) | ✅ |
| 3 | Kalıcı güncelleme kuyruğu (offline bekletme, tekrar deneme, toplu güncelleme, durum adımları) | ✅ |
| 4 | Ürün/içerik yönetimi ve cihaz ↔ ürün eşleştirme | |
| 5 | Şablon motoru, dinamik alanlar, sunucuda bitmap üretimi | |
| 6 | Tasarım editörü | |
| 7 | Zamanlama | |
| 8 | Dış API, ERP entegrasyonu, stok uyarıları | |
| 9 | Gelişmiş dashboard, gateway OTA güncelleme | |
