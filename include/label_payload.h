#pragma once
#include <Arduino.h>

// Bu duzen, e-paper_nfc/Core/Src/main.c ve nrf24l01_Receiver/Core/Src/radio_demo.c
// icindeki OFF_*/LEN_* sabitleriyle birebir eslesmelidir - biri degisirse digeri de
// guncellenmeli, aksi halde alici tarafta alanlar kayar.

#define OFF_MAGIC        0
#define LEN_MAGIC        4
#define OFF_TEMPLATE     (OFF_MAGIC + LEN_MAGIC)            // 4
#define OFF_DISCOUNT     (OFF_TEMPLATE + 1)                 // 5
#define OFF_CAMPAIGNFLAG (OFF_DISCOUNT + 1)                 // 6
#define OFF_BUSINESS     (OFF_CAMPAIGNFLAG + 1)             // 7
#define LEN_BUSINESS     16
#define OFF_NAME         (OFF_BUSINESS + LEN_BUSINESS)      // 23
#define LEN_NAME         34
#define OFF_SUBTITLE     (OFF_NAME + LEN_NAME)              // 57
#define LEN_SUBTITLE     16
#define OFF_PRICE        (OFF_SUBTITLE + LEN_SUBTITLE)      // 73
#define LEN_PRICE        6
#define OFF_OLDPRICE     (OFF_PRICE + LEN_PRICE)            // 79
#define LEN_OLDPRICE     6
#define OFF_UNIT         (OFF_OLDPRICE + LEN_OLDPRICE)      // 85
#define LEN_UNIT         5
#define OFF_BOTTOMCODE   (OFF_UNIT + LEN_UNIT)              // 90
#define LEN_BOTTOMCODE   14
#define OFF_CAMPAIGN     (OFF_BOTTOMCODE + LEN_BOTTOMCODE)  // 104
#define LEN_CAMPAIGN     14
#define OFF_BARCODE      (OFF_CAMPAIGN + LEN_CAMPAIGN)      // 118
#define LEN_BARCODE      12
#define OFF_INGREDIENTS  (OFF_BARCODE + LEN_BARCODE)        // 130
#define LEN_INGREDIENTS  70
#define OFF_ALLERGENS    (OFF_INGREDIENTS + LEN_INGREDIENTS)// 200
#define LEN_ALLERGENS    70
#define ESLD_TEXT_BYTES  (OFF_ALLERGENS + LEN_ALLERGENS)    // 270

#define LOGO_SIZE          32
#define LEN_LOGO_BITMAP    (LOGO_SIZE * LOGO_SIZE / 8)      // 128
#define OFF_LOGO_PRESENT   ESLD_TEXT_BYTES                  // 270
#define OFF_LOGO_BITMAP    (OFF_LOGO_PRESENT + 1)           // 271
#define TOTAL_LABEL_BYTES  (OFF_LOGO_BITMAP + LEN_LOGO_BITMAP) // 399

// Web formundan gelen alanlari tasiyan yapi (uzunluklar LEN_* ile ayni)
struct LabelFields {
    uint8_t templateID = 0;
    uint8_t discountEnabled = 0;
    uint8_t campaignEnabled = 0;
    String business;
    String name;
    String subtitle;
    String price;
    String oldPrice;
    String unit;
    String bottomCode;
    String campaignText;
    String barcode;
    String ingredients;
    String allergens;
    uint8_t logoPresent = 0;
    uint8_t logoBitmap[LEN_LOGO_BITMAP] = {0};
};

// fields icindeki verileri TOTAL_LABEL_BYTES boyutundaki out buffer'a paketler.
// Metin alanlari kendi LEN_* sinirina kirpilir ve kalan yer 0 ile doldurulur.
void PackLabelPayload(const LabelFields &fields, uint8_t out[TOTAL_LABEL_BYTES]);
