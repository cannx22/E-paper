#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <SPI.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>
#include "config.h"
#include "label_payload.h"
#include "nrf_gateway.h"

WebServer server(80);
bool nrfReady = false;

// ---- Kullanici girisi / rol tabanli erisim ----
// Kullanicilar NVS'de ("users" namespace'i, wifiPrefs ile ayni desende)
// sabit slotlarda saklanir; oturumlar (login sonrasi cookie) sadece RAM'de
// tutulur, cihaz yeniden baslarsa herkes tekrar giris yapar - bu sorun degil.
#define ROLE_USER  0
#define ROLE_ADMIN 1

Preferences userPrefs;

struct Session {
    bool active = false;
    String token;
    String username;
    uint8_t role = ROLE_USER;
    unsigned long lastActivityMillis = 0;
};
Session sessions[MAX_SESSIONS];

// requireAuth()/getSessionFromRequest() tarafindan doldurulur, sadece o an
// islenen istek icin gecerlidir (WebServer tek seferde tek istek isler).
String g_reqUsername;
uint8_t g_reqRole = ROLE_USER;

// ---- WiFi kurulum sihirbazi: SSID/sifre artik config.h'a gomulu degil,
// cihazin flash hafizasina (NVS/Preferences) kaydediliyor. Baglanti
// kurulamazsa cihaz kendi "kurulum" Access Point'ini acip, taraycidan
// erisilebilen bir sihirbaz sayfasi (/wifi) uzerinden yeni ag bilgilerini
// almayi ve kaydetmeyi sagliyor - boylece her yeni yere tasindiginda
// kod degistirip yeniden yuklemek gerekmiyor. ----
Preferences wifiPrefs;
DNSServer dnsServer;
const byte DNS_PORT = 53;
bool apMode = false;
unsigned long restartAtMillis = 0;

// Birden fazla gateway ayni anda calisirken (farkli subeler) AP adi/mDNS adi
// carpismasin diye, cihazin kendi fabrika MAC adresinden gelen (dolayisiyla
// garanti benzersiz) son 3 bayti isme ekliyoruz - config.h'daki AP_SSID/
// MDNS_HOSTNAME artik "temel isim", gercekte kullanilan isimler bu sonek ile
// olusturuluyor (ornek: "ESP32-NRF-Gateway-A1B2C3", "esp32-etiket-a1b2c3").
String uniqueSuffix;   // "A1B2C3" (buyuk harf, AP adinda)
String apSsidFull;     // AP_SSID + "-" + uniqueSuffix
String mdnsHostnameFull; // MDNS_HOSTNAME + "-" + kucuk harfli uniqueSuffix

String computeUniqueSuffix() {
    String mac = WiFi.macAddress(); // "AA:BB:CC:DD:EE:FF"
    mac.replace(":", "");
    if (mac.length() >= 6) {
        return mac.substring(mac.length() - 6); // son 3 bayt (6 hex karakter)
    }
    return "000000";
}

String loadSavedSSID() {
    wifiPrefs.begin("wifi", true);
    String s = wifiPrefs.getString("ssid", "");
    wifiPrefs.end();
    return s;
}

String loadSavedPass() {
    wifiPrefs.begin("wifi", true);
    String p = wifiPrefs.getString("pass", "");
    wifiPrefs.end();
    return p;
}

void saveWifiCreds(const String &ssid, const String &pass) {
    wifiPrefs.begin("wifi", false);
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("pass", pass);
    wifiPrefs.end();
}

// ---- Kullanici hesaplari (NVS, "users" namespace'i) ----
// Sabit slotlar: count, u0..u7 (kullanici adi), h0..h7 (tuzlu SHA-256 hash,
// hex), s0..s7 (tuz, hex), r0..r7 (rol: 0=user, 1=admin). Silme islemi
// slotlari basa dogru kaydirir, boylece "count" her zaman gercek slot
// sayisini yansitir ve bosluk/kullanilan bitmap tutmaya gerek kalmaz.

String randomHex(size_t numBytes) {
    uint8_t buf[32];
    if (numBytes > sizeof(buf)) numBytes = sizeof(buf);
    esp_fill_random(buf, numBytes);
    String out;
    char hexPart[3];
    for (size_t i = 0; i < numBytes; i++) {
        sprintf(hexPart, "%02x", buf[i]);
        out += hexPart;
    }
    return out;
}

String sha256Hex(const String &input) {
    unsigned char hash[32];
    mbedtls_sha256((const unsigned char *)input.c_str(), input.length(), hash, 0);
    String out;
    char hexPart[3];
    for (int i = 0; i < 32; i++) {
        sprintf(hexPart, "%02x", hash[i]);
        out += hexPart;
    }
    return out;
}

uint8_t countUsers() {
    userPrefs.begin("users", true);
    uint8_t count = userPrefs.getUChar("count", 0);
    userPrefs.end();
    return count;
}

uint8_t countAdmins() {
    uint8_t total = 0;
    userPrefs.begin("users", true);
    uint8_t count = userPrefs.getUChar("count", 0);
    for (uint8_t i = 0; i < count; i++) {
        if (userPrefs.getUChar(("r" + String(i)).c_str(), ROLE_USER) == ROLE_ADMIN) {
            total++;
        }
    }
    userPrefs.end();
    return total;
}

bool findUserIndex(const String &username, uint8_t &indexOut) {
    userPrefs.begin("users", true);
    uint8_t count = userPrefs.getUChar("count", 0);
    bool found = false;
    for (uint8_t i = 0; i < count; i++) {
        String u = userPrefs.getString(("u" + String(i)).c_str(), "");
        if (u == username) {
            indexOut = i;
            found = true;
            break;
        }
    }
    userPrefs.end();
    return found;
}

bool verifyUser(const String &username, const String &password, uint8_t &roleOut) {
    uint8_t idx;
    if (!findUserIndex(username, idx)) {
        return false;
    }
    userPrefs.begin("users", true);
    String salt = userPrefs.getString(("s" + String(idx)).c_str(), "");
    String storedHash = userPrefs.getString(("h" + String(idx)).c_str(), "");
    uint8_t role = userPrefs.getUChar(("r" + String(idx)).c_str(), ROLE_USER);
    userPrefs.end();

    if (sha256Hex(salt + password) != storedHash) {
        return false;
    }
    roleOut = role;
    return true;
}

bool createUser(const String &username, const String &password, uint8_t role) {
    userPrefs.begin("users", false);
    uint8_t count = userPrefs.getUChar("count", 0);
    if (count >= MAX_USERS) {
        userPrefs.end();
        return false;
    }
    String salt = randomHex(8);
    userPrefs.putString(("u" + String(count)).c_str(), username);
    userPrefs.putString(("s" + String(count)).c_str(), salt);
    userPrefs.putString(("h" + String(count)).c_str(), sha256Hex(salt + password));
    userPrefs.putUChar(("r" + String(count)).c_str(), role);
    userPrefs.putUChar("count", count + 1);
    userPrefs.end();
    return true;
}

bool setUserPassword(const String &username, const String &newPassword) {
    uint8_t idx;
    if (!findUserIndex(username, idx)) {
        return false;
    }
    userPrefs.begin("users", false);
    String salt = randomHex(8);
    userPrefs.putString(("s" + String(idx)).c_str(), salt);
    userPrefs.putString(("h" + String(idx)).c_str(), sha256Hex(salt + newPassword));
    userPrefs.end();
    return true;
}

bool deleteUser(const String &username) {
    uint8_t idx;
    if (!findUserIndex(username, idx)) {
        return false;
    }
    userPrefs.begin("users", false);
    uint8_t count = userPrefs.getUChar("count", 0);
    // Silinen slottan sonraki tum slotlari bir yukari kaydir, bosluk kalmasin.
    for (uint8_t i = idx; i + 1 < count; i++) {
        userPrefs.putString(("u" + String(i)).c_str(), userPrefs.getString(("u" + String(i + 1)).c_str(), ""));
        userPrefs.putString(("s" + String(i)).c_str(), userPrefs.getString(("s" + String(i + 1)).c_str(), ""));
        userPrefs.putString(("h" + String(i)).c_str(), userPrefs.getString(("h" + String(i + 1)).c_str(), ""));
        userPrefs.putUChar(("r" + String(i)).c_str(), userPrefs.getUChar(("r" + String(i + 1)).c_str(), ROLE_USER));
    }
    userPrefs.putUChar("count", count - 1);
    userPrefs.end();
    return true;
}

void ensureDefaultAdmin() {
    if (countUsers() == 0) {
        createUser(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, ROLE_ADMIN);
        Serial.println("Varsayilan admin hesabi olusturuldu: " DEFAULT_ADMIN_USERNAME " / " DEFAULT_ADMIN_PASSWORD);
    }
}

// ---- Oturumlar (login sonrasi cookie, sadece RAM'de) ----

String generateSessionToken() {
    return randomHex(16);
}

String extractCookieValue(const String &cookieHeader, const String &name) {
    int searchFrom = 0;
    while (searchFrom < (int)cookieHeader.length()) {
        int sep = cookieHeader.indexOf(';', searchFrom);
        String pair = (sep == -1) ? cookieHeader.substring(searchFrom) : cookieHeader.substring(searchFrom, sep);
        pair.trim();
        int eq = pair.indexOf('=');
        if (eq != -1 && pair.substring(0, eq) == name) {
            return pair.substring(eq + 1);
        }
        if (sep == -1) break;
        searchFrom = sep + 1;
    }
    return "";
}

int findSessionSlotByToken(const String &token) {
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].active && sessions[i].token == token) {
            return i;
        }
    }
    return -1;
}

String createSession(const String &username, uint8_t role) {
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (!sessions[i].active) { slot = i; break; }
    }
    if (slot == -1) {
        // Bos slot yok - en uzun suredir hareketsiz oturumu devral (kucuk
        // yerel cihaz icin makul bir davranis, reddetmek yerine).
        unsigned long oldest = sessions[0].lastActivityMillis;
        slot = 0;
        for (int i = 1; i < MAX_SESSIONS; i++) {
            if (sessions[i].lastActivityMillis < oldest) {
                oldest = sessions[i].lastActivityMillis;
                slot = i;
            }
        }
    }
    sessions[slot].active = true;
    sessions[slot].token = generateSessionToken();
    sessions[slot].username = username;
    sessions[slot].role = role;
    sessions[slot].lastActivityMillis = millis();
    return sessions[slot].token;
}

void destroySession(const String &token) {
    int slot = findSessionSlotByToken(token);
    if (slot != -1) {
        sessions[slot].active = false;
    }
}

bool getSessionFromRequest(String &usernameOut, uint8_t &roleOut) {
    if (!server.hasHeader("Cookie")) {
        return false;
    }
    String token = extractCookieValue(server.header("Cookie"), SESSION_COOKIE_NAME);
    if (token.length() == 0) {
        return false;
    }
    int slot = findSessionSlotByToken(token);
    if (slot == -1) {
        return false;
    }
    if (millis() - sessions[slot].lastActivityMillis > SESSION_TIMEOUT_MS) {
        sessions[slot].active = false;
        return false;
    }
    sessions[slot].lastActivityMillis = millis();
    usernameOut = sessions[slot].username;
    roleOut = sessions[slot].role;
    return true;
}

void redirectToLogin() {
    server.sendHeader("Location", "/login", true);
    server.send(302, "text/plain", "");
}

