/*
 * E-paper resim modu alicisi - aciklama: epd_image_rx.h, docs/resim-modu.md
 */
#include "epd_image_rx.h"
#include <stddef.h>
#include <string.h>

enum { ST_IDLE = 0, ST_RECEIVING = 1, ST_DONE = 2, ST_ERROR = 3 };

/* ---- CRC32 (IEEE, tablo flash'ta, 1 KB) ---- */
static const uint32_t CRC_TABLE[256] = {
    0x00000000u, 0x77073096u, 0xEE0E612Cu, 0x990951BAu, 0x076DC419u, 0x706AF48Fu, 0xE963A535u, 0x9E6495A3u,
    0x0EDB8832u, 0x79DCB8A4u, 0xE0D5E91Eu, 0x97D2D988u, 0x09B64C2Bu, 0x7EB17CBDu, 0xE7B82D07u, 0x90BF1D91u,
    0x1DB71064u, 0x6AB020F2u, 0xF3B97148u, 0x84BE41DEu, 0x1ADAD47Du, 0x6DDDE4EBu, 0xF4D4B551u, 0x83D385C7u,
    0x136C9856u, 0x646BA8C0u, 0xFD62F97Au, 0x8A65C9ECu, 0x14015C4Fu, 0x63066CD9u, 0xFA0F3D63u, 0x8D080DF5u,
    0x3B6E20C8u, 0x4C69105Eu, 0xD56041E4u, 0xA2677172u, 0x3C03E4D1u, 0x4B04D447u, 0xD20D85FDu, 0xA50AB56Bu,
    0x35B5A8FAu, 0x42B2986Cu, 0xDBBBC9D6u, 0xACBCF940u, 0x32D86CE3u, 0x45DF5C75u, 0xDCD60DCFu, 0xABD13D59u,
    0x26D930ACu, 0x51DE003Au, 0xC8D75180u, 0xBFD06116u, 0x21B4F4B5u, 0x56B3C423u, 0xCFBA9599u, 0xB8BDA50Fu,
    0x2802B89Eu, 0x5F058808u, 0xC60CD9B2u, 0xB10BE924u, 0x2F6F7C87u, 0x58684C11u, 0xC1611DABu, 0xB6662D3Du,
    0x76DC4190u, 0x01DB7106u, 0x98D220BCu, 0xEFD5102Au, 0x71B18589u, 0x06B6B51Fu, 0x9FBFE4A5u, 0xE8B8D433u,
    0x7807C9A2u, 0x0F00F934u, 0x9609A88Eu, 0xE10E9818u, 0x7F6A0DBBu, 0x086D3D2Du, 0x91646C97u, 0xE6635C01u,
    0x6B6B51F4u, 0x1C6C6162u, 0x856530D8u, 0xF262004Eu, 0x6C0695EDu, 0x1B01A57Bu, 0x8208F4C1u, 0xF50FC457u,
    0x65B0D9C6u, 0x12B7E950u, 0x8BBEB8EAu, 0xFCB9887Cu, 0x62DD1DDFu, 0x15DA2D49u, 0x8CD37CF3u, 0xFBD44C65u,
    0x4DB26158u, 0x3AB551CEu, 0xA3BC0074u, 0xD4BB30E2u, 0x4ADFA541u, 0x3DD895D7u, 0xA4D1C46Du, 0xD3D6F4FBu,
    0x4369E96Au, 0x346ED9FCu, 0xAD678846u, 0xDA60B8D0u, 0x44042D73u, 0x33031DE5u, 0xAA0A4C5Fu, 0xDD0D7CC9u,
    0x5005713Cu, 0x270241AAu, 0xBE0B1010u, 0xC90C2086u, 0x5768B525u, 0x206F85B3u, 0xB966D409u, 0xCE61E49Fu,
    0x5EDEF90Eu, 0x29D9C998u, 0xB0D09822u, 0xC7D7A8B4u, 0x59B33D17u, 0x2EB40D81u, 0xB7BD5C3Bu, 0xC0BA6CADu,
    0xEDB88320u, 0x9ABFB3B6u, 0x03B6E20Cu, 0x74B1D29Au, 0xEAD54739u, 0x9DD277AFu, 0x04DB2615u, 0x73DC1683u,
    0xE3630B12u, 0x94643B84u, 0x0D6D6A3Eu, 0x7A6A5AA8u, 0xE40ECF0Bu, 0x9309FF9Du, 0x0A00AE27u, 0x7D079EB1u,
    0xF00F9344u, 0x8708A3D2u, 0x1E01F268u, 0x6906C2FEu, 0xF762575Du, 0x806567CBu, 0x196C3671u, 0x6E6B06E7u,
    0xFED41B76u, 0x89D32BE0u, 0x10DA7A5Au, 0x67DD4ACCu, 0xF9B9DF6Fu, 0x8EBEEFF9u, 0x17B7BE43u, 0x60B08ED5u,
    0xD6D6A3E8u, 0xA1D1937Eu, 0x38D8C2C4u, 0x4FDFF252u, 0xD1BB67F1u, 0xA6BC5767u, 0x3FB506DDu, 0x48B2364Bu,
    0xD80D2BDAu, 0xAF0A1B4Cu, 0x36034AF6u, 0x41047A60u, 0xDF60EFC3u, 0xA867DF55u, 0x316E8EEFu, 0x4669BE79u,
    0xCB61B38Cu, 0xBC66831Au, 0x256FD2A0u, 0x5268E236u, 0xCC0C7795u, 0xBB0B4703u, 0x220216B9u, 0x5505262Fu,
    0xC5BA3BBEu, 0xB2BD0B28u, 0x2BB45A92u, 0x5CB36A04u, 0xC2D7FFA7u, 0xB5D0CF31u, 0x2CD99E8Bu, 0x5BDEAE1Du,
    0x9B64C2B0u, 0xEC63F226u, 0x756AA39Cu, 0x026D930Au, 0x9C0906A9u, 0xEB0E363Fu, 0x72076785u, 0x05005713u,
    0x95BF4A82u, 0xE2B87A14u, 0x7BB12BAEu, 0x0CB61B38u, 0x92D28E9Bu, 0xE5D5BE0Du, 0x7CDCEFB7u, 0x0BDBDF21u,
    0x86D3D2D4u, 0xF1D4E242u, 0x68DDB3F8u, 0x1FDA836Eu, 0x81BE16CDu, 0xF6B9265Bu, 0x6FB077E1u, 0x18B74777u,
    0x88085AE6u, 0xFF0F6A70u, 0x66063BCAu, 0x11010B5Cu, 0x8F659EFFu, 0xF862AE69u, 0x616BFFD3u, 0x166CCF45u,
    0xA00AE278u, 0xD70DD2EEu, 0x4E048354u, 0x3903B3C2u, 0xA7672661u, 0xD06016F7u, 0x4969474Du, 0x3E6E77DBu,
    0xAED16A4Au, 0xD9D65ADCu, 0x40DF0B66u, 0x37D83BF0u, 0xA9BCAE53u, 0xDEBB9EC5u, 0x47B2CF7Fu, 0x30B5FFE9u,
    0xBDBDF21Cu, 0xCABAC28Au, 0x53B39330u, 0x24B4A3A6u, 0xBAD03605u, 0xCDD70693u, 0x54DE5729u, 0x23D967BFu,
    0xB3667A2Eu, 0xC4614AB8u, 0x5D681B02u, 0x2A6F2B94u, 0xB40BBE37u, 0xC30C8EA1u, 0x5A05DF1Bu, 0x2D02EF8Du,
};

