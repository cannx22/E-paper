/*
 * E-paper resim modu alicisi (STM32 referans uygulamasi)
 *
 * Gateway'den (ESP32) nRF24 ile gelen resim paketlerini isler:
 *   - Sikistirilmis (RLE) veriyi paket paket acar ve panelin RAM'ine
 *     dogrudan yazdirir. Goruntunun tamami MCU RAM'inde TUTULMAZ
 *     (648x480 4 renk = 77.760 byte; bu modul ~100 byte RAM kullanir).
 *   - Acilmis verinin CRC32'sini hesaplar; tum paketler geldiyse ve CRC
 *     tutuyorsa ekran yenilenir. Yarim kalan aktarimda ekran YENILENMEZ,
 *     eski goruntu ekranda kalir.
 *   - Gateway'in STATUS sorgusuna ACK payload ile durum doner.
 *
 * Protokol: docs/resim-modu.md
 * Donanimdan bagimsizdir (HAL kullanmaz); panel ve nRF islemleri
 * EpdImgOps ile disaridan verilir. C99, dinamik bellek kullanmaz.
 *
 * Kullanim ozeti:
 *   static EpdImgRx rx;
 *   EpdImg_Init(&rx, &ops);
 *   // nRF'ten her paket alindiginda (kesme veya ana dongu):
 *   if (!EpdImg_OnPacket(&rx, buf, len)) { eski 399 byte protokolu... }
 *   // ana dongude:
 *   EpdImg_Poll(&rx);   // gerekiyorsa ops->commit() (ekran yenileme) burada cagrilir
 */
#ifndef EPD_IMAGE_RX_H
#define EPD_IMAGE_RX_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Paket tipleri (paketin ilk byte'i). Eski protokolde ilk byte 0..13
 * (parca sira numarasi) oldugu icin cakisma yok. */
#define EPD_IMG_PKT_START  0xA1
#define EPD_IMG_PKT_DATA   0xA2
#define EPD_IMG_PKT_END    0xA3
#define EPD_IMG_PKT_STATUS 0xA4

#define EPD_IMG_VERSION    1
#define EPD_IMG_HEADER_LEN 24

/* Panel veri bicimleri (baslik byte 1) */
#define EPD_IMG_FMT_BW        1  /* 1 bit/piksel, MSB solda, 1 = beyaz, 0 = siyah */
#define EPD_IMG_FMT_TWO_PLANE 2  /* once BW duzlemi (1 = beyaz), sonra renk duzlemi (1 = kirmizi/sari) */
#define EPD_IMG_FMT_BWRY      3  /* 2 bit/piksel, ilk piksel bit7-6: 00 siyah, 01 beyaz, 10 sari, 11 kirmizi */

/* Sikistirma (baslik byte 2) */
#define EPD_IMG_COMP_NONE 0
#define EPD_IMG_COMP_RLE  1

/* STATUS cevabindaki durum kodlari */
#define EPD_IMG_ST_OK        0x00 /* veri tam, CRC dogru, ekran yenileniyor */
#define EPD_IMG_ST_CRC       0x01 /* CRC tutmadi */
#define EPD_IMG_ST_SEQ       0x02 /* paket atlandi / sira hatasi */
#define EPD_IMG_ST_SIZE      0x03 /* uzunluk tutmadi */
#define EPD_IMG_ST_FORMAT    0x04 /* desteklenmeyen bicim / cozunurluk / surum */
#define EPD_IMG_ST_BUSY      0x05 /* onceki ekran yenilemesi suruyor */
#define EPD_IMG_ST_RECEIVING 0x06 /* aktarim suruyor */
#define EPD_IMG_ST_IDLE      0xFF /* aktarim yok */

typedef struct {
    /* Aktarim basinda cagrilir: panel RAM yazimina hazirlan (ornek JD79665:
     * init + 0x10 komutu). Panel bu bicimi/cozunurlugu desteklemiyorsa 0
     * disi bir deger donun (gateway'e EPD_IMG_ST_FORMAT gider). */
    int  (*begin)(void *ctx, uint8_t format, uint16_t width, uint16_t height);
    /* Acilmis panel verisini sirayla yazar. offset: acilmis verideki konum.
     * EPD_IMG_FMT_TWO_PLANE'de offset >= duzlem boyu ise renk duzlemidir
     * (SSD1680: 0x26); tek bir cagri hicbir zaman duzlem sinirini gecmez. */
    void (*write)(void *ctx, uint32_t offset, const uint8_t *data, uint16_t len);
    /* Tum veri geldi ve CRC dogru: ekrani yenile (ornek 0x12). Uzun surer
     * (4 renk panelde 12-20 sn); EpdImg_Poll icinden, ana dongude cagrilir. */
    void (*commit)(void *ctx);
    /* Aktarim yarida kaldi / hata: ekran yenilenmez. Panel RAM'i yarim
     * kalmistir; bir sonraki aktarim bastan yazar. (NULL olabilir) */
    void (*abort)(void *ctx);
    /* nRF24: pipe 0 icin ACK payload yukle. Oncesinde TX FIFO temizlenmeli
     * (flush_tx) ki gateway'e en guncel durum gitsin. */
    void (*set_ack)(void *ctx, const uint8_t *data, uint8_t len);
    void *ctx;
} EpdImgOps;

typedef struct {
    const EpdImgOps *ops;
    uint8_t  state;          /* ic durum */
    uint8_t  status;         /* son durum kodu (EPD_IMG_ST_*) */
    uint8_t  format;
    uint8_t  compression;
    uint16_t width, height;
    uint32_t raw_len;        /* acilmis veri uzunlugu */
    uint32_t data_len;       /* sikistirilmis veri uzunlugu */
    uint32_t crc_expected;
    uint32_t plane_len;      /* TWO_PLANE: bir duzlemin uzunlugu */
    uint32_t raw_pos;        /* panele yazilan byte */
    uint32_t data_pos;       /* alinan veri byte'i */
    uint32_t crc;            /* calisan CRC32 */
    uint16_t next_seq;       /* beklenen DATA sira numarasi */
    uint8_t  rle_mode;       /* 0: kontrol byte bekleniyor, 1: duz veri, 2: tekrar byte'i bekleniyor */
    uint8_t  rle_count;
    uint8_t  commit_pending;
    uint8_t  out_len;
    uint8_t  out[32];        /* panele toplu yazim tamponu */
} EpdImgRx;

void EpdImg_Init(EpdImgRx *rx, const EpdImgOps *ops);

/* nRF'ten gelen her paket icin cagrilir. Paket resim moduna aitse isler ve
 * 1 doner; degilse (eski protokol) 0 doner. Kesme icinden cagrilabilir;
 * ancak write() o zaman SPI'yi kesmede kullanir; tercihen ana dongude
 * cagirin. */
int EpdImg_OnPacket(EpdImgRx *rx, const uint8_t *pkt, uint8_t len);

/* Ana dongude cagrilir: CRC dogrulanmis aktarim varsa ops->commit() cagrilir
 * (ekran yenileme). Yenileme yapildiysa 1 doner. */
int EpdImg_Poll(EpdImgRx *rx);

/* Son durum (EPD_IMG_ST_*) */
uint8_t EpdImg_Status(const EpdImgRx *rx);

/* CRC32 (IEEE 802.3, zlib ile ayni). crc baslangic 0, parca parca cagrilabilir. */
uint32_t EpdImg_Crc32(uint32_t crc, const uint8_t *data, uint32_t len);

#ifdef __cplusplus
}
#endif

#endif /* EPD_IMAGE_RX_H */
