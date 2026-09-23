#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <esp_system.h>
#include "config.h"
#include "label_payload.h"
#include "nrf_gateway.h"
#include "cloud_client.h"

// Etiket gonderimi artik bulut sunucudan yonetiliyor (server/ klasoru): bu
// cihazda yerel etiket paneli / kullanici girisi yok. Yerel web sunucusu
// sadece WiFi kurulum (Access Point) modunda, /wifi sihirbazi icin calisir.
WebServer server(80);
bool nrfReady = false;

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

void clearWifiCreds() {
    wifiPrefs.begin("wifi", false);
    wifiPrefs.remove("ssid");
    wifiPrefs.remove("pass");
    wifiPrefs.end();
}

// ---- Bulut sunucu ayarlari (NVS, "cloud" namespace'i) ----
// url: kurulum sayfasindan girilen sunucu adresi (bossa config.h'daki
// SERVER_URL_DEFAULT). secret: ilk acilista uretilen, bu cihaza ozel rastgele
// anahtar - sunucu gateway'i MAC + bu anahtarla tanir. Flash silinirse yeni
// anahtar uretilir; o zaman admin panelden "Anahtar Sifirla" gerekir.
Preferences cloudPrefs;
String gatewayId; // tam MAC adresi, 12 hex (ornek "A1B2C3D4E5F6")

String loadServerUrl() {
    cloudPrefs.begin("cloud", true);
    String url = cloudPrefs.getString("url", "");
    cloudPrefs.end();
    return url.length() > 0 ? url : String(SERVER_URL_DEFAULT);
}

void saveServerUrl(const String &url) {
    cloudPrefs.begin("cloud", false);
    if (url.length() > 0) cloudPrefs.putString("url", url);
    else cloudPrefs.remove("url");
    cloudPrefs.end();
}