uint32_t EpdImg_Crc32(uint32_t crc, const uint8_t *data, uint32_t len) {
    crc = ~crc;
    while (len--) crc = CRC_TABLE[(crc ^ *data++) & 0xFFu] ^ (crc >> 8);
    return ~crc;
}

static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint16_t rd16(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

/* Gateway'in STATUS sorgusuna gidecek cevap: [0xA4][durum][CRC32 LE] */
static void arm_status(EpdImgRx *rx) {
    uint8_t a[6];
    a[0] = EPD_IMG_PKT_STATUS;
    a[1] = rx->status;
    a[2] = (uint8_t)rx->crc_expected;
    a[3] = (uint8_t)(rx->crc_expected >> 8);
    a[4] = (uint8_t)(rx->crc_expected >> 16);
    a[5] = (uint8_t)(rx->crc_expected >> 24);
    if (rx->ops->set_ack) rx->ops->set_ack(rx->ops->ctx, a, sizeof(a));
}

static void fail(EpdImgRx *rx, uint8_t status) {
    if (rx->state == ST_RECEIVING && rx->ops->abort) rx->ops->abort(rx->ops->ctx);
    rx->state = ST_ERROR;
    rx->status = status;
    rx->out_len = 0;
    arm_status(rx);
}

/* Tamponu panele yaz (TWO_PLANE'de duzlem sinirinda bolunur). */
static void flush_out(EpdImgRx *rx) {
    uint8_t *p = rx->out;
    uint16_t n = rx->out_len;
    uint32_t off = rx->raw_pos - n;
    while (n) {
        uint16_t k = n;
        if (rx->plane_len && off < rx->plane_len && off + k > rx->plane_len) k = (uint16_t)(rx->plane_len - off);
        rx->ops->write(rx->ops->ctx, off, p, k);
        p += k; off += k; n -= k;
    }
    rx->out_len = 0;
}

/* Acilmis bir byte: CRC'ye ekle, tampona koy. 0 = uzunluk asildi. */
static int put_raw(EpdImgRx *rx, uint8_t b) {
    if (rx->raw_pos >= rx->raw_len) return 0;
    rx->crc = CRC_TABLE[(rx->crc ^ b) & 0xFFu] ^ (rx->crc >> 8); /* ters cevrilmis CRC uzerinde calisir */
    rx->out[rx->out_len++] = b;
    rx->raw_pos++;
    if (rx->out_len == sizeof(rx->out)) flush_out(rx);
    return 1;
}

/* Alinan (sikistirilmis) veri byte'larini isle. 0 = hata. */
static int feed(EpdImgRx *rx, const uint8_t *d, uint8_t n) {
    uint8_t i;
    for (i = 0; i < n; i++) {
        uint8_t b = d[i];
        if (rx->compression == EPD_IMG_COMP_NONE) {
            if (!put_raw(rx, b)) return 0;
            continue;
        }
        /* RLE: 0x00-0x7F -> ardindan (c+1) byte duz; 0x80-0xFF -> sonraki byte (c-126) kez */
        if (rx->rle_mode == 0) {
            if (b < 0x80) { rx->rle_mode = 1; rx->rle_count = (uint8_t)(b + 1); }
            else { rx->rle_mode = 2; rx->rle_count = (uint8_t)(b - 126); }
        } else if (rx->rle_mode == 1) {
            if (!put_raw(rx, b)) return 0;
            if (--rx->rle_count == 0) rx->rle_mode = 0;
        } else {
            uint8_t k;
            for (k = 0; k < rx->rle_count; k++) if (!put_raw(rx, b)) return 0;
            rx->rle_mode = 0;
        }
    }
    return 1;
}

static uint32_t expected_raw_len(uint8_t format, uint16_t w, uint16_t h, uint32_t *plane) {
    uint32_t p1 = (uint32_t)((w + 7u) / 8u) * h;
    *plane = 0;
    if (format == EPD_IMG_FMT_BW) return p1;
    if (format == EPD_IMG_FMT_TWO_PLANE) { *plane = p1; return p1 * 2u; }
    if (format == EPD_IMG_FMT_BWRY) return (uint32_t)((w + 3u) / 4u) * h;
    return 0;
}

static void on_start(EpdImgRx *rx, const uint8_t *pkt, uint8_t len) {
    const uint8_t *h = pkt + 1;
    uint32_t plane;
    if (rx->commit_pending) {
        /* Onceki goruntu henuz ekrana basilmadi; yenisini sonra alalim. */
        rx->status = EPD_IMG_ST_BUSY;
        arm_status(rx);
        return;
    }
    if (rx->state == ST_RECEIVING && rx->ops->abort) rx->ops->abort(rx->ops->ctx);
    memset(&rx->format, 0, sizeof(EpdImgRx) - offsetof(EpdImgRx, format));
    if (len < 1 + EPD_IMG_HEADER_LEN) { fail(rx, EPD_IMG_ST_FORMAT); return; }
    rx->format = h[1];
    rx->compression = h[2];
    rx->width = rd16(h + 4);
    rx->height = rd16(h + 6);
    rx->raw_len = rd32(h + 8);
    rx->data_len = rd32(h + 12);
    rx->crc_expected = rd32(h + 16);
    if (h[0] != EPD_IMG_VERSION || rx->compression > EPD_IMG_COMP_RLE ||
        expected_raw_len(rx->format, rx->width, rx->height, &plane) != rx->raw_len || rx->raw_len == 0) {
        rx->state = ST_ERROR;
        rx->status = EPD_IMG_ST_FORMAT;
        arm_status(rx);
        return;
    }
    rx->plane_len = plane;
    if (rx->ops->begin(rx->ops->ctx, rx->format, rx->width, rx->height) != 0) {
        rx->state = ST_ERROR;
        rx->status = EPD_IMG_ST_FORMAT;
        arm_status(rx);
        return;
    }
    rx->crc = 0xFFFFFFFFu;
    rx->state = ST_RECEIVING;
    rx->status = EPD_IMG_ST_RECEIVING;
    arm_status(rx);
}

static void on_data(EpdImgRx *rx, const uint8_t *pkt, uint8_t len) {
    uint16_t seq;
    uint8_t n;
    if (rx->state != ST_RECEIVING || len < 4) return;
    seq = rd16(pkt + 1);
    if (seq == (uint16_t)(rx->next_seq - 1u) && rx->next_seq) return; /* tekrar gelen paket (ACK kayboldu) */
    if (seq != rx->next_seq) { fail(rx, EPD_IMG_ST_SEQ); return; }
    n = (uint8_t)(len - 3);
    if (rx->data_pos + n > rx->data_len) { fail(rx, EPD_IMG_ST_SIZE); return; }
    if (!feed(rx, pkt + 3, n)) { fail(rx, EPD_IMG_ST_SIZE); return; }
    rx->data_pos += n;
    rx->next_seq++;
}

static void on_end(EpdImgRx *rx, const uint8_t *pkt, uint8_t len) {
    uint32_t crc;
    if (rx->state != ST_RECEIVING) { arm_status(rx); return; } /* tekrar gelen END: durumu koru */
    if (len < 7 || rd16(pkt + 1) != rx->next_seq) { fail(rx, EPD_IMG_ST_SEQ); return; }
    if (rx->data_pos != rx->data_len || rx->raw_pos != rx->raw_len || rx->rle_mode != 0) { fail(rx, EPD_IMG_ST_SIZE); return; }
    if (rx->out_len) flush_out(rx);
    crc = ~rx->crc;
    if (crc != rx->crc_expected || rd32(pkt + 3) != rx->crc_expected) { fail(rx, EPD_IMG_ST_CRC); return; }
    rx->state = ST_DONE;
    rx->status = EPD_IMG_ST_OK;
    rx->commit_pending = 1;
    arm_status(rx); /* gateway STATUS ile soracak; ekran yenilemesi Poll'da */
}

void EpdImg_Init(EpdImgRx *rx, const EpdImgOps *ops) {
    memset(rx, 0, sizeof(*rx));
    rx->ops = ops;
    rx->state = ST_IDLE;
    rx->status = EPD_IMG_ST_IDLE;
}

int EpdImg_OnPacket(EpdImgRx *rx, const uint8_t *pkt, uint8_t len) {
    if (!len) return 0;
    switch (pkt[0]) {
        case EPD_IMG_PKT_START:  on_start(rx, pkt, len); return 1;
        case EPD_IMG_PKT_DATA:   on_data(rx, pkt, len); return 1;
        case EPD_IMG_PKT_END:    on_end(rx, pkt, len); return 1;
        case EPD_IMG_PKT_STATUS: arm_status(rx); return 1; /* bir sonraki sorgu icin cevabi tekrar yukle */
        default: return 0;
    }
}

int EpdImg_Poll(EpdImgRx *rx) {
    if (!rx->commit_pending) return 0;
    rx->commit_pending = 0;
    if (rx->ops->commit) rx->ops->commit(rx->ops->ctx);
    return 1;
}

uint8_t EpdImg_Status(const EpdImgRx *rx) {
    return rx->status;
}
