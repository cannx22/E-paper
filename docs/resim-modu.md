# Resim Modu: Tasarımı Etikete Göndermek

Bu belge gömülü yazılım (ESP32 gateway ve STM32 alıcı) tarafı için yazıldı. Web panelinde
çizilen tasarımın etikete nasıl gittiğini ve iki firmware'de ne yapılması gerektiğini anlatır.

- **ESP32 kodu hazır ve derleniyor:** [src/image_sender.cpp](../src/image_sender.cpp). Kendi
  firmware'inize taşımanız yeterli (bkz. [ESP32 tarafı](#esp32-tarafı-gateway)).
- **STM32 için referans kod hazır:** [docs/stm32/epd_image_rx.c](stm32/epd_image_rx.c).
  Donanımdan bağımsızdır. Siz sadece panel ve nRF fonksiyonlarını bağlarsınız (bkz.
  [STM32 tarafı](#stm32-tarafı-alıcı)).
- Bilgisayarda çalışan bir test de var (bkz. [Test](#test)).

## 1. Genel mantık

Eski sistemde sunucu **metin alanları** gönderiyordu (ürün adı, fiyat...). Etiketin nasıl
görüneceğine STM32 kendi içindeki sabit şablonla karar veriyordu.

Resim modunda **çizimi sunucu yapar**. Sunucu etikete, panelin RAM'ine doğrudan yazılacak
pikselleri gönderir. STM32 artık hiçbir şey çizmez; gelen baytları panele kopyalar.

```
Web paneli (tasarım + veri)
   │
   ▼
Sunucu:  çiz (480×648) → panel yönüne döndür (648×480) → panel RAM biçimi (2 bit/piksel)
         → RLE ile sıkıştır → CRC32 → 24 byte başlık ekle  = "blob"
   │   WebSocket: send_image (JSON) + ikili parçalar (≤ 8 KB)
   ▼
ESP32:   blob'u belleğe alır, içeriğini anlamaz; nRF paketlerine böler
   │   nRF24: START, DATA × N, END, STATUS
   ▼
STM32:   paket geldikçe açar → panel RAM'ine yazar (0x10) → CRC doğruysa ekranı yeniler (0x12)
```

Bu yapı üç sebeple seçildi:

1. **Ekranda görülen, editörde görülenle aynı.** Fontlar, Türkçe karakterler ve barkodlar
   sunucuda çizilir. STM32'de font tutmaya gerek kalmaz.
2. **STM32'nin RAM'i yetmese de çalışır.** 648×480 4 renk tam ekran 77.760 byte eder. Alıcı
   görüntüyü RAM'de toplamaz: her paketi açıp hemen panelin RAM'ine yazar. Referans kod yaklaşık
   100 byte RAM kullanır.
3. **Yarım görüntü ekrana çıkmaz.** Panel RAM'ine yazmak ekranı değiştirmez. Ekran yenileme
   komutu ancak tüm paketler gelip CRC tuttuğunda verilir. Aktarım yarıda kalırsa eski görüntü
   ekranda kalır, sunucu da işi daha sonra tekrar dener.

Eski 399 byte'lık alan modu aynen çalışmaya devam eder. Resim paketlerinin ilk baytı
`0xA1–0xA4` aralığındadır. Eski protokolün ilk baytı (parça sıra no) `0–13` olduğu için iki
protokol çakışmaz.

## 2. Panel: GDEY0583F41 (5.83", 4 renk)

| | |
|---|---|
| Çözünürlük | 648 × 480 (panelin kendi tarama yönü yatay) |
| Renkler | siyah, beyaz, sarı, kırmızı |
| Sürücü | JD79665 |
| Ekran yenileme | 12 sn (hızlı) / 20 sn (tam) |

Sunucuda bu panel için iki ekran modeli var:

| Kod | Tasarım tuvali | Panele yazarken döndürme |
|---|---|---|
| `EPD583-BWRY-V` | 480 × 648 (dikey, fotoğraftaki kullanım) | 90° saat yönü |
| `EPD583-BWRY-H` | 648 × 480 (yatay) | 0° |

Döndürme sunucuda yapılır, STM32'ye her zaman panelin kendi yönünde (648×480) veri gelir.
Etikette görüntü baş aşağı çıkarsa STM32'de değişiklik gerekmez: **Sistem Ayarları → Ekran
Modelleri → Panel yönü** ayarını 90° yerine 270° yapmak yeterli.

## 3. Panel veri biçimleri

Sunucu veriyi doğrudan panelin RAM biçiminde üretir. Bütün biçimlerde ortak kurallar:

- Veri satır satır gelir; önce 0. satır.
- Satır içinde soldan sağa gider; baytın en yüksek bitleri soldaki pikseldir.
- Satır sonundaki artık bitler beyazla doldurulur.

### Biçim 3: BWRY, 2 bit/piksel (GDEY0583F41)

Bir bayt 4 piksel taşır. İlk piksel bit 7–6'dadır.

| Kod | Renk |
|---|---|
| `00` | siyah |
| `01` | beyaz |
| `10` | sarı |
| `11` | kırmızı |

- Satır uzunluğu `ceil(648 / 4) = 162` byte, toplam `162 × 480 = 77.760` byte.
- Tamamen beyaz bir bayt `0x55`'tir.

> **Doğrulayın:** Bu renk kodları Good Display'in 4 renkli JD79665/JD79661 örnek kodlarındaki
> `black 0x00, white 0x01, yellow 0x02, red 0x03` tanımlarıyla aynıdır. Veri `0x10`
> komutundan sonra bu sırayla yazılır. Sizin panel fonksiyonunuzda kodlar farklıysa bize
> söyleyin; değişiklik sunucuda tek satırdır, STM32'de bir şey değişmez.

### Biçim 1: Siyah-beyaz, 1 bit/piksel

`1 = beyaz`, `0 = siyah` (SSD1680'in `0x24` RAM'i). Toplam `ceil(W/8) × H` byte.

### Biçim 2: İki düzlem (3 renkli BWR / BWY paneller)

Önce siyah-beyaz düzlem gelir (`1 = beyaz`, SSD1680 `0x24`), ardından renk düzlemi gelir
(`1 = kırmızı/sarı`, SSD1680 `0x26`). Her düzlem `ceil(W/8) × H` byte'tır.

## 4. Blob: 24 byte başlık + veri

Sunucunun gateway'e gönderdiği veri budur. Sayılar little endian'dır.

| Ofset | Boy | Alan | Açıklama |
|---|---|---|---|
| 0 | 1 | version | `1` |
| 1 | 1 | format | `1` BW, `2` iki düzlem, `3` BWRY |
| 2 | 1 | compression | `0` sıkıştırma yok, `1` RLE |
| 3 | 1 | flags | `0` (ileride kullanılacak) |
| 4 | 2 | width | panel genişliği (5.83" için 648) |
| 6 | 2 | height | panel yüksekliği (480) |
| 8 | 4 | rawLength | açılmış veri uzunluğu (77.760) |
| 12 | 4 | dataLength | başlıktan sonraki veri uzunluğu |
| 16 | 4 | crc32 | **açılmış** verinin CRC32'si |
| 20 | 4 | reserved | `0` |

### RLE (sıkıştırma)

PackBits benzeri basit bir yöntemdir ve akış halinde açılabilir; bir kontrol baytı ile bir
paketin sonu çakışabilir. `c` kontrol baytıdır:

| `c` | Anlamı |
|---|---|
| `0x00–0x7F` | Ardından gelen `c + 1` bayt olduğu gibi kopyalanır (1–128 bayt). |
| `0x80–0xFF` | Ardından gelen **tek** bayt `c − 126` kez tekrarlanır (2–129 kez). |

Örnek: `82 55 01 AB CD` → `55 55 55 55 AB CD`.

Sunucu sıkıştırılmış veri daha kısaysa RLE kullanır, değilse ham veri gönderir. Örnek fiyat
listesi tasarımında 77.760 byte, 35.711 byte'a iner ve 1.235 nRF paketi tutar. 250 kbps'de bu
aktarımın tahminen 4 saniye sürmesi beklenir (gerçek donanımda ölçülmedi).

### CRC32

zlib / Ethernet ile aynı CRC32'dir: polinom `0xEDB88320`, başlangıç `0xFFFFFFFF`, sonda ters
çevrilir. Test değeri: `"123456789"` → `0xCBF43926`. Hesap açılmış veri üzerinde yapılır, yani
alıcı panele yazdığı baytların CRC'sini hesaplar.

## 5. Sunucu ↔ ESP32 (WebSocket)

Mevcut protokole bir mesaj eklendi. **Sunucu, `hello` mesajında `fw` < `2.3.0` bildiren
gateway'lere resim göndermez** (panelde "firmware eski" uyarısı çıkar).

```
srv → gw  {"type":"send_image","reqId":"7","serial":"80156767","size":35735,"chunk":8192}
srv → gw  [ikili mesaj: blob'un 0–8191. baytları]
srv → gw  [ikili mesaj: 8192–16383] ... toplam "size" bayt
gw  → srv {"type":"ack","reqId":"7"}                              (blob tam alındı)
gw  → srv {"type":"result","reqId":"7","ok":true,"message":"OK: ..."}
```

- İkili parçalar 8 KB'tır, çünkü arduinoWebSockets kütüphanesi 15 KB'tan büyük mesajları
  reddeder.
- Gateway aynı anda tek iş yapar. Meşgulken gelen istek `ok:false` ile reddedilir.
- `message` metni panelde gösterilir. İçinde `MAX_RT` / `karsilik yok` geçerse iş "Cihaz
  ulaşılamıyor" sayılır.
- Sunucu başarısız işleri 30 sn, 2 dk ve 10 dk sonra tekrar dener.
- Sunucu sonucu 90 sn içinde bekler.

## 6. ESP32 ↔ STM32 (nRF24 paketleri)

nRF ayarları değişmedi: kanal 40, 250 kbps, 3 byte adres (ters çevrilir), CRC 2 byte, Auto-ACK,
dinamik payload, ACK payload açık. Bir paket en fazla 32 byte'tır.

| Paket | Baytlar | Uzunluk |
|---|---|---|
| **START** | `A1` + 24 byte başlık (blob'un ilk 24 baytı) | 25 |
| **DATA** | `A2`, `seq` (2 byte LE, 0'dan başlar), en fazla 29 byte veri | ≤ 32 |
| **END** | `A3`, DATA paket sayısı (2 byte LE), CRC32 (4 byte LE) | 7 |
| **STATUS** | `A4` | 1 |

STATUS paketinin cevabı alıcının **ACK payload**'ıdır:

```
[A4][durum][CRC32 (4 byte LE)]
```

| Durum | Anlamı |
|---|---|
| `00` | Tüm veri geldi, CRC doğru, ekran yenileniyor (başarılı) |
| `01` | CRC tutmadı |
| `02` | Paket atlandı / sıra hatası |
| `03` | Uzunluk tutmadı |
| `04` | Biçim, çözünürlük veya sürüm desteklenmiyor |
| `05` | Meşgul: önceki görüntü henüz ekrana basılmadı |
| `06` | Aktarım sürüyor (END işlenmedi) |
| `FF` | Alıcıda aktarım yok |

### Akış ve hata durumları

1. **Gateway:** Her paket donanımda 10 kez denenir. ACK gelmezse aynı paket yazılımla 3 kez
   daha gönderilir. Yine olmazsa aktarım iptal edilir ve sunucu daha sonra baştan dener.
2. **Alıcı, tekrar gelen paketler:** Aynı `seq` ikinci kez gelirse yok sayılır (ACK
   kaybolduğu için gateway tekrar göndermiş olabilir). Sıra atlanırsa durum `02` olur ve
   aktarım iptal edilir.
3. **Alıcı, START:** START her zaman yeni bir aktarım başlatır. Yarım kalan aktarım bırakılır.
4. **Gateway, STATUS sorgusu:** END'den 30 ms sonra STATUS gönderir ve ACK payload'u okur.
   Cevabın ilk baytı `A4` değilse veya CRC uymuyorsa 40 ms arayla 8 kez tekrar sorar.
5. **Gateway, sonuç:** Durum `00` gelirse sunucuya başarılı bildirir. Hiç cevap gelmezse "alıcı
   resim modunu desteklemiyor olabilir" hatası döner.
6. **Alıcı, akış kontrolü:** Paket açılıp panele yazılırken nRF'in 3 paketlik RX FIFO'su
   dolabilir. Dolunca nRF ACK vermez, gateway'in donanım tekrarları da beklemeyi sağlar. Bu
   yüzden ayrıca bir akış kontrolü gerekmez.

## ESP32 tarafı (gateway)

Bu repodaki gateway firmware'ine eklendi ve `pio run -e esp32dev` ile derlendi (Flash %87,
RAM %15). Kendi güncel firmware'inize taşırken yapılacaklar:

| Dosya | Ne yapıldı |
|---|---|
| [include/image_sender.h](../include/image_sender.h), [src/image_sender.cpp](../src/image_sender.cpp) | **Yeni.** Blob'u START/DATA/END/STATUS paketlerine böler, gönderir, alıcının durumunu okur. Olduğu gibi kopyalayın. |
| [src/nrf_gateway.cpp](../src/nrf_gateway.cpp) | 3 fonksiyon eklendi: `NrfGateway_OpenTarget`, `NrfGateway_Write` (tek paket + ACK payload okuma), `NrfGateway_FlushRx`. |
| [src/cloud_client.cpp](../src/cloud_client.cpp) | `send_image` mesajı alınır, ikili parçalar (`WStype_BIN`) `malloc` ile ayrılmış tampona eklenir, tamamlanınca `ack` gönderilir ve gönderim `CloudClient_Loop()` içinde yapılır. Uzun gönderimde bağlantı kopmasın diye `CloudClient_Poll()` her 64 pakette bir çağrılır. |
| [src/main.cpp](../src/main.cpp) | `handleCloudImage()` eklendi, `CloudClient_SetImageHandler(handleCloudImage)` ile kaydedildi. |
| [include/config.h](../include/config.h) | `FW_VERSION "2.3.0"`. **Bu sürüm verilmezse sunucu resim göndermez.** |

**Yapmanız gereken tek şey:** `main.cpp` içindeki `nrfAddressForSerial()` fonksiyonu bu
repoda geçici olarak sabit `ESA` adresini döndürüyor. Bunu kendi firmware'inizdeki
**seri no → BCD adres** çevirme fonksiyonuyla değiştirin.

Bellek: Blob gateway'de tek parça olarak tutulur (en fazla 96 KB; 5.83" örneği 35 KB).
Ayrılamazsa sunucuya "Gateway belleği yetersiz" hatası döner. Telemetrideki `heap` değeri
bunu izlemek için kullanılabilir.

## STM32 tarafı (alıcı)

[docs/stm32/epd_image_rx.h](stm32/epd_image_rx.h) ve [epd_image_rx.c](stm32/epd_image_rx.c)
dosyalarını projenize ekleyin. C99'dur, HAL ve dinamik bellek kullanmaz.

### 1. Panel ve nRF fonksiyonlarını bağlayın

Aşağıdaki örnek, Good Display örnek kodundaki fonksiyon adlarıyla yazıldı. Sizin bu panel
için yazdığınız mevcut fonksiyonlar büyük ihtimalle bunların aynısıdır:

```c
#include "epd_image_rx.h"

static int epd_begin(void *ctx, uint8_t format, uint16_t w, uint16_t h) {
    if (format != EPD_IMG_FMT_BWRY || w != 648 || h != 480) return -1; /* -> durum 04 */
    EPD_Init();               /* mevcut init fonksiyonunuz (reset + register ayarlari) */
    EPD_W21_WriteCMD(0x10);   /* panel RAM'ine veri yazmaya basla */
    return 0;
}

static void epd_write(void *ctx, uint32_t offset, const uint8_t *data, uint16_t len) {
    /* veri sirayla gelir; offset sadece iki duzlemli panellerde gerekir */
    for (uint16_t i = 0; i < len; i++) EPD_W21_WriteDATA(data[i]);
}

static void epd_commit(void *ctx) {
    EPD_W21_WriteCMD(0x12);   /* ekrani yenile */
    EPD_W21_WriteDATA(0x00);
    lcd_chkstatus();          /* BUSY bitene kadar bekle (12-20 sn) */
    EPD_DeepSleep();
}

static void nrf_set_ack(void *ctx, const uint8_t *data, uint8_t len) {
    nRF24_FlushTX();                              /* eski ACK payload'lari temizle */
    nRF24_WriteAckPayload(nRF24_PIPE0, data, len);
}

static const EpdImgOps ops = { epd_begin, epd_write, epd_commit, NULL, nrf_set_ack, NULL };
static EpdImgRx rx;
```

`abort` NULL olabilir. Yarım kalan aktarımda ekran yenilenmediği için yapılacak bir şey yoktur;
sonraki START `begin()` ile RAM'e baştan yazar.

### 2. Paketleri verin

```c
EpdImg_Init(&rx, &ops);   /* acilista bir kez */

/* nRF'ten paket alininca: */
uint8_t len = nRF24_GetDynamicPayloadLength();
nRF24_ReadPayload(buf, len);
if (!EpdImg_OnPacket(&rx, buf, len)) {
    /* resim paketi degil: eski 399 byte alan protokolu (mevcut kodunuz) */
}

/* ana dongude: */
EpdImg_Poll(&rx);         /* CRC dogrulandiysa burada epd_commit() cagrilir */
```

Dikkat edilecekler:

- **ACK payload:** Mevcut alıcı her pakete `"aCk PaYlOaD"` cevabı yüklüyor. Resim paketlerinde
  (`0xA1–0xA4`) bunu **yapmayın**, cevabı `EpdImg` kendisi yükler. Yoksa gateway STATUS
  cevabını okuyamaz. Gateway eski cevapları birkaç denemede tüketir ama doğrusu yüklememektir.
- **Kesme mi, ana döngü mü:** `EpdImg_OnPacket` paket açılırken panele SPI ile yazar.
  Kesmede çağırırsanız SPI'nin başka yerde kullanılmadığından emin olun. En kolayı, kesmede
  bayrak kaldırıp paketi ana döngüde okumaktır.
- **Ekran yenilenirken (12–20 sn)** yeni paket işlenmez. nRF FIFO dolunca gateway'in
  gönderimi başarısız olur, sunucu 30 sn sonra tekrar dener. Ek bir şey yapmanız gerekmez.
- **Uyku:** Alıcı belirli aralıklarla uyanıp dinliyorsa START gelene kadar uyanık kalmalıdır.
  Tek tek paketlerin arasında uyumamalıdır; 5.83" aktarımının tahminen 4 saniye sürmesi beklenir.

## Test

### 1. STM32 kodunu bilgisayarda test edin (donanım gerekmez)

[docs/stm32/test_epd_image_rx.c](stm32/test_epd_image_rx.c) gateway'in paketleme
mantığını taklit eder ve şu senaryoları dener:

- normal aktarım
- tekrar gelen paketler
- bozuk veri
- eksik paket

```
gcc -std=c99 -Wall -o test test_epd_image_rx.c epd_image_rx.c
./test tasarim-12.blob tasarim-12.raw
```

Test dosyaları sunucudan indirilir (giriş yapmış tarayıcıda):

- `/api/designs/<id>/panel-blob`: gateway'e giden blob
- `/api/designs/<id>/panel-blob?type=raw`: panelin RAM'ine yazılması beklenen 77.760 bayt

Biz bu testi 2.13" BW, 2.13" BWR, 2.9" BW (270° döndürmeli), 5.83" BWRY ve sıkıştırmasız
bir görüntüyle çalıştırdık. Hepsi geçti.

### 2. Gerçek donanımda

1. Gateway'e 2.3.0 firmware'ini yükleyin. Panelde gateway sayfasında sürüm görünür.
2. **Cihazlar** sayfasında cihazın ekran modelini `5.83" 4 Renk Dikey` yapın.
3. **Tasarımlar → Kasa Önü Fiyat Listesi (4 Renk)** → **Etikete Gönder** → cihazı seçin →
   **Gönder**.
4. Başarılıysa panelde "alıcı CRC'yi doğruladı; ekran yenileniyor" yazar. Cihaz sayfasında
   ekrana giden görüntü görünür.

## Hata mesajları

| Panelde görünen | Muhtemel sebep |
|---|---|
| Gateway firmware'i resim modunu desteklemiyor (2.3.0 gerekli) | Gateway eski firmware'de |
| Aliciya ulasilamadi (baslangic paketi) | Adres yanlış, alıcı kapalı veya uykuda |
| Gonderim paket #N icin basarisiz oldu | Aktarım yarıda koptu: menzil, parazit veya alıcı meşgul (ekran yeniliyor) |
| Alici durum bildirmedi | Alıcı resim modunu bilmiyor ya da ACK payload'u kendisi dolduruyor |
| Alici goruntuyu reddetti: CRC tutmadi | Veri bozuk geldi veya RLE açma hatası |
| Alici goruntuyu reddetti: bicimi desteklemiyor | `begin()` -1 döndü: çözünürlük veya biçim farklı |
| Gateway bellegi yetersiz | Blob ESP32 belleğine sığmadı |

## Doğrulanması gerekenler

1. **JD79665 renk kodları ve bayt sırası** (`00` siyah, `01` beyaz, `10` sarı, `11` kırmızı;
   ilk piksel bit 7–6). Mevcut panel fonksiyonunuzla karşılaştırın.
2. **Panel yönü:** Dikey kullanımda görüntü ters çıkarsa panel ayarlarından 270° seçin.
3. **Seri no → nRF adresi:** Gateway'de `nrfAddressForSerial()`, alıcıda dinlenen adres.
4. **STM32 modeli ve RAM'i:** Referans kod tampon gerektirmez. Yine de modeli bilmek ileride
   hızlı ekran yenileme gibi işler için faydalı olur.
