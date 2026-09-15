#include "nrf_gateway.h"
#include <RF24.h>
#include "config.h"

static RF24 radio(NRF_CE_PIN, NRF_CSN_PIN);

bool NrfGateway_Init() {
    if (!radio.begin()) {
        return false;
    }

    radio.setChannel(40);                  // nRF24_SetRFChannel(40)
    radio.setDataRate(RF24_250KBPS);       // nRF24_SetDataRate(nRF24_DR_250kbps)
    radio.setCRCLength(RF24_CRC_16);       // nRF24_SetCRCScheme(nRF24_CRC_2byte)
    radio.setAddressWidth(NRF_ADDR_LEN);   // nRF24_SetAddrWidth(3)
    radio.setPALevel(RF24_PA_MAX);         // nRF24_SetTXPower(nRF24_TXPWR_0dBm)
    radio.setAutoAck(true);                // nRF24_EnableAA(nRF24_PIPE0)
    radio.setRetries(9, 10);               // nRF24_SetAutoRetr(nRF24_ARD_2500us, 10) -> (9+1)*250us = 2500us
    radio.enableDynamicPayloads();         // nRF24_SetDynamicPayloadLength(nRF24_DPL_ON)
    radio.enableAckPayload();              // nRF24_SetPayloadWithAck(1)
    radio.stopListening();                 // PTX modu (nRF24_MODE_TX)

    bool connected = radio.isChipConnected();

    // Cipin kendi register'larindan geri okunan gercek durumu yazdir - "ayarladim
    // sandigim" degil, cipin uzerinde fiilen ne oldugunu goruyoruz.
    Serial.println("--- nRF24 register durumu (chip'ten geri okundu) ---");
    radio.printPrettyDetails();
    Serial.println("--- nRF24 register durumu sonu ---");

    return connected;
}

SendResult NrfGateway_SendLabel(const uint8_t payload[TOTAL_LABEL_BYTES], const uint8_t targetAddr[NRF_ADDR_LEN]) {
    SendResult result;

    // ONEMLI - ADRES BAYT SIRASI DUZELTMESI:
    // Alici tarafindaki (STM32) nRF24_SetAddr() fonksiyonunda bir bug var:
    // addr_width'i SETUP_AW registerindan +1 ile hesapliyor (+2 olmasi gerekirken),
    // bu yanlis degerle calisan do-while donguisu telafi olarak tam adres
    // genisligi kadar (3) bayt yaziyor ama TERS SIRAYLA (addr[2], addr[1], addr[0]).
    // Yani "ESA" fiziksel register'a A,S,E (LSB->MSB) olarak yaziliyor.
    // RF24 kutuphanesi ise spec'e uygun DUZ sirada (E,S,A) yaziyor - bu yuzden
    // STM32 alicisiyla adresler hicbir zaman eslesmiyordu (MAX_RT'nin gercek
    // sebebi buydu, donanimla ilgisi yoktu). Burada adresi tersine cevirip
    // aliciyla ayni fiziksel register degerini olusturuyoruz.
    uint8_t reversedAddr[NRF_ADDR_LEN];
    for (uint8_t i = 0; i < NRF_ADDR_LEN; i++) {
        reversedAddr[i] = targetAddr[NRF_ADDR_LEN - 1 - i];
    }

    radio.openWritingPipe(reversedAddr);
    radio.openReadingPipe(0, reversedAddr);

    Serial.println("--- gonderim oncesi register durumu ---");
    radio.printPrettyDetails();
    Serial.println("--- gonderim oncesi register durumu sonu ---");

    uint8_t chunk[1 + NRF_CHUNK_DATA_LEN];

    for (uint8_t seq = 0; seq < NRF_CHUNK_COUNT; seq++) {
        uint16_t offset = (uint16_t)seq * NRF_CHUNK_DATA_LEN;
        uint16_t remaining = TOTAL_LABEL_BYTES - offset;
        uint8_t dataLen = (remaining > NRF_CHUNK_DATA_LEN) ? NRF_CHUNK_DATA_LEN : (uint8_t)remaining;

        chunk[0] = seq;
        memcpy(&chunk[1], payload + offset, dataLen);

        bool ok = radio.write(chunk, 1 + dataLen);
        if (!ok) {
            result.success = false;
            result.lastChunkSent = seq;
            return result;
        }

        // Alici her basarili parcaya "aCk PaYlOaD" ACK payload'u ile cevap
        // veriyor; kendi RX FIFO'muzda birikip sonraki gonderimi tikamamasi
        // icin hemen tuketiyoruz (nrf24l01_Receiver tarafindaki ayni mantik).
        while (radio.isAckPayloadAvailable()) {
            uint8_t ackBuf[32];
            radio.read(ackBuf, sizeof(ackBuf));
        }

        delay(2);
    }

    result.success = true;
    result.lastChunkSent = NRF_CHUNK_COUNT - 1;
    return result;
}
