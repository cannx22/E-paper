#pragma once

// Ev/ofis WiFi bilgilerinizi buraya girin. Cihaz her acilista once
// NVS'ye (flash) kaydedilmis WiFi bilgisini dener (/wifi sihirbazindan
// girilen en son ag); burasi sadece NVS'de hic kayit yoksa (ilk kurulum
// veya fabrika ayarlarina donus) kullanilan yedek/varsayilan degerdir.
#define WIFI_SSID     "FNF_TEKNOLOJI"
#define WIFI_PASSWORD "fnf111213"
#define WIFI_CONNECT_TIMEOUT_MS 10000

// STA baglantisi kurulamazsa acilan yerel kurulum Access Point'i - bu sadece
// TEMEL isim: main.cpp calisirken sonuna cihazin MAC adresinden gelen
// benzersiz bir kod ekleniyor (ornek: "ESP32-NRF-Gateway-A1B2C3"), boylece
// birden fazla gateway ayni anda calisirken isimleri carpismiyor.
#define AP_SSID     "ESP32-NRF-Gateway"
#define AP_PASSWORD "12345678" // en az 8 karakter

// http://<MDNS_HOSTNAME>-xxxxxx.local/ adresinden erisim icin (STA ve AP
// modunda calisir) - burasi da TEMEL isim, gercek adres calisma zamaninda
// MAC tabanli benzersiz kodla birlestirilir (bkz. main.cpp uniqueSuffix).
// iOS/Android bazi durumlarda .local'i desteklemeyebilir; o zaman Serial
// Monitor'deki veya router panelindeki IP adresini kullanin.
#define MDNS_HOSTNAME "esp32-etiket"

// nRF24L01+ SPI pin baglantilari.
// GECICI TEST: SCK/MOSI/MISO farkli GPIO'lara tasindi (GPIO matrisi uzerinden,
// varsayilan VSPI IO_MUX pinleri 18/19/23 yerine) - bu pinlerin/kablolamanin
// sorun olup olmadigini test etmek icin. CE/CSN ayni kaldi.
#define NRF_CE_PIN  32
#define NRF_CSN_PIN 33
#define NRF_SCK_PIN  14
#define NRF_MISO_PIN 27
#define NRF_MOSI_PIN 13

// nrf24l01_Receiver projesindeki RECEIVER_NRF_ADDR_BYTES ile birebir eslesmeli
// (Core/Inc/main.h -> RECEIVER_BOARD_ESA / RECEIVER_BOARD_ESB secimine gore)
#define TARGET_ADDR_ESA "ESA" // 2.13" panel (GDEY0213B74, 122x250)
#define TARGET_ADDR_ESB "ESB" // 1.54" panel (200x200)

// ---- Kullanici girisi / rol tabanli erisim ----
// Cihazda hic kayitli kullanici yoksa (ilk kurulum) otomatik olusturulan
// admin hesabi - ilk giristen sonra admin panelinden sifresi degistirilmeli.
#define DEFAULT_ADMIN_USERNAME "admin"
#define DEFAULT_ADMIN_PASSWORD "admin123"
#define MAX_USERS 8
#define MAX_SESSIONS 4
#define SESSION_COOKIE_NAME "esp32session"
#define SESSION_TIMEOUT_MS (30UL * 60UL * 1000UL) // 30 dakika hareketsizlik
