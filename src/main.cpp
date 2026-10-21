/**
 * =============================================================================
 *  HỆ THỐNG GIÁM SÁT VÀ CẢNH BÁO TÉ NGÃ CHO NGƯỜI CAO TUỔI
 *  Radar sóng milimet 60 GHz (DFRobot C1001) + ESP32-S3
 *  Đồ án tổng hợp (402114)
 * =============================================================================
 *
 *  LUỒNG HOẠT ĐỘNG (máy trạng thái ở mục 4 của bản kế hoạch)
 *
 *      KHÔNG_NGƯỜI ──(radar thấy người)──> CÓ_NGƯỜI
 *           ^                                 │
 *           └──(radar không thấy người)───────┘
 *                                             │ (radar báo té ngã)
 *                                             v
 *                                      NGHI_NGỜ_TÉ_NGÃ
 *                            loa hỏi thăm + đếm ngược 30 giây
 *                                      │               │
 *                     (bấm "Tôi ổn") ──┘               └── (hết giờ / bấm SOS)
 *                              │                                   │
 *                              v                                   v
 *                      về CÓ_NGƯỜI                            KHẨN_CẤP
 *                 (ghi log, nghỉ 60 giây)              (gửi Telegram, LED đỏ)
 *
 *  PHÂN CHIA CÔNG VIỆC GIỮA HAI NHÂN (core) CỦA ESP32-S3
 *      core 0 : task đọc radar (thư viện DFRobot chạy chậm và hay chặn)
 *      core 1 : loop() – máy trạng thái, nút, LED
 *               task phát âm thanh I2S
 *               task gửi Telegram (bắt tay HTTPS mất 1–3 giây)
 *               task của máy chủ web không đồng bộ (AsyncTCP)
 *      Nhờ tách task, thao tác bấm nút luôn được phản hồi dưới 50 ms.
 * =============================================================================
 */
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <LittleFS.h>

#include "config.h"
#include "secrets.h"

// Mã nguồn chia theo layer (xem build_flags trong platformio.ini):
#include "core/app_types.h"     // kiểu dữ liệu chung
#include "core/app_api.h"       // cầu nối web <-> máy trạng thái
#include "hal/audio.h"          // loa I2S / MAX98357A
#include "hal/assistant.h"      // trợ lý hội thoại kiểu Xiaozhi (mic INMP441)
#include "hal/hmi.h"            // nút bấm, LED, còi
#include "hal/radar.h"          // radar C1001 qua UART
#include "hal/rf_remote.h"      // nút SOS đeo tay 433 MHz
#include "net/notifier.h"       // gửi Telegram
#include "net/web_ui.h"         // máy chủ web + WebSocket
#include "net/wifi_mgr.h"       // bộ quản lý đa Wi-Fi (NVS + AP cấu hình)
#include "storage/event_log.h"  // nhật ký sự kiện LittleFS

