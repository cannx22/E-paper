#pragma once
#include <Arduino.h>
#include "nrf_gateway.h"

// Resim modu: sunucunun urettigi goruntu verisini (blob) nRF24 ile aliciya
// gonderir. Gateway verinin icerigini anlamaz; sadece parcalar.
// Protokolun tamami: docs/resim-modu.md
//
// Blob = 24 byte baslik + panel verisi (RLE sikistirilmis olabilir).
// Hava uzerindeki paketler (en fazla 32 byte):
//   START  [0xA1][24 byte baslik]                            = 25 byte
//   DATA   [0xA2][seq lo][seq hi][en fazla 29 byte veri]     <= 32 byte
//   END    [0xA3][paket sayisi lo][hi][CRC32 (4 byte, LE)]   = 7 byte
//   STATUS [0xA4]  -> alici ACK payload'u ile cevaplar:
//          [0xA4][durum][CRC32 (4 byte, LE)]
#define IMG_PKT_START  0xA1
#define IMG_PKT_DATA   0xA2
#define IMG_PKT_END    0xA3
#define IMG_PKT_STATUS 0xA4

#define IMG_VERSION         1
#define IMG_HEADER_LEN      24
#define IMG_DATA_PER_PACKET 29
// Gateway'in bellekte tutabilecegi en buyuk blob (sunucu da bunu asmaz).
#define IMG_MAX_BLOB        (96 * 1024)

// Alicinin STATUS cevabindaki durum kodlari
#define IMG_ST_OK         0x00 // tum veri geldi, CRC dogru, ekran yenileniyor
#define IMG_ST_CRC        0x01 // CRC tutmadi
#define IMG_ST_SEQ        0x02 // paket atlandi / sira hatasi
#define IMG_ST_SIZE       0x03 // uzunluk tutmadi (eksik veya fazla veri)
#define IMG_ST_FORMAT     0x04 // desteklenmeyen format / cozunurluk / surum
#define IMG_ST_BUSY       0x05 // alici mesgul (onceki ekran yenilemesi suruyor)
#define IMG_ST_RECEIVING  0x06 // aktarim hala suruyor (END islenmedi)
#define IMG_ST_IDLE       0xFF // alicida aktarim yok

// Uzun gonderimde WebSocket baglantisi kopmasin diye arada cagrilir.
typedef void (*ImageSenderPoll)();

struct ImageSendResult {
    bool success = false;
    uint32_t totalPackets = 0;   // START + DATA + END
    uint32_t packetsSent = 0;
    int32_t failedSeq = -1;      // DATA paketi basarisizsa sira no, START: -2, END: -3
    bool statusRead = false;     // alicidan STATUS cevabi alindi mi
    uint8_t rxStatus = IMG_ST_IDLE;
    uint32_t elapsedMs = 0;
    String message;              // sunucuya "result" olarak gider
};

const char *ImageSender_StatusText(uint8_t status);

// blob'u targetAddr (3 byte nRF adresi) alicisina gonderir.
ImageSendResult ImageSender_Send(const uint8_t *blob, size_t len, const uint8_t targetAddr[NRF_ADDR_LEN], ImageSenderPoll poll);
