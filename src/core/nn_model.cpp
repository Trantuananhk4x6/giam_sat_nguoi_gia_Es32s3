#include "nn_model.h"

#include "fall_model.h"
#include "nn_weights.h"

#include <math.h>

namespace NnModel {

namespace {

bool   g_ready = false;
Result g_last;

#if NN_MODEL_TRAINED

/// Một mạng truyền thẳng đã làm phẳng thành mảng, theo đúng cách
/// `xuat_nn_header()` trong notebook Kaggle ghi ra.
struct Net {
    int          layers;   ///< số lớp có trọng số (2 lớp ẩn + 1 lớp ra = 3)
    const int*   dims;     ///< dims[0] = số đầu vào … dims[layers] = số đầu ra
    const float* params;   ///< W0,B0, W1,B1, … ghép liền nhau
    const float* mean;     ///< trung bình của StandardScaler (dims[0] phần tử)
    const float* scale;    ///< độ lệch chuẩn của StandardScaler
};

const Net FALL_NET{NN_FALL_LAYERS, NN_FALL_DIMS, NN_FALL_PARAMS,
                   NN_FALL_MEAN, NN_FALL_SCALE};
const Net POSTURE_NET{NN_POSTURE_LAYERS, NN_POSTURE_DIMS, NN_POSTURE_PARAMS,
                      NN_POSTURE_MEAN, NN_POSTURE_SCALE};

/// Số cửa sổ liên tiếp phải vượt ngưỡng mới kết luận là ngã — giống hệt luật
/// của hồi quy logistic, để hai model so sánh được công bằng.
uint8_t g_aboveCount = 0;

inline float sigmoid(float x) {
    if (x >  30.0f) return 1.0f;    // chặn biên để expf() không tràn số
    if (x < -30.0f) return 0.0f;
    return 1.0f / (1.0f + expf(-x));
}

/**
 * Chạy một mạng: chuẩn hóa đầu vào -> các lớp ẩn dùng ReLU -> lớp ra để NGUYÊN
 * (chưa qua sigmoid/softmax, vì hai mạng kết thúc khác nhau).
 *
 * @param in   dims[0] đặc trưng thô
 * @param out  nhận dims[layers] giá trị thô, phải đủ chỗ
 */
void forward(const Net& net, const float* in, float* out) {
    // Hai vùng đệm lật qua lật lại giữa các lớp. NN_MAX_UNITS là số nơ-ron lớn
    // nhất của mọi lớp trong mọi mạng, do notebook tính sẵn.
    float buf[2][NN_MAX_UNITS];
    int cur = 0;

    for (int i = 0; i < net.dims[0]; ++i) {
        const float s = net.scale[i];
        buf[cur][i] = (in[i] - net.mean[i]) / (s != 0.0f ? s : 1.0f);
    }

    const float* p = net.params;
    for (int l = 0; l < net.layers; ++l) {
        const int nIn  = net.dims[l];
        const int nOut = net.dims[l + 1];
        const float* w = p;              // nOut x nIn, theo hàng: [đầu ra][đầu vào]
        const float* b = p + nOut * nIn;
        p = b + nOut;

        const float* src = buf[cur];
        float*       dst = buf[1 - cur];
        for (int o = 0; o < nOut; ++o) {
            float acc = b[o];
            const float* wo = w + (size_t)o * nIn;
            for (int i = 0; i < nIn; ++i) acc += wo[i] * src[i];
            // Lớp ẩn dùng ReLU (đúng mặc định activation="relu" của sklearn),
            // lớp ra để nguyên.
            dst[o] = (l < net.layers - 1 && acc < 0.0f) ? 0.0f : acc;
        }
        cur = 1 - cur;
    }

    for (int i = 0; i < net.dims[net.layers]; ++i) out[i] = buf[cur][i];
}

#endif  // NN_MODEL_TRAINED

}  // namespace

const char* postureName(uint8_t p) {
    switch (p) {
        case PS_NO_PERSON: return "khong co nguoi";
        case PS_UPRIGHT:   return "dung / di lai";
        case PS_SITTING:   return "ngoi";
        case PS_ON_BED:    return "nam tren giuong";
        case PS_ON_FLOOR:  return "NAM TREN SAN";
        default:           return "?";
    }
}

void begin() {
#if NN_MODEL_TRAINED
    if (NN_MODEL_SPEC_VERSION != FallModel::FEATURE_SPEC_VERSION) {
        Serial.printf("[NN] LECH PHIEN BAN dac trung: file trong so v%d, firmware v%d"
                      " -> bo qua mang no-ron\n",
                      (int)NN_MODEL_SPEC_VERSION, (int)FallModel::FEATURE_SPEC_VERSION);
        g_ready = false;
        return;
    }
    // Mạng phải nhận đúng 10 đặc trưng, nếu không là file trọng số của bản khác
    if (NN_FALL_DIMS[0] != FallModel::FEATURE_COUNT ||
        NN_POSTURE_DIMS[0] != FallModel::FEATURE_COUNT ||
        NN_POSTURE_DIMS[NN_POSTURE_LAYERS] != POSTURE_COUNT) {
        Serial.println("[NN] File nn_weights.h khong khop so dac trung / so tu the -> bo qua");
        g_ready = false;
        return;
    }
    g_ready = true;
    Serial.printf("[NN] Da nap mang no-ron: %s\n", NN_MODEL_INFO);
#else
    g_ready = false;
    Serial.println("[NN] Chua huan luyen mang no-ron -> chi dung hoi quy logistic + chip radar");
#endif
}

bool ready() { return g_ready; }

void update(const Radar::FeatureSample* ring, size_t ringSize,
            size_t head, uint32_t total, Result& out) {
#if NN_MODEL_TRAINED
    out.ready = g_ready;
    if (!g_ready) {
        out = Result{};
        return;
    }

    float f[FallModel::FEATURE_COUNT];
    if (!FallModel::extractFeatures(ring, ringSize, head, total, f)) {
        out = g_last;            // chưa đủ 3 giây dữ liệu: giữ kết quả cũ
        out.fall = false;
        return;
    }

    // --- mạng té ngã: 1 đầu ra, qua sigmoid ---
    float z = 0.0f;
    forward(FALL_NET, f, &z);
    out.fallProb = sigmoid(z);

    if (out.fallProb >= NN_FALL_THRESHOLD) {
        if (g_aboveCount < 255) g_aboveCount++;
    } else {
        g_aboveCount = 0;
    }
    out.fall = (g_aboveCount >= NN_CONFIRM_WINDOWS);

    // --- mạng tư thế: 5 đầu ra, qua softmax ---
    float raw[POSTURE_COUNT];
    forward(POSTURE_NET, f, raw);
    float mx = raw[0];
    for (uint8_t i = 1; i < POSTURE_COUNT; ++i) mx = (raw[i] > mx) ? raw[i] : mx;
    float sum = 0.0f;
    for (uint8_t i = 0; i < POSTURE_COUNT; ++i) {
        raw[i] = expf(raw[i] - mx);     // trừ giá trị lớn nhất cho khỏi tràn số
        sum += raw[i];
    }
    uint8_t best = 0;
    for (uint8_t i = 0; i < POSTURE_COUNT; ++i) {
        raw[i] /= (sum != 0.0f ? sum : 1.0f);
        if (raw[i] > raw[best]) best = i;
    }
    out.ready       = true;
    out.posture     = best;
    out.postureProb = raw[best];
    out.floorProb   = raw[PS_ON_FLOOR];
    g_last = out;
#else
    (void)ring; (void)ringSize; (void)head; (void)total;
    out = Result{};
#endif
}

const char* info() {
#if NN_MODEL_TRAINED
    return NN_MODEL_INFO;
#else
    return "chua huan luyen";
#endif
}

}  // namespace NnModel
