#include "fall_model.h"
#include "model_weights.h"
#include <math.h>

namespace FallModel {

namespace {

bool  g_ready = false;
float g_lastProb = 0.0f;

/// Số cửa sổ liên tiếp phải vượt ngưỡng mới kết luận là té ngã.
/// Đặt 2 để một cửa sổ nhiễu đơn lẻ không làm model báo động.
constexpr uint8_t CONFIRM_WINDOWS = 2;
uint8_t g_aboveCount = 0;

inline float sigmoid(float x) {
    // Chặn biên để exp() không tràn số trên vi điều khiển
    if (x >  30.0f) return 1.0f;
    if (x < -30.0f) return 0.0f;
    return 1.0f / (1.0f + expf(-x));
}

}  // namespace

void begin() {
#if FALL_MODEL_TRAINED
    if (FALL_MODEL_SPEC_VERSION != FEATURE_SPEC_VERSION) {
        Serial.printf("[MODEL] LECH PHIEN BAN dac trung: file trong so v%d, firmware v%d"
                      " -> bo qua model\n",
                      (int)FALL_MODEL_SPEC_VERSION, (int)FEATURE_SPEC_VERSION);
        g_ready = false;
        return;
    }
    g_ready = true;
    Serial.printf("[MODEL] Da nap model: %s\n", FALL_MODEL_INFO);
#else
    g_ready = false;
    Serial.println("[MODEL] Chua huan luyen -> chi dung thuat toan san trong chip radar");
#endif
}

bool ready() { return g_ready; }

bool extractFeatures(const Radar::FeatureSample* ring, size_t ringSize,
                     size_t head, uint32_t total, float* out) {
    if (!ring || !out || ringSize == 0) return false;
    if (total < WINDOW_SIZE) return false;   // chưa đủ 3 giây dữ liệu

    // Lấy WINDOW_SIZE mẫu mới nhất, cũ trước mới sau
    const Radar::FeatureSample* w[WINDOW_SIZE];
    for (uint8_t i = 0; i < WINDOW_SIZE; ++i) {
        const size_t idx = (head + ringSize - WINDOW_SIZE + i) % ringSize;
        w[i] = &ring[idx];
    }

    float sumRange = 0.0f, maxRange = 0.0f;
    float sumDist = 0.0f, minDist = 1e9f;
    uint8_t nPresent = 0, nActive = 0, nStatic = 0;

    for (uint8_t i = 0; i < WINDOW_SIZE; ++i) {
        const float r = (float)w[i]->range;
        const float d = (float)w[i]->distanceCm;
        sumRange += r;
        if (r > maxRange) maxRange = r;
        sumDist += d;
        if (d < minDist) minDist = d;
        if (w[i]->present)        nPresent++;
        if (w[i]->movement == 2)  nActive++;
        if (w[i]->staticStay)     nStatic++;
    }

    const float meanRange = sumRange / WINDOW_SIZE;
    float varRange = 0.0f;
    for (uint8_t i = 0; i < WINDOW_SIZE; ++i) {
        const float dv = (float)w[i]->range - meanRange;
        varRange += dv * dv;
    }
    const float stdRange = sqrtf(varRange / WINDOW_SIZE);

    const float firstRange = (float)w[0]->range;
    const float lastRange  = (float)w[WINDOW_SIZE - 1]->range;
    const float firstDist  = (float)w[0]->distanceCm;
    const float lastDist   = (float)w[WINDOW_SIZE - 1]->distanceCm;
    const float n          = (float)WINDOW_SIZE;

    // --- Hợp đồng đặc trưng v1 (phải khớp dashboard/src/lib/features.ts) ---
    out[0] = meanRange / 100.0f;
    out[1] = maxRange / 100.0f;
    out[2] = stdRange / 50.0f;
    out[3] = (lastRange - firstRange) / 100.0f;
    out[4] = (sumDist / n) / 400.0f;
    out[5] = (lastDist - firstDist) / 200.0f;
    out[6] = minDist / 400.0f;
    out[7] = (float)nPresent / n;
    out[8] = (float)nActive / n;
    out[9] = (float)nStatic / n;
    return true;
}

void update(const Radar::FeatureSample* ring, size_t ringSize,
            size_t head, uint32_t total,
            bool& readyOut, bool& fallOut, float& probOut) {
    readyOut = g_ready;
    if (!g_ready) {
        fallOut = false;
        probOut = 0.0f;
        return;
    }

    float f[FEATURE_COUNT];
    if (!extractFeatures(ring, ringSize, head, total, f)) {
        fallOut = false;
        probOut = g_lastProb;     // giữ giá trị cũ khi chưa đủ dữ liệu
        return;
    }

    float z = FALL_MODEL_BIAS;
    for (uint8_t i = 0; i < FEATURE_COUNT; ++i) z += FALL_MODEL_WEIGHTS[i] * f[i];
    const float p = sigmoid(z);
    g_lastProb = p;
    probOut = p;

    if (p >= FALL_MODEL_THRESHOLD) {
        if (g_aboveCount < 255) g_aboveCount++;
    } else {
        g_aboveCount = 0;
    }
    fallOut = (g_aboveCount >= CONFIRM_WINDOWS);
}

const char* info() {
#if FALL_MODEL_TRAINED
    return FALL_MODEL_INFO;
#else
    return "chua huan luyen";
#endif
}

}  // namespace FallModel
