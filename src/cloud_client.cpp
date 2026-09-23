#include "cloud_client.h"
#include <WiFi.h>
#include <WebSocketsClient.h>

static const char *DEFAULT_WS_PATH = "/ws/gateway";
static const uint32_t RECONNECT_INTERVAL_MS = 5000;
// Panelde calisma suresi / WiFi sinyali / bos bellek / hata durumu icin.
static const uint32_t TELEMETRY_INTERVAL_MS = 60000;
// Sunucu anahtari reddettiyse (bad_secret) her 5 sn'de bir denemek yerine
// seyrek dene - admin panelden "Anahtar Sifirla" yapilinca kendiliginden baglanir.
static const uint32_t REJECTED_RECONNECT_INTERVAL_MS = 60000;

static WebSocketsClient ws;
static CloudConfig g_cfg;
static CloudSendHandler g_onSend = nullptr;
static CloudCommandHandler g_onCommand = nullptr;
static bool g_connected = false;
static bool g_telemetryDue = false;
static unsigned long g_lastTelemetryMillis = 0;

// nRF gonderimi ~1 sn surebilir; WebSocket olay callback'i icinde degil,
// CloudClient_Loop() icinde (ws.loop() dondukten sonra) yapiyoruz.
static JsonDocument g_pendingJob;
static bool g_hasPendingJob = false;
static String g_pendingCommand;

bool CloudClient_ParseUrl(const String &url, bool &tls, String &host, uint16_t &port, String &path) {
    String rest;
    if (url.startsWith("wss://")) { tls = true; rest = url.substring(6); }
    else if (url.startsWith("https://")) { tls = true; rest = url.substring(8); }
    else if (url.startsWith("ws://")) { tls = false; rest = url.substring(5); }
    else if (url.startsWith("http://")) { tls = false; rest = url.substring(7); }
    else return false;

    int slash = rest.indexOf('/');
    String hostPort = (slash == -1) ? rest : rest.substring(0, slash);
    path = (slash == -1) ? String("") : rest.substring(slash);
    if (path.length() <= 1) path = DEFAULT_WS_PATH;

    int colon = hostPort.indexOf(':');
    if (colon == -1) {
        host = hostPort;
        port = tls ? 443 : 80;
    } else {
        host = hostPort.substring(0, colon);
        long p = hostPort.substring(colon + 1).toInt();
        if (p <= 0 || p > 65535) return false;
        port = (uint16_t)p;
    }
    return host.length() > 0;
}

static void sendJson(JsonDocument &doc) {
    String out;
    serializeJson(doc, out);
    ws.sendTXT(out);
}

static void sendHello() {
    JsonDocument doc;
    doc["type"] = "hello";
    doc["id"] = g_cfg.gatewayId;
    doc["secret"] = g_cfg.secret;
    doc["fw"] = g_cfg.fwVersion;
    doc["nrf"] = g_cfg.nrfReady;
    sendJson(doc);
}

static void sendTelemetry() {
    JsonDocument doc;
    doc["type"] = "telemetry";
    doc["uptime"] = millis() / 1000;
    doc["rssi"] = WiFi.RSSI();
    doc["ssid"] = WiFi.SSID();
    doc["heap"] = ESP.getFreeHeap();
    doc["nrf"] = g_cfg.nrfReady;
    doc["error"] = g_cfg.nrfReady ? "" : "nRF24 modulu baslatilamadi (kablo/pin baglantisini kontrol edin)";
    sendJson(doc);
    g_lastTelemetryMillis = millis();
}

static void sendResult(const String &reqId, bool ok, const String &message) {
    JsonDocument doc;
    doc["type"] = "result";
    doc["reqId"] = reqId;
    doc["ok"] = ok;
    doc["message"] = message;
    sendJson(doc);
}

