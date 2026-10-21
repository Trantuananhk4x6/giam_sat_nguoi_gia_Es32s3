#include "rf_remote.h"
#include "config.h"
#include "secrets.h"

#include <RCSwitch.h>

namespace RfRemote {

namespace {

RCSwitch g_rx;
bool     g_enabled   = false;
bool     g_pressed   = false;   ///< cờ "vừa bấm", chờ loop() lấy
uint32_t g_presses   = 0;
uint32_t g_rejected  = 0;
uint32_t g_lastCode  = 0;
uint32_t g_lastAccept = 0;      ///< chống nhận trùng một lần bấm

/**
 * Remote EV1527 phát lặp lại cùng một mã rất nhiều lần trong một lần bấm (để
 * chống nhiễu). Nếu không chặn thì một lần bấm sẽ bị tính thành hàng chục lần.
 * Chặn bằng cách bỏ qua mọi mã giống nhau đến trong vòng 2 giây.
 */
constexpr uint32_t REPEAT_BLOCK_MS = 2000;

bool isKnownCode(uint32_t code) {
    if (code == 0) return false;
    if (RF_REMOTE_CODE_1 != 0 && code == (uint32_t)RF_REMOTE_CODE_1) return true;
    if (RF_REMOTE_CODE_2 != 0 && code == (uint32_t)RF_REMOTE_CODE_2) return true;
    return false;
}

/// Chưa khai mã nào trong secrets.h -> đang ở bước "học mã"
bool learningMode() {
    return RF_REMOTE_CODE_1 == 0 && RF_REMOTE_CODE_2 == 0;
}

}  // namespace

bool begin() {
    if (PIN_RF_433 < 0) {
        Serial.println("[RF] Khong gan mach thu 433MHz (PIN_RF_433 = -1)");
        return false;
    }
    pinMode(PIN_RF_433, INPUT);
    // RCSwitch tự gắn ngắt (interrupt) vào chân này
    g_rx.enableReceive(digitalPinToInterrupt(PIN_RF_433));
    g_enabled = true;

    if (learningMode()) {
        Serial.println("[RF] CHE DO HOC MA: bam nut cua ban, ma se duoc in ra day.");
        Serial.println("[RF] Copy con so do vao RF_REMOTE_CODE_1 trong include/secrets.h");
    } else {
        Serial.printf("[RF] San sang, chi nhan ma %lu", (unsigned long)RF_REMOTE_CODE_1);
        if (RF_REMOTE_CODE_2 != 0) Serial.printf(" va %lu", (unsigned long)RF_REMOTE_CODE_2);
        Serial.println();
    }
    return true;
}

bool takePress() {
    if (!g_enabled) return false;

    while (g_rx.available()) {
        const uint32_t code = (uint32_t)g_rx.getReceivedValue();
        const uint8_t  bits = g_rx.getReceivedBitlength();
        g_rx.resetAvailable();
        if (code == 0) continue;          // nhiễu, RCSwitch trả về 0
        g_lastCode = code;

        if (learningMode()) {
            // Chưa khai mã: in ra cho người lắp đặt lấy, và vẫn CHO PHÉP kích
            // để thử ngay lúc mới lắp. Khai mã vào secrets.h thì mới an toàn.
            Serial.printf("[RF] Nhan duoc ma %lu (%u bit) -- chua khai trong secrets.h\n",
                          (unsigned long)code, bits);
        } else if (!isKnownCode(code)) {
            g_rejected++;
            Serial.printf("[RF] Bo qua ma la %lu (%u bit)\n", (unsigned long)code, bits);
            continue;
        }

        // Chặn nhận trùng: một lần bấm phát lặp cùng mã rất nhiều lần
        if (millis() - g_lastAccept < REPEAT_BLOCK_MS) continue;
        g_lastAccept = millis();
        g_presses++;
        g_pressed = true;
        Serial.printf("[RF] >>> NUT SOS DEO TAY (ma %lu) <<<\n", (unsigned long)code);
    }

    if (!g_pressed) return false;
    g_pressed = false;
    return true;
}

bool     enabled()       { return g_enabled; }
uint32_t pressCount()    { return g_presses; }
uint32_t rejectedCount() { return g_rejected; }
uint32_t lastCode()      { return g_lastCode; }

}  // namespace RfRemote