String loadOrCreateSecret() {
    cloudPrefs.begin("cloud", false);
    String secret = cloudPrefs.getString("secret", "");
    if (secret.length() != 32) {
        uint8_t buf[16];
        esp_fill_random(buf, sizeof(buf));
        char hex[33];
        for (size_t i = 0; i < sizeof(buf); i++) sprintf(hex + i * 2, "%02x", buf[i]);
        secret = hex;
        cloudPrefs.putString("secret", secret);
        Serial.println("Yeni gateway anahtari uretildi.");
    }
    cloudPrefs.end();
    return secret;
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
      <li>Cihaz birka&#231; saniye i&ccedil;inde yeniden ba&#351;lay&#305;p se&ccedil;ti&#287;iniz a&#287;a ba&#287;lanacak ve internet &uuml;zerinden sunucuya ba&#287;lanacak.</li>
      <li>Sunucu panelinde <b>Gateway'ler</b> sayfas&#305;nda bu cihaz (kimlik: <b id="gwIdText">...</b>) <b>Onay Bekliyor</b> olarak g&ouml;r&uuml;n&uuml;r; onaylay&#305;nca etiket g&ouml;nderebilirsiniz.</li>
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
      <div class="field">
        <label>Sunucu Adresi (bo&#351; b&#305;rak&#305;l&#305;rsa varsay&#305;lan)</label>
        <input name="server" id="serverInput" autocomplete="off" placeholder="wss://...">
        <p class="hint" id="serverDefault"></p>
      </div>
      <button type="submit" class="btn-primary">&#128190; Kaydet ve Yeniden Ba&#351;lat</button>
    </form>
    <div id="wifiResult"></div>
  </section>
</div>

<script>
function escapeHtmlW(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

fetch('/wifi/status').then(function(r){ return r.json(); }).then(function(s){
  if (s.id) document.getElementById('deviceIdBadge').textContent = '#' + s.id;
  if (s.id) document.getElementById('gwIdText').textContent = s.id;
  if (s.serverCustom) document.getElementById('serverInput').value = s.server;
  document.getElementById('serverDefault').textContent = 'Varsayılan: ' + s.serverDefault;
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

// Bu sayfalar sadece kurulum AP'si acikken sunulur - AP'ye (sifreli, fiziksel
// olarak yakin) baglanabilmek zaten guvenlik siniri, ayrica giris istenmiyor.
void handleWifiPage() {
    server.send(200, "text/html; charset=utf-8", WIFI_PAGE);
}

void handleWifiStatus() {
    String serverUrl = loadServerUrl();
    String json = "{";
    json += "\"id\":\"" + gatewayId + "\",";
    json += "\"server\":\"" + jsonEscape(serverUrl) + "\",";
    json += "\"serverDefault\":\"" + jsonEscape(SERVER_URL_DEFAULT) + "\",";
    json += "\"serverCustom\":";
    json += (serverUrl != SERVER_URL_DEFAULT) ? "true," : "false,";
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
    String ssid = server.arg("ssid");
    String pass = server.arg("password");
    String serverUrl = server.arg("server");
    serverUrl.trim();

    if (ssid.length() == 0) {
        server.send(400, "text/plain; charset=utf-8", "HATA: Ag adi (SSID) bos olamaz.");
        return;
    }
    if (serverUrl.length() > 0) {
        bool tls; String host, path; uint16_t port;
        if (!CloudClient_ParseUrl(serverUrl, tls, host, port, path)) {
            server.send(400, "text/plain; charset=utf-8",
                "HATA: Sunucu adresi gecersiz (ornek: wss://etiket.1.2.3.4.sslip.io).");
            return;
        }
    }

    saveWifiCreds(ssid, pass);
    saveServerUrl(serverUrl);
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

static const uint8_t ADDR_ESA[NRF_ADDR_LEN] = {TARGET_ADDR_ESA[0], TARGET_ADDR_ESA[1], TARGET_ADDR_ESA[2]};
static const uint8_t ADDR_ESB[NRF_ADDR_LEN] = {TARGET_ADDR_ESB[0], TARGET_ADDR_ESB[1], TARGET_ADDR_ESB[2]};

// Sunucudan gelen "send" mesaji: eskiden yerel /send formundan gelen alanlar
// artik JSON olarak geliyor; paketleme ve nRF gonderimi ayni.
bool handleCloudSend(JsonObjectConst f, const String &board, String &message) {
    Serial.println("=== sunucudan etiket istegi geldi ===");

    if (!nrfReady) {
        Serial.println("REDDEDILDI: nRF24 hazir degil.");
        message = "HATA: nRF24L01 modulu baslatilamadi (kablo/pin baglantisini kontrol edin).";
        return false;
    }

    LabelFields fields;
    fields.templateID = f["templateID"] | 1;
    fields.discountEnabled = f["discountEnabled"] | 0;
    fields.campaignEnabled = f["campaignEnabled"] | 0;
    fields.business = f["business"] | "";
    fields.name = f["name"] | "";
    fields.subtitle = f["subtitle"] | "";
    fields.price = f["price"] | "";
    fields.oldPrice = f["oldPrice"] | "";
    fields.unit = f["unit"] | "";
    fields.bottomCode = f["bottomCode"] | "";
    fields.campaignText = f["campaignText"] | "";
    fields.barcode = f["barcode"] | "";
    fields.ingredients = f["ingredients"] | "";
    fields.allergens = f["allergens"] | "";
    fields.logoPresent = 0; // logo yukleme henuz eklenmedi

    Serial.print("  business="); Serial.println(fields.business);
    Serial.print("  name=");     Serial.println(fields.name);
    Serial.print("  price=");    Serial.println(fields.price);
    Serial.print("  board=");    Serial.println(board);

    uint8_t payload[TOTAL_LABEL_BYTES];
    PackLabelPayload(fields, payload);

    Serial.print("  payload ilk 32 byte (hex): ");
    for (int i = 0; i < 32; i++) {
        if (payload[i] < 0x10) Serial.print('0');
        Serial.print(payload[i], HEX);
        Serial.print(' ');
    }
    Serial.println();

    const uint8_t *targetAddr = (board == "ESB") ? ADDR_ESB : ADDR_ESA;
    Serial.print("  hedef adres: ");
    Serial.print((char)targetAddr[0]); Serial.print((char)targetAddr[1]); Serial.println((char)targetAddr[2]);

    Serial.println("  NRF24 uzerinden gonderim basliyor...");
    SendResult result = NrfGateway_SendLabel(payload, targetAddr);

    bool ok;
    if (result.success) {
        Serial.println("  SONUC: basarili, tum parcalar gonderildi.");
        message = "OK: " + String(result.totalChunks) + " parca " + board + " adresine gonderildi.";
        ok = true;
    } else {
        Serial.print("  SONUC: basarisiz, parca #");
        Serial.println(result.lastChunkSent);
        message = "HATA: gonderim parca #" + String(result.lastChunkSent) + " icin basarisiz oldu (MAX_RT / karsilik yok).";
        ok = false;
    }
    Serial.println("=== etiket istegi bitti ===");
    return ok;
}

// Admin panelinden gonderilen komutlar.
void handleCloudCommand(const String &command) {
    if (command == "restart") {
        Serial.println("Sunucudan yeniden baslatma komutu geldi.");
        restartAtMillis = millis() + 500;
    } else if (command == "wifi_reset") {
        Serial.println("Sunucudan WiFi sifirlama komutu geldi - kayitli ag siliniyor, kurulum moduna gecilecek.");
        clearWifiCreds();
        restartAtMillis = millis() + 500;
    }
}

void startSetupWebServer() {
    server.on("/", HTTP_GET, handleWifiPage);
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
    server.onNotFound(handleCaptiveRedirect);

    server.begin();
    Serial.println("Kurulum web sayfasi basladi: http://192.168.4.1/wifi");
}

bool hasSavedWifi = false;
unsigned long lastApActivityMillis = 0;

void setup() {
    Serial.begin(115200);
    delay(200);

    // MAC adresi okunabilsin diye WiFi radyosunu bir kez kisaca uyandirip
    // cihaza ozel (garanti benzersiz) kimlik ve AP adini hesapliyoruz.
    WiFi.mode(WIFI_STA);
    gatewayId = WiFi.macAddress();
    gatewayId.replace(":", "");
    gatewayId.toUpperCase();
    uniqueSuffix = computeUniqueSuffix();
    uniqueSuffix.toUpperCase();
    apSsidFull = String(AP_SSID) + "-" + uniqueSuffix;
    String suffixLower = uniqueSuffix;
    suffixLower.toLowerCase();
    mdnsHostnameFull = String(MDNS_HOSTNAME) + "-" + suffixLower;
    Serial.print("Gateway kimligi: ");
    Serial.print(gatewayId);
    Serial.print("  firmware: ");
    Serial.println(FW_VERSION);

    hasSavedWifi = loadSavedSSID().length() > 0;
    connectWiFi();

    // nRF24L01 SPI hatlari - config.h'daki NRF_*_PIN tanimlariyla birebir eslesir.
    SPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);

    nrfReady = NrfGateway_Init();
    Serial.println(nrfReady ? "nRF24L01 hazir." : "nRF24L01 baslatilamadi!");

    if (apMode) {
        startSetupWebServer();
        lastApActivityMillis = millis();
        return;
    }

    CloudConfig cfg;
    cfg.url = loadServerUrl();
    cfg.gatewayId = gatewayId;
    cfg.secret = loadOrCreateSecret();
    cfg.fwVersion = FW_VERSION;
    cfg.nrfReady = nrfReady;
    CloudClient_Begin(cfg, handleCloudSend, handleCloudCommand);
}

unsigned long lastWifiCheckMillis = 0;
const unsigned long WIFI_CHECK_INTERVAL_MS = 10000; // 10 saniyede bir baglanti kontrolu

void loop() {
    if (apMode) {
        server.handleClient();
        dnsServer.processNextRequest();

        // Elektrik kesintisinden sonra modem ESP32'den gec acilirsa cihaz
        // kayitli aga baglanamayip kurulum moduna duser; uzaktaki bir gateway
        // orada takili kalmasin diye, kayitli ag varsa ve kurulum agina kimse
        // baglanmadiysa bir sure sonra yeniden baslayip tekrar dener.
        if (WiFi.softAPgetStationNum() > 0) {
            lastApActivityMillis = millis();
        } else if (hasSavedWifi && millis() - lastApActivityMillis > AP_RETRY_TIMEOUT_MS) {
            Serial.println("Kurulum modunda islem yapilmadi, kayitli ag icin yeniden baslatiliyor...");
            delay(100);
            ESP.restart();
        }
    } else {
        CloudClient_Loop();

        if (millis() - lastWifiCheckMillis > WIFI_CHECK_INTERVAL_MS) {
            // STA modundayken WiFi baglantisi koparsa periyodik olarak fark
            // edip yeniden baglanmayi dener; sunucu baglantisini WebSocket
            // istemcisi kendisi yeniden kurar.
            lastWifiCheckMillis = millis();
            if (WiFi.status() != WL_CONNECTED) {
                Serial.println("WiFi baglantisi koptu, yeniden baglaniliyor...");
                WiFi.reconnect();
            }
        }
    }

    if (restartAtMillis != 0 && millis() > restartAtMillis) {
        Serial.println("Yeniden baslatiliyor...");
        delay(100);
        ESP.restart();
    }
}
