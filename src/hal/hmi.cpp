#include "hmi.h"
#include "config.h"

namespace Hmi {

namespace {

// --------------------------- Nút nhấn có chống dội ---------------------------
struct Button {
    int      pin;
    bool     stable   = true;   // mức đã ổn định (true = nhả, do kéo lên)
    bool     lastRaw  = true;
    uint32_t lastEdge = 0;
    bool     pressed  = false;  // cờ "vừa bấm (ngắn)", chờ chương trình chính lấy

    // --- Phát hiện GIỮ LÂU (cho trợ lý: bấm-giữ-để-nói) ---
    // holdMs = 0 nghĩa là KHÔNG theo dõi giữ lâu cho nút này (giữ nguyên hành vi
    // cũ). Khi một lần giữ lâu đã được ghi nhận, lần nhả tay sau đó KHÔNG được
    // tính là bấm ngắn -> không kích hoạt nhầm "Tôi ổn".
    uint32_t holdMs      = 0;       // ngưỡng coi là giữ lâu (ms); 0 = tắt
    uint32_t downAt      = 0;       // millis() lúc nút được nhấn xuống
    bool     held        = false;   // cờ "vừa giữ đủ lâu", chờ lấy
    bool     holdFired   = false;   // đã bắn sự kiện giữ cho lần nhấn hiện tại
    bool     suppressTap = false;   // bỏ qua bấm ngắn cho lần nhả sắp tới

    void begin(int p, uint32_t holdThresholdMs = 0) {
        pin    = p;
        holdMs = holdThresholdMs;
        pinMode(pin, INPUT_PULLUP);
        stable = lastRaw = digitalRead(pin);
    }

    void update() {
        const bool raw = digitalRead(pin);
        if (raw != lastRaw) {            // có thay đổi -> bắt đầu tính thời gian ổn định
            lastRaw  = raw;
            lastEdge = millis();
            return;
        }

        // Trong lúc đang GIỮ (đã ổn định ở mức LOW): kiểm tra ngưỡng giữ lâu.
        if (holdMs > 0 && stable == LOW && !holdFired &&
            millis() - downAt >= holdMs) {
            held        = true;    // báo cho chương trình chính
            holdFired   = true;    // chỉ bắn một lần cho mỗi lần nhấn
            suppressTap = true;    // lần nhả tới KHÔNG tính là bấm ngắn
        }

        if (raw == stable) return;
        if (millis() - lastEdge < BTN_DEBOUNCE_MS) return;
        stable = raw;

        if (holdMs == 0) {
            // Nút KHÔNG theo dõi giữ lâu (vd nút SOS): giữ NGUYÊN hành vi cũ —
            // ghi nhận ngay lúc nhấn xuống để phản hồi SOS nhanh nhất có thể.
            if (stable == LOW) pressed = true;
            return;
        }

        // Nút CÓ theo dõi giữ lâu (vd nút xanh dùng cho trợ lý): phải chờ tới
        // lúc NHẢ mới biết là bấm ngắn hay giữ lâu, nên ghi nhận bấm ngắn khi nhả.
        if (stable == LOW) {               // vừa nhấn xuống
            downAt    = millis();
            holdFired = false;
        } else {                           // vừa nhả ra
            if (suppressTap) {
                suppressTap = false;       // vừa là một lần giữ lâu -> bỏ bấm ngắn
            } else {
                pressed = true;            // bấm ngắn bình thường -> "Tôi ổn"
            }
        }
    }

    bool take() {
        if (!pressed) return false;
        pressed = false;
        return true;
    }

