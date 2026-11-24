#include "image_sender.h"

// Bir paket donanim seviyesinde 10 kez denenir (setRetries(9, 10)); ACK hala
// gelmezse ayni paket yazilimla bu kadar daha denenir. Alici ayni sira
// numarasini ikinci kez alirsa yok sayar (ACK'i kaybolan paket).
static const uint8_t PACKET_TRIES = 3;
// END'den sonra alicinin CRC'yi kontrol edip durum cevabini (ACK payload)
// hazirlamasi icin beklenen sure ve deneme sayisi.
static const uint16_t STATUS_FIRST_DELAY_MS = 30;
static const uint16_t STATUS_RETRY_DELAY_MS = 40;
static const uint8_t STATUS_TRIES = 8;
// Bu kadar pakette bir WebSocket baglantisi canli tutulur.
static const uint16_t POLL_EVERY = 64;

static uint32_t readU32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static bool sendPacket(const uint8_t *pkt, uint8_t len) {
    for (uint8_t t = 0; t < PACKET_TRIES; t++) {
        if (NrfGateway_Write(pkt, len, nullptr, nullptr)) return true;
        delay(2 + t * 3);
    }
    return false;
}

const char *ImageSender_StatusText(uint8_t status) {
    switch (status) {
        case IMG_ST_OK:        return "goruntu alindi, ekran yenileniyor";
        case IMG_ST_CRC:       return "CRC tutmadi (veri bozuk geldi)";
        case IMG_ST_SEQ:       return "paket atlandi / sira hatasi";
        case IMG_ST_SIZE:      return "veri uzunlugu tutmadi";
        case IMG_ST_FORMAT:    return "alici bu goruntu bicimini desteklemiyor";
        case IMG_ST_BUSY:      return "alici mesgul (onceki ekran yenilemesi suruyor)";
        case IMG_ST_RECEIVING: return "alici aktarimi tamamlamadi";
        case IMG_ST_IDLE:      return "alicida aktarim yok";
        default:               return "bilinmeyen durum";
    }
}

ImageSendResult ImageSender_Send(const uint8_t *blob, size_t len, const uint8_t targetAddr[NRF_ADDR_LEN], ImageSenderPoll poll) {
    ImageSendResult r;
    unsigned long started = millis();

    if (len < IMG_HEADER_LEN || blob[0] != IMG_VERSION) {
        r.message = "HATA: Gecersiz goruntu verisi (baslik).";
        return r;
    }
    uint32_t dataLen = readU32(blob + 12);
    uint32_t crc = readU32(blob + 16);
    if ((size_t)IMG_HEADER_LEN + dataLen != len) {
        r.message = "HATA: Goruntu verisinin uzunlugu baslikla tutmuyor.";
        return r;
    }
    uint32_t dataPackets = (dataLen + IMG_DATA_PER_PACKET - 1) / IMG_DATA_PER_PACKET;
    if (dataPackets > 0xFFFF) {
        r.message = "HATA: Goruntu cok buyuk (65535 paketten fazla).";
        return r;
    }
    r.totalPackets = dataPackets + 2;
    const uint8_t *data = blob + IMG_HEADER_LEN;

    NrfGateway_OpenTarget(targetAddr);
    NrfGateway_FlushRx();

    uint8_t pkt[32];

    // START: baslik oldugu gibi
    pkt[0] = IMG_PKT_START;
    memcpy(pkt + 1, blob, IMG_HEADER_LEN);
    if (!sendPacket(pkt, 1 + IMG_HEADER_LEN)) {
        r.failedSeq = -2;
        r.message = "HATA: Aliciya ulasilamadi (baslangic paketi, MAX_RT / karsilik yok).";
        return r;
    }
    r.packetsSent++;

    // DATA
    for (uint32_t seq = 0; seq < dataPackets; seq++) {
        uint32_t off = seq * IMG_DATA_PER_PACKET;
        uint8_t n = (uint8_t)min((uint32_t)IMG_DATA_PER_PACKET, dataLen - off);
        pkt[0] = IMG_PKT_DATA;
        pkt[1] = seq & 0xFF;
        pkt[2] = (seq >> 8) & 0xFF;
        memcpy(pkt + 3, data + off, n);
        if (!sendPacket(pkt, 3 + n)) {
            r.failedSeq = (int32_t)seq;
            r.message = "HATA: Gonderim paket #" + String(seq) + "/" + String(dataPackets) + " icin basarisiz oldu (MAX_RT / karsilik yok).";
            return r;
        }
        r.packetsSent++;
        if (poll && (seq % POLL_EVERY) == POLL_EVERY - 1) poll();
    }

    // END: paket sayisi + CRC (alici kendi saydigi ve hesapladigi ile karsilastirir)
    pkt[0] = IMG_PKT_END;
    pkt[1] = dataPackets & 0xFF;
    pkt[2] = (dataPackets >> 8) & 0xFF;
    memcpy(pkt + 3, blob + 16, 4);
    if (!sendPacket(pkt, 7)) {
        r.failedSeq = -3;
        r.message = "HATA: Bitis paketi gonderilemedi (MAX_RT / karsilik yok).";
        return r;
    }
    r.packetsSent++;

    // STATUS: alicinin hazirladigi ACK payload'u okunur.
    delay(STATUS_FIRST_DELAY_MS);
    for (uint8_t t = 0; t < STATUS_TRIES && !r.statusRead; t++) {
        uint8_t ack[32];
        uint8_t ackLen = 0;
        pkt[0] = IMG_PKT_STATUS;
        if (NrfGateway_Write(pkt, 1, ack, &ackLen) && ackLen >= 6 && ack[0] == IMG_PKT_STATUS && readU32(ack + 2) == crc) {
            r.statusRead = true;
            r.rxStatus = ack[1];
            if (r.rxStatus == IMG_ST_RECEIVING) r.statusRead = false; // CRC kontrolu bitmemis, tekrar sor
        }
        if (!r.statusRead) delay(STATUS_RETRY_DELAY_MS);
    }
    r.elapsedMs = millis() - started;

    String info = String(r.packetsSent) + " paket, " + String(len) + " byte, " + String(r.elapsedMs) + " ms";
    if (!r.statusRead) {
        r.message = "HATA: Goruntu gonderildi (" + info + ") ama alici durum bildirmedi. Alici firmware'i resim modunu desteklemiyor olabilir.";
        return r;
    }
    if (r.rxStatus != IMG_ST_OK) {
        r.message = "HATA: Alici goruntuyu reddetti: " + String(ImageSender_StatusText(r.rxStatus)) + " (" + info + ").";
        return r;
    }
    r.success = true;
    r.message = "OK: Goruntu gonderildi (" + info + "), alici CRC'yi dogruladi; ekran yenileniyor.";
    return r;
}