static void handleMessage(uint8_t *payload, size_t length) {
    JsonDocument doc;
    if (deserializeJson(doc, payload, length)) {
        Serial.println("[bulut] gecersiz JSON mesaj, atlandi.");
        return;
    }
    String type = doc["type"] | "";

    if (type == "hello_ack" || type == "status") {
        String status = doc["status"] | "";
        String name = doc["name"] | "";
        ws.setReconnectInterval(RECONNECT_INTERVAL_MS);
        const char *label =
            status == "active"     ? "AKTIF" :
            status == "pending"    ? "BEKLEMEDE (merkez panelden kaydedilmeli)" :
            status == "registered" ? "KAYITLI (bayi hesabina eklenmeli - QR/sahiplenme kodu)" :
            status == "awaiting"   ? "BAGLANTI BEKLENIYOR" :
            status == "disabled"   ? "DEVRE DISI" : status.c_str();
        Serial.print("[bulut] durum: ");
        Serial.print(label);
        Serial.print(" - isim: ");
        Serial.println(name);
        if (type == "hello_ack") g_telemetryDue = true;
    } else if (type == "send") {
        if (g_hasPendingJob) {
            sendResult(doc["reqId"] | "", false, "HATA: Gateway mesgul, onceki gonderim suruyor.");
            return;
        }
        g_pendingJob = doc;
        g_hasPendingJob = true;
    } else if (type == "command") {
        g_pendingCommand = doc["command"] | "";
    } else if (type == "error") {
        String error = doc["error"] | "";
        Serial.print("[bulut] sunucu baglantiyi reddetti: ");
        Serial.println(error);
        if (error == "bad_secret") {
            Serial.println("[bulut] Anahtar eslesmiyor - admin panelden bu gateway icin 'Anahtar Sifirla' yapin.");
            ws.setReconnectInterval(REJECTED_RECONNECT_INTERVAL_MS);
        }
    }
}

static void onEvent(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED:
            g_connected = true;
            Serial.println("[bulut] sunucuya baglandi, kimlik gonderiliyor...");
            sendHello();
            break;
        case WStype_DISCONNECTED:
            if (g_connected) Serial.println("[bulut] sunucu baglantisi koptu, yeniden denenecek.");
            g_connected = false;
            break;
        case WStype_TEXT:
            handleMessage(payload, length);
            break;
        default:
            break;
    }
}

bool CloudClient_Begin(const CloudConfig &cfg, CloudSendHandler onSend, CloudCommandHandler onCommand) {
    g_cfg = cfg;
    g_onSend = onSend;
    g_onCommand = onCommand;

    bool tls;
    String host, path;
    uint16_t port;
    if (!CloudClient_ParseUrl(cfg.url, tls, host, port, path)) {
        Serial.print("[bulut] gecersiz sunucu adresi: '");
        Serial.print(cfg.url);
        Serial.println("' - WiFi kurulum sayfasindan duzeltin.");
        return false;
    }

    Serial.print("[bulut] sunucu: ");
    Serial.print(tls ? "wss://" : "ws://");
    Serial.print(host); Serial.print(':'); Serial.print(port); Serial.println(path);

    if (tls) {
        // Sertifika verilmedigi icin kutuphane setInsecure() kullanir: trafik
        // sifreli ama sunucu sertifikasi dogrulanmaz. Gateway'in kimligi
        // zaten sunucuda anahtarla dogrulaniyor.
        ws.beginSSL(host.c_str(), port, path.c_str());
    } else {
        ws.begin(host.c_str(), port, path.c_str());
    }
    ws.onEvent(onEvent);
    ws.setReconnectInterval(RECONNECT_INTERVAL_MS);
    // 15 sn'de bir ping; 3 sn icinde 2 pong gelmezse baglanti koptu sayilir.
    ws.enableHeartbeat(15000, 3000, 2);
    return true;
}

void CloudClient_Loop() {
    ws.loop();

    if (g_hasPendingJob) {
        String reqId = g_pendingJob["reqId"] | "";
        String board = g_pendingJob["board"] | "ESA";
        String message;
        bool ok = g_onSend ? g_onSend(g_pendingJob["fields"].as<JsonObjectConst>(), board, message) : false;
        g_pendingJob.clear();
        g_hasPendingJob = false;
        sendResult(reqId, ok, message);
    }

    if (g_connected && (g_telemetryDue || millis() - g_lastTelemetryMillis > TELEMETRY_INTERVAL_MS)) {
        g_telemetryDue = false;
        sendTelemetry();
    }

    if (g_pendingCommand.length() > 0) {
        String command = g_pendingCommand;
        g_pendingCommand = "";
        if (g_onCommand) g_onCommand(command);
    }
}

bool CloudClient_IsConnected() {
    return g_connected;
}
