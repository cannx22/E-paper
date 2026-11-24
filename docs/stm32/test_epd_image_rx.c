/*
 * epd_image_rx icin bilgisayarda calisan test (donanim gerekmez).
 *
 * Sunucunun urettigi blob dosyasini gateway gibi paketlere boler
 * (START / DATA / END / STATUS), aliciya verir ve panele yazilan veriyi
 * beklenen ham veriyle karsilastirir. Hata senaryolari da denenir.
 *
 * Derleme ve calistirma (ornek):
 *   gcc -std=c99 -Wall -o test test_epd_image_rx.c epd_image_rx.c
 *   ./test ornek.blob ornek.raw
 * ornek.blob: sunucudaki /api/designs/:id/panel-blob ile indirilebilir
 * ornek.raw : beklenen acilmis panel verisi (test icin)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "epd_image_rx.h"

typedef struct {
    uint8_t *ram;          /* sahte panel RAM'i */
    uint32_t size;
    uint32_t written;
    int began, commits, aborts;
    uint8_t ack[32];
    uint8_t ack_len;
} Mock;

static int m_begin(void *c, uint8_t format, uint16_t w, uint16_t h) {
    Mock *m = (Mock *)c;
    (void)format; (void)w; (void)h;
    m->began++;
    m->written = 0;
    return 0;
}
static void m_write(void *c, uint32_t off, const uint8_t *d, uint16_t n) {
    Mock *m = (Mock *)c;
    if (off != m->written) { printf("  HATA: sirasiz yazim off=%u beklenen=%u\n", off, m->written); exit(1); }
    if (off + n > m->size) { printf("  HATA: panel RAM tasti\n"); exit(1); }
    memcpy(m->ram + off, d, n);
    m->written += n;
}
static void m_commit(void *c) { ((Mock *)c)->commits++; }
static void m_abort(void *c) { ((Mock *)c)->aborts++; }
static void m_set_ack(void *c, const uint8_t *d, uint8_t n) {
    Mock *m = (Mock *)c;
    memcpy(m->ack, d, n);
    m->ack_len = n;
}

static uint8_t *read_file(const char *path, uint32_t *len) {
    FILE *f = fopen(path, "rb");
    uint8_t *buf;
    long n;
    if (!f) { printf("dosya acilamadi: %s\n", path); exit(2); }
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    buf = (uint8_t *)malloc((size_t)n + 1);
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { printf("okunamadi: %s\n", path); exit(2); }
    fclose(f);
    *len = (uint32_t)n;
    return buf;
}