    bool takeHold() {
        if (!held) return false;
        held = false;
        return true;
    }
};

Button g_btnOk, g_btnSos;

// ------------------------------- Đèn LED ------------------------------------
inline void ledWrite(int pin, bool on) {
    digitalWrite(pin, LED_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
}

SysState g_state   = ST_BOOT;
uint32_t g_blipEnd = 0;

// -------------------------------- Còi buzzer --------------------------------
constexpr uint8_t  BUZZER_LEDC_CH = 0;
bool     g_alarmOn     = false;
bool     g_alarmUrgent = false;
bool     g_buzzerUp    = false;
uint32_t g_buzzerNext  = 0;
bool     g_hasBuzzer   = false;

void buzzerTone(uint16_t freq) {
    if (!g_hasBuzzer) return;
    // ledcWriteTone() tự đặt chu kỳ xung ở mức 50% (to nhất với còi thụ động),
    // nên KHÔNG được gọi ledcWrite() sau nó, nếu không tiếng sẽ bị nhỏ đi.
    if (freq == 0) ledcWrite(BUZZER_LEDC_CH, 0);
    else           ledcWriteTone(BUZZER_LEDC_CH, freq);
}

}  // namespace

void begin() {
    // Nút xanh "Tôi ổn" đồng thời làm nút "bấm-giữ-để-nói" cho trợ lý: bấm NGẮN
    // vẫn là "Tôi ổn" (ghi nhận lúc nhả), GIỮ LÂU >= ASSISTANT_PTT_HOLD_MS thì
    // phát sự kiện giữ (takeOkHold). Đặt ASSISTANT_PTT_HOLD_MS = 0 trong config
    // để tắt hẳn, khi đó nút xanh quay về hành vi cũ (ghi nhận lúc nhấn).
    g_btnOk.begin(PIN_BTN_OK, ASSISTANT_PTT_HOLD_MS);
    // Nút SOS GIỮ NGUYÊN: ghi nhận ngay lúc nhấn để phản hồi khẩn cấp tức thì.
    g_btnSos.begin(PIN_BTN_SOS);

    pinMode(PIN_LED_GREEN, OUTPUT);
    pinMode(PIN_LED_YELLOW, OUTPUT);
    pinMode(PIN_LED_RED, OUTPUT);
    ledWrite(PIN_LED_GREEN, false);
    ledWrite(PIN_LED_YELLOW, false);
    ledWrite(PIN_LED_RED, false);

    g_hasBuzzer = (PIN_BUZZER >= 0);
    if (g_hasBuzzer) {
        ledcSetup(BUZZER_LEDC_CH, 2000, 8);
        ledcAttachPin(PIN_BUZZER, BUZZER_LEDC_CH);
        ledcWrite(BUZZER_LEDC_CH, 0);
    }
    Serial.println("[HMI] San sang (2 nut, 3 LED, buzzer)");
}

void update() {
    g_btnOk.update();
    g_btnSos.update();

    const uint32_t now = millis();

    // ----- Mẫu nháy LED theo trạng thái -----
    bool green = false, yellow = false, red = false;
    switch (g_state) {
        case ST_BOOT:
            yellow = (now / 150) % 2;                    // nháy nhanh: đang khởi động
            break;
        case ST_NO_PERSON:
            green = (now % 3000) < 80;                   // nháy rất ngắn mỗi 3s: vẫn sống
            break;
        case ST_PRESENT:
            green = true;                                // sáng liên tục: bình thường
            break;
        case ST_SUSPECT_FALL:
            yellow = (now / 250) % 2;                    // nháy nhanh: đang chờ phản hồi
            break;
        case ST_EMERGENCY:
            red = (now / 400) % 2;                       // nháy đỏ: đã báo động
            break;
    }
    if (now < g_blipEnd) yellow = true;                  // phản hồi thao tác

    ledWrite(PIN_LED_GREEN, green);
    ledWrite(PIN_LED_YELLOW, yellow);
    ledWrite(PIN_LED_RED, red);

    // ----- Còi báo động (bíp ngắt quãng, không dùng delay) -----
    if (!g_alarmOn) {
        if (g_buzzerUp) {
            buzzerTone(0);
            g_buzzerUp = false;
        }
        return;
    }
    const uint32_t onMs  = g_alarmUrgent ? 400 : 120;
    const uint32_t offMs = g_alarmUrgent ? 300 : 1400;
    if (now >= g_buzzerNext) {
        g_buzzerUp = !g_buzzerUp;
        buzzerTone(g_buzzerUp ? (g_alarmUrgent ? 2600 : 2000) : 0);
        g_buzzerNext = now + (g_buzzerUp ? onMs : offMs);
    }
}

bool takeOkPress()  { return g_btnOk.take(); }
bool takeOkHold()   { return g_btnOk.takeHold(); }
bool takeSosPress() { return g_btnSos.take(); }

void setState(SysState s) { g_state = s; }

void setAlarm(bool on, bool urgent) {
    if (g_alarmOn == on && g_alarmUrgent == urgent) return;
    g_alarmOn     = on;
    g_alarmUrgent = urgent;
    g_buzzerNext  = millis();
    if (!on) {
        buzzerTone(0);
        g_buzzerUp = false;
    }
}

void blip() { g_blipEnd = millis() + 150; }

}  // namespace Hmi
