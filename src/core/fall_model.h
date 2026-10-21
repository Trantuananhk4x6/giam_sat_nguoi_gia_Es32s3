/**
 * @file  fall_model.h
 * @brief Model phát hiện té ngã do CHÍNH BẠN huấn luyện, chạy ngay trên ESP32-S3.
 *
 * ================== VÌ SAO CÓ FILE NÀY (phần "AI" của đồ án) ==================
 *
 * Mô-đun radar C1001 đã có thuật toán phát hiện té ngã chạy sẵn bên trong chip.
 * Nhưng thuật toán đó là của nhà sản xuất, không phải của bạn — nếu hội đồng hỏi
 * "AI trong đề tài nằm ở đâu?" thì rất khó trả lời.
 *
 * File này là câu trả lời: một bộ phân loại HỒI QUY LOGISTIC (logistic regression)
 * do bạn tự huấn luyện trên dữ liệu bạn tự đo, chạy song song với thuật toán của
 * chip. Nhờ vậy báo cáo có được một chương so sánh rất đáng giá:
 * "model của em" vs "thuật toán có sẵn trong chip".
 *
 * Chọn hồi quy logistic chứ không phải mạng nơ-ron sâu là có lý do:
 *   - Số liệu đồ án chỉ vài trăm mẫu — mạng sâu sẽ học vẹt (overfit) ngay.
 *   - Trọng số chỉ là 11 con số, nhét vào ESP32 chạy trong vài micro-giây.
 *   - Giải thích được: mỗi trọng số cho biết đặc trưng nào quan trọng tới đâu.
 *     Hội đồng hỏi "vì sao model quyết định như vậy" là trả lời được ngay.
 *
 * ================== HỢP ĐỒNG ĐẶC TRƯNG (QUAN TRỌNG) ==========================
 *
 * Bên huấn luyện (dashboard, TypeScript) và bên chạy (ESP32, C++) PHẢI tính đặc
 * trưng giống nhau từng con số, nếu lệch thì model chạy sai mà không báo lỗi gì.
 * Vì vậy cách tính được viết ra thành "hợp đồng" có số phiên bản ở dưới, và
 * được cài y hệt ở hai nơi:
 *
 *      C++          : src/fall_model.cpp        -> extractFeatures()
 *      TypeScript   : dashboard/src/lib/features.ts -> extractFeatures()
 *
 * Sửa một bên thì PHẢI sửa bên kia và tăng số phiên bản.
 *
 * Cửa sổ 12 mẫu x 250 ms = 3 giây gần nhất. 10 đặc trưng:
 *
 *   f0 = trung bình biên độ chuyển động / 100
 *   f1 = biên độ chuyển động lớn nhất / 100
 *   f2 = độ lệch chuẩn biên độ / 50
 *   f3 = (biên độ cuối - biên độ đầu) / 100      <- ngã rồi nằm im thì âm
 *   f4 = trung bình khoảng cách (cm) / 400
 *   f5 = (khoảng cách cuối - đầu) / 200
 *   f6 = khoảng cách nhỏ nhất / 400
 *   f7 = tỉ lệ số mẫu có người
 *   f8 = tỉ lệ số mẫu "đang hoạt động" (movement == 2)
 *   f9 = tỉ lệ số mẫu "nằm im một chỗ"
 *
 * CỐ Ý KHÔNG ĐƯA cờ té ngã của radar vào đặc trưng. Nếu đưa vào, model chỉ việc
 * sao chép lại kết quả của chip và con số chính xác 99% kia hoàn toàn vô nghĩa.
 * Đây là điểm dễ bị hội đồng bắt lỗi nhất, nên nói rõ trong báo cáo.
 */
#pragma once
#include "radar.h"

namespace FallModel {

/// Phiên bản hợp đồng đặc trưng. Phải khớp với FEATURE_SPEC_VERSION ở dashboard.
constexpr uint8_t FEATURE_SPEC_VERSION = 1;

/// Số đặc trưng và số mẫu trong một cửa sổ
constexpr uint8_t FEATURE_COUNT = 10;
constexpr uint8_t WINDOW_SIZE   = 12;   // 12 x 250 ms = 3 giây

/// Nạp trọng số (từ include/model_weights.h). Gọi một lần trong setup().
void begin();

/// Đã có trọng số đã huấn luyện hay chưa
bool ready();

/**
 * Tính đặc trưng cho WINDOW_SIZE mẫu mới nhất trong vòng đệm.
 * @param out  mảng ít nhất FEATURE_COUNT phần tử
 * @return false nếu chưa đủ mẫu
 */
bool extractFeatures(const Radar::FeatureSample* ring, size_t ringSize,
                     size_t head, uint32_t total, float* out);

/**
 * Chạy model trên dữ liệu mới nhất rồi trả kết quả qua tham số.
 * An toàn khi gọi liên tục; nếu chưa có trọng số thì đặt ready = false.
 */
void update(const Radar::FeatureSample* ring, size_t ringSize,
            size_t head, uint32_t total,
            bool& readyOut, bool& fallOut, float& probOut);

/// Chuỗi mô tả model để hiện lên trang web (ngày huấn luyện, số mẫu…)
const char* info();

}  // namespace FallModel