/* mode: 0 normal, 1 her 7. paketi iki kez gonder, 2 bir veri byte'ini boz, 3 bir paketi atla */
static uint8_t run(const uint8_t *blob, uint32_t len, Mock *m, int mode) {
    static EpdImgRx rx;
    EpdImgOps ops = { m_begin, m_write, m_commit, m_abort, m_set_ack, 0 };
    uint8_t pkt[32];
    uint32_t data_len = (uint32_t)blob[12] | ((uint32_t)blob[13] << 8) | ((uint32_t)blob[14] << 16) | ((uint32_t)blob[15] << 24);
    uint32_t packets = (data_len + 28) / 29, seq;
    if (len != 24 + data_len) { printf("  HATA: blob uzunlugu baslikla tutmuyor\n"); exit(1); }
    ops.ctx = m;
    EpdImg_Init(&rx, &ops);
    memset(m->ram, 0xEE, m->size);
    m->ack_len = 0;

    pkt[0] = EPD_IMG_PKT_START;
    memcpy(pkt + 1, blob, 24);
    EpdImg_OnPacket(&rx, pkt, 25);
    for (seq = 0; seq < packets; seq++) {
        uint32_t off = seq * 29;
        uint8_t n = (uint8_t)((data_len - off) < 29 ? (data_len - off) : 29);
        if (mode == 3 && seq == packets / 2) continue;
        pkt[0] = EPD_IMG_PKT_DATA;
        pkt[1] = (uint8_t)seq;
        pkt[2] = (uint8_t)(seq >> 8);
        memcpy(pkt + 3, blob + 24 + off, n);
        if (mode == 2 && seq == packets / 2) pkt[3 + n / 2] ^= 0x01;
        EpdImg_OnPacket(&rx, pkt, (uint8_t)(3 + n));
        if (mode == 1 && seq % 7 == 0) EpdImg_OnPacket(&rx, pkt, (uint8_t)(3 + n));
    }
    pkt[0] = EPD_IMG_PKT_END;
    pkt[1] = (uint8_t)packets;
    pkt[2] = (uint8_t)(packets >> 8);
    memcpy(pkt + 3, blob + 16, 4);
    EpdImg_OnPacket(&rx, pkt, 7);
    if (mode == 1) EpdImg_OnPacket(&rx, pkt, 7); /* tekrar gelen END durumu bozmamali */
    pkt[0] = EPD_IMG_PKT_STATUS;
    EpdImg_OnPacket(&rx, pkt, 1);
    EpdImg_Poll(&rx);
    if (m->ack_len != 6 || m->ack[0] != EPD_IMG_PKT_STATUS || memcmp(m->ack + 2, blob + 16, 4) != 0) {
        printf("  HATA: STATUS cevabi hatali\n");
        exit(1);
    }
    return m->ack[1];
}

int main(int argc, char **argv) {
    uint32_t blen, rlen;
    uint8_t *blob, *raw, st;
    Mock m;
    int fails = 0;
    if (argc < 3) { printf("kullanim: %s ornek.blob ornek.raw\n", argv[0]); return 2; }
    blob = read_file(argv[1], &blen);
    raw = read_file(argv[2], &rlen);
    memset(&m, 0, sizeof(m));
    m.size = rlen;
    m.ram = (uint8_t *)malloc(rlen);
    printf("%s: blob %u byte, panel verisi %u byte, format %u, %ux%u, sikistirma %u\n",
           argv[1], blen, rlen, blob[1], blob[4] | (blob[5] << 8), blob[6] | (blob[7] << 8), blob[2]);

    st = run(blob, blen, &m, 0);
    if (st != EPD_IMG_ST_OK || m.commits != 1 || memcmp(m.ram, raw, rlen) != 0) { printf("  [HATA] normal aktarim (durum %u)\n", st); fails++; }
    else printf("  [tamam] normal aktarim: panel verisi birebir ayni, ekran 1 kez yenilendi\n");

    memset(&m.began, 0, sizeof(int) * 3);
    st = run(blob, blen, &m, 1);
    if (st != EPD_IMG_ST_OK || m.commits != 1 || memcmp(m.ram, raw, rlen) != 0) { printf("  [HATA] tekrar gelen paketler (durum %u)\n", st); fails++; }
    else printf("  [tamam] tekrar gelen paketler yok sayildi\n");

    memset(&m.began, 0, sizeof(int) * 3);
    st = run(blob, blen, &m, 2);
    if ((st != EPD_IMG_ST_CRC && st != EPD_IMG_ST_SIZE) || m.commits != 0) { printf("  [HATA] bozuk veri (durum %u, yenileme %d)\n", st, m.commits); fails++; }
    else printf("  [tamam] bozuk veri reddedildi (durum %u), ekran yenilenmedi\n", st);

    memset(&m.began, 0, sizeof(int) * 3);
    st = run(blob, blen, &m, 3);
    if (st != EPD_IMG_ST_SEQ || m.commits != 0 || m.aborts != 1) { printf("  [HATA] eksik paket (durum %u)\n", st); fails++; }
    else printf("  [tamam] eksik paket fark edildi (SEQ), ekran yenilenmedi\n");

    free(blob); free(raw); free(m.ram);
    return fails ? 1 : 0;
}