bool requireAuth(uint8_t minRole) {
    if (!getSessionFromRequest(g_reqUsername, g_reqRole)) {
        redirectToLogin();
        return false;
    }
    if (g_reqRole < minRole) {
        server.send(403, "text/plain; charset=utf-8", "HATA: Bu islem icin yetkiniz yok.");
        return false;
    }
    return true;
}

bool requireAuthOrApMode(uint8_t minRole) {
    if (apMode) {
        return true; // kurulum AP'sine fiziksel/RF erisim zaten guvenlik siniri
    }
    return requireAuth(minRole);
}

// /send gibi tarayici navigasyonu degil de JS fetch ile cagrilan endpoint'ler
// icin: 302 yonlendirme yerine JS'in zaten isledigi 401/403 metni doner.
bool requireAuthApi(uint8_t minRole) {
    if (!getSessionFromRequest(g_reqUsername, g_reqRole)) {
        server.send(401, "text/plain; charset=utf-8", "HATA: Giris yapmalisiniz.");
        return false;
    }
    if (g_reqRole < minRole) {
        server.send(403, "text/plain; charset=utf-8", "HATA: Bu islem icin yetkiniz yok.");
        return false;
    }
    return true;
}

bool tryConnectSTA(const String &ssid, const String &pass, uint32_t timeoutMs) {
    if (ssid.length() == 0) {
        return false;
    }

    WiFi.mode(WIFI_STA);
    // Router'in "bagli cihazlar" listesinde MAC/genel isim yerine taniyici
    // (ve birden fazla gateway varsa birbirinden ayirt edilebilir) bir ad
    // gorunsun diye - boylece mDNS (.local) calismayan bir agda bile IP'yi
    // router paneli uzerinden kolayca bulabilirsiniz.
    WiFi.setHostname(mdnsHostnameFull.c_str());
    WiFi.begin(ssid.c_str(), pass.c_str());

    Serial.print("WiFi'ya baglaniliyor ('");
    Serial.print(ssid);
    Serial.print("')");
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
        delay(250);
        Serial.print(".");
    }
    Serial.println();
    return WiFi.status() == WL_CONNECTED;
}

void startSetupAP() {
    apMode = true;

    // STA modundan AP moduna gecerken WiFi.softAP() bazen sessizce basarisiz
    // oluyor - once radyoyu tam kapatip AP_STA modunda temiz baslatiyoruz.
    // AP_STA (sadece AP degil) sayesinde kurulum sayfasindaki "Aglari Tara"
    // ozelligi de calisir (tarama STA radyosunu gerektirir).
    WiFi.disconnect(true, true);
    delay(200);
    WiFi.mode(WIFI_OFF);
    delay(200);
    WiFi.mode(WIFI_AP_STA);
    delay(200);

    bool apOk = WiFi.softAP(apSsidFull.c_str(), AP_PASSWORD);
    if (apOk) {
        Serial.print("Kurulum Access Point'i basladi. SSID: ");
        Serial.print(apSsidFull);
        Serial.print(" Sifre: ");
        Serial.print(AP_PASSWORD);
        Serial.print(" IP: ");
        Serial.println(WiFi.softAPIP());
        Serial.println("Bu aga baglanip tarayicidan herhangi bir adrese gitmeyi deneyin -");
        Serial.println("otomatik olarak kurulum sayfasina yonlenir (olmazsa http://192.168.4.1/wifi).");
    } else {
        Serial.println("Kurulum Access Point'i baslatilamadi! (WiFi.softAP() false dondu)");
    }

    dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
}

static const uint8_t ADDR_ESA[NRF_ADDR_LEN] = {TARGET_ADDR_ESA[0], TARGET_ADDR_ESA[1], TARGET_ADDR_ESA[2]};
static const uint8_t ADDR_ESB[NRF_ADDR_LEN] = {TARGET_ADDR_ESB[0], TARGET_ADDR_ESB[1], TARGET_ADDR_ESB[2]};