// ===========================================================================
//  Biến trạng thái
// ===========================================================================
namespace {

volatile SysState g_state = ST_BOOT;
uint32_t g_stateSince = 0;     ///< millis() lúc vào trạng thái hiện tại

uint32_t g_suspectStart  = 0;  ///< lúc bắt đầu đếm ngược chờ phản hồi
uint32_t g_fallDetectedAt = 0; ///< lúc radar báo ngã (để tính thời gian cảnh báo)
uint32_t g_cooldownUntil = 0;  ///< trong khoảng này thì bỏ qua báo ngã mới
uint32_t g_lastVoiceAt   = 0;  ///< lần phát loa hỏi thăm gần nhất
uint8_t  g_voiceCount    = 0;  ///< đã hỏi thăm bao nhiêu lần trong lượt này

uint32_t g_emergencyAt    = 0; ///< lúc chuyển sang KHẨN_CẤP
bool     g_awaitDelivery  = false;
uint32_t g_alertLatencyMs = 0; ///< thời gian từ lúc ngã tới lúc Telegram gửi xong

// Cờ yêu cầu đến từ trang web (đặt bởi task web, xử lý trong loop)
volatile bool g_reqIamOk     = false;
volatile bool g_reqSos       = false;
volatile bool g_reqSimFall   = false;
volatile bool g_reqTestVoice = false;
volatile bool g_reqTestTg    = false;
volatile bool g_reqTestMail  = false;
volatile bool g_reqTestZalo  = false;
volatile bool g_reqClearLog  = false;
volatile bool g_reqAssistant = false;   // yêu cầu kích hoạt trợ lý (từ web)
volatile int8_t g_reqPresence = -1;   // -1 không yêu cầu, 0 = ra, 1 = vào

// Lời nhắn người nhà chờ loa phát (dashboard đẩy WAV xuống, hoặc lệnh /hoitham).
// Task web / task Telegram ghi, loop() đọc: chuỗi được chép trong spinlock để
// loop() không bao giờ đọc phải tên/đường dẫn đang ghi dở.
portMUX_TYPE      g_sayMux      = portMUX_INITIALIZER_UNLOCKED;
volatile bool     g_reqSay      = false;
char              g_sayFrom[48] = "";      ///< tên người gửi, tối đa SAY_FROM_MAX byte
char              g_sayPath[24] = "";      ///< file WAV trong LittleFS
volatile uint32_t g_sayReqAt    = 0;       ///< millis() lúc nhận yêu cầu
bool              g_sayPlaying  = false;   ///< loa đang đọc lời nhắn (chỉ loop() dùng)
constexpr size_t   SAY_FROM_MAX    = 40;      ///< "tu " + tên vẫn vừa note[64] của nhật ký
constexpr uint32_t SAY_WAIT_MAX_MS = 60000;   ///< loa bận quá lâu thì bỏ lời nhắn

// Cảnh báo sinh hiệu (chỉ hoạt động khi ENABLE_SLEEP_MODE = true)
uint32_t g_vitalBadSince = 0;   ///< millis() lúc bắt đầu vượt ngưỡng liên tục
uint32_t g_vitalAlertAt  = 0;   ///< lần gửi cảnh báo sinh hiệu gần nhất

bool g_wifiWasUp   = false;
bool g_timeSynced  = false;

// ===========================================================================
//  Hàm phụ trợ
// ===========================================================================

/// Thoát các ký tự đặc biệt để tin nhắn Telegram ở chế độ HTML không bị lỗi.
String esc(const String& s) {
    String o;
    o.reserve(s.length() + 8);
    for (size_t i = 0; i < s.length(); ++i) {
        const char c = s[i];
        if      (c == '&') o += "&amp;";
        else if (c == '<') o += "&lt;";
        else if (c == '>') o += "&gt;";
        else               o += c;
    }
    return o;
}

/// Độ dài (1..4 byte) của ký tự UTF-8 hợp lệ bắt đầu tại s; 0 nếu là byte lỗi.
size_t utf8CharLen(const uint8_t* s, size_t avail) {
    const uint8_t c = s[0];
    if (c < 0x80) return 1;
    size_t  n;
    uint8_t lo = 0x80, hi = 0xBF;   // khoảng hợp lệ của byte thứ hai
    if      (c >= 0xC2 && c <= 0xDF) n = 2;
    else if (c >= 0xE0 && c <= 0xEF) { n = 3; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { n = 4; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    else return 0;
    if (avail < n || s[1] < lo || s[1] > hi) return 0;
    for (size_t i = 2; i < n; ++i)
        if ((s[i] & 0xC0) != 0x80) return 0;
    return n;
}

/**
 * Chép tên người gửi lời nhắn vào dst, tối đa maxBytes byte và KHÔNG cắt đôi
 * một ký tự UTF-8 (chữ "â" trong "Lâm" dài 2 byte, emoji dài 4 byte).
 *
 * Đồng thời bỏ byte UTF-8 lỗi, ký tự điều khiển và < > & " — tên này do người
 * ngoài gõ (tham số web, tên Telegram) rồi đi vào nhật ký: trang web hiện nhật
 * ký bằng innerHTML, file CSV bọc ghi chú trong dấu ", còn WebSocket sẽ đóng kết
 * nối nếu gặp UTF-8 lỗi.
 */
void copySenderName(char* dst, size_t cap, const char* src, size_t maxBytes) {
    if (maxBytes > cap - 1) maxBytes = cap - 1;
    const uint8_t* s   = (const uint8_t*)(src ? src : "");
    const size_t   len = strlen((const char*)s);
    size_t o = 0;
    for (size_t i = 0; i < len;) {
        const size_t n = utf8CharLen(s + i, len - i);
        const bool drop = (n == 0) ||
                          (n == 1 && (s[i] < 0x20 || s[i] == 0x7F || strchr("<>&\"", s[i]) ||
                                      (s[i] == ' ' && o == 0)));   // bỏ khoảng trắng đầu
        if (drop) { ++i; continue; }
        if (o + n > maxBytes) break;   // không đủ chỗ cho trọn ký tự -> dừng
        memcpy(dst + o, s + i, n);
        o += n;
        i += n;
    }
    while (o > 0 && dst[o - 1] == ' ') --o;   // bỏ khoảng trắng cuối
    dst[o] = '\0';
}

/// Chuỗi ngày giờ theo múi giờ Việt Nam, dùng trong tin nhắn và log.
String clockText() {
    const time_t now = time(nullptr);
    if (now < 1600000000) return String("chưa đồng bộ giờ (uptime ") + (millis() / 1000) + "s)";
    struct tm tmv;
    localtime_r(&now, &tmv);
    char buf[32];
    strftime(buf, sizeof(buf), "%H:%M:%S ngày %d/%m/%Y", &tmv);
    return String(buf);
}

void gotoState(SysState s) {
    if (g_state == s) return;
    g_state      = s;
    g_stateSince = millis();
    Hmi::setState(s);
    Hmi::setAlarm(s == ST_SUSPECT_FALL || s == ST_EMERGENCY, s == ST_EMERGENCY);
    Serial.printf("[STATE] -> %s\n", stateName(s));
    WebUi::pushNow();
}

/// Vào trạng thái nghi ngờ té ngã: phát loa hỏi thăm và bắt đầu đếm ngược.
void enterSuspect(EventSource src, const char* note) {
    g_suspectStart   = millis();
    g_fallDetectedAt = millis();
    g_lastVoiceAt    = 0;
    g_voiceCount     = 0;
    EventLog::add(EV_FALL_SUSPECT, src, ST_SUSPECT_FALL, note);
    gotoState(ST_SUSPECT_FALL);
}

/// Phát cảnh báo khẩn cấp: ghi log, đẩy tin Telegram vào hàng đợi.
void raiseEmergency(EventSource src, const String& reasonVi, const char* note) {
    g_emergencyAt   = millis();
    g_awaitDelivery = true;
    EventLog::add(EV_EMERGENCY, src, ST_EMERGENCY, note);
    gotoState(ST_EMERGENCY);

    // Ghi chú: thư viện String của Arduino KHÔNG có phép "chuỗi hằng" + String,
    // nên mọi tin nhắn đều được ghép bằng các lệnh += liên tiếp (cũng đỡ tốn RAM).
    const RadarSnapshot r = Radar::snapshot();
    String msg;
    msg.reserve(420);
    msg += "\xF0\x9F\x9A\xA8 <b>CẢNH BÁO TÉ NGÃ</b> \xF0\x9F\x9A\xA8\n";
    msg += "\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\n";
    msg += "\xF0\x9F\x91\xA4 <b>Người giám sát:</b> ";
    msg += esc(PATIENT_NAME);
    msg += "\n\xF0\x9F\x93\x8D <b>Vị trí:</b> ";
    msg += esc(DEVICE_PLACE);
    msg += "\n\xF0\x9F\x95\x92 <b>Thời điểm:</b> ";
    msg += esc(clockText());
    msg += "\n\xE2\x9A\xA0\xEF\xB8\x8F <b>Nguyên nhân:</b> ";
    msg += esc(reasonVi);
    msg += "\n\xF0\x9F\x93\xA1 <b>Radar:</b> ";
    msg += r.present ? "còn thấy người trong phòng" : "không còn thấy người trong phòng";
    msg += r.staticStay ? ", đang nằm im một chỗ." : ".";
    if (WiFi.status() == WL_CONNECTED) {
        msg += "\n\xF0\x9F\x94\x97 <a href=\"http://";
        msg += WiFi.localIP().toString();
        msg += "/\">Xem trực tiếp trang giám sát</a>";
    }
    msg += "\n\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\xE2\x94\x81\n";
    msg += "<b>\xF0\x9F\x86\x98 Hãy gọi điện hoặc tới kiểm tra ngay!</b>";
    Notifier::send(msg);

    Audio::play(AUDIO_FILE_ALERT, true);   // nếu chưa có file thì tự phát tiếng bíp
}

/// Người dùng xác nhận vẫn ổn (từ nút bấm hoặc từ trang web).
void confirmSafe(EventSource src) {
    char note[64];

    if (g_state == ST_SUSPECT_FALL) {
        const uint32_t responseMs = millis() - g_suspectStart;
        snprintf(note, sizeof(note), "phan hoi sau %lu.%lus",
                 (unsigned long)(responseMs / 1000), (unsigned long)((responseMs % 1000) / 100));
        EventLog::add(EV_CANCELLED, src, ST_SUSPECT_FALL, note);
        g_cooldownUntil = millis() + FALL_COOLDOWN_S * 1000UL;
        Audio::play(AUDIO_FILE_OK, true);
        gotoState(ST_PRESENT);
        return;
    }

    if (g_state == ST_EMERGENCY) {
        const uint32_t sinceMs = millis() - g_emergencyAt;
        snprintf(note, sizeof(note), "xac nhan an toan sau %lus",
                 (unsigned long)(sinceMs / 1000));
        EventLog::add(EV_RECOVERED, src, ST_EMERGENCY, note);
        String msg = "\xE2\x9C\x85 <b>ĐÃ XÁC NHẬN AN TOÀN</b>\n";
        msg += esc(PATIENT_NAME);
        msg += " đã bấm nút xác nhận ổn lúc ";
        msg += esc(clockText());
        msg += ".";
        Notifier::send(msg);
        g_cooldownUntil = millis() + FALL_COOLDOWN_S * 1000UL;
        gotoState(ST_PRESENT);
        return;
    }

    // Bấm lúc hệ thống bình thường: coi như thao tác kiểm tra nút
    Hmi::blip();
    EventLog::add(EV_TEST, src, g_state, "bam nut xanh luc binh thuong");
    WebUi::pushNow();
}

/// Trong lúc đếm ngược: phát lại câu hỏi thăm theo chu kỳ.
void serviceVoicePrompt() {
    const uint32_t now = millis();
    const bool firstTime = (g_lastVoiceAt == 0);
    if (!firstTime && now - g_lastVoiceAt < VOICE_REPEAT_EVERY_S * 1000UL) return;
    // Không chen vào khi loa đang phát dở
    if (Audio::isPlaying()) return;
    // Chỉ hỏi tối đa số lần vừa đủ trong khung thời gian chờ
    if (g_voiceCount >= (CONFIRM_WINDOW_S / VOICE_REPEAT_EVERY_S) + 1) return;
    g_lastVoiceAt = now;
    g_voiceCount++;
    Audio::play(AUDIO_FILE_ASK);
    Serial.printf("[VOICE] Hoi tham lan %u\n", g_voiceCount);
}

/**
 * Theo dõi nhịp tim / nhịp thở lúc đang ở chế độ giấc ngủ.
 *
 * Ngưỡng để RẤT RỘNG và phải vượt ngưỡng liên tục một phút mới gửi tin. Lý do:
 * một cảnh báo giả lúc 2 giờ sáng làm người thân mất ngủ và lần sau họ sẽ tắt
 * thông báo — lúc đó cảnh báo thật cũng vô nghĩa. Thà bỏ sót vài ca nhẹ còn hơn
 * làm người ta mất niềm tin vào hệ thống.
 *
 * LƯU Ý: số liệu này là ƯỚC LƯỢNG bằng sóng milimet, KHÔNG phải thiết bị y tế.
 * Nội dung tin nhắn luôn ghi rõ điều đó.
 */
void serviceVitals() {
    if (!ENABLE_SLEEP_MODE) return;

    const RadarSnapshot r = Radar::snapshot();
    if (r.mode != RM_SLEEP || !r.vitals.valid) {
        g_vitalBadSince = 0;
        return;
    }

    const char* reason = nullptr;
    const uint8_t hr = r.vitals.heartRate;
    const uint8_t br = r.vitals.breatheValue;

    if (r.vitals.struggle == 1) {
        reason = "Phát hiện vùng vẫy bất thường trong lúc ngủ";
    } else if (hr > 0 && (hr < HR_ALERT_MIN || hr > HR_ALERT_MAX)) {
        reason = "Nhịp tim ước lượng ngoài ngưỡng bình thường";
    } else if (br > 0 && (br < BREATHE_ALERT_MIN || br > BREATHE_ALERT_MAX)) {
        reason = "Nhịp thở ước lượng ngoài ngưỡng bình thường";
    }

    if (reason == nullptr) {
        g_vitalBadSince = 0;
        return;
    }
    if (g_vitalBadSince == 0) {
        g_vitalBadSince = millis();
        return;
    }
    if (millis() - g_vitalBadSince < VITALS_ALERT_AFTER_S * 1000UL) return;
    if (g_vitalAlertAt != 0 &&
        millis() - g_vitalAlertAt < VITALS_ALERT_COOLDOWN_S * 1000UL) return;

    g_vitalAlertAt  = millis();
    g_vitalBadSince = 0;

    char note[64];
    snprintf(note, sizeof(note), "nhip tim %u, nhip tho %u", hr, br);
    EventLog::add(EV_VITALS_ALERT, SRC_RADAR, g_state, note);

    String msg = "\xE2\x9A\xA0\xEF\xB8\x8F <b>SINH HIỆU BẤT THƯỜNG</b>\n";
    msg += "Người được giám sát: ";
    msg += esc(PATIENT_NAME);
    msg += "\nThời điểm: ";
    msg += esc(clockText());
    msg += "\nHiện tượng: ";
    msg += esc(reason);
    msg += "\nNhịp tim ước lượng: ";
    msg += (hr > 0) ? String(hr) : String("chưa đo được");
    msg += " nhịp/phút\nNhịp thở ước lượng: ";
    msg += (br > 0) ? String(br) : String("chưa đo được");
    msg += " lần/phút\n\n<i>Đây là số liệu ước lượng bằng sóng radar, KHÔNG phải "
           "thiết bị y tế. Hãy gọi điện kiểm tra, đừng dùng để chẩn đoán.</i>";
    Notifier::send(msg);
    WebUi::pushNow();
}

// ===========================================================================
//  Máy trạng thái
// ===========================================================================
void stateMachineTick() {
    const RadarSnapshot r    = Radar::snapshot();
    const bool fallEvent     = Radar::takeFallEvent();
    const uint32_t now       = millis();
    const bool inCooldown    = now < g_cooldownUntil;

    // --- Nút SOS có hiệu lực ở MỌI trạng thái (yêu cầu ở mục 4) ---
    // Ba đường vào đều được chấp nhận: nút có dây trên hộp, nút đeo tay qua
    // sóng 433 MHz, và nút trên trang web.
    const bool sosWired  = Hmi::takeSosPress();
    const bool sosRemote = RfRemote::takePress();
    if (sosWired || sosRemote || g_reqSos) {
        const EventSource src = sosRemote ? SRC_REMOTE
                              : (sosWired ? SRC_BUTTON : SRC_WEB);
        g_reqSos = false;
        if (g_state != ST_EMERGENCY) {
            g_fallDetectedAt = now;
            EventLog::add(sosRemote ? EV_SOS_REMOTE : EV_SOS, src, g_state,
                          sosRemote ? "nut SOS deo tay" : "nut SOS");
            raiseEmergency(src,
                           sosRemote ? "Người dùng bấm nút SOS đeo tay"
                                     : "Người dùng chủ động bấm nút SOS",
                           sosRemote ? "tu nut deo tay" : "tu nut SOS");
        }
        return;
    }

    // --- Nút "Tôi ổn" ---
    if (Hmi::takeOkPress()) confirmSafe(SRC_BUTTON);
    if (g_reqIamOk) { g_reqIamOk = false; confirmSafe(SRC_WEB); }

    // --- Trợ lý hội thoại: "bấm-giữ-để-nói" bằng nút XANH, hoặc từ trang web ---
    // CHỈ cho kích hoạt khi hệ thống đang BÌNH THƯỜNG (CÓ_NGƯỜI / KHÔNG_NGƯỜI).
    // Khi đang nghi ngờ té ngã hay khẩn cấp thì tuyệt đối không bật trợ lý để
    // không chen vào loa hỏi thăm / cảnh báo. Nút giữ lâu đã được tách riêng
    // khỏi bấm ngắn trong HMI nên không ảnh hưởng chức năng "Tôi ổn".
    const bool okHold = Hmi::takeOkHold();   // luôn lấy để xóa cờ, dù trợ lý tắt
    if ((okHold || g_reqAssistant) && Assistant::isEnabled()) {
        const bool normal = (g_state == ST_PRESENT || g_state == ST_NO_PERSON);
        if (normal && !Assistant::isBusy()) {
            Hmi::blip();
            EventLog::add(EV_TEST, okHold ? SRC_BUTTON : SRC_WEB, g_state,
                          okHold ? "kich hoat tro ly (giu nut xanh)"
                                 : "kich hoat tro ly (web)");
            Assistant::startListening();
        } else {
            Serial.println("[TRO LY] Bo qua kich hoat: khong o trang thai binh thuong hoac dang ban");
        }
    }
    g_reqAssistant = false;   // luôn xóa cờ web dù có kích hoạt hay không

    switch (g_state) {
        case ST_BOOT:
            if (r.online || r.lastUpdate != 0) gotoState(r.present ? ST_PRESENT : ST_NO_PERSON);
            break;

        case ST_NO_PERSON:
            if (r.present) {
                EventLog::add(EV_PRESENCE_IN, SRC_RADAR, ST_PRESENT, "");
                gotoState(ST_PRESENT);
            }
            // Vẫn phải xử lý: người ngã rồi nằm im, radar có thể báo "không người"
            if (fallEvent && !inCooldown) enterSuspect(SRC_RADAR, "nga khi dang bao khong nguoi");
            break;

        case ST_PRESENT:
            if (!r.present) {
                EventLog::add(EV_PRESENCE_OUT, SRC_RADAR, ST_NO_PERSON, "");
                gotoState(ST_NO_PERSON);
                break;
            }
            if (fallEvent) {
                if (inCooldown) {
                    // Radar báo ngã dai dẳng sau khi người dùng đã nói "tôi ổn"
                    // -> bỏ qua để loa không hỏi thăm lặp lại liên tục.
                    char note[48];
                    snprintf(note, sizeof(note), "bo qua, con %lus nghi",
                             (unsigned long)((g_cooldownUntil - now) / 1000));
                    EventLog::add(EV_FALL_SUSPECT, SRC_RADAR, ST_PRESENT, note);
                } else {
                    enterSuspect(SRC_RADAR, "radar bao te nga");
                }
            }
            break;

        case ST_SUSPECT_FALL: {
            serviceVoicePrompt();
            const uint32_t elapsed = now - g_suspectStart;
            if (elapsed >= CONFIRM_WINDOW_S * 1000UL) {
                Audio::stop();
                char note[48];
                snprintf(note, sizeof(note), "het %lus khong phan hoi",
                         (unsigned long)CONFIRM_WINDOW_S);
                String reason = "Phát hiện té ngã, không có phản hồi sau ";
                reason += CONFIRM_WINDOW_S;
                reason += " giây";
                raiseEmergency(SRC_RADAR, reason, note);
            }
            break;
        }

        case ST_EMERGENCY:
            // Chỉ thoát khỏi trạng thái khẩn cấp khi có người bấm xác nhận.
            // (Cố ý không tự thoát: hội đồng sẽ hỏi "nếu người đó ngất thì sao?")
            break;
    }

    // --- Đo thời gian thực tế từ lúc ngã tới lúc tin Telegram gửi xong ---
    if (g_awaitDelivery && Notifier::lastSuccessMs() > g_emergencyAt) {
        g_alertLatencyMs = Notifier::lastSuccessMs() - g_fallDetectedAt;
        g_awaitDelivery  = false;
        char note[64];
        snprintf(note, sizeof(note), "tong %lu.%lus tu luc nga",
                 (unsigned long)(g_alertLatencyMs / 1000),
                 (unsigned long)((g_alertLatencyMs % 1000) / 100));
        EventLog::add(EV_TELEGRAM_OK, SRC_SYSTEM, g_state, note);
        WebUi::pushNow();
    }
}

// ===========================================================================
//  Các yêu cầu thử nghiệm từ trang web
// ===========================================================================
void serviceWebRequests() {
    if (g_reqSimFall) {
        g_reqSimFall = false;
        Radar::injectFallEvent();
        EventLog::add(EV_TEST, SRC_WEB, g_state, "mo phong te nga");
    }
    if (g_reqPresence >= 0) {
        Radar::injectPresence(g_reqPresence == 1);
        EventLog::add(EV_TEST, SRC_WEB, g_state,
                      g_reqPresence == 1 ? "mo phong co nguoi" : "mo phong khong nguoi");
        g_reqPresence = -1;
    }
    if (g_reqTestVoice) {
        g_reqTestVoice = false;
        if (!Audio::play(AUDIO_FILE_ASK)) Audio::playBeeps(2);
        EventLog::add(EV_TEST, SRC_WEB, g_state, "thu loa");
    }
    if (g_reqTestTg) {
        g_reqTestTg = false;
        String msg = "\xE2\x84\xB9\xEF\xB8\x8F <b>Tin thử nghiệm</b>\nHệ thống giám sát té ngã của ";
        msg += esc(PATIENT_NAME);
        msg += " hoạt động bình thường.\nThời điểm: ";
        msg += esc(clockText());
        // Gửi tin thử CHỈ qua Telegram. Nếu Telegram chưa cấu hình thì ghi log rõ.
        if (Notifier::sendOne(msg, Notifier::CH_TELEGRAM))
            EventLog::add(EV_TEST, SRC_WEB, g_state, "gui tin thu Telegram");
        else
            EventLog::add(EV_TEST, SRC_WEB, g_state, "kenh Telegram chua bat");
    }
    if (g_reqTestMail) {
        g_reqTestMail = false;
        String msg = "\xE2\x84\xB9\xEF\xB8\x8F <b>Tin thử nghiệm</b>\nHệ thống giám sát té ngã của ";
        msg += esc(PATIENT_NAME);
        msg += " hoạt động bình thường.\nThời điểm: ";
        msg += esc(clockText());
        // Gửi tin thử CHỈ qua Email. Nếu Email chưa cấu hình thì ghi log rõ.
        if (Notifier::sendOne(msg, Notifier::CH_EMAIL))
            EventLog::add(EV_TEST, SRC_WEB, g_state, "gui tin thu Email");
        else
            EventLog::add(EV_TEST, SRC_WEB, g_state, "kenh Email chua bat");
    }
    if (g_reqTestZalo) {
        g_reqTestZalo = false;
        String msg = "\xE2\x84\xB9\xEF\xB8\x8F <b>Tin thử nghiệm</b>\nHệ thống giám sát té ngã của ";
        msg += esc(PATIENT_NAME);
        msg += " hoạt động bình thường.\nThời điểm: ";
        msg += esc(clockText());
        // Gửi tin thử CHỈ qua Zalo. Nếu Zalo chưa cấu hình thì ghi log rõ.
        if (Notifier::sendOne(msg, Notifier::CH_ZALO))
            EventLog::add(EV_TEST, SRC_WEB, g_state, "gui tin thu Zalo");
        else
            EventLog::add(EV_TEST, SRC_WEB, g_state, "kenh Zalo chua bat");
    }
    if (g_reqClearLog) {
        g_reqClearLog = false;
        EventLog::clear();
        EventLog::add(EV_TEST, SRC_WEB, g_state, "da xoa nhat ky");
        WebUi::pushNow();
    }
}

// ===========================================================================
//  Lời nhắn người nhà phát ra loa
// ===========================================================================
//  Yêu cầu đến từ task web (POST /api/say) hoặc task Telegram (/hoitham), nhưng
//  chỉ loop() mới bấm phát — cùng chỗ với máy trạng thái — nên lời nhắn không
//  bao giờ chen vào câu hỏi thăm khi nghi ngã hay âm báo động.

/// Kết thúc một yêu cầu (đã phát hoặc bị bỏ): xóa cờ, ghi nhật ký, báo trang web.
void finishSay(const char* note) {
    g_reqSay = false;
    EventLog::add(EV_MESSAGE, SRC_WEB, g_state, note);
    WebUi::pushNow();
}

void serviceSay() {
    // Đang đọc lời nhắn (dài tới ~22 giây) mà radar vừa báo nghi ngờ té ngã thì
    // cắt ngay: serviceVoicePrompt() chỉ hỏi thăm khi loa rảnh, để lời nhắn chạy
    // tiếp thì câu "có ổn không" bị trễ, ăn mất phần lớn 30 giây chờ phản hồi.
    // Ở KHẨN_CẤP thì raiseEmergency() đã tự cắt bằng âm báo động; KHÔNG gọi
    // stop() lúc đó kẻo cắt nhầm chính âm báo động.
    if (g_sayPlaying) {
        if (!Audio::isPlaying() || g_state == ST_EMERGENCY) {
            g_sayPlaying = false;
        } else if (g_state == ST_SUSPECT_FALL) {
            Audio::stop();
            g_sayPlaying = false;
            EventLog::add(EV_MESSAGE, SRC_SYSTEM, g_state, "ngat giua chung (nghi te nga)");
        }
    }

    if (!g_reqSay) return;

    // Đang cảnh báo: loa dành cho hỏi thăm / báo động -> bỏ hẳn lời nhắn.
    if (g_state == ST_SUSPECT_FALL || g_state == ST_EMERGENCY) {
        finishSay("bo qua (dang canh bao)");
        return;
    }

    // Loa hoặc trợ lý đang bận thì chờ (không chen ngang), quá 60 giây thì bỏ.
    if (!Audio::isPlaying() && !Assistant::isBusy()) {
        char from[sizeof(g_sayFrom)];
        char path[sizeof(g_sayPath)];
        portENTER_CRITICAL(&g_sayMux);
        strlcpy(from, g_sayFrom, sizeof(from));
        strlcpy(path, g_sayPath, sizeof(path));
        portEXIT_CRITICAL(&g_sayMux);

        // play() trả false nếu trợ lý vừa chiếm loa đúng lúc này -> thử lại vòng sau.
        if (Audio::play(path)) {
            g_sayPlaying = true;
            char note[64];
            if (from[0]) snprintf(note, sizeof(note), "tu %s", from);
            else         strlcpy(note, "loi nhan nguoi nha", sizeof(note));
            // Xóa cờ SAU khi play(): task phát âm (ưu tiên cao hơn, cùng core 1)
            // đã bật isPlaying(), nên phía web không thấy loa "rảnh" ở giữa.
            finishSay(note);
            return;
        }
    }
    if (millis() - g_sayReqAt >= SAY_WAIT_MAX_MS) finishSay("bo qua (loa ban qua lau)");
}

// ===========================================================================
//  Wi-Fi và đồng hồ
// ===========================================================================
// Khởi động Wi-Fi: giao hẳn cho bộ quản lý đa Wi-Fi (WifiMgr). WifiMgr nạp danh
// sách mạng từ NVS (seed từ secrets.h nếu NVS rỗng), tự quét + nối mạng mạnh
// nhất, và tự bật AP cấu hình khi không nối được mạng nào. begin() PHI CHẶN:
// không chờ sẵn kết nối ở đây — việc nối diễn ra dần trong serviceWifi().
void startWifi() {
    WifiMgr::begin();
}

// Theo dõi Wi-Fi mỗi vòng loop(). WifiMgr lo phần máy trạng thái (nối lại, bật/
// tắt AP); hàm này CHỈ giữ các hành vi cũ gắn với lúc CHUYỂN trạng thái lên/
// xuống: ghi log EV_WIFI_UP/DOWN, đồng bộ NTP lần đầu nối được, bật mDNS.
void serviceWifi() {
    WifiMgr::loop();

    const bool up = WifiMgr::isConnected();

    if (up && !g_wifiWasUp) {
        Serial.printf("[WIFI] Da ket noi \"%s\". IP = %s, RSSI = %d dBm\n",
                      WiFi.SSID().c_str(),
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
        EventLog::add(EV_WIFI_UP, SRC_SYSTEM, g_state, WiFi.localIP().toString().c_str());
        if (!g_timeSynced) {
            configTzTime(TIMEZONE_VN, NTP_SERVER_1, NTP_SERVER_2);
            g_timeSynced = true;
        }
        if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);
    } else if (!up && g_wifiWasUp) {
        Serial.println("[WIFI] Mat ket noi -> tin canh bao se duoc xep hang doi");
        EventLog::add(EV_WIFI_DOWN, SRC_SYSTEM, g_state, "");
    }
    g_wifiWasUp = up;
}

// ===========================================================================
//  Trả lời người nhà khi họ nhắn cho bot Telegram
// ===========================================================================
//
//  Người nhà nhắn "dạo này ông bà thế nào?" -> bot trả lời tình hình hiện tại
//  bằng lời lẽ dễ hiểu. Hàm này do task gửi tin (notifier) gọi, nên chỉ ĐỌC
//  trạng thái, không đổi gì — tránh tranh chấp với máy trạng thái ở loop().
//  Riêng lệnh /hoitham chỉ BẬT CỜ qua App::requestSay(); loop() mới phát loa.

/// Mô tả "cách đây bao lâu" cho thân thiện: "vừa xong", "3 phút trước"...
String agoText(uint32_t sinceMs) {
    if (sinceMs == 0) return String("chưa có");
    const uint32_t s = sinceMs / 1000;
    if (s < 60)    return String(s) + " giây trước";
    if (s < 3600)  return String(s / 60) + " phút trước";
    if (s < 86400) return String(s / 3600) + " giờ " + String((s % 3600) / 60) + " phút trước";
    return String(s / 86400) + " ngày trước";
}

/// Dòng mô tả cảnh báo đang diễn ra (dùng chung cho các câu trả lời người nhà).
String alertLineVi(SysState st) {
    if (st == ST_EMERGENCY) {
        String s = "\xF0\x9F\x9A\xA8 <b>ĐANG CÓ CẢNH BÁO KHẨN CẤP!</b>\n";
        s += esc(PATIENT_NAME);
        s += " có thể vừa bị ngã và chưa phản hồi. <b>Hãy gọi điện hoặc tới kiểm tra ngay.</b>";
        return s;
    }
    return String("\xE2\x9A\xA0\xEF\xB8\x8F <b>Vừa phát hiện nghi ngờ té ngã</b>, hệ thống đang hỏi thăm và chờ phản hồi.");
}

/// true nếu tin mở đầu bằng lệnh cmd, kể cả dạng "/lenh@TenBot" khi nhắn trong nhóm.
bool isCommand(const String& lower, const char* cmd) {
    if (!lower.startsWith(cmd)) return false;
    const size_t n = strlen(cmd);
    if (lower.length() == n) return true;
    const char c = lower[n];
    return c == ' ' || c == '@' || c == '\n' || c == '\t';
}

/// Lệnh /hoitham, /loinhan đến ESP32 nghĩa là dashboard đang tắt (lúc bật thì
/// dashboard đọc tin và tự đẩy giọng đọc nguyên văn xuống). ESP32 không tự tổng
/// hợp giọng được nên phát câu hỏi thăm thu sẵn, rồi nói rõ cho người nhà biết.
String replyGreeting(const Notifier::FamilyMessage& m) {
    const SysState st = g_state;
    if (st == ST_SUSPECT_FALL || st == ST_EMERGENCY) {
        String s = "\xE2\x9B\x94 <b>Chưa phát lời nhắn qua loa</b> vì thiết bị đang xử lý cảnh báo:\n\n";
        s += alertLineVi(st);
        s += "\n\n\xF0\x9F\x95\x92 Cập nhật lúc ";
        s += esc(clockText());
        return s;
    }
    // Chưa nạp file thu sẵn thì loa chỉ kêu 3 tiếng bíp thay thế — người già dễ
    // hoảng vì giống tiếng báo lỗi — nên không phát gì và nói thật với người nhà.
    if (!LittleFS.exists(AUDIO_FILE_GREET)) {
        Serial.println("[SAY] Thieu " AUDIO_FILE_GREET " -> dat file vao data/ roi nap uploadfs");
        String s = "\xE2\x84\xB9\xEF\xB8\x8F Thiết bị chưa có lời hỏi thăm thu sẵn nên chưa phát gì qua loa.\n";
        s += esc("Muốn loa đọc đúng nguyên văn lời nhắn, hãy bật dashboard trên máy tính.");
        return s;
    }
    if (!App::requestSay(m.fromName.c_str(), AUDIO_FILE_GREET))
        return String("\xE2\x8F\xB3 Loa đang chờ phát một lời nhắn khác, anh/chị thử lại sau ít phút nhé.");

    String s = "\xE2\x9C\x85 ";
    s += esc("Đã phát lời hỏi thăm qua loa (giọng thu sẵn).\n"
             "Muốn loa đọc đúng nguyên văn lời nhắn, hãy bật dashboard trên máy tính.");
    return s;
}

String buildFamilyReply(const Notifier::FamilyMessage& m) {
    const String& msg = m.lower;   // so khớp lệnh / từ khóa trên bản chữ thường

    // Xét /hoitham TRƯỚC "help"/"lệnh": lời nhắn có thể chứa đúng những chữ đó
    // ("/hoitham nhớ uống thuốc theo lệnh bác sĩ").
    if (isCommand(msg, "/hoitham") || isCommand(msg, "/loinhan")) return replyGreeting(m);

    const RadarSnapshot r = Radar::snapshot();
    const EventLog::Stats st = EventLog::stats();

    // Một vài lệnh nhanh
    const bool askHelp = msg.indexOf("help") >= 0 || msg.indexOf("lenh") >= 0 ||
                         msg.indexOf("lệnh") >= 0 || msg == "/help" || msg == "/start";
    if (askHelp) {
        String h = "\xF0\x9F\x91\x8B Xin chào! Em là trợ lý giám sát của <b>";
        h += esc(PATIENT_NAME);
        h += "</b>.\nAnh/chị nhắn một trong các câu sau:\n";
        h += "• <b>tình hình</b> — xem ông/bà hiện giờ thế nào\n";
        h += "• <b>số liệu</b> — thống kê trong ngày\n";
        h += "• <b>vị trí</b> — thiết bị đặt ở đâu\n";
        h += "• <b>/hoitham &lt;lời nhắn&gt;</b> — nhờ loa ở nhà nói lời nhắn của anh/chị\n";
        h += "Hoặc hỏi tự nhiên: \"dạo này ông bà thế nào?\"";
        return h;
    }

    // Trạng thái hiện tại bằng lời
    String s;
    switch (g_state) {
        case ST_EMERGENCY:
            s = alertLineVi(ST_EMERGENCY);
            s += "\n\n";
            break;
        case ST_SUSPECT_FALL:
            s = alertLineVi(ST_SUSPECT_FALL);
            s += "\n\n";
            break;
        case ST_PRESENT:
            s = "\xE2\x9C\x85 <b>Mọi thứ bình thường.</b>\n";
            s += esc(PATIENT_NAME);
            s += r.movement == 2 ? " đang đi lại/hoạt động trong phòng.\n\n"
                                 : " đang ở trong phòng, nghỉ ngơi yên tĩnh.\n\n";
            break;
        case ST_NO_PERSON:
            s = "\xF0\x9F\x8F\xA0 Hiện <b>không thấy ai</b> trong phòng (";
            s += esc(DEVICE_PLACE);
            s += "). Có thể ông/bà đang ở phòng khác.\n\n";
            break;
        default:
            s = "Hệ thống vừa khởi động, đang kết nối với cảm biến.\n\n";
            break;
    }

    // Người hỏi "số liệu" thì thêm thống kê, còn mặc định cho thông tin gọn
    if (msg.indexOf("số liệu") >= 0 || msg.indexOf("so lieu") >= 0 ||
        msg.indexOf("thống kê") >= 0 || msg.indexOf("thong ke") >= 0) {
        s += "\xF0\x9F\x93\x8A <b>Thống kê</b>\n";
        s += "• Lần nghi ngờ té ngã: " + String(st.suspects) + "\n";
        s += "• Lần bấm \"Tôi ổn\": " + String(st.cancelled) + "\n";
        s += "• Lần phát cảnh báo: " + String(st.emergency) + "\n";
        s += "• Lần bấm SOS: " + String(st.sos) + "\n";
    } else if (msg.indexOf("vị trí") >= 0 || msg.indexOf("vi tri") >= 0 ||
               msg.indexOf("ở đâu") >= 0 || msg.indexOf("o dau") >= 0) {
        s += "\xF0\x9F\x93\x8D Thiết bị đặt tại: <b>" + esc(DEVICE_PLACE) + "</b>\n";
    } else {
        // Mặc định: vài dòng tình hình
        s += "Radar: " + String(r.online ? "đang hoạt động bình thường" : "mất liên lạc");
        s += r.present ? ", có người trong phòng.\n" : ", không thấy người.\n";
        if (st.suspects > 0 || st.emergency > 0)
            s += "Hôm nay: " + String(st.suspects) + " lần nghi ngờ, " +
                 String(st.emergency) + " lần cảnh báo.\n";
    }

    s += "\n\xF0\x9F\x95\x92 Cập nhật lúc " + esc(clockText());
    return s;
}

}  // namespace

// ===========================================================================
//  Cầu nối cho trang web (khai báo trong app_api.h)
// ===========================================================================
namespace App {

Status status() {
    Status s;
    s.state     = g_state;
    s.stateAgeS = (millis() - g_stateSince) / 1000;
    if (g_state == ST_SUSPECT_FALL) {
        const uint32_t elapsed = millis() - g_suspectStart;
        const uint32_t total   = CONFIRM_WINDOW_S * 1000UL;
        s.countdownS = elapsed >= total ? 0 : (total - elapsed + 999) / 1000;
    }
    if (millis() < g_cooldownUntil) s.cooldownS = (g_cooldownUntil - millis()) / 1000;
    s.lastAlertMs    = g_emergencyAt;
    s.alertLatencyMs = g_alertLatencyMs;
    s.sayPending     = g_reqSay;
    return s;
}

void requestIamOk()        { g_reqIamOk     = true; }
void requestSos()          { g_reqSos       = true; }
void requestSimulateFall() { g_reqSimFall   = true; }
void requestTestVoice()    { g_reqTestVoice = true; }
void requestTestTelegram() { g_reqTestTg    = true; }
void requestTestEmail()    { g_reqTestMail  = true; }
void requestTestZalo()     { g_reqTestZalo  = true; }
void requestClearLog()     { g_reqClearLog  = true; }
void requestAssistant()    { g_reqAssistant = true; }
void requestSimPresence(bool present) { g_reqPresence = present ? 1 : 0; }

bool requestSay(const char* from, const char* path) {
    if (path == nullptr || path[0] == '\0') return false;
    char name[sizeof(g_sayFrom)];
    copySenderName(name, sizeof(name), from, SAY_FROM_MAX);   // làm ngoài spinlock cho ngắn
    const uint32_t now = millis();

    bool accepted = false;
    portENTER_CRITICAL(&g_sayMux);
    // Đang có lời nhắn chờ thì giữ nguyên nó: lời nhắn đến trước được phát trước,
    // không để lệnh /hoitham ghi đè lời nhắn nguyên văn dashboard vừa đẩy xuống.
    if (!g_reqSay) {
        strlcpy(g_sayFrom, name, sizeof(g_sayFrom));
        strlcpy(g_sayPath, path, sizeof(g_sayPath));
        g_sayReqAt = now;
        g_reqSay   = true;   // bật cờ SAU CÙNG
        accepted   = true;
    }
    portEXIT_CRITICAL(&g_sayMux);

    if (!accepted) Serial.println("[SAY] Dang co loi nhan cho phat -> bo yeu cau moi");
    return accepted;
}

bool sayPending() { return g_reqSay; }

}  // namespace App

// ===========================================================================
//  setup / loop
// ===========================================================================
void setup() {
    Serial.begin(115200);
    delay(600);                       // chờ cổng USB-CDC sẵn sàng
    Serial.println();
    Serial.println("==========================================================");
    Serial.println(" HE THONG CANH BAO TE NGA - Radar 60GHz + ESP32-S3");
    Serial.printf (" Nguoi duoc giam sat: %s (%s)\n", PATIENT_NAME, DEVICE_PLACE);
    Serial.printf (" PSRAM: %u byte | Flash: %u byte\n",
                   (unsigned)ESP.getPsramSize(), (unsigned)ESP.getFlashChipSize());
    if (SIMULATE_RADAR) Serial.println(" *** DANG CHAY CHE DO MO PHONG RADAR ***");
    Serial.println("==========================================================");

    EventLog::begin();
    Hmi::begin();
    RfRemote::begin();
    Audio::begin();
    Assistant::begin();               // trợ lý hội thoại (tự tắt nếu thiếu server/mic)
    Radar::begin();                   // task riêng, không chặn setup()

    startWifi();                      // giao Wi-Fi cho WifiMgr (phi chặn)
    // Cho WifiMgr ít giây để nối mạng đã lưu TRƯỚC khi gửi tin khởi động, để tin
    // "đã khởi động" kịp kèm địa chỉ trang giám sát trong trường hợp thường gặp
    // (có mạng đã lưu đang hiện diện). Không nối được thì cũng không chờ lâu:
    // WifiMgr sẽ tiếp tục thử (và bật AP cấu hình) trong loop().
    {
        const uint32_t t0 = millis();
        Serial.print("[WIFI] Dang quet va noi mang da luu");
        while (!WifiMgr::isConnected() && millis() - t0 < 15000) {
            serviceWifi();
            delay(200);
            Serial.print(".");
        }
        Serial.println();
    }
    serviceWifi();
    Notifier::onFamilyMessage(buildFamilyReply);   // bật chat hai chiều với người nhà
    Notifier::begin();
    WebUi::begin();

    EventLog::add(EV_BOOT, SRC_SYSTEM, ST_BOOT, SIMULATE_RADAR ? "che do mo phong" : "");
    g_stateSince = millis();
    Hmi::setState(ST_BOOT);

    String msg = "\xE2\x84\xB9\xEF\xB8\x8F <b>Hệ thống giám sát đã khởi động</b>\n";
    msg += "Người được giám sát: ";
    msg += esc(PATIENT_NAME);
    msg += "\nVị trí: ";
    msg += esc(DEVICE_PLACE);
    if (WiFi.status() == WL_CONNECTED) {
        msg += "\nTrang giám sát: http://";
        msg += WiFi.localIP().toString();
        msg += "/";
    }
    Notifier::send(msg);

    Serial.println("[APP] San sang. Mo trang giam sat tren dien thoai cung Wi-Fi.");
}

void loop() {
    Hmi::update();            // đọc nút, nháy LED, điều khiển còi
    serviceWebRequests();     // các thao tác thử nghiệm từ trang web
    serviceSay();             // lời nhắn người nhà chờ loa phát (dashboard / Telegram)
    stateMachineTick();       // máy trạng thái chính
    serviceVitals();          // theo dõi nhịp tim/nhịp thở (nếu bật chế độ giấc ngủ)
    serviceWifi();            // theo dõi và kết nối lại Wi-Fi
    WebUi::loop();            // đẩy dữ liệu qua WebSocket
    Assistant::loop();        // trợ lý hội thoại (rất nhẹ; việc nặng ở task riêng)

    delay(5);                 // nhường CPU cho các task khác
}
