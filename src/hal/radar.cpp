#include "radar.h"
#include "config.h"
#include "event_log.h"
#include "fall_model.h"
#include "nn_model.h"
#include "nn_weights.h"
#include <math.h>
#include "radar_frame.h"

#include <DFRobot_HumanDetection.h>
#include <stdarg.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace Radar {

namespace {

// Thư viện chính chủ chỉ dùng cho hai việc: nạp cấu hình lúc khởi động, và làm
// phương án dự phòng nếu bộ đọc nhanh không giải mã được khung nào.
DFRobot_HumanDetection g_hu(&Serial1);

RadarSnapshot     g_snap;
SemaphoreHandle_t g_mutex      = nullptr;
TaskHandle_t      g_task       = nullptr;
uint32_t          g_takenEdges = 0;   ///< số sự kiện ngã máy trạng thái đã lấy
char              g_health[56]  = "chua khoi tao";

// --- Vòng đệm mẫu đặc trưng ---
FeatureSample g_ring[FEATURE_RING_SIZE];
size_t        g_ringHead  = 0;        ///< vị trí ghi tiếp theo
uint32_t      g_ringTotal = 0;        ///< tổng số mẫu đã ghi từ lúc bật nguồn

/// Bộ giải mã khung UART (khai ở đây vì cả phần đổi chế độ và vòng đọc đều dùng)
RadarFrame::Parser g_parser;

struct Lock {
    Lock()  { if (g_mutex) xSemaphoreTake(g_mutex, portMAX_DELAY); }
    ~Lock() { if (g_mutex) xSemaphoreGive(g_mutex); }
};

/// Ghi trạng thái sức khỏe (chuỗi hiện trên trang web)
void setHealth(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[sizeof(g_health)];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    Lock lk;
    memcpy(g_health, buf, sizeof(g_health));
    memcpy(g_snap.health, buf, sizeof(g_snap.health));
}

// ===========================================================================
//  Nạp cấu hình (dùng thư viện chính chủ, chạy một lần lúc khởi động)
// ===========================================================================

/// Theo hướng dẫn của DFRobot, BẮT BUỘC gọi sensorRet() sau khi đổi cấu hình,
/// nếu không mô-đun có thể không hoạt động đúng.
void configureSensor() {
    g_hu.configLEDLight(g_hu.eFALLLed, 1);    // đèn báo ngã trên mô-đun
    g_hu.configLEDLight(g_hu.eHPLed, 1);      // đèn báo có người trên mô-đun
    g_hu.dmInstallHeight(RADAR_INSTALL_HEIGHT_CM);
    g_hu.dmFallTime(RADAR_FALL_TIME_S);
    g_hu.dmUnmannedTime(RADAR_UNMANNED_TIME_S);
    g_hu.dmFallConfig(g_hu.eResidenceTime, RADAR_RESIDENCE_TIME_S);
    g_hu.dmFallConfig(g_hu.eFallSensitivityC, RADAR_FALL_SENSITIVITY);
    g_hu.dmFallConfig(g_hu.eResidenceSwitchC, 1);   // bật báo nằm im một chỗ
    g_hu.dmFallConfig(g_hu.eReportSwitchC, 1);      // bật mô-đun tự báo điểm quỹ đạo
    g_hu.dmFallConfig(g_hu.eReportFreqC, 2);        // tần số tự báo (đơn vị của hãng)
    g_hu.sensorRet();                               // khởi động lại để áp dụng
    delay(2000);
}

/// Bắt tay + nạp cấu hình. Trả về false nếu không liên lạc được với radar.
bool handshakeAndConfigure() {
    setHealth("dang bat tay voi radar...");
    uint8_t attempt = 0;
    // begin() của thư viện tự delay 10 giây chờ mô-đun khởi động xong
    while (g_hu.begin() != 0) {
        attempt++;
        Serial.printf("[RADAR] Khong ket noi duoc (lan %u). Kiem tra day TX/RX va nguon 5V.\n",
                      attempt);
        setHealth("khong phan hoi (lan %u)", attempt);
        if (attempt == 3) {
            EventLog::add(EV_RADAR_ERROR, SRC_SYSTEM, ST_BOOT, "khong bat tay duoc");
        }
        if (attempt >= 10) return false;
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    Serial.println("[RADAR] Da ket noi");

    uint8_t modeTry = 0;
    while (g_hu.configWorkMode(g_hu.eFallingMode) != 0) {
        if (++modeTry >= 5) {
            Serial.println("[RADAR] Khong doi duoc che do phat hien te nga");
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    configureSensor();

    const uint16_t height = g_hu.dmGetInstallHeight();
    Serial.printf("[RADAR] Che do=%u, chieu cao lap=%u cm, tre bao nga=%lu s, do nhay=%u\n",
                  g_hu.getWorkMode(), height, (unsigned long)g_hu.getFallTime(),
                  (unsigned)g_hu.getFallData(g_hu.eFallSensitivity));
    {
        Lock lk;
        g_snap.online    = true;
        g_snap.mode      = RM_FALL;
        g_snap.modeSince = millis();
    }
    return true;
}

// ===========================================================================
//  Vòng đệm mẫu đặc trưng
// ===========================================================================

/// Lấy một mẫu đặc trưng từ trạng thái hiện tại. Gọi khi ĐANG giữ mutex.
void pushFeatureLocked() {
    FeatureSample& s = g_ring[g_ringHead];
    s.t          = millis();
    s.present    = g_snap.present ? 1 : 0;
    s.movement   = g_snap.movement;
    s.range      = g_snap.movingRange;
    s.staticStay = g_snap.staticStay ? 1 : 0;
    s.distanceCm = g_snap.distanceCm;
    s.trackX     = g_snap.trackX;
    s.trackY     = g_snap.trackY;
    g_ringHead = (g_ringHead + 1) % FEATURE_RING_SIZE;
    g_ringTotal++;
}

/// Chạy hai mạng nơ-ron trên cửa sổ vừa đẩy vào vòng đệm và chép kết quả vào
/// ảnh chụp trạng thái. Phải gọi khi ĐANG giữ Lock (giống pushFeatureLocked).
void updateNnLocked() {
    NnModel::Result r;
    NnModel::update(g_ring, FEATURE_RING_SIZE, g_ringHead, g_ringTotal, r);
    g_snap.nnReady       = r.ready;
    g_snap.nnFall        = r.fall;
    g_snap.nnProb        = r.fallProb;
    g_snap.nnPosture     = r.posture;
    g_snap.nnPostureProb = r.postureProb;
    g_snap.nnFloorProb   = r.floorProb;
#if NN_MODEL_TRAINED
    if (r.ready) {
        float f[FallModel::FEATURE_COUNT];
        if (FallModel::extractFeatures(g_ring, FEATURE_RING_SIZE, g_ringHead, g_ringTotal, f)) {
            float buf[2][NN_MAX_UNITS];
            int cur = 0;
            for (int i = 0; i < NN_POSTURE_DIMS[0]; ++i) {
                const float s = NN_POSTURE_SCALE[i];
                buf[cur][i] = (f[i] - NN_POSTURE_MEAN[i]) / (s != 0.0f ? s : 1.0f);
            }
            const float* p = NN_POSTURE_PARAMS;
            for (int l = 0; l < NN_POSTURE_LAYERS; ++l) {
                const int nIn  = NN_POSTURE_DIMS[l];
                const int nOut = NN_POSTURE_DIMS[l + 1];
                const float* w = p;
                const float* b = p + nOut * nIn;
                p = b + nOut;
                const float* src = buf[cur];
                float*       dst = buf[1 - cur];
                for (int o = 0; o < nOut; ++o) {
                    float acc = b[o];
                    const float* wo = w + (size_t)o * nIn;
                    for (int i = 0; i < nIn; ++i) acc += wo[i] * src[i];
                    dst[o] = (l < NN_POSTURE_LAYERS - 1 && acc < 0.0f) ? 0.0f : acc;
                }
                cur = 1 - cur;
            }
            float mx = buf[cur][0];
            for (uint8_t i = 1; i < NnModel::POSTURE_COUNT; ++i)
                if (buf[cur][i] > mx) mx = buf[cur][i];
            float sum = 0.0f;
            for (uint8_t i = 0; i < NnModel::POSTURE_COUNT; ++i) {
                g_snap.nnPostureProbs[i] = expf(buf[cur][i] - mx);
                sum += g_snap.nnPostureProbs[i];
            }
            for (uint8_t i = 0; i < NnModel::POSTURE_COUNT; ++i) {
                g_snap.nnPostureProbs[i] /= (sum != 0.0f ? sum : 1.0f);
            }
        }
    }
#endif
}

// ===========================================================================
//  Quản lý chế độ: phát hiện té ngã  <->  theo dõi giấc ngủ
// ===========================================================================
//
// Mô-đun C1001 chỉ chạy MỘT chế độ tại một thời điểm. Đổi chế độ phải nạp lại
// cấu hình và khởi động lại mô-đun, mất 15–20 giây, và TRONG KHOẢNG ĐÓ KHÔNG
// PHÁT HIỆN ĐƯỢC TÉ NGÃ. Đây là đánh đổi thật, không che được, nên firmware:
//   1. mặc định TẮT tính năng này (ENABLE_SLEEP_MODE = false);
//   2. luôn coi chế độ phát hiện té ngã là chế độ ưu tiên;
//   3. ĐO và ghi lại tổng thời gian "mù" (blindMs) để đưa vào báo cáo.
//
// Điều kiện vào chế độ giấc ngủ: đang trong khung giờ đêm VÀ radar thấy người
// nằm im liên tục đủ lâu (mặc định 5 phút) — tức là gần như chắc chắn đã lên
// giường, không phải chỉ ngồi nghỉ một lát.
//
// Điều kiện ra: radar báo ra khỏi giường, hết khung giờ đêm, hoặc không còn
// người. Ra khỏi giường là lúc nguy hiểm nhất (dễ ngã khi vừa ngủ dậy) nên
// firmware chuyển về chế độ té ngã ngay.

uint32_t g_stillSince = 0;   ///< millis() lúc bắt đầu nằm im liên tục (0 = không)

/// Thời gian tối thiểu phải ở trong một chế độ trước khi được đổi lần nữa.
/// Chặn hiện tượng đổi qua đổi lại liên tục khi dữ liệu dao động quanh ngưỡng.
constexpr uint32_t MODE_MIN_DWELL_MS = 60000;

/// Đang trong khung giờ cho phép theo dõi giấc ngủ hay không.
/// Trả về false nếu chưa đồng bộ được giờ qua NTP — không biết mấy giờ thì
/// không được tự ý rời chế độ phát hiện té ngã.
bool inSleepWindow() {
    const time_t now = time(nullptr);
    if (now < 1600000000) return false;
    struct tm tmv;
    localtime_r(&now, &tmv);
    const uint8_t h = (uint8_t)tmv.tm_hour;
    if (SLEEP_WINDOW_START_HOUR <= SLEEP_WINDOW_END_HOUR) {
        return h >= SLEEP_WINDOW_START_HOUR && h < SLEEP_WINDOW_END_HOUR;
    }
    // Khung giờ vắt qua nửa đêm, ví dụ 22h -> 6h
    return h >= SLEEP_WINDOW_START_HOUR || h < SLEEP_WINDOW_END_HOUR;
}

/// Nạp cấu hình riêng cho chế độ giấc ngủ
void configureSleepMode() {
    g_hu.configSleep(g_hu.eAbnormalStruggleC, 1);  // bật báo vùng vẫy bất thường
    g_hu.configSleep(g_hu.eUnattendedStateC, 1);   // bật báo không có người
    g_hu.sensorRet();
    delay(2000);
}

/**
 * Đổi chế độ làm việc của mô-đun. Hàm này CHẶN 15–20 giây.
 * Chỉ được gọi từ trong task radar, không bao giờ gọi từ loop() hay web.
 * @return true nếu đổi thành công
 */
bool switchMode(RadarMode target) {
    const uint32_t startedAt = millis();
    {
        Lock lk;
        g_snap.mode = RM_SWITCHING;
    }
    setHealth("dang doi sang %s...", radarModeName(target));
    Serial.printf("[RADAR] Doi che do -> %s (mat ~15-20s, tam thoi khong phat hien te nga)\n",
                  radarModeName(target));

    const auto wanted = (target == RM_SLEEP) ? g_hu.eSleepMode : g_hu.eFallingMode;
    bool ok = false;
    for (uint8_t attempt = 0; attempt < 3 && !ok; ++attempt) {
        ok = (g_hu.configWorkMode(wanted) == 0);
        if (!ok) vTaskDelay(pdMS_TO_TICKS(1000));
    }

    if (ok) {
        // Nạp lại cấu hình của chế độ mới. Theo hướng dẫn DFRobot, đổi chế độ
        // xong phải nạp lại tham số rồi sensorRet() mới chắc chắn có hiệu lực.
        if (target == RM_SLEEP) configureSleepMode();
        else                    configureSensor();
    } else {
        Serial.println("[RADAR] Doi che do THAT BAI -> giu nguyen che do te nga");
        EventLog::add(EV_RADAR_ERROR, SRC_SYSTEM, ST_BOOT, "doi che do that bai");
    }

    const uint32_t blind = millis() - startedAt;
    const RadarMode finalMode = ok ? target : RM_FALL;
    {
        Lock lk;
        g_snap.mode      = finalMode;
        g_snap.modeSince = millis();
        g_snap.blindMs  += blind;
        g_snap.modeSwitches++;
        if (finalMode == RM_FALL) g_snap.vitals = VitalsSnapshot{};  // xóa sinh hiệu cũ
    }
    g_parser.reset();
    while (Serial1.available()) Serial1.read();   // dọn rác sinh ra lúc đổi chế độ
    g_stillSince = 0;

    char note[64];
    snprintf(note, sizeof(note), "sang %s, mu %lu.%lus",
             radarModeName(finalMode),
             (unsigned long)(blind / 1000), (unsigned long)((blind % 1000) / 100));
    EventLog::add(EV_MODE_SWITCH, SRC_SYSTEM, ST_BOOT, note);
    setHealth("doc nhanh - %s", radarModeName(finalMode));
    return ok;
}

/// Xét xem có cần đổi chế độ hay không. Trả về chế độ cần chuyển sang, hoặc
/// chế độ hiện tại nếu không cần đổi.
RadarMode decideMode(const RadarSnapshot& r) {
    if (!ENABLE_SLEEP_MODE) return RM_FALL;
    if (millis() - r.modeSince < MODE_MIN_DWELL_MS) return r.mode;

    if (r.mode == RM_FALL) {
        // Theo dõi chuỗi "nằm im liên tục"
        const bool lyingStill = r.present && r.movement == 1;
        if (!lyingStill) {
            g_stillSince = 0;
        } else if (g_stillSince == 0) {
            g_stillSince = millis();
        }

        const bool stillLongEnough =
            g_stillSince != 0 &&
            (millis() - g_stillSince) >= SLEEP_ENTER_AFTER_STILL_S * 1000UL;
        if (inSleepWindow() && stillLongEnough) return RM_SLEEP;
        return RM_FALL;
    }

    if (r.mode == RM_SLEEP) {
        // Ra khỏi giường là lúc dễ ngã nhất -> về chế độ té ngã ngay
        if (r.vitals.valid && r.vitals.inBed == 0) return RM_FALL;
        if (!inSleepWindow()) return RM_FALL;
        if (!r.present)       return RM_FALL;
        return RM_SLEEP;
    }
    return RM_FALL;
}

// ===========================================================================
//  Cách đọc NHANH: gửi lệnh rồi giải mã khung, không chờ byte nào
// ===========================================================================

void sendQuery(uint8_t ctrl, uint8_t cmd) {
    uint8_t buf[12];
    const size_t n = RadarFrame::buildRead(buf, sizeof(buf), ctrl, cmd);
    if (n) Serial1.write(buf, n);
}

/// Cập nhật ảnh chụp từ một khung vừa giải mã. Gọi khi ĐANG giữ mutex.
void applyFrameLocked(const RadarFrame::Frame& f, bool& fallEdge) {
    using namespace RadarFrame;

    if (f.ctrl == CTRL_HUMAN) {
        switch (f.baseCmd()) {
            case CMD_PRESENCE:  g_snap.present     = (f.data[0] == 1); break;
            case CMD_MOTION:    g_snap.movement    = f.data[0];        break;
            case CMD_BODY_MOVE: g_snap.movingRange = f.data[0];        break;
            case CMD_DISTANCE:
                if (f.len >= 2) g_snap.distanceCm = f.u16();
                break;
            default: break;   // các khung khác chưa dùng tới
        }
        g_snap.lastUpdate = millis();
        return;
    }

    if (f.ctrl == CTRL_FALL) {
        switch (f.baseCmd()) {
            case CMD_FALL_STATE: {
                const bool now = (f.data[0] == 1);
                if (now && !g_snap.fallFlag) {
                    g_snap.fallEdges++;     // chốt sự kiện cho máy trạng thái
                    fallEdge = true;
                }
                g_snap.fallFlag  = now;
                g_snap.fallAgeMs = 0;
                break;
            }
            case CMD_STATIC_RES: g_snap.staticStay = (f.data[0] == 1); break;
            case CMD_TRACK:
                if (f.len >= 4) {
                    g_snap.trackX = (uint16_t)((f.data[0] << 8) | f.data[1]);
                    g_snap.trackY = (uint16_t)((f.data[2] << 8) | f.data[3]);
                }
                break;
            case CMD_BREAK_HIGH:
                if (f.len >= 2) g_snap.breakHeight = f.u16();
                break;
            default: break;
        }
        g_snap.lastUpdate = millis();
        return;
    }

    // --- Các khung chỉ xuất hiện ở CHẾ ĐỘ GIẤC NGỦ ---
    if (f.ctrl == CTRL_HEART && f.baseCmd() == CMD_HEART_RATE) {
        g_snap.vitals.heartRate  = f.data[0];
        g_snap.vitals.valid      = true;
        g_snap.vitals.lastUpdate = millis();
        return;
    }

    if (f.ctrl == CTRL_BREATHE) {
        switch (f.baseCmd()) {
            case CMD_BREATHE_STATE: g_snap.vitals.breatheState = f.data[0]; break;
            case CMD_BREATHE_VALUE: g_snap.vitals.breatheValue = f.data[0]; break;
            default: return;
        }
        g_snap.vitals.valid      = true;
        g_snap.vitals.lastUpdate = millis();
        return;
    }

    if (f.ctrl == CTRL_SLEEP) {
        switch (f.baseCmd()) {
            case CMD_IN_BED:      g_snap.vitals.inBed      = f.data[0]; break;
            case CMD_SLEEP_STATE: g_snap.vitals.sleepState = f.data[0]; break;
            case CMD_SLEEP_SCORE: g_snap.vitals.sleepScore = f.data[0]; break;
            case CMD_STRUGGLE:    g_snap.vitals.struggle   = f.data[0]; break;
            default: return;
        }
        g_snap.vitals.valid      = true;
        g_snap.vitals.lastUpdate = millis();
    }
}

/// Danh sách lệnh gửi xoay vòng. Cứ hai lệnh lại có một lệnh hỏi trạng thái ngã,
/// nên trạng thái quan trọng nhất được làm mới mỗi ~2 x RADAR_QUERY_INTERVAL_MS.
struct Query { uint8_t ctrl, cmd; };
constexpr Query QUERY_PLAN[] = {
    {RadarFrame::CTRL_FALL,  0x81},   // trạng thái té ngã  <-- quan trọng nhất
    {RadarFrame::CTRL_HUMAN, 0x81},   // có người hay không
    {RadarFrame::CTRL_FALL,  0x81},   // trạng thái té ngã
    {RadarFrame::CTRL_HUMAN, 0x83},   // biên độ chuyển động
    {RadarFrame::CTRL_FALL,  0x81},   // trạng thái té ngã
    {RadarFrame::CTRL_HUMAN, 0x84},   // khoảng cách
    {RadarFrame::CTRL_FALL,  0x81},   // trạng thái té ngã
    {RadarFrame::CTRL_HUMAN, 0x82},   // kiểu chuyển động
    {RadarFrame::CTRL_FALL,  0x81},   // trạng thái té ngã
    {RadarFrame::CTRL_FALL,  0x85},   // nằm im một chỗ
};
constexpr size_t QUERY_PLAN_LEN = sizeof(QUERY_PLAN) / sizeof(QUERY_PLAN[0]);

/// Kế hoạch gửi lệnh khi đang ở CHẾ ĐỘ GIẤC NGỦ.
/// Ưu tiên "trên giường hay không" vì đó là tín hiệu để quay về chế độ té ngã.
constexpr Query SLEEP_QUERY_PLAN[] = {
    {RadarFrame::CTRL_SLEEP,   0x81},   // trên giường / ra khỏi giường  <-- quan trọng nhất
    {RadarFrame::CTRL_HEART,   0x82},   // nhịp tim
    {RadarFrame::CTRL_SLEEP,   0x81},   // trên giường / ra khỏi giường
    {RadarFrame::CTRL_BREATHE, 0x82},   // số lần thở mỗi phút
    {RadarFrame::CTRL_SLEEP,   0x81},   // trên giường / ra khỏi giường
    {RadarFrame::CTRL_SLEEP,   0x91},   // vùng vẫy bất thường
    {RadarFrame::CTRL_SLEEP,   0x81},   // trên giường / ra khỏi giường
    {RadarFrame::CTRL_SLEEP,   0x82},   // trạng thái giấc ngủ
    {RadarFrame::CTRL_SLEEP,   0x81},   // trên giường / ra khỏi giường
    {RadarFrame::CTRL_BREATHE, 0x81},   // trạng thái nhịp thở
    {RadarFrame::CTRL_HUMAN,   0x81},   // còn người trong phòng không
    {RadarFrame::CTRL_SLEEP,   0x90},   // điểm chất lượng giấc ngủ
};
constexpr size_t SLEEP_QUERY_PLAN_LEN =
    sizeof(SLEEP_QUERY_PLAN) / sizeof(SLEEP_QUERY_PLAN[0]);

/// Vòng đọc nhanh.
/// Nếu hoạt động được thì hàm này KHÔNG BAO GIỜ trả về (chạy mãi trong task).
/// Chỉ trả về (false) khi hết thời gian thăm dò mà không giải mã được khung nào,
/// để hàm gọi chuyển sang vòng đọc bằng thư viện.
bool fastLoop() {
    g_parser.reset();
    while (Serial1.available()) Serial1.read();   // dọn rác còn sót trong bộ đệm

    {
        Lock lk;
        g_snap.fastMode = true;
    }
    setHealth("doc nhanh (khong chan)");

    const uint32_t startedAt    = millis();
    uint32_t       nextQuery    = 0;
    uint32_t       nextFeature  = 0;
    uint32_t       nextDecision = 0;
    uint32_t       lastFallAt   = millis();
    size_t         slot         = 0;
    bool           proved       = false;

    for (;;) {
        // 1. Giải mã mọi byte vừa đến
        RadarFrame::Frame frame;
        while (Serial1.available()) {
            if (!g_parser.feed((uint8_t)Serial1.read(), frame)) continue;
            bool fallEdge = false;
            {
                Lock lk;
                applyFrameLocked(frame, fallEdge);
                g_snap.framesGood = g_parser.goodFrames();
                g_snap.framesBad  = g_parser.badFrames();
                g_snap.online     = true;
            }
            if (frame.ctrl == RadarFrame::CTRL_FALL &&
                frame.baseCmd() == RadarFrame::CMD_FALL_STATE) {
                lastFallAt = millis();
            }
            if (fallEdge) Serial.println("[RADAR] >>> PHAT HIEN TE NGA <<<");
            proved = true;
        }

        // 2. Chưa thấy khung nào sau thời gian thăm dò -> trả quyền cho cách chậm
        if (!proved && millis() - startedAt > RADAR_FAST_PROBE_MS) {
            Serial.println("[RADAR] Khong giai ma duoc khung nao -> quay ve dung thu vien");
            EventLog::add(EV_RADAR_ERROR, SRC_SYSTEM, ST_BOOT, "chuyen sang che do thu vien");
            Lock lk;
            g_snap.fastMode = false;
            return false;
        }

        // 3. Gửi lệnh tiếp theo theo kế hoạch xoay vòng của chế độ đang chạy
        const uint32_t now = millis();
        const RadarMode mode = snapshot().mode;
        if (now >= nextQuery) {
            const bool sleeping = (mode == RM_SLEEP);
            nextQuery = now + (sleeping ? VITALS_QUERY_INTERVAL_MS
                                        : RADAR_QUERY_INTERVAL_MS);
            const Query& q = sleeping ? SLEEP_QUERY_PLAN[slot % SLEEP_QUERY_PLAN_LEN]
                                      : QUERY_PLAN[slot % QUERY_PLAN_LEN];
            slot++;
            sendQuery(q.ctrl, q.cmd);
        }

        // 4. Xét đổi chế độ mỗi giây (chỉ khi ENABLE_SLEEP_MODE = true)
        if (ENABLE_SLEEP_MODE && now >= nextDecision) {
            nextDecision = now + 1000;
            const RadarSnapshot r = snapshot();
            const RadarMode want = decideMode(r);
            if (want != r.mode && r.mode != RM_SWITCHING) {
                switchMode(want);        // chặn 15–20 giây, có ghi nhật ký
                nextQuery   = millis();
                slot        = 0;
                nextFeature = millis();
                continue;
            }
        }

        // 5. Lấy mẫu đặc trưng và chạy model
        if (now >= nextFeature) {
            nextFeature = now + FEATURE_PERIOD_MS;
            Lock lk;
            g_snap.fallAgeMs = now - lastFallAt;
            pushFeatureLocked();
            FallModel::update(g_ring, FEATURE_RING_SIZE, g_ringHead, g_ringTotal,
                              g_snap.modelReady, g_snap.modelFall, g_snap.modelProb);
            updateNnLocked();
        }

        vTaskDelay(pdMS_TO_TICKS(5));   // nhường CPU, vẫn đủ nhanh cho 115200 baud
    }
}

// ===========================================================================
//  Cách đọc CHẬM (dự phòng): dùng thư viện chính chủ
// ===========================================================================

/// Lưu ý về thư viện: khi quá thời gian chờ, các hàm get* trả về 0 chứ không báo
/// lỗi riêng. Vì vậy trạng thái "có người" được lọc qua 2 lần đọc giống nhau, và
/// tình trạng sống/chết của radar kiểm tra bằng getWorkMode() (hợp lệ là 1 hoặc 2).
void libraryLoop() {
    setHealth("doc bang thu vien (cham)");
    {
        Lock lk;
        g_snap.fastMode = false;
    }

    uint8_t  presenceVotes = 0;
    bool     lastPresent   = false;
    bool     lastFall      = false;
    uint32_t loops         = 0;
    uint32_t nextFeature   = 0;
    uint32_t lastFallAt    = millis();

    for (;;) {
        const bool     rawPresent = g_hu.smHumanData(g_hu.eHumanPresence) == 1;
        const uint8_t  movement   = (uint8_t)g_hu.smHumanData(g_hu.eHumanMovement);
        const uint8_t  range      = (uint8_t)g_hu.smHumanData(g_hu.eHumanMovingRange);
        const uint16_t distance   = g_hu.smHumanData(g_hu.eHumanDistance);
        const bool     fallNow    = g_hu.getFallData(g_hu.eFallState) == 1;
        const bool     staticStay = g_hu.getFallData(g_hu.estaticResidencyState) == 1;

        if (rawPresent == lastPresent) presenceVotes = 0;
        else if (++presenceVotes >= 2) { lastPresent = rawPresent; presenceVotes = 0; }

        {
            Lock lk;
            g_snap.present     = lastPresent;
            g_snap.movement    = movement;
            g_snap.movingRange = range;
            if (distance > 0) g_snap.distanceCm = distance;
            g_snap.staticStay = staticStay;
            g_snap.fallFlag   = fallNow;
            g_snap.lastUpdate = millis();
            if (fallNow && !lastFall) {
                g_snap.fallEdges++;
                Serial.println("[RADAR] >>> PHAT HIEN TE NGA <<<");
            }
            lastFallAt       = millis();
            g_snap.fallAgeMs = 0;
        }
        lastFall = fallNow;

        if (++loops % 10 == 0) {
            const uint8_t mode = g_hu.getWorkMode();
            uint32_t errs = 0;
            {
                Lock lk;
                if (mode == 0) {
                    errs = ++g_snap.readErrors;
                    g_snap.online = false;
                } else {
                    g_snap.online = true;
                }
            }
            if (mode == 0) setHealth("mat lien lac (%lu loi)", (unsigned long)errs);
            else           setHealth("doc bang thu vien (cham)");
        }

        if (millis() >= nextFeature) {
            nextFeature = millis() + FEATURE_PERIOD_MS;
            Lock lk;
            g_snap.fallAgeMs = millis() - lastFallAt;
            pushFeatureLocked();
            FallModel::update(g_ring, FEATURE_RING_SIZE, g_ringHead, g_ringTotal,
                              g_snap.modelReady, g_snap.modelFall, g_snap.modelProb);
            updateNnLocked();
        }

        vTaskDelay(pdMS_TO_TICKS(RADAR_POLL_INTERVAL_MS));
    }
}

// ===========================================================================
//  Task
// ===========================================================================

void radarTask(void*) {
    Serial1.begin(RADAR_BAUD, SERIAL_8N1, PIN_RADAR_RX, PIN_RADAR_TX);

    if (!handshakeAndConfigure()) {
        setHealth("khong khoi tao duoc radar");
        // Vẫn giữ task sống để trang web hiện được tình trạng lỗi
        for (;;) vTaskDelay(pdMS_TO_TICKS(5000));
    }

    if (RADAR_FORCE_LIBRARY) {
        Serial.println("[RADAR] RADAR_FORCE_LIBRARY = true -> dung thu vien ngay tu dau");
    } else {
        // Nếu bộ đọc nhanh hoạt động thì hàm này chạy mãi, không bao giờ trả về.
        // Nó chỉ trả về khi không giải mã được khung nào -> rơi xuống cách chậm.
        fastLoop();
    }
    libraryLoop();
}

/// Task giả lập dùng khi SIMULATE_RADAR = true (radar chưa về tới)
void simTask(void*) {
    {
        Lock lk;
        g_snap.online  = true;
        g_snap.present = true;
    }
    setHealth("CHE DO MO PHONG (khong co radar)");
    uint32_t nextFeature = 0;
    for (;;) {
        {
            Lock lk;
            g_snap.movement    = g_snap.present ? 2 : 0;
            g_snap.movingRange = g_snap.present ? (uint8_t)random(20, 60) : 0;
            g_snap.distanceCm  = g_snap.present ? (uint16_t)random(100, 300) : 0;
            g_snap.lastUpdate  = millis();
            if (millis() >= nextFeature) {
                nextFeature = millis() + FEATURE_PERIOD_MS;
                pushFeatureLocked();
                FallModel::update(g_ring, FEATURE_RING_SIZE, g_ringHead, g_ringTotal,
                                  g_snap.modelReady, g_snap.modelFall, g_snap.modelProb);
                updateNnLocked();
            }
        }
        vTaskDelay(pdMS_TO_TICKS(RADAR_POLL_INTERVAL_MS));
    }
}

}  // namespace

bool begin() {
    if (!g_mutex) g_mutex = xSemaphoreCreateMutex();
    FallModel::begin();
    NnModel::begin();
    {
        Lock lk;
        g_snap.modelReady = FallModel::ready();
        g_snap.nnReady    = NnModel::ready();
    }
    const bool ok = xTaskCreatePinnedToCore(
                        SIMULATE_RADAR ? simTask : radarTask,
                        "radar", 6144, nullptr, 2, &g_task, 0) == pdPASS;
    if (!ok) Serial.println("[RADAR] LOI: khong tao duoc task doc radar");
    return ok;
}

RadarSnapshot snapshot() {
    Lock lk;
    return g_snap;
}

bool takeFallEvent() {
    Lock lk;
    if (g_snap.fallEdges == g_takenEdges) return false;
    g_takenEdges = g_snap.fallEdges;
    return true;
}

void injectFallEvent() {
    Lock lk;
    g_snap.fallEdges++;
    g_snap.fallFlag = true;
}

void injectPresence(bool present) {
    Lock lk;
    g_snap.present    = present;
    g_snap.lastUpdate = millis();
}

const char* healthText() {
    static char s_copy[sizeof(g_health)];
    Lock lk;
    memcpy(s_copy, g_health, sizeof(s_copy));
    return s_copy;
}

size_t copyFeatures(FeatureSample* out, size_t cap, uint32_t sinceMs) {
    if (!out || cap == 0) return 0;
    Lock lk;
    const size_t stored = g_ringTotal < FEATURE_RING_SIZE
                          ? (size_t)g_ringTotal
                          : FEATURE_RING_SIZE;
    size_t written = 0;
    // Đi từ mẫu cũ nhất tới mẫu mới nhất
    for (size_t i = 0; i < stored; ++i) {
        const size_t idx = (g_ringHead + FEATURE_RING_SIZE - stored + i) % FEATURE_RING_SIZE;
        if (g_ring[idx].t <= sinceMs) continue;
        if (written >= cap) break;
        out[written++] = g_ring[idx];
    }
    return written;
}

uint32_t featureCount() {
    Lock lk;
    return g_ringTotal;
}

}  // namespace Radar
