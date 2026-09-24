#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

// Bulut sunucu baglantisi (server/src/gateways.js ile ayni protokol).
// Gateway NAT/modem arkasinda oldugu icin baglantiyi kendisi acar ve acik
// tutar: ws(s)://<sunucu>/ws/gateway. Baglaninca "hello" ile kimligini
// (MAC) ve cihaza ozel gizli anahtarini bildirir; sunucu etiket verisini
// "send" mesajiyla yollar, gateway hemen "ack" ile aldigini bildirir, nRF24
// ile gonderip sonucu "result" ile cevaplar.

// "send" mesaji geldiginde cagrilir: fields icindeki etiket alanlarini board
// ("ESA"/"ESB") adresine gonderir, sonucu message'a yazar.
typedef bool (*CloudSendHandler)(JsonObjectConst fields, const String &board, String &message);

// "command" mesaji geldiginde cagrilir ("restart", "wifi_reset").
typedef void (*CloudCommandHandler)(const String &command);

struct CloudConfig {
    String url;        // ornek: "wss://etiket.1.2.3.4.sslip.io/ws/gateway"
    String gatewayId;  // MAC adresi, 12 hex (buyuk harf)
    String secret;     // cihaza ozel rastgele anahtar (NVS'de saklanir)
    String fwVersion;
    bool nrfReady = false;
};

// URL gecersizse false doner (baglanti denenmez).
bool CloudClient_Begin(const CloudConfig &cfg, CloudSendHandler onSend, CloudCommandHandler onCommand);
void CloudClient_Loop();
bool CloudClient_IsConnected();

// url'yi parcalarina ayirir; "ws://", "wss://", "http://", "https://" kabul
// edilir, yol verilmemisse "/ws/gateway" kullanilir.
bool CloudClient_ParseUrl(const String &url, bool &tls, String &host, uint16_t &port, String &path);
