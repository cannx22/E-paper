#pragma once
#include <Arduino.h>
#include "label_payload.h"

// nrf24l01_Receiver/Core/Src/radio_demo.c (DEMO_RX_ESB_ACK_PL) ile birebir
// eslesen hava-uzeri (over-the-air) parcalama protokolu:
//   her paket = [seq byte][en fazla NRF_CHUNK_DATA_LEN veri byte'i]
//   seq: 0..NRF_CHUNK_COUNT-1, son parca daha kisa (399 - 13*30 = 9 byte)
#define NRF_ADDR_LEN       3
#define NRF_CHUNK_DATA_LEN 30
#define NRF_CHUNK_COUNT    ((TOTAL_LABEL_BYTES + NRF_CHUNK_DATA_LEN - 1) / NRF_CHUNK_DATA_LEN) // 14

struct SendResult {
    bool success = false;
    uint8_t lastChunkSent = 0; // basarisizlik durumunda kac parca gittigini gosterir
    uint8_t totalChunks = NRF_CHUNK_COUNT;
};

// SPI + nRF24L01+ donanimini NRF_TRANSMITTER (DEMO_TX_ESB_ACK_PL) projesindeki
// ayarlarla ayni sekilde baslatir: kanal 40, 250kbps, adres genisligi 3,
// CRC 2 byte, Enhanced ShockBurst (Auto-ACK) + Dynamic Payload + ACK payload.
bool NrfGateway_Init();

// payload (TOTAL_LABEL_BYTES) verisini targetAddr (3 byte, ornegin "ESA"/"ESB")
// adresine NRF_CHUNK_COUNT parca halinde gonderir.
SendResult NrfGateway_SendLabel(const uint8_t payload[TOTAL_LABEL_BYTES], const uint8_t targetAddr[NRF_ADDR_LEN]);
