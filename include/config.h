#pragma once

// Ev/ofis WiFi bilgilerinizi buraya girin. Cihaz her acilista once
// NVS'ye (flash) kaydedilmis WiFi bilgisini dener (/wifi sihirbazindan
// girilen en son ag); burasi sadece NVS'de hic kayit yoksa (ilk kurulum
// veya fabrika ayarlarina donus) kullanilan yedek/varsayilan degerdir.
#define WIFI_SSID     ""
#define WIFI_PASSWORD ""
#define WIFI_CONNECT_TIMEOUT_MS 10000

// STA baglantisi kurulamazsa acilan yerel kurulum Access Point'i - bu sadece
// TEMEL isim: main.cpp calisirken sonuna cihazin MAC adresinden gelen
// benzersiz bir kod ekleniyor (ornek: "ESP32-NRF-Gateway-A1B2C3"), boylece
// birden fazla gateway ayni anda calisirken isimleri carpismiyor.
#define AP_SSID     "ESP32-NRF-Gateway"
#define AP_PASSWORD "12345678" // en az 8 karakter

// Kurulum AP'si acikken kayitli bir WiFi agi varsa ve bu sure boyunca kurulum
// agina kimse baglanmadiysa cihaz yeniden baslayip kayitli agi tekrar dener
// (elektrik kesintisinden sonra modem gec acilirsa takili kalmasin diye).
#define AP_RETRY_TIMEOUT_MS (5UL * 60UL * 1000UL)

// Router'in "bagli cihazlar" listesinde gorunen isim - TEMEL isim, sonuna
// MAC tabanli benzersiz kod eklenir (ornek: "esp32-etiket-a1b2c3").
#define MDNS_HOSTNAME "esp32-etiket"

// ---- Bulut sunucu (server/ klasoru, Coolify'da calisir) ----
// Gateway WiFi'ye baglaninca bu adrese WebSocket ile baglanir. Coolify'in
// verdigi adresi (ornek "https://xxxx.1.2.3.4.sslip.io") buraya wss:// ile
// yazin; https ayarlanmadiysa ws:// kullanin. Yol verilmezse /ws/gateway.
// Kurulum sayfasindaki "Sunucu Adresi" alanindan cihaz bazinda da
// degistirilebilir (NVS'ye kaydedilir, bu deger sadece varsayilan).
#define SERVER_URL_DEFAULT "wss://etiket.SUNUCU-IP.sslip.io/ws/gateway"

#define FW_VERSION "2.0.0"

// nRF24L01+ SPI pin baglantilari.
// SCK/MISO/MOSI artik ESP32'nin varsayilan VSPI IO_MUX pinlerinde (18/19/23) -
// GPIO matrisi uzerinden farkli pinlere tasima testi tamamlandi. CE/CSN
// donanimsal SPI'nin parcasi degil, RF24 kutuphanesinde yazilimla secilen
// keyfi GPIO'lar oldugu icin degismedi.
#define NRF_CE_PIN  32
#define NRF_CSN_PIN 33
#define NRF_SCK_PIN  18
#define NRF_MISO_PIN 19
#define NRF_MOSI_PIN 23

// nrf24l01_Receiver projesindeki RECEIVER_NRF_ADDR_BYTES ile birebir eslesmeli
// (Core/Inc/main.h -> RECEIVER_BOARD_ESA / RECEIVER_BOARD_ESB secimine gore)
#define TARGET_ADDR_ESA "ESA" // 2.13" panel (GDEY0213B74, 122x250)
#define TARGET_ADDR_ESB "ESB" // 1.54" panel (200x200)

// Kullanici girisi / rol tabanli erisim artik bulut sunucuda (server/src/auth.js).