static const char PAGE_HEADER[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-Paper Raf Etiketleri</title>
<style>
:root{
  --red:#d62828; --red-dark:#b71c1c; --red-darker:#8e0000;
  --bg:#fff2f2; --card:#ffffff; --border:#e0b3b3;
  --text:#2b2b2b; --muted:#7f8c8d;
}
*{box-sizing:border-box;}
body{
  font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg); color:var(--text); margin:0; padding:0 0 40px;
}
.banner{background:var(--red); padding:16px 20px; display:flex; align-items:center; gap:14px;}
.banner .tag{font-size:30px;}
.banner h1{color:#fff; font-size:20px; margin:0;}
.banner p{color:#ffe1e1; font-size:12px; margin:2px 0 0;}
.wifi-link{margin-left:auto; background:rgba(255,255,255,.18); color:#fff; padding:7px 14px; border-radius:20px; font-size:12px; text-decoration:none; white-space:nowrap; font-weight:600;}
.wifi-link:hover{background:rgba(255,255,255,.3);}
.layout{
  max-width:1180px; margin:20px auto; padding:0 16px;
  display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap;
}
.form-col{flex:1 1 480px; min-width:280px;}
.preview-col{flex:0 1 460px; min-width:260px; position:sticky; top:16px;}
.card{
  background:var(--card); border:2px solid var(--red); border-radius:10px;
  padding:14px 16px 18px; margin-bottom:16px;
}
.card h2{
  color:var(--red-dark); font-size:14px; text-transform:uppercase;
  letter-spacing:.03em; margin:0 0 12px;
}
.field{margin-bottom:12px;}
.field label{display:flex; justify-content:space-between; font-weight:600; font-size:13px; margin-bottom:4px;}
.counter{font-weight:400; color:var(--muted); font-size:12px;}
.counter.over{color:var(--red-darker); font-weight:700;}
input[type=text],input:not([type]),input[type=number],select,textarea{
  width:100%; padding:8px; font-size:14px; border:1px solid var(--border);
  border-radius:5px; background:#fff; color:var(--text);
}
input:focus,select:focus,textarea:focus{outline:none; border:2px solid var(--red); padding:7px;}
.row{display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;}
.row>.field{flex:1; min-width:110px;}
.checkbox{display:flex; align-items:center; gap:6px; font-weight:600; font-size:13px; padding-bottom:9px;}
.checkbox input{width:16px; height:16px; accent-color:var(--red);}
.btn-primary,.btn-ghost{
  border:none; border-radius:6px; padding:10px 20px; font-weight:700;
  font-size:14px; cursor:pointer;
}
.btn-primary{background:var(--red); color:#fff; width:100%;}
.btn-primary:hover{background:var(--red-dark);}
.btn-primary:active{background:var(--red-darker);}
.btn-ghost{background:#fff; color:var(--red-dark); border:1px solid var(--red);}
.btn-ghost:hover{background:#ffe6e6;}
.btn-ghost.danger{color:var(--red-darker); border-color:var(--red-darker);}
.send-row{margin-top:4px;}
#result{margin-top:14px; padding:12px; border-radius:8px; white-space:pre-wrap; font-size:13px; display:none;}
#result.ok{display:block; background:#d4edda; color:#155724; border:1px solid #b7e0c2;}
#result.err{display:block; background:#f8d7da; color:#7a1c25; border:1px solid #edb9bf;}
.preview-card{
  background:var(--card); border:2px solid var(--red); border-radius:10px;
  padding:14px 16px 18px;
}
.preview-card h2{color:var(--red-dark); font-size:14px; text-transform:uppercase; letter-spacing:.03em; margin:0 0 12px;}
.preview-frame{
  background:#2b2b2b; border:6px solid var(--red); border-radius:10px;
  padding:10px; display:flex; justify-content:center;
}
#labelCanvas{width:100%; max-width:460px; height:auto; image-rendering:pixelated; background:#fff; display:block;}
.presets-row{display:flex; gap:8px; flex-wrap:wrap;}
.presets-row select{flex:1; min-width:140px;}
@media (max-width:900px){
  .preview-col{position:static; flex:1 1 100%;}
}
.bulk-wrap{max-width:1180px; margin:0 auto 20px; padding:0 16px;}
.hint{color:var(--muted); font-size:13px; margin:0 0 12px;}
.bulk-controls{display:flex; gap:10px; flex-wrap:wrap; align-items:center;}
.bulk-controls input[type=file]{
  flex:1; min-width:200px; background:#fff; border:1px solid var(--border);
  border-radius:5px; padding:6px; font-size:13px;
}
.bulk-table-scroll{overflow-x:auto; margin-top:14px;}
#bulkTable{width:100%; border-collapse:collapse; font-size:13px;}
#bulkTable th{
  background:var(--red); color:#fff; text-align:left; padding:8px 10px;
  white-space:nowrap;
}
#bulkTable td{padding:7px 10px; border-bottom:1px solid var(--border); white-space:nowrap;}
#bulkTable tbody tr:nth-child(even){background:#fff8f8;}
.bulk-status.ok{color:#1e7e34; font-weight:700;}
.bulk-status.err{color:var(--red-darker); font-weight:700;}
#bulkLog{margin-top:10px; font-size:13px; color:var(--muted);}
</style></head><body>
<div class="banner">
  <span class="tag">&#127991;&#65039;</span>
  <div>
    <h1>E-Paper Raf Etiketleri <span id="deviceIdBadge" style="opacity:.7; font-size:13px; font-weight:400;"></span></h1>
  </div>
)HTML";

static const char PAGE_FORM[] PROGMEM = R"HTML(
<div class="layout">
<main class="form-col">

  <section class="card">
    <h2>Kay&#305;tl&#305; &Uuml;r&uuml;nler</h2>
    <div class="presets-row">
      <select id="presetSelect"><option value="">(kay&#305;tl&#305; &uuml;r&uuml;n yok)</option></select>
      <button type="button" class="btn-ghost" id="presetLoadBtn">Y&uuml;kle</button>
      <button type="button" class="btn-ghost" id="presetSaveBtn">Kaydet</button>
      <button type="button" class="btn-ghost danger" id="presetDeleteBtn">Sil</button>
    </div>
  </section>

  <form id="f">
    <section class="card">
      <h2>Ba&#287;lant&#305;</h2>
      <div class="field">
        <label>Hedef Ekran</label>
        <select name="board" id="boardSelect">
          <option value="ESA">ESA (2.13" panel)</option>
          <option value="ESB">ESB (1.54" panel)</option>
        </select>
      </div>
    </section>

    <section class="card">
      <h2>&#350;ablon</h2>
      <div class="row">
        <div class="field">
          <label>Kategori</label>
          <select id="categorySelect">
            <option value="">Kategori se&ccedil;in (&#351;ablon/birim &ouml;nerir)</option>
            <option value="manav">Manav</option>
            <option value="kasap">Kasap</option>
            <option value="sarkuteri">&#350;ark&uuml;teri</option>
            <option value="kozmetik">Kozmetik</option>
            <option value="genel">Genel</option>
          </select>
        </div>
        <div class="field">
          <label>&#350;ablon</label>
          <select name="templateID" id="templateSelect">
            <option value="1">Standart</option>
            <option value="3">Ticket</option>
            <option value="4">Basic</option>
          </select>
        </div>
        <label class="checkbox"><input type="checkbox" name="discountEnabled" id="discountEnabled" value="1"> &#304;ndirim</label>
        <label class="checkbox"><input type="checkbox" name="campaignEnabled" id="campaignEnabled" value="1"> Kampanya</label>
      </div>
    </section>

    <section class="card">
      <h2>Etiket &#304;&ccedil;eri&#287;i</h2>
      <div class="field">
        <label>&#304;&#351;letme Ad&#305; <span class="counter" data-max="16" id="cnt-business">0/16</span></label>
        <input name="business" id="businessInput" maxlength="32">
      </div>
      <div class="field">
        <label>&Uuml;r&uuml;n Ad&#305; <span class="counter" data-max="34" id="cnt-name">0/34</span></label>
        <input name="name" id="productInput" maxlength="64">
      </div>
      <div class="field">
        <label>Alt Ba&#351;l&#305;k <span class="counter" data-max="16" id="cnt-subtitle">0/16</span></label>
        <input name="subtitle" id="subtitleInput" maxlength="32">
      </div>
      <div class="row">
        <div class="field">
          <label>Fiyat <span class="counter" data-max="6" id="cnt-price">0/6</span></label>
          <input name="price" id="priceInput" maxlength="12">
        </div>
        <div class="field">
          <label>Eski Fiyat <span class="counter" data-max="6" id="cnt-oldPrice">0/6</span></label>
          <input name="oldPrice" id="oldPriceInput" maxlength="12">
        </div>
        <div class="field">
          <label>Birim</label>
          <input name="unit" id="unitInput" list="unitOptions" maxlength="5">
          <datalist id="unitOptions">
            <option value="TL"><option value="EUR"><option value="USD">
            <option value="ADET"><option value="KG"><option value="GR"><option value="LT"><option value="ML">
            <option value="TL/KG"><option value="TL/AD"><option value="TL/LT"><option value="TL/GR">
          </datalist>
        </div>
      </div>
      <div class="field">
        <label>Alt Kod <span class="counter" data-max="14" id="cnt-bottomCode">0/14</span></label>
        <input name="bottomCode" id="bottomCodeInput" maxlength="28">
      </div>
      <div class="field" id="barcodeWrap">
        <label>Barkod (12 haneli)</label>
        <div class="row">
          <input name="barcode" id="barcodeInput" maxlength="12" pattern="[0-9]*" placeholder="12 haneli EAN-13 kaynak rakamlar&#305;" style="flex:1;">
          <button type="button" class="btn-ghost" id="randomBarcodeBtn">Rastgele</button>
        </div>
      </div>
    </section>

    <div class="send-row">
      <button type="submit" class="btn-primary">&#128225; G&ouml;nder</button>
    </div>
  </form>
  <div id="result"></div>
</main>

<aside class="preview-col">
  <div class="preview-card">
    <h2>&Ouml;nizleme (e-paper ekran&#305;)</h2>
    <div class="preview-frame">
      <canvas id="labelCanvas" width="750" height="384"></canvas>
    </div>
  </div>
</aside>
</div>

<div class="bulk-wrap">
  <section class="card">
    <h2>Toplu G&uuml;ncelleme (Excel ile)</h2>
    <p class="hint">Birden fazla ekran&#305; tek seferde g&uuml;ncellemek i&ccedil;in &ouml;nce &ouml;rnek Excel &#351;ablonunu indirin, i&ccedil;ini doldurup buradan tekrar y&uuml;kleyin. (Bu &ouml;zellik i&ccedil;in taray&#305;c&#305;n&#305;z&#305;n internete de ba&#287;l&#305; olmas&#305; gerekir.)</p>
    <div class="bulk-controls">
      <button type="button" class="btn-ghost" id="downloadTemplateBtn">&#128229; Excel &#350;ablonu &#304;ndir</button>
      <input type="file" id="excelFileInput" accept=".xlsx,.xls,.csv">
      <button type="button" class="btn-ghost" id="parseExcelBtn">Y&uuml;kle ve &Ouml;nizle</button>
    </div>
    <div id="bulkTableWrap" class="bulk-table-scroll" style="display:none;">
      <table id="bulkTable">
        <thead>
          <tr><th>#</th><th>Ekran</th><th>&#350;ablon</th><th>&#304;&#351;letme</th><th>&Uuml;r&uuml;n</th><th>Fiyat</th><th>Durum</th></tr>
        </thead>
        <tbody></tbody>
      </table>
      <div class="send-row">
        <button type="button" class="btn-primary" id="bulkSendBtn">&#128225; Toplu G&ouml;nder</button>
      </div>
    </div>
    <div id="bulkLog"></div>
  </section>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<script>
// Birden fazla gateway varsa hangi cihazda oldugunuzu ayirt edebilmeniz icin
// (MAC tabanli, cihaza ozel kimlik).
fetch('/wifi/status').then(function(r){ return r.json(); }).then(function(s){
  if (s.id) document.getElementById('deviceIdBadge').textContent = '#' + s.id;
}).catch(function(){});

// ---- Turkce kodlama (label_payload.cpp / protocol.py ile birebir) ----
var TURKISH_CODES = {'Ç':1,'ç':2,'Ğ':3,'ğ':4,'İ':5,'ı':6,
                      'Ö':7,'ö':8,'Ş':9,'ş':10,'Ü':11,'ü':12};
function encodedLength(s){
  var n = 0;
  for (var i = 0; i < s.length; i++) n += 1;
  return n;
}
function bindCounter(inputEl, counterEl, max){
  function update(){
    var len = encodedLength(inputEl.value);
    if (len > max){
      var v = inputEl.value;
      while (encodedLength(v) > max && v.length > 0) v = v.slice(0, -1);
      inputEl.value = v;
      len = encodedLength(v);
    }
    counterEl.textContent = len + '/' + max;
    counterEl.classList.toggle('over', len >= max);
  }
  inputEl.addEventListener('input', update);
  update();
}
bindCounter(document.getElementById('businessInput'), document.getElementById('cnt-business'), 16);
bindCounter(document.getElementById('productInput'), document.getElementById('cnt-name'), 34);
bindCounter(document.getElementById('subtitleInput'), document.getElementById('cnt-subtitle'), 16);
bindCounter(document.getElementById('priceInput'), document.getElementById('cnt-price'), 6);
bindCounter(document.getElementById('oldPriceInput'), document.getElementById('cnt-oldPrice'), 6);
bindCounter(document.getElementById('bottomCodeInput'), document.getElementById('cnt-bottomCode'), 14);

// ---- Sablon secimine gore barkod alanini gizle/goster (Basic'te barkod yok) ----
var templateSelect = document.getElementById('templateSelect');
var barcodeWrap = document.getElementById('barcodeWrap');
function updateBarcodeVisibility(){
  barcodeWrap.style.display = (templateSelect.value === '4') ? 'none' : 'block';
}
templateSelect.addEventListener('change', function(){ updateBarcodeVisibility(); scheduleRender(); });

// ---- Kategoriye gore onerilen sablon/birim (mevcut 3 sabit sablonu
// kategoriye esler - receiver tarafinda degisiklik gerektirmez) ----
var CATEGORY_DEFAULTS = {
  manav:     { templateID: '1', unit: 'KG' },
  kasap:     { templateID: '1', unit: 'KG' },
  sarkuteri: { templateID: '3', unit: 'KG' },
  kozmetik:  { templateID: '4', unit: 'ADET' }
};
document.getElementById('categorySelect').addEventListener('change', function(e){
  var def = CATEGORY_DEFAULTS[e.target.value];
  if (!def) return;
  templateSelect.value = def.templateID;
  document.getElementById('unitInput').value = def.unit;
  updateBarcodeVisibility();
  scheduleRender();
});
updateBarcodeVisibility();

document.getElementById('randomBarcodeBtn').addEventListener('click', function(){
  var digits = '';
  for (var i = 0; i < 12; i++) digits += Math.floor(Math.random() * 10);
  document.getElementById('barcodeInput').value = digits;
  scheduleRender();
});

// ---- Kayitli urunler (tarayici localStorage'inda, cihaza gore degil) ----
var PRESET_KEY = 'esp32_nrf_gateway_presets_v1';
function loadPresets(){
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch(e) { return {}; }
}
function savePresets(obj){ localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); }
function refreshPresetSelect(selectName){
  var presets = loadPresets();
  var sel = document.getElementById('presetSelect');
  sel.innerHTML = '';
  var names = Object.keys(presets);
  if (names.length === 0){
    sel.innerHTML = '<option value="">(kayıtlı ürün yok)</option>';
    return;
  }
  names.sort().forEach(function(n){
    var opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    sel.appendChild(opt);
  });
  if (selectName && presets[selectName]) sel.value = selectName;
}
function collectFormValues(){
  return {
    board: document.getElementById('boardSelect').value,
    templateID: templateSelect.value,
    discountEnabled: document.getElementById('discountEnabled').checked,
    campaignEnabled: document.getElementById('campaignEnabled').checked,
    business: document.getElementById('businessInput').value,
    name: document.getElementById('productInput').value,
    subtitle: document.getElementById('subtitleInput').value,
    price: document.getElementById('priceInput').value,
    oldPrice: document.getElementById('oldPriceInput').value,
    unit: document.getElementById('unitInput').value,
    bottomCode: document.getElementById('bottomCodeInput').value,
    barcode: document.getElementById('barcodeInput').value
  };
}
function applyFormValues(v){
  document.getElementById('boardSelect').value = v.board || 'ESA';
  templateSelect.value = v.templateID || '1';
  document.getElementById('discountEnabled').checked = !!v.discountEnabled;
  document.getElementById('campaignEnabled').checked = !!v.campaignEnabled;
  document.getElementById('businessInput').value = v.business || '';
  document.getElementById('productInput').value = v.name || '';
  document.getElementById('subtitleInput').value = v.subtitle || '';
  document.getElementById('priceInput').value = v.price || '';
  document.getElementById('oldPriceInput').value = v.oldPrice || '';
  document.getElementById('unitInput').value = v.unit || '';
  document.getElementById('bottomCodeInput').value = v.bottomCode || '';
  document.getElementById('barcodeInput').value = v.barcode || '';
  updateBarcodeVisibility();
  scheduleRender();
}
document.getElementById('presetSaveBtn').addEventListener('click', function(){
  var name = document.getElementById('productInput').value.trim() ||
             document.getElementById('presetSelect').value.trim();
  name = prompt('Kaydedilecek ürün adı:', name);
  if (!name) return;
  name = name.trim();
  if (!name) return;
  var presets = loadPresets();
  presets[name] = collectFormValues();
  savePresets(presets);
  refreshPresetSelect(name);
});
document.getElementById('presetLoadBtn').addEventListener('click', function(){
  var name = document.getElementById('presetSelect').value;
  if (!name) return;
  var presets = loadPresets();
  if (presets[name]) applyFormValues(presets[name]);
});
document.getElementById('presetDeleteBtn').addEventListener('click', function(){
  var name = document.getElementById('presetSelect').value;
  if (!name) return;
  if (!confirm("'" + name + "' kayıtlı ürün silinsin mi?")) return;
  var presets = loadPresets();
  delete presets[name];
  savePresets(presets);
  refreshPresetSelect();
});
refreshPresetSelect();

// ---- Etiket onizlemesi: e-paper_nfc firmware'inin cizim mantiginin
// (LabelSenderApp/label_preview.py) JS'e portu - piksel-birebir degil ama
// yerlesim/kirilma/hizalama davranisi ayni. ----
var FONT8 = [5, 8], FONT12 = [7, 12], FONT16 = [11, 16], FONT20 = [14, 20], FONT24 = [17, 24];
var SCALE = 3, LW = 250, LH = 128;
var BLACK = '#000000', WHITE = '#ffffff';
var TEMPLATE_TICKET = 3, TEMPLATE_BASIC = 4;

function splitTwoLines(text, areaWidth, fontWidth){
  var maxChars = Math.max(1, Math.floor(areaWidth / fontWidth));
  if (text.length * fontWidth <= areaWidth) return [text, ''];
  var words = text.split(' ').filter(function(w){ return w.length > 0; });
  var line1 = '', line2 = '', onLine2 = false;
  for (var i = 0; i < words.length; i++){
    var word = words[i], wlen = word.length;
    if (!onLine2 && line1 === '' && wlen > maxChars){
      line1 = word.slice(0, maxChars);
      line2 = word.slice(maxChars);
      onLine2 = true;
    } else if (!onLine2 && (line1 === '' || line1.length + 1 + wlen <= maxChars)){
      line1 = line1 ? (line1 + ' ' + word) : word;
    } else {
      onLine2 = true;
      if (line2 === '' || line2.length + 1 + wlen <= maxChars) line2 = line2 ? (line2 + ' ' + word) : word;
    }
  }
  return [line1, line2];
}

var ctx = document.getElementById('labelCanvas').getContext('2d');

function rectFill(x0,y0,x1,y1,fill){
  ctx.fillStyle = fill;
  ctx.fillRect(x0*SCALE, y0*SCALE, (x1-x0)*SCALE, (y1-y0)*SCALE);
}
function hline(x0,y,x1,fill){
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1, Math.floor(SCALE/2));
  ctx.beginPath();
  ctx.moveTo(x0*SCALE, y*SCALE);
  ctx.lineTo(x1*SCALE, y*SCALE);
  ctx.stroke();
}
function drawText(x,y,text,fm,fill,bold){
  if (!text) return;
  var fw = fm[0], fh = fm[1];
  var cellW = fw*SCALE;
  ctx.fillStyle = fill;
  ctx.font = (bold ? 'bold ' : '') + Math.round(fh*SCALE*0.8) + 'px Consolas, "Courier New", monospace';
  ctx.textBaseline = 'top';
  for (var i = 0; i < text.length; i++) ctx.fillText(text[i], x*SCALE + i*cellW, y*SCALE);
}
function drawTextCentered(x0,x1,y,text,fm,fill,bold,bg){
  var fw = fm[0], fh = fm[1];
  var textWidth = text.length*fw, boxWidth = x1-x0;
  var x = textWidth < boxWidth ? x0 + Math.floor((boxWidth-textWidth)/2) : x0;
  if (bg) rectFill(x,y,x+textWidth,y+fh,bg);
  drawText(x,y,text,fm,fill,bold);
}

var EAN_L=["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
var EAN_G=["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
var EAN_R=["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
var EAN_FIRST_PARITY=["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function ean13Checksum(digits12){
  var total = 0;
  for (var i = 0; i < digits12.length; i++) total += digits12[i] * ((i % 2 === 0) ? 1 : 3);
  var rem = total % 10;
  return rem === 0 ? 0 : 10 - rem;
}
function drawEan13(x,y,moduleW,height,barcodeStr){
  var s = (barcodeStr || '').slice(0, 12);
  while (s.length < 12) s += '0';
  var digits12 = [];
  for (var i = 0; i < 12; i++) digits12.push(parseInt(s[i], 10) || 0);
  var full = digits12.concat([ean13Checksum(digits12)]);
  var parity = EAN_FIRST_PARITY[full[0]];
  var bits = '101';
  for (i = 0; i < 6; i++) bits += (parity[i] === 'L') ? EAN_L[full[i+1]] : EAN_G[full[i+1]];
  bits += '01010';
  for (i = 0; i < 6; i++) bits += EAN_R[full[i+7]];
  bits += '101';
  var bx = x;
  for (i = 0; i < bits.length; i++){
    if (bits[i] === '1') rectFill(bx,y,bx+moduleW,y+height,BLACK);
    bx += moduleW;
  }
  var text = full.join('');
  var barcodeWidth = 95*moduleW, textWidth = 13*FONT12[0];
  var textX = barcodeWidth > textWidth ? x + Math.floor((barcodeWidth-textWidth)/2) : x;
  drawText(textX, y+height+4, text, FONT12, BLACK);
}

function priceBoxStandartKampanya(x,y,boxW,boxH,d){
  rectFill(x,y,x+boxW,y+boxH,BLACK);
  if (d.discountEnabled && d.oldPrice){
    var oldY = y+4, priceX = x+4;
    if (d.price.indexOf('.') === -1){
      var tw = d.price.length*FONT16[0];
      if (tw < boxW) priceX = x + Math.floor((boxW-tw)/2);
    }
    drawText(x+4, oldY, d.oldPrice, FONT16, WHITE);
    hline(x+3, oldY+8, x+boxW-4, WHITE);
    drawText(priceX, oldY+22, d.price, FONT16, WHITE);
    drawText(x+4, y+boxH-14, d.unit, FONT12, WHITE);
  } else {
    var priceX2 = x+4;
    if (d.price.indexOf('.') === -1){
      var tw2 = d.price.length*FONT20[0];
      if (tw2 < boxW) priceX2 = x + Math.floor((boxW-tw2)/2);
    }
    drawText(priceX2, y+Math.floor(boxH/2)-12, d.price, FONT20, WHITE);
    drawText(x+4, y+boxH-14, d.unit, FONT12, WHITE);
  }
}
function priceBoxTicket(x,y,boxW,boxH,d){
  rectFill(x,y,x+boxW,y+boxH,BLACK);
  if (d.discountEnabled && d.oldPrice){
    var oldY = y+4;
    var priceWidth = d.price.length*FONT16[0];
    var priceX = priceWidth < boxW ? x + Math.floor((boxW-priceWidth)/2) : x+4;
    drawText(x+4, oldY, d.oldPrice, FONT16, WHITE);
    hline(x+3, oldY+8, x+boxW-4, WHITE);
    drawText(priceX, oldY+22, d.price, FONT16, WHITE);
    var unitWidth = d.unit.length*FONT12[0];
    var unitX = unitWidth < boxW ? x + Math.floor((boxW-unitWidth)/2) : x+4;
    drawText(unitX, y+boxH-14, d.unit, FONT12, WHITE);
  } else {
    var priceWidth2 = d.price.length*FONT20[0];
    var priceX2 = priceWidth2 < boxW ? x + Math.floor((boxW-priceWidth2)/2) : x+4;
    var unitWidth2 = d.unit.length*FONT12[0];
    var unitX2 = unitWidth2 < boxW ? x + Math.floor((boxW-unitWidth2)/2) : x+4;
    drawText(priceX2, y+Math.floor(boxH/2)-12, d.price, FONT20, WHITE);
    drawText(unitX2, y+boxH-14, d.unit, FONT12, WHITE);
  }
}
function priceBarBasic(x,y,boxW,boxH,d){
  var priceWidth = d.price.length*FONT24[0];
  var unitWidth = d.unit.length*FONT12[0];
  var totalWidth = priceWidth+6+unitWidth;
  var startX = totalWidth < boxW ? x + Math.floor((boxW-totalWidth)/2) : x+4;
  if (d.discountEnabled && d.oldPrice){
    var oldWidth = d.oldPrice.length*FONT8[0];
    var oldX = oldWidth < boxW ? x + Math.floor((boxW-oldWidth)/2) : x+4;
    var oldY = y+2, priceY = y+8;
    drawText(oldX, oldY, d.oldPrice, FONT8, WHITE);
    hline(oldX-2, oldY+4, oldX+oldWidth+2, WHITE);
    drawText(startX, priceY, d.price, FONT24, WHITE);
    drawText(startX+priceWidth+6, priceY+(FONT24[1]-FONT12[1]), d.unit, FONT12, WHITE);
  } else {
    var priceY2 = y + Math.floor((boxH-FONT24[1])/2) - 4;
    drawText(startX, priceY2, d.price, FONT24, WHITE);
    drawText(startX+priceWidth+6, priceY2+(FONT24[1]-FONT12[1]), d.unit, FONT12, WHITE);
  }
}
function priceBoxStandart(x,y,boxW,boxH,d){
  rectFill(x,y,x+boxW,y+boxH,BLACK);
  if (d.discountEnabled && d.oldPrice){
    var oldY = y+4;
    var priceFont = FONT20;
    var tw = d.price.length*priceFont[0];
    if (tw >= boxW){ priceFont = FONT16; tw = d.price.length*priceFont[0]; }
    var priceX = tw < boxW ? x + Math.floor((boxW-tw)/2) : x+4;
    drawText(x+4, oldY, d.oldPrice, FONT16, WHITE);
    hline(x+3, oldY+9, x+boxW-4, WHITE);
    drawText(priceX, oldY+24, d.price, priceFont, WHITE);
    drawText(x+4, y+boxH-16, d.unit, FONT12, WHITE);
  } else {
    var priceX2 = x+4, priceFont2, priceY, tw2;
    if (d.price.indexOf('.') === -1){
      priceFont2 = FONT24; priceY = y+Math.floor(boxH/2)-18; tw2 = d.price.length*FONT24[0];
    } else {
      priceFont2 = FONT20; priceY = y+Math.floor(boxH/2)-15; tw2 = d.price.length*FONT20[0];
      if (tw2 >= boxW){ priceFont2 = FONT16; priceY = y+Math.floor(boxH/2)-12; tw2 = d.price.length*FONT16[0]; }
    }
    if (tw2 < boxW) priceX2 = x + Math.floor((boxW-tw2)/2);
    drawText(priceX2, priceY, d.price, priceFont2, WHITE);
    drawText(x+4, y+boxH-16, d.unit, FONT12, WHITE);
  }
}

function drawTicket(d){
  var hasSubtitle = !!d.subtitle;
  var gapToProduct = 16;
  var productFont = FONT20;
  var parts = splitTwoLines(d.name, 242, productFont[0]);
  var line1 = parts[0], line2 = parts[1];
  var prodLines = line2 ? 2 : 1;
  var contentH = gapToProduct + prodLines*productFont[1] + (hasSubtitle ? productFont[1] : 0);
  if (contentH > 50){
    productFont = FONT16;
    parts = splitTwoLines(d.name, 242, productFont[0]); line1 = parts[0]; line2 = parts[1];
    prodLines = line2 ? 2 : 1;
    contentH = gapToProduct + prodLines*productFont[1] + (hasSubtitle ? productFont[1] : 0);
    if (contentH > 50){
      productFont = FONT12;
      parts = splitTwoLines(d.name, 242, productFont[0]); line1 = parts[0]; line2 = parts[1];
      prodLines = line2 ? 2 : 1;
      contentH = gapToProduct + prodLines*productFont[1] + (hasSubtitle ? productFont[1] : 0);
    }
  }
  var topMargin = contentH < 50 ? Math.floor((50-contentH)/2) : 0;
  var businessY = topMargin;
  var productY = businessY + gapToProduct;

  drawTextCentered(4,246,businessY,d.business,FONT16,BLACK,true);
  drawTextCentered(4,246,productY,line1,productFont,BLACK,true);
  if (prodLines === 2) drawTextCentered(4,246,productY+productFont[1],line2,productFont,BLACK,true);
  if (hasSubtitle) drawTextCentered(4,246,productY+prodLines*productFont[1],d.subtitle,productFont,BLACK);

  priceBoxTicket(4,50,242,38,d);
  drawTextCentered(4,242,80,d.bottomCode,FONT8,BLACK,false,WHITE);
  drawEan13(20,90,2,12,d.barcode);
}
function drawBasic(d){
  rectFill(0,0,LW,LH,BLACK);
  var hasSubtitle = !!d.subtitle;
  var gap = 4;
  var productFont = FONT20;
  var parts = splitTwoLines(d.name, 250, productFont[0]);
  var line1 = parts[0], line2 = parts[1];
  var prodLines = line2 ? 2 : 1;
  var productLineH = productFont[1]+2;
  var contentH = FONT20[1]+gap+prodLines*productLineH+(hasSubtitle ? gap+productFont[1] : 0);
  var fallbacks = [FONT16, FONT12];
  for (var i = 0; i < fallbacks.length; i++){
    if (contentH <= 68) break;
    productFont = fallbacks[i];
    parts = splitTwoLines(d.name, 250, productFont[0]); line1 = parts[0]; line2 = parts[1];
    prodLines = line2 ? 2 : 1;
    productLineH = productFont[1]+2;
    contentH = FONT20[1]+gap+prodLines*productLineH+(hasSubtitle ? gap+productFont[1] : 0);
  }
  var topMargin = contentH < 68 ? Math.floor((68-contentH)/2) : 0;
  var businessY = topMargin;
  var productY = businessY + FONT20[1] + gap;

  drawTextCentered(0,250,businessY,d.business,FONT20,WHITE,true);
  drawTextCentered(0,250,productY,line1,productFont,WHITE,true);
  if (prodLines === 2) drawTextCentered(0,250,productY+productLineH,line2,productFont,WHITE,true);
  if (hasSubtitle) drawTextCentered(0,250,productY+prodLines*productLineH+gap,d.subtitle,productFont,WHITE);

  drawTextCentered(4,242,70,d.bottomCode,FONT12,WHITE);
  priceBarBasic(0,90,250,38,d);
}
function drawStandartKampanya(d){
  drawTextCentered(4,160,4,d.business,FONT16,BLACK,true);
  hline(4,21,164,BLACK);
  drawTextCentered(4,160,25,d.name,FONT16,BLACK,true);
  priceBoxStandartKampanya(170,4,76,70,d);
  rectFill(4,60,246,78,BLACK);
  drawTextCentered(4,246,63,'KAMPANYA',FONT12,WHITE);
  drawEan13(25,86,2,20,d.barcode);
}
function drawStandart(d){
  var productFont = FONT16;
  var hasSubtitle = !!d.subtitle;
  var gapToProduct = 21, gapToSubtitle = 3;
  var parts = splitTwoLines(d.name, 164, productFont[0]);
  var line1 = parts[0], line2 = parts[1];
  var prodLines = line2 ? 2 : 1;
  var productLineH = productFont[1]+2;
  var contentH = gapToProduct + prodLines*productLineH + (hasSubtitle ? gapToSubtitle+productFont[1] : 0);
  if (contentH > 76){
    productFont = FONT12;
    parts = splitTwoLines(d.name, 164, productFont[0]); line1 = parts[0]; line2 = parts[1];
    prodLines = line2 ? 2 : 1;
    productLineH = productFont[1]+2;
    contentH = gapToProduct + prodLines*productLineH + (hasSubtitle ? gapToSubtitle+productFont[1] : 0);
  }
  var topMargin = contentH < 76 ? Math.floor((76-contentH)/2) : 0;
  var businessY = topMargin;
  var dividerY = businessY + 17;
  var productY = businessY + gapToProduct;

  drawTextCentered(0,164,businessY,d.business,FONT16,BLACK,true);
  hline(0,dividerY,164,BLACK);
  drawTextCentered(0,164,productY,line1,productFont,BLACK,true);
  if (prodLines === 2) drawTextCentered(0,164,productY+productLineH,line2,productFont,BLACK,true);
  if (hasSubtitle) drawTextCentered(0,164,productY+prodLines*productLineH+gapToSubtitle,d.subtitle,productFont,BLACK);

  priceBoxStandart(166,0,84,76,d);
  hline(4,76,246,BLACK);
  drawTextCentered(4,246,77,d.bottomCode,FONT8,BLACK);
  drawEan13(25,86,2,20,d.barcode);
}

function renderPreview(){
  var d = collectFormValues();
  d.templateID = parseInt(d.templateID, 10) || 1;
  rectFill(0,0,LW,LH,WHITE);
  if (d.templateID === TEMPLATE_TICKET) drawTicket(d);
  else if (d.templateID === TEMPLATE_BASIC) drawBasic(d);
  else if (d.campaignEnabled) drawStandartKampanya(d);
  else drawStandart(d);
}
var renderPending = false;
function scheduleRender(){
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(function(){ renderPending = false; renderPreview(); });
}
document.getElementById('f').addEventListener('input', scheduleRender);
document.getElementById('f').addEventListener('change', scheduleRender);
renderPreview();

// ---- Gonderim ----
document.getElementById('f').addEventListener('submit', function(e){
  e.preventDefault();
  var res = document.getElementById('result');
  res.className = ''; res.style.display = 'block'; res.textContent = 'Gönderiliyor...';
  var body = new URLSearchParams(new FormData(e.target));
  var okStatus = false;
  fetch('/send', {method:'POST', body: body})
    .then(function(r){ okStatus = r.ok; return r.text(); })
    .then(function(txt){
      res.className = okStatus ? 'ok' : 'err';
      res.textContent = txt;
    })
    .catch(function(err){
      res.className = 'err';
      res.textContent = 'İstek başarısız: ' + err;
    });
});

// ---- Toplu guncelleme (Excel sablonu indir / yukle / sirayla gonder) ----
var BULK_HEADERS = ['Hedef Ekran','Şablon','İndirim','Kampanya','İşletme Adı','Ürün Adı','Alt Başlık','Fiyat','Eski Fiyat','Birim','Alt Kod','Barkod'];
var BULK_EXAMPLE_ROWS = [
  ['ESA','Standart','Hayır','Hayır','Cemil Market','Süt 1L','Yerli Üretim','24.90','','TL','',''],
  ['ESB','Ticket','Evet','Hayır','Cemil Market','Beyaz Peynir 500g','','45','60','TL','','8690000000127']
];

function requireXlsx(){
  if (typeof XLSX === 'undefined'){
    alert('Excel kütüphanesi yüklenemedi. Bu özellik için cihazınızın internete de bağlı olması gerekir.');
    return false;
  }
  return true;
}

document.getElementById('downloadTemplateBtn').addEventListener('click', function(){
  if (!requireXlsx()) return;
  var rows = [BULK_HEADERS].concat(BULK_EXAMPLE_ROWS);
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = BULK_HEADERS.map(function(h){ return {wch: Math.max(14, h.length + 2)}; });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Etiketler');
  XLSX.writeFile(wb, 'etiket_sablonu.xlsx');
});

function bulkGetField(row, names){
  var keys = Object.keys(row);
  for (var i = 0; i < names.length; i++){
    for (var j = 0; j < keys.length; j++){
      if (keys[j].trim().toLowerCase() === names[i].toLowerCase()) {
        return String(row[keys[j]] === undefined ? '' : row[keys[j]]).trim();
      }
    }
  }
  return '';
}
function bulkYesNo(v){
  v = (v || '').toLowerCase();
  return v === 'evet' || v === 'yes' || v === '1' || v === 'true' || v === 'doğru';
}
function normalizeBulkRow(row){
  var board = bulkGetField(row, ['Hedef Ekran','board','ekran']).toUpperCase();
  var templateText = bulkGetField(row, ['Şablon','Sablon','template']).toLowerCase();
  var templateID = '1';
  if (templateText.indexOf('ticket') !== -1) templateID = '3';
  else if (templateText.indexOf('basic') !== -1) templateID = '4';
  return {
    board: board === 'ESB' ? 'ESB' : 'ESA',
    templateID: templateID,
    discountEnabled: bulkYesNo(bulkGetField(row, ['İndirim','Indirim','discount'])),
    campaignEnabled: bulkYesNo(bulkGetField(row, ['Kampanya','campaign'])),
    business: bulkGetField(row, ['İşletme Adı','Isletme Adi','business']),
    name: bulkGetField(row, ['Ürün Adı','Urun Adi','product','name']),
    subtitle: bulkGetField(row, ['Alt Başlık','Alt Baslik','subtitle']),
    price: bulkGetField(row, ['Fiyat','price']),
    oldPrice: bulkGetField(row, ['Eski Fiyat','Eski fiyat','oldPrice']),
    unit: bulkGetField(row, ['Birim','unit']),
    bottomCode: bulkGetField(row, ['Alt Kod','bottomCode']),
    barcode: bulkGetField(row, ['Barkod','barcode'])
  };
}

var bulkRows = [];

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderBulkTable(){
  var wrap = document.getElementById('bulkTableWrap');
  var tbody = document.querySelector('#bulkTable tbody');
  tbody.innerHTML = '';
  bulkRows.forEach(function(r, idx){
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + escapeHtml(r.board) + '</td>' +
      '<td>' + escapeHtml(r.templateID === '3' ? 'Ticket' : (r.templateID === '4' ? 'Basic' : 'Standart')) + '</td>' +
      '<td>' + escapeHtml(r.business) + '</td>' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td>' + escapeHtml(r.price) + '</td>' +
      '<td class="bulk-status">Bekliyor</td>';
    tbody.appendChild(tr);
  });
  wrap.style.display = bulkRows.length ? 'block' : 'none';
  document.getElementById('bulkLog').textContent = bulkRows.length
    ? (bulkRows.length + ' satır okundu, kontrol edip "Toplu Gönder" ile devam edin.')
    : 'Dosyada geçerli satır bulunamadı (İşletme Adı veya Ürün Adı dolu en az bir satır olmalı).';
}

document.getElementById('parseExcelBtn').addEventListener('click', function(){
  if (!requireXlsx()) return;
  var fileInput = document.getElementById('excelFileInput');
  if (!fileInput.files || fileInput.files.length === 0){
    alert('Önce bir Excel (.xlsx) veya CSV dosyası seçin.');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e){
    try {
      var data = new Uint8Array(e.target.result);
      var wb = XLSX.read(data, {type:'array'});
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rawRows = XLSX.utils.sheet_to_json(ws, {defval:''});
      bulkRows = rawRows.map(normalizeBulkRow).filter(function(r){ return r.business || r.name; });
      renderBulkTable();
    } catch (err) {
      alert('Dosya okunamadı: ' + err);
    }
  };
  reader.readAsArrayBuffer(fileInput.files[0]);
});

// Toplu gonderimde MAX_RT hatasi (etiket onceki veriyi/ekrani islerken meşgul
// oldugu icin) tekli gonderimden farkli olarak burada satir bazinda otomatik
// yeniden deneniyor - tekli gonderim yolunu (handleSend / nrf_gateway.cpp)
// etkilemez, sadece bu toplu akista devreye girer.
var BULK_MAX_RETRIES = 2;       // ilk denemeden sonra en fazla kac kez daha denensin
var BULK_RETRY_DELAY_MS = 5000; // yeniden denemeler arasi sabit bekleme

function sendBulkRow(body){
  return fetch('/send', {method:'POST', body: body}).then(function(resp){
    return resp.text().then(function(txt){ return {ok: resp.ok, txt: txt}; });
  });
}

async function sendBulkSequential(){
  var statusCells = document.querySelectorAll('#bulkTable tbody tr .bulk-status');
  for (var i = 0; i < bulkRows.length; i++){
    var r = bulkRows[i];
    var body = new URLSearchParams();
    body.set('board', r.board);
    body.set('templateID', r.templateID);
    if (r.discountEnabled) body.set('discountEnabled', '1');
    if (r.campaignEnabled) body.set('campaignEnabled', '1');
    body.set('business', r.business);
    body.set('name', r.name);
    body.set('subtitle', r.subtitle);
    body.set('price', r.price);
    body.set('oldPrice', r.oldPrice);
    body.set('unit', r.unit);
    body.set('bottomCode', r.bottomCode);
    body.set('barcode', r.barcode);

    var attempt = 0;
    var result = null;
    while (attempt <= BULK_MAX_RETRIES) {
      statusCells[i].textContent = attempt === 0 ? 'Gönderiliyor...' : ('Tekrar deneniyor (' + attempt + '/' + BULK_MAX_RETRIES + ')...');
      statusCells[i].className = 'bulk-status';
      try {
        result = await sendBulkRow(body);
      } catch (err) {
        result = {ok: false, txt: 'HATA: ' + err};
      }
      if (result.ok) break;
      attempt++;
      if (attempt <= BULK_MAX_RETRIES) {
        await new Promise(function(resolve){ setTimeout(resolve, BULK_RETRY_DELAY_MS); });
      }
    }
    statusCells[i].textContent = result.txt;
    statusCells[i].className = 'bulk-status ' + (result.ok ? 'ok' : 'err');

    await new Promise(function(resolve){ setTimeout(resolve, 250); });
  }
  document.getElementById('bulkLog').textContent = 'Toplu gönderim tamamlandı (' + bulkRows.length + ' satır).';
}
document.getElementById('bulkSendBtn').addEventListener('click', function(){
  var btn = document.getElementById('bulkSendBtn');
  btn.disabled = true;
  sendBulkSequential().then(function(){ btn.disabled = false; });
});
</script>
</body></html>
)HTML";

// ---- WiFi kurulum sihirbazi sayfasi (/wifi) ----
static const char LOGIN_PAGE[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giris Yap</title>
<style>
:root{
  --red:#d62828; --red-dark:#b71c1c; --red-darker:#8e0000;
  --bg:#fff2f2; --card:#ffffff; --border:#e0b3b3;
  --text:#2b2b2b; --muted:#7f8c8d;
}
*{box-sizing:border-box;}
body{
  font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg); color:var(--text); margin:0; padding:0;
  display:flex; align-items:center; justify-content:center; min-height:100vh;
}
.card{background:var(--card); border:2px solid var(--red); border-radius:10px; padding:28px 26px; width:100%; max-width:340px;}
.card h1{color:var(--red-dark); font-size:18px; margin:0 0 4px;}
.card p.hint{color:var(--muted); font-size:12px; margin:0 0 18px;}
label{display:block; font-size:13px; font-weight:600; margin:12px 0 5px;}
input[type=text],input[type=password]{
  width:100%; padding:9px 10px; border:1px solid var(--border); border-radius:6px; font-size:14px;
}
button{
  width:100%; margin-top:18px; padding:10px; background:var(--red); color:#fff; border:none;
  border-radius:6px; font-size:14px; font-weight:700; cursor:pointer;
}
button:hover{background:var(--red-dark);}
</style></head><body>
<form class="card" method="POST" action="/login">
  <h1>&#127991;&#65039; E-Paper Raf Etiketleri</h1>
  <p class="hint">Devam etmek icin giris yapin.</p>
  <label for="username">Kullanici Adi</label>
  <input type="text" id="username" name="username" autocomplete="username" required>
  <label for="password">Sifre</label>
  <input type="password" id="password" name="password" autocomplete="current-password" required>
  <button type="submit">Giris Yap</button>
</form>
</body></html>
)HTML";

static const char ADMIN_USERS_TOP[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kullanici Yonetimi</title>
<style>
:root{
  --red:#d62828; --red-dark:#b71c1c; --red-darker:#8e0000;
  --bg:#fff2f2; --card:#ffffff; --border:#e0b3b3;
  --text:#2b2b2b; --muted:#7f8c8d;
}
*{box-sizing:border-box;}
body{
  font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg); color:var(--text); margin:0; padding:0 0 40px;
}
.banner{background:var(--red); padding:16px 20px; display:flex; align-items:center; gap:14px;}
.banner .tag{font-size:30px;}
.banner h1{color:#fff; font-size:20px; margin:0;}
.banner p{color:#ffe1e1; font-size:12px; margin:2px 0 0;}
.wifi-link{margin-left:auto; background:rgba(255,255,255,.18); color:#fff; padding:7px 14px; border-radius:20px; font-size:12px; text-decoration:none; white-space:nowrap; font-weight:600;}
.wifi-link:hover{background:rgba(255,255,255,.3);}
.wrap{max-width:640px; margin:20px auto; padding:0 16px;}
.card{background:var(--card); border:2px solid var(--red); border-radius:10px; padding:16px 18px 20px; margin-bottom:16px;}
.card h2{color:var(--red-dark); font-size:14px; text-transform:uppercase; letter-spacing:.03em; margin:0 0 12px;}
table{width:100%; border-collapse:collapse; font-size:13px;}
th{background:var(--red); color:#fff; text-align:left; padding:8px 10px;}
td{padding:7px 10px; border-bottom:1px solid var(--border); vertical-align:middle;}
tr:nth-child(even){background:#fff8f8;}
.role-admin{color:var(--red-dark); font-weight:700;}
.role-user{color:var(--muted);}
form.inline{display:inline;}
.btn-sm{padding:5px 10px; font-size:12px; border:none; border-radius:5px; cursor:pointer; color:#fff;}
.btn-del{background:var(--red-darker);}
.btn-reset{background:#555;}
label{display:block; font-size:13px; font-weight:600; margin:12px 0 5px;}
input[type=text],input[type=password],select{
  width:100%; padding:9px 10px; border:1px solid var(--border); border-radius:6px; font-size:14px;
}
button.btn-primary{
  width:100%; margin-top:18px; padding:10px; background:var(--red); color:#fff; border:none;
  border-radius:6px; font-size:14px; font-weight:700; cursor:pointer;
}
button.btn-primary:hover{background:var(--red-dark);}
.pw-row{display:flex; gap:6px; align-items:center;}
.pw-row input{width:120px; padding:5px 7px; font-size:12px;}
</style></head><body>
<div class="banner">
  <span class="tag">&#128101;</span>
  <div>
    <h1>Kullanici Yonetimi</h1>
    <p>Admin ve kullanici hesaplarini buradan yonetin.</p>
  </div>
  <a href="/" class="wifi-link">&#8592; Ana Sayfa</a>
  <a href="/logout" class="wifi-link">&#128274; Cikis</a>
</div>
<div class="wrap">
<div class="card">
<h2>Mevcut Kullanicilar</h2>
<table><thead><tr><th>Kullanici Adi</th><th>Rol</th><th>Sifre Sifirla</th><th></th></tr></thead><tbody>
)HTML";

static const char ADMIN_USERS_BOTTOM[] PROGMEM = R"HTML(
</tbody></table>
</div>
<div class="card">
<h2>Yeni Kullanici Ekle</h2>
<form method="POST" action="/admin/users/add">
  <label for="newUsername">Kullanici Adi</label>
  <input type="text" id="newUsername" name="username" required>
  <label for="newPassword">Sifre</label>
  <input type="password" id="newPassword" name="password" required>
  <label for="newRole">Rol</label>
  <select id="newRole" name="role">
    <option value="user">Kullanici (sadece etiket gonderme)</option>
    <option value="admin">Admin (her sey + kullanici yonetimi)</option>
  </select>
  <button type="submit" class="btn-primary">Kullanici Ekle</button>
</form>
</div>
</div>
</body></html>
)HTML";

static const char WIFI_PAGE[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WiFi Kurulum Sihirbaz&#305;</title>
<style>
:root{
  --red:#d62828; --red-dark:#b71c1c; --red-darker:#8e0000;
  --bg:#fff2f2; --card:#ffffff; --border:#e0b3b3;
  --text:#2b2b2b; --muted:#7f8c8d;
}
*{box-sizing:border-box;}
body{
  font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg); color:var(--text); margin:0; padding:0 0 40px;
}
.banner{background:var(--red); padding:16px 20px; display:flex; align-items:center; gap:14px;}
.banner .tag{font-size:30px;}
.banner h1{color:#fff; font-size:20px; margin:0;}
.banner p{color:#ffe1e1; font-size:12px; margin:2px 0 0;}
.wrap{max-width:640px; margin:20px auto; padding:0 16px;}
.card{background:var(--card); border:2px solid var(--red); border-radius:10px; padding:16px 18px 20px; margin-bottom:16px;}
.card h2{color:var(--red-dark); font-size:14px; text-transform:uppercase; letter-spacing:.03em; margin:0 0 12px;}
.steps{margin:0; padding-left:20px; font-size:14px; line-height:1.6;}
.steps li{margin-bottom:8px;}
.hint{color:var(--muted); font-size:13px;}
#currentStatus{font-size:13px; margin:0 0 12px; padding:8px 10px; background:#fff8f8; border:1px solid var(--border); border-radius:6px;}
.row{display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;}
.network-list{max-height:220px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; margin-bottom:16px;}
.network-item{display:flex; justify-content:space-between; gap:10px; padding:9px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);}
.network-item:last-child{border-bottom:none;}
.network-item:hover{background:#ffe6e6;}
.network-item .rssi{color:var(--muted); white-space:nowrap;}
.field{margin-bottom:12px;}
.field label{display:block; font-weight:600; font-size:13px; margin-bottom:4px;}
input{width:100%; padding:8px; font-size:14px; border:1px solid var(--border); border-radius:5px; box-sizing:border-box;}
input:focus{outline:none; border:2px solid var(--red); padding:7px;}
.btn-primary,.btn-ghost{border:none; border-radius:6px; padding:10px 20px; font-weight:700; font-size:14px; cursor:pointer;}
.btn-primary{background:var(--red); color:#fff; width:100%;}
.btn-primary:hover{background:var(--red-dark);}
.btn-ghost{background:#fff; color:var(--red-dark); border:1px solid var(--red);}
.btn-ghost:hover{background:#ffe6e6;}
#wifiResult{margin-top:12px; padding:12px; border-radius:8px; font-size:13px; display:none; white-space:pre-wrap;}
#wifiResult.ok{display:block; background:#d4edda; color:#155724; border:1px solid #b7e0c2;}
#wifiResult.err{display:block; background:#f8d7da; color:#7a1c25; border:1px solid #edb9bf;}
.back-link{text-align:center; font-size:13px;}
.back-link a{color:var(--red-dark); text-decoration:none; font-weight:600;}
</style></head><body>
<div class="banner">
  <span class="tag">&#128246;</span>
  <div>
    <h1>WiFi Kurulum Sihirbaz&#305; <span id="deviceIdBadge" style="opacity:.7; font-size:13px; font-weight:400;"></span></h1>
    <p>ESP32 Etiket A&#287; Ge&ccedil;idi</p>
  </div>
</div>
<div class="wrap">
  <section class="card">
    <h2>Nas&#305;l &Ccedil;al&#305;&#351;&#305;r?</h2>
    <ol class="steps">
      <li>Cihaz yeni bir yere ta&#351;&#305;nd&#305;&#287;&#305;nda veya ba&#287;lanamad&#305;&#287;&#305;nda kendi <b>ESP32-NRF-Gateway</b> a&#287;&#305;n&#305; yay&#305;nlar (&#351;ifre: <b>12345678</b>). Bu sayfay&#305; g&ouml;r&uuml;yorsan&#305;z do&#287;ru yerdesiniz.</li>
      <li>A&#351;a&#287;&#305;daki listeden kendi ev/i&#351;yeri WiFi a&#287;&#305;n&#305;z&#305; se&#231;in (ya da elle yaz&#305;n).</li>
      <li>&#350;ifrenizi girin ve <b>"Kaydet ve Yeniden Ba&#351;lat"</b> butonuna bas&#305;n.</li>
      <li>Cihaz birka&#231; saniye i&ccedil;inde yeniden ba&#351;lay&#305;p se&ccedil;ti&#287;iniz a&#287;a otomatik ba&#287;lanacak. Bu sayfaya ve etiket g&ouml;nderim sayfas&#305;na art&#305;k o a&#287; &uuml;zerinden eri&#351;ebilirsiniz.</li>
    </ol>
  </section>

  <section class="card">
    <h2>WiFi A&#287;&#305; Se&ccedil;</h2>
    <p id="currentStatus">Durum al&#305;n&#305;yor...</p>
    <div class="row">
      <button type="button" class="btn-ghost" id="scanBtn">&#128260; A&#287;lar&#305; Tara</button>
      <span id="scanStatus" class="hint"></span>
    </div>
    <div id="networkList" class="network-list"></div>

    <form id="wifiForm">
      <div class="field">
        <label>A&#287; Ad&#305; (SSID)</label>
        <input name="ssid" id="ssidInput" autocomplete="off" required>
      </div>
      <div class="field">
        <label>&#350;ifre</label>
        <input name="password" id="passInput" type="password" autocomplete="off">
      </div>
      <button type="submit" class="btn-primary">&#128190; Kaydet ve Yeniden Ba&#351;lat</button>
    </form>
    <div id="wifiResult"></div>
  </section>

  <p class="back-link"><a href="/">&larr; Etiket sayfas&#305;na d&ouml;n</a></p>
</div>

<script>
function escapeHtmlW(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

fetch('/wifi/status').then(function(r){ return r.json(); }).then(function(s){
  if (s.id) document.getElementById('deviceIdBadge').textContent = '#' + s.id;
  var el = document.getElementById('currentStatus');
  if (s.mode === 'ap') {
    el.textContent = '⚠️ Kurulum modunda: cihaz kendi "' + s.ssid + '" ağını yayınlıyor (' + s.ip + ').';
  } else {
    el.textContent = '✅ Şu an bağlı: ' + s.ssid + ' (' + s.ip + ')';
  }
}).catch(function(){
  document.getElementById('currentStatus').textContent = 'Durum alınamadı.';
});

function scanNetworks(){
  var status = document.getElementById('scanStatus');
  var list = document.getElementById('networkList');
  status.textContent = 'Taranıyor...';
  list.innerHTML = '';
  fetch('/wifi/scan').then(function(r){ return r.json(); }).then(function(networks){
    status.textContent = networks.length + ' ağ bulundu (sinyale göre sıralı).';
    networks.sort(function(a,b){ return b.rssi - a.rssi; });
    networks.forEach(function(n){
      var div = document.createElement('div');
      div.className = 'network-item';
      div.innerHTML =
        '<span>' + (n.secure ? '&#128274; ' : '') + escapeHtmlW(n.ssid) + '</span>' +
        '<span class="rssi">' + n.rssi + ' dBm</span>';
      div.addEventListener('click', function(){
        document.getElementById('ssidInput').value = n.ssid;
        document.getElementById('passInput').focus();
      });
      list.appendChild(div);
    });
  }).catch(function(err){
    status.textContent = 'Tarama başarısız: ' + err;
  });
}
document.getElementById('scanBtn').addEventListener('click', scanNetworks);
scanNetworks();

document.getElementById('wifiForm').addEventListener('submit', function(e){
  e.preventDefault();
  var res = document.getElementById('wifiResult');
  res.className = ''; res.style.display = 'block'; res.textContent = 'Kaydediliyor...';
  var body = new URLSearchParams(new FormData(e.target));
  var okStatus = false;
  fetch('/wifi/save', {method:'POST', body: body})
    .then(function(r){ okStatus = r.ok; return r.text(); })
    .then(function(txt){
      res.className = okStatus ? 'ok' : 'err';
      res.textContent = txt;
    })
    .catch(function(err){
      res.className = 'err';
      res.textContent = 'İstek başarısız: ' + err;
    });
});
</script>
</body></html>
)HTML";

String jsonEscape(const String &s) {
    String out;
    out.reserve(s.length() + 4);
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

String buildNavLinks(uint8_t role) {
    String nav;
    if (role == ROLE_ADMIN) {
        nav += "<a href=\"/wifi\" class=\"wifi-link\">&#128246; WiFi Ayarlari</a>";
        nav += "<a href=\"/admin/users\" class=\"wifi-link\">&#128101; Kullanicilar</a>";
    }
    nav += "<a href=\"/logout\" class=\"wifi-link\">&#128274; Cikis</a>";
    return nav;
}

void handleRoot() {
    if (!requireAuth(ROLE_USER)) return;
    String page = String(PAGE_HEADER) + buildNavLinks(g_reqRole) + "</div>" + String(PAGE_FORM);
    server.send(200, "text/html; charset=utf-8", page);
}

void handleWifiPage() {
    if (!requireAuthOrApMode(ROLE_ADMIN)) return;
    server.send(200, "text/html; charset=utf-8", WIFI_PAGE);
}

void handleWifiStatus() {
    if (!requireAuthOrApMode(ROLE_ADMIN)) return;
    String json = "{";
    json += "\"id\":\"" + uniqueSuffix + "\",";
    if (apMode) {
        json += "\"mode\":\"ap\",";
        json += "\"ssid\":\"" + jsonEscape(apSsidFull) + "\",";
        json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\"";
    } else {
        json += "\"mode\":\"sta\",";
        json += "\"ssid\":\"" + jsonEscape(WiFi.SSID()) + "\",";
        json += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
    }
    json += "}";
    server.send(200, "application/json; charset=utf-8", json);
}

void handleWifiScan() {
    if (!requireAuthOrApMode(ROLE_ADMIN)) return;
    int n = WiFi.scanNetworks();
    String json = "[";
    for (int i = 0; i < n; i++) {
        if (i > 0) json += ",";
        json += "{\"ssid\":\"" + jsonEscape(WiFi.SSID(i)) + "\"";
        json += ",\"rssi\":" + String(WiFi.RSSI(i));
        json += ",\"secure\":";
        json += (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "false" : "true";
        json += "}";
    }
    json += "]";
    server.send(200, "application/json; charset=utf-8", json);
}

void handleWifiSave() {
    if (!requireAuthOrApMode(ROLE_ADMIN)) return;
    String ssid = server.arg("ssid");
    String pass = server.arg("password");

    if (ssid.length() == 0) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Ag adi (SSID) bos olamaz.");
        return;
    }

    saveWifiCreds(ssid, pass);
    Serial.print("WiFi bilgileri NVS'ye kaydedildi, yeni ag: ");
    Serial.println(ssid);

    server.send(200, "text/plain; charset=utf-8",
        "WiFi bilgileriniz kaydedildi. Cihaz birazdan yeniden baslayip '" + ssid + "' agina baglanmayi deneyecek.");

    // Yanitin tarayiciya ulasmasi icin restart'i biraz erteliyoruz (loop() icinde yapilir).
    restartAtMillis = millis() + 1500;
}

void handleCaptiveRedirect() {
    server.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/wifi", true);
    server.send(302, "text/plain", "");
}

// ---- Giris / kullanici yonetimi sayfalari ----

String htmlEscape(const String &s) {
    String out;
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '&') out += "&amp;";
        else if (c == '<') out += "&lt;";
        else if (c == '>') out += "&gt;";
        else if (c == '"') out += "&quot;";
        else out += c;
    }
    return out;
}

void sendSessionCookie(const String &token) {
    server.sendHeader("Set-Cookie",
        String(SESSION_COOKIE_NAME) + "=" + token + "; Path=/; HttpOnly", true);
}

void handleLoginPage() {
    String username; uint8_t role;
    if (getSessionFromRequest(username, role)) {
        server.sendHeader("Location", "/", true);
        server.send(302, "text/plain", "");
        return;
    }
    server.send(200, "text/html; charset=utf-8", LOGIN_PAGE);
}

void handleLoginSubmit() {
    String username = server.arg("username");
    String password = server.arg("password");
    uint8_t role;
    if (!verifyUser(username, password, role)) {
        server.send(401, "text/html; charset=utf-8",
            "<p style=\"font-family:sans-serif\">HATA: Hatali kullanici adi veya sifre. "
            "<a href=\"/login\">Tekrar dene</a></p>");
        return;
    }
    String token = createSession(username, role);
    sendSessionCookie(token);
    server.sendHeader("Location", "/", true);
    server.send(302, "text/plain", "");
}

void handleLogout() {
    if (server.hasHeader("Cookie")) {
        String token = extractCookieValue(server.header("Cookie"), SESSION_COOKIE_NAME);
        if (token.length() > 0) destroySession(token);
    }
    server.sendHeader("Set-Cookie", String(SESSION_COOKIE_NAME) + "=; Path=/; HttpOnly; Max-Age=0", true);
    server.sendHeader("Location", "/login", true);
    server.send(302, "text/plain", "");
}

void redirectToAdminUsers() {
    server.sendHeader("Location", "/admin/users", true);
    server.send(302, "text/plain", "");
}

void handleAdminUsersPage() {
    if (!requireAuth(ROLE_ADMIN)) return;

    String rows;
    userPrefs.begin("users", true);
    uint8_t count = userPrefs.getUChar("count", 0);
    for (uint8_t i = 0; i < count; i++) {
        String u = userPrefs.getString(("u" + String(i)).c_str(), "");
        uint8_t r = userPrefs.getUChar(("r" + String(i)).c_str(), ROLE_USER);
        String uEsc = htmlEscape(u);
        rows += "<tr><td>" + uEsc + "</td>";
        rows += r == ROLE_ADMIN ? "<td class=\"role-admin\">Admin</td>" : "<td class=\"role-user\">Kullanici</td>";
        rows += "<td><form class=\"inline pw-row\" method=\"POST\" action=\"/admin/users/reset-password\">"
                "<input type=\"hidden\" name=\"username\" value=\"" + uEsc + "\">"
                "<input type=\"password\" name=\"password\" placeholder=\"yeni sifre\" required>"
                "<button type=\"submit\" class=\"btn-sm btn-reset\">Sifirla</button></form></td>";
        rows += "<td><form class=\"inline\" method=\"POST\" action=\"/admin/users/delete\" "
                "onsubmit=\"return confirm('" + uEsc + " silinsin mi?');\">"
                "<input type=\"hidden\" name=\"username\" value=\"" + uEsc + "\">"
                "<button type=\"submit\" class=\"btn-sm btn-del\">Sil</button></form></td></tr>";
    }
    userPrefs.end();

    String page = String(ADMIN_USERS_TOP) + rows + String(ADMIN_USERS_BOTTOM);
    server.send(200, "text/html; charset=utf-8", page);
}

void handleAdminUserAdd() {
    if (!requireAuth(ROLE_ADMIN)) return;
    String username = server.arg("username");
    String password = server.arg("password");
    uint8_t role = (server.arg("role") == "admin") ? ROLE_ADMIN : ROLE_USER;

    uint8_t existingIdx;
    if (username.length() == 0 || password.length() == 0) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Kullanici adi ve sifre bos olamaz.");
        return;
    }
    if (findUserIndex(username, existingIdx)) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Bu kullanici adi zaten kayitli.");
        return;
    }
    if (countUsers() >= MAX_USERS) {
        server.send(400, "text/plain; charset=utf-8", "HATA: En fazla " + String(MAX_USERS) + " kullanici olabilir.");
        return;
    }
    createUser(username, password, role);
    redirectToAdminUsers();
}

void handleAdminUserDelete() {
    if (!requireAuth(ROLE_ADMIN)) return;
    String username = server.arg("username");

    if (username == g_reqUsername) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Kendi hesabinizi silemezsiniz.");
        return;
    }
    uint8_t idx;
    if (!findUserIndex(username, idx)) {
        server.send(404, "text/plain; charset=utf-8", "HATA: Kullanici bulunamadi.");
        return;
    }
    userPrefs.begin("users", true);
    uint8_t targetRole = userPrefs.getUChar(("r" + String(idx)).c_str(), ROLE_USER);
    userPrefs.end();
    if (targetRole == ROLE_ADMIN && countAdmins() <= 1) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Son admin hesabi silinemez.");
        return;
    }
    deleteUser(username);
    redirectToAdminUsers();
}

void handleAdminUserResetPassword() {
    if (!requireAuth(ROLE_ADMIN)) return;
    String username = server.arg("username");
    String password = server.arg("password");
    if (password.length() == 0) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Sifre bos olamaz.");
        return;
    }
    if (!setUserPassword(username, password)) {
        server.send(404, "text/plain; charset=utf-8", "HATA: Kullanici bulunamadi.");
        return;
    }
    redirectToAdminUsers();
}

void handleSend() {
    if (!requireAuthApi(ROLE_USER)) return;
    Serial.println("=== /send istegi geldi ===");

    if (!nrfReady) {
        Serial.println("REDDEDILDI: nRF24 hazir degil.");
        server.send(503, "text/plain; charset=utf-8", "HATA: nRF24L01 modulu baslatilamadi (kablo/pin baglantisini kontrol edin).");
        return;
    }

    LabelFields fields;
    fields.templateID = (uint8_t)server.arg("templateID").toInt();
    fields.discountEnabled = (uint8_t)server.arg("discountEnabled").toInt();
    fields.campaignEnabled = (uint8_t)server.arg("campaignEnabled").toInt();
    fields.business = server.arg("business");
    fields.name = server.arg("name");
    fields.subtitle = server.arg("subtitle");
    fields.price = server.arg("price");
    fields.oldPrice = server.arg("oldPrice");
    fields.unit = server.arg("unit");
    fields.bottomCode = server.arg("bottomCode");
    fields.campaignText = server.arg("campaignText");
    fields.barcode = server.arg("barcode");
    fields.ingredients = server.arg("ingredients");
    fields.allergens = server.arg("allergens");
    fields.logoPresent = 0; // logo yukleme henuz eklenmedi

    Serial.print("  business="); Serial.println(fields.business);
    Serial.print("  name=");     Serial.println(fields.name);
    Serial.print("  price=");    Serial.println(fields.price);
    Serial.print("  board=");    Serial.println(server.arg("board"));

    uint8_t payload[TOTAL_LABEL_BYTES];
    PackLabelPayload(fields, payload);

    Serial.print("  payload ilk 32 byte (hex): ");
    for (int i = 0; i < 32; i++) {
        if (payload[i] < 0x10) Serial.print('0');
        Serial.print(payload[i], HEX);
        Serial.print(' ');
    }
    Serial.println();

    String board = server.arg("board");
    const uint8_t *targetAddr = (board == "ESB") ? ADDR_ESB : ADDR_ESA;
    Serial.print("  hedef adres: ");
    Serial.print((char)targetAddr[0]); Serial.print((char)targetAddr[1]); Serial.println((char)targetAddr[2]);

    Serial.println("  NRF24 uzerinden gonderim basliyor...");
    SendResult result = NrfGateway_SendLabel(payload, targetAddr);

    String msg;
    if (result.success) {
        Serial.println("  SONUC: basarili, tum parcalar gonderildi.");
        msg = "OK: " + String(result.totalChunks) + " parca " + board + " adresine gonderildi.";
        server.send(200, "text/plain; charset=utf-8", msg);
    } else {
        Serial.print("  SONUC: basarisiz, parca #");
        Serial.println(result.lastChunkSent);
        msg = "HATA: gonderim parca #" + String(result.lastChunkSent) + " icin basarisiz oldu (MAX_RT / karsilik yok).";
        server.send(502, "text/plain; charset=utf-8", msg);
    }
    Serial.println("=== /send istegi bitti ===");
}

void connectWiFi() {
    String savedSsid = loadSavedSSID();
    String savedPass = loadSavedPass();
    bool connected = false;

    if (savedSsid.length() > 0) {
        Serial.print("NVS'de kayitli WiFi bilgisi bulundu ('");
        Serial.print(savedSsid);
        Serial.println("'), baglaniliyor...");
        connected = tryConnectSTA(savedSsid, savedPass, WIFI_CONNECT_TIMEOUT_MS);
    } else {
        Serial.println("NVS'de kayitli WiFi bilgisi yok.");
    }

    if (!connected) {
        // Hic kayit yoksa (ilk kurulum) veya kayitli ag artik erisilemezse,
        // config.h'daki varsayilan degerleri de bir kez deneyelim - eski
        // davranisla geriye donuk uyumluluk icin. Basarili olursa bir daha
        // config.h'a bakmamak icin NVS'ye de kaydediyoruz.
        Serial.println("Varsayilan (config.h) ag deneniyor...");
        connected = tryConnectSTA(WIFI_SSID, WIFI_PASSWORD, WIFI_CONNECT_TIMEOUT_MS);
        if (connected) {
            saveWifiCreds(WIFI_SSID, WIFI_PASSWORD);
        }
    }

    if (connected) {
        apMode = false;
        Serial.print("WiFi baglandi, IP: ");
        Serial.println(WiFi.localIP());
        return;
    }

    Serial.print("WiFi'ya baglanilamadi (durum kodu: ");
    Serial.print(WiFi.status());
    Serial.println("). 1=SSID bulunamadi 4=sifre/kimlik hatasi 6=baglanti koptu");
    Serial.println("Kurulum Access Point'i aciliyor - /wifi sihirbazindan yeni ag girebilirsiniz.");
    startSetupAP();
}

void setup() {
    Serial.begin(115200);
    delay(200);

    ensureDefaultAdmin();

    // MAC adresi okunabilsin diye WiFi radyosunu bir kez kisaca uyandirip
    // cihaza ozel (garanti benzersiz) AP adi / mDNS adini hesapliyoruz -
    // birden fazla gateway ayni anda calisirken isim carpismasini onler.
    WiFi.mode(WIFI_STA);
    uniqueSuffix = computeUniqueSuffix();
    uniqueSuffix.toUpperCase();
    apSsidFull = String(AP_SSID) + "-" + uniqueSuffix;
    String suffixLower = uniqueSuffix;
    suffixLower.toLowerCase();
    mdnsHostnameFull = String(MDNS_HOSTNAME) + "-" + suffixLower;
    Serial.print("Cihaz kimligi: ");
    Serial.println(uniqueSuffix);

    connectWiFi();

    // nRF24L01 SPI hatlari GPIO matrisi uzerinden ozel pinlere yonlendiriliyor
    // (CE=32, CSN=33, SCK=14, MISO=27, MOSI=13) - config.h'daki NRF_*_PIN
    // tanimlariyla birebir eslesir.
    SPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);

    nrfReady = NrfGateway_Init();
    Serial.println(nrfReady ? "nRF24L01 hazir." : "nRF24L01 baslatilamadi!");

    // Cookie header'i istek basina yakalanabilsin diye (varsayilan olarak
    // WebServer hicbir header'i tutmaz) - oturum kontrolu bunu kullanir.
    static const char *kCollectHeaders[] = {"Cookie"};
    server.collectHeaders(kCollectHeaders, 1);

    server.on("/", HTTP_GET, handleRoot);
    server.on("/send", HTTP_POST, handleSend);

    server.on("/login", HTTP_GET, handleLoginPage);
    server.on("/login", HTTP_POST, handleLoginSubmit);
    server.on("/logout", HTTP_GET, handleLogout);

    server.on("/admin/users", HTTP_GET, handleAdminUsersPage);
    server.on("/admin/users/add", HTTP_POST, handleAdminUserAdd);
    server.on("/admin/users/delete", HTTP_POST, handleAdminUserDelete);
    server.on("/admin/users/reset-password", HTTP_POST, handleAdminUserResetPassword);

    // WiFi kurulum sihirbazi (/wifi) - hem kurulum (AP) modunda hem de zaten
    // baglanmisken (cihazi baska bir yere tasiyip agi degistirmek icin) erisilebilir.
    server.on("/wifi", HTTP_GET, handleWifiPage);
    server.on("/wifi/status", HTTP_GET, handleWifiStatus);
    server.on("/wifi/scan", HTTP_GET, handleWifiScan);
    server.on("/wifi/save", HTTP_POST, handleWifiSave);

    // Isletim sistemlerinin "internete baglimi?" kontrol adresleri - kurulum
    // (AP) modundayken bunlari /wifi sihirbazina yonlendirerek telefonun
    // otomatik olarak kurulum sayfasini acmasini sagliyoruz (captive portal).
    server.on("/generate_204", handleCaptiveRedirect);
    server.on("/gen_204", handleCaptiveRedirect);
    server.on("/hotspot-detect.html", handleCaptiveRedirect);
    server.on("/library/test/success.html", handleCaptiveRedirect);
    server.on("/ncsi.txt", handleCaptiveRedirect);
    server.on("/connecttest.txt", handleCaptiveRedirect);
    server.onNotFound([]() {
        if (apMode) {
            handleCaptiveRedirect();
        } else {
            server.send(404, "text/plain; charset=utf-8", "Bulunamadi");
        }
    });

    server.begin();
    Serial.println("HTTP sunucu basladi.");

    if (MDNS.begin(mdnsHostnameFull.c_str())) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("Adres: http://" + mdnsHostnameFull + ".local/");
    } else {
        Serial.println("mDNS baslatilamadi, sadece IP adresinden erisin.");
    }
}

void loop() {
    server.handleClient();

    if (apMode) {
        dnsServer.processNextRequest();
    }

    if (restartAtMillis != 0 && millis() > restartAtMillis) {
        Serial.println("WiFi ayarlari degisti, yeniden baslatiliyor...");
        delay(100);
        ESP.restart();
    }
}
