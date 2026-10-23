/**
 * @file  nn_model.h
 * @brief Mạng nơ-ron nhỏ (MLP) chạy ngay trên ESP32-S3 — phần "AI mạnh" của đồ án.
 *
 * ================== VÌ SAO THÊM FILE NÀY BÊN CẠNH fall_model.* ==============
 *
 * `fall_model.*` là hồi quy logistic: 11 con số, giải thích được từng trọng số.
 * Nhưng đo trên dữ liệu công khai mm-ADL (11 + 4 người, chia theo NGƯỜI) thì nó
 * quá yếu — ở mức báo nhầm chấp nhận được nó chỉ bắt được vài phần trăm cú ngã.
 * Lý do: ranh giới giữa "ngã xuống sàn" và "ngồi xuống ghế / nằm xuống giường"
 * không phải đường thẳng trong không gian 10 đặc trưng này.
 *
 * Một MLP trên ĐÚNG 10 đặc trưng đó bắt được nhiều hơn hẳn ở cùng mức báo nhầm,
 * mà vẫn chỉ vài nghìn số thực (hơn chục KB) và chạy trong vài chục micro-giây,
 * nên KHÔNG cần tới laptop: vẫn chạy trên ESP32.
 *
 * KIẾN TRÚC và SỐ LIỆU không ghi cứng ở đây, vì chúng do notebook chọn và đổi
 * theo từng lần huấn luyện. Chỗ tra số liệu đang dùng:
 *   - `NN_FALL_DIMS` / `NN_POSTURE_DIMS` trong include/nn_weights.h
 *   - `NN_MODEL_INFO` — firmware in ra lúc khởi động và hiện trên trang web
 *   - `model_report.json` do notebook xuất, và docs/huan_luyen_model.md
 *
 * Vì vậy đồ án giữ CẢ HAI model và so sánh định lượng trong báo cáo:
 *
 *      hồi quy logistic  — dễ giải thích, yếu
 *      MLP               — mạnh hơn nhiều, khó giải thích hơn
 *      thuật toán trong chip C1001 — của nhà sản xuất, dùng point cloud
 *
 * ================== HAI MẠNG DÙNG CHUNG BỘ MÁY Ở ĐÂY =======================
 *
 *   1. Mạng TÉ NGÃ   (1 đầu ra, hàm sigmoid)  -> xác suất "vừa có cú ngã"
 *   2. Mạng TƯ THẾ   (5 đầu ra, hàm softmax)  -> không người / đứng-đi / ngồi /
 *                                                nằm giường / nằm sàn
 *
 * Mạng tư thế trả lời đúng câu hỏi gây báo nhầm nhiều nhất: "người này đang nằm
 * trên SÀN hay trên GIƯỜNG?". Radar gắn trần nên khoảng cách tới người nằm sàn
 * (~270 cm) khác người nằm giường (~220 cm), nhờ đó phân biệt được.
 *
 * ================== HỢP ĐỒNG ĐẶC TRƯNG =====================================
 *
 * Cả hai mạng dùng ĐÚNG 10 đặc trưng của `FallModel::extractFeatures()` và đúng
 * cửa sổ 12 mẫu x 250 ms. Không có hợp đồng đặc trưng thứ hai để lệch nhau.
 * Trọng số nằm trong `include/nn_weights.h` do notebook Kaggle sinh ra.
 */
#pragma once
#include "radar.h"

namespace NnModel {

/// Số lớp của mạng tư thế, theo đúng thứ tự notebook xuất ra
constexpr uint8_t POSTURE_COUNT = 5;

/// Tư thế người ở cuối cửa sổ 3 giây gần nhất
enum Posture : uint8_t {
    PS_NO_PERSON = 0,  ///< không có người trong vùng quét
    PS_UPRIGHT   = 1,  ///< đứng hoặc đi lại
    PS_SITTING   = 2,  ///< ngồi (ghế)
    PS_ON_BED    = 3,  ///< nằm trên giường / sofa
    PS_ON_FLOOR  = 4,  ///< NẰM TRÊN SÀN — dấu hiệu đáng lo nhất
};

/// Tên tư thế không dấu, để in ra Serial và hiện lên trang web
const char* postureName(uint8_t p);

/// Kết quả một lượt chạy hai mạng
struct Result {
    bool    ready       = false;  ///< đã nạp được trọng số chưa
    bool    fall        = false;  ///< mạng té ngã kết luận có ngã (đã qua luật xác nhận)
    float   fallProb    = 0.0f;   ///< xác suất mạng té ngã đưa ra, 0..1
    uint8_t posture     = PS_NO_PERSON;
    float   postureProb = 0.0f;   ///< xác suất của tư thế đang báo
    float   floorProb   = 0.0f;   ///< riêng xác suất "nằm trên sàn", dùng để chốt cảnh báo
};

/// Nạp trọng số từ include/nn_weights.h. Gọi một lần trong setup().
void begin();

/// Đã có trọng số đã huấn luyện hay chưa
bool ready();

/**
 * Chạy cả hai mạng trên 12 mẫu mới nhất của vòng đệm đặc trưng.
 * An toàn khi gọi liên tục; chưa đủ dữ liệu thì giữ kết quả cũ.
 */
void update(const Radar::FeatureSample* ring, size_t ringSize,
            size_t head, uint32_t total, Result& out);

/// Chuỗi mô tả model để hiện lên trang web (ngày huấn luyện, số liệu…)
const char* info();

}  // namespace NnModel
