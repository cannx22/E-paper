#include "label_payload.h"

static const uint8_t MAGIC_HEADER[LEN_MAGIC] = {'E', 'S', 'L', 'D'};

// LabelSenderApp/protocol.py encode_turkish() ile birebir eslesen tablo: bu 12
// Turkce harf, alici tarafin font tablosunda (GetTurkishTable) tek byte'lik
// 1-12 kodlariyla temsil ediliyor - UTF-8 baytlariyla degil.
struct TurkishMap { uint8_t utf8_1; uint8_t utf8_2; uint8_t code; };
static const TurkishMap TURKISH_TABLE[] = {
    {0xC3, 0x87, 1},  // Ç
    {0xC3, 0xA7, 2},  // ç
    {0xC4, 0x9E, 3},  // Ğ
    {0xC4, 0x9F, 4},  // ğ
    {0xC4, 0xB0, 5},  // İ
    {0xC4, 0xB1, 6},  // ı
    {0xC3, 0x96, 7},  // Ö
    {0xC3, 0xB6, 8},  // ö
    {0xC5, 0x9E, 9},  // Ş
    {0xC5, 0x9F, 10}, // ş
    {0xC3, 0x9C, 11}, // Ü
    {0xC3, 0xBC, 12}, // ü
};

// UTF-8 (taraycidan gelen form verisi) girdiyi firmware'in bekledigi ASCII +
// Turkce-kod semasina cevirir. Turkce harfler d'ki 1-12 koduna, ASCII oldugu
// gibi gecer; desteklenmeyen (diger cok byte'li) karakterler atlanir.
static String EncodeTurkish(const String &s) {
    String out;
    out.reserve(s.length());
    size_t i = 0;
    size_t len = s.length();
    while (i < len) {
        uint8_t b0 = (uint8_t)s[i];
        if (b0 < 0x80) {
            out += (char)b0;
            i += 1;
            continue;
        }
        if (b0 >= 0xC0 && i + 1 < len) {
            uint8_t b1 = (uint8_t)s[i + 1];
            bool matched = false;
            for (size_t k = 0; k < sizeof(TURKISH_TABLE) / sizeof(TURKISH_TABLE[0]); k++) {
                if (TURKISH_TABLE[k].utf8_1 == b0 && TURKISH_TABLE[k].utf8_2 == b1) {
                    out += (char)TURKISH_TABLE[k].code;
                    matched = true;
                    break;
                }
            }
            if (matched) {
                i += 2;
                continue;
            }
            // Desteklenmeyen cok byte'li UTF-8 karakter - baytlarini atla.
            i += (b0 >= 0xF0) ? 4 : (b0 >= 0xE0) ? 3 : 2;
            continue;
        }
        i += 1;
    }
    return out;
}

// s icerigini (Turkce kodlamasi uygulanmis olarak) out+offset konumuna en
// fazla maxLen byte olarak yazar, kalan kismi orijinal protokoldeki gibi
// space (0x20) ile doldurur (bkz. LabelSenderApp/protocol.py _pack_text).
static void WriteField(uint8_t *out, size_t offset, size_t maxLen, const String &s) {
    String encoded = EncodeTurkish(s);
    size_t copyLen = encoded.length();
    if (copyLen > maxLen) copyLen = maxLen;
    memcpy(out + offset, encoded.c_str(), copyLen);
    if (copyLen < maxLen) {
        memset(out + offset + copyLen, ' ', maxLen - copyLen);
    }
}

// Barkod alani: protocol.py _pack_barcode ile ayni - bos ise 12 adet '0',
// aksi halde ASCII rakam karakterleriyle (eksikse '0' ile tamamlanarak) yazilir.
static void WriteBarcode(uint8_t *out, size_t offset, size_t maxLen, const String &s) {
    size_t copyLen = s.length();
    if (copyLen > maxLen) copyLen = maxLen;
    memcpy(out + offset, s.c_str(), copyLen);
    if (copyLen < maxLen) {
        memset(out + offset + copyLen, '0', maxLen - copyLen);
    }
}

void PackLabelPayload(const LabelFields &fields, uint8_t out[TOTAL_LABEL_BYTES]) {
    memset(out, ' ', TOTAL_LABEL_BYTES);
    memcpy(out + OFF_MAGIC, MAGIC_HEADER, LEN_MAGIC);

    out[OFF_TEMPLATE] = fields.templateID;
    out[OFF_DISCOUNT] = fields.discountEnabled;
    out[OFF_CAMPAIGNFLAG] = fields.campaignEnabled;

    WriteField(out, OFF_BUSINESS, LEN_BUSINESS, fields.business);
    WriteField(out, OFF_NAME, LEN_NAME, fields.name);
    WriteField(out, OFF_SUBTITLE, LEN_SUBTITLE, fields.subtitle);
    WriteField(out, OFF_PRICE, LEN_PRICE, fields.price);
    WriteField(out, OFF_OLDPRICE, LEN_OLDPRICE, fields.oldPrice);
    WriteField(out, OFF_UNIT, LEN_UNIT, fields.unit);
    WriteField(out, OFF_BOTTOMCODE, LEN_BOTTOMCODE, fields.bottomCode);
    WriteField(out, OFF_CAMPAIGN, LEN_CAMPAIGN, fields.campaignText);

    WriteBarcode(out, OFF_BARCODE, LEN_BARCODE, fields.barcode);

    WriteField(out, OFF_INGREDIENTS, LEN_INGREDIENTS, fields.ingredients);
    WriteField(out, OFF_ALLERGENS, LEN_ALLERGENS, fields.allergens);

    out[OFF_LOGO_PRESENT] = fields.logoPresent ? 1 : 0;
    memcpy(out + OFF_LOGO_BITMAP, fields.logoBitmap, LEN_LOGO_BITMAP);
}
