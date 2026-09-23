# E-Paper Etiket Sunucusu

ESP32 gateway'ler WiFi'ye bağlanınca bu sunucuya WebSocket ile bağlanır (`/ws/gateway`).
Etiketler tarayıcıdan bu sunucu üzerinden gönderilir:

```
Tarayıcı ──HTTPS──> Sunucu (Coolify) ──wss──> ESP32 Gateway ──nRF24──> E-paper etiket
```

## Coolify'a kurulum

1. **Repoyu GitHub'a yükleyin** (bu klasörün bulunduğu repo; özel repo olabilir).
2. Coolify'da **Project → + New → Resource → Private Repository (GitHub App)** (veya public
   ise *Public Repository*) seçip repoyu ve dalı seçin.
3. Ayarlar:
   - **Build Pack:** `Dockerfile`
   - **Base Directory:** `/server`
   - **Ports Exposes:** `3000`
4. **Domains:** Coolify otomatik olarak `http://<rastgele>.<sunucu-ip>.sslip.io` verir. Bunu
   `https://etiket.<sunucu-ip>.sslip.io` gibi değiştirin. `https://` yazınca Coolify Let's
   Encrypt sertifikasını kendisi alır.
5. **Environment Variables:**
   - `ADMIN_PASSWORD`: ilk admin hesabının şifresi (kullanıcı adı `admin`, `ADMIN_USERNAME`
     ile değiştirilebilir). Verilmezse rastgele bir şifre üretilip deploy loglarına yazılır.
     Bu değişken sadece hiç kullanıcı yokken, yani ilk açılışta kullanılır.
6. **Persistent Storage:** yeni bir volume ekleyin, **Destination Path:** `/app/data`.
   Kullanıcılar, gateway'ler ve gönderim geçmişi burada tutulur. Volume eklenmezse her
   deploy'da bu bilgiler silinir.
7. **Deploy**'a basın. `https://etiket.<sunucu-ip>.sslip.io/healthz` adresi `ok` dönmeli.

## Gateway'i bağlama

1. `include/config.h` içindeki `SERVER_URL_DEFAULT` değerini sunucu adresinizle değiştirin:
   `wss://etiket.<sunucu-ip>.sslip.io/ws/gateway`. Domain `http://` ise `ws://` yazın.
2. Firmware'i ESP32'ye yükleyin.
3. ESP32'yi çalıştırın. Kayıtlı WiFi yoksa `ESP32-NRF-Gateway-XXXXXX` ağını açar (şifre
   `12345678`). Bu ağa bağlanınca kurulum sayfası açılır; açılmazsa `http://192.168.4.1`
   adresine gidin. İşyeri WiFi'sini seçip kaydedin. Sunucu adresi alanı boş kalırsa
   `config.h`'daki varsayılan adres kullanılır.
4. Panelde **Gateway'ler** sayfasına girin. Cihaz **Onay Bekliyor** olarak görünür;
   **Onayla**'ya basın.
5. **Etiket Gönder** sayfasında gateway'i ve ekranı (ESA/ESB) seçip gönderin.

## Yerel geliştirme

```
cd server
npm install
set ADMIN_PASSWORD=admin123
npm start          # http://localhost:3000
```

Yerel testte gateway'in bilgisayara bağlanması için kurulum sayfasındaki sunucu adresine
`ws://<bilgisayarın-yerel-ip>:3000` yazın.
