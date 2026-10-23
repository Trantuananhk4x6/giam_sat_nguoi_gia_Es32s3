/**
 * @file  model_weights.h
 * @brief Trọng số của model phát hiện té ngã. FILE NÀY ĐƯỢC SINH TỰ ĐỘNG.
 *
 * ĐỪNG SỬA TAY. Cách tạo file này:
 *   1. Chạy dashboard:  cd dashboard && npm run dev
 *   2. Mở trang "Huấn luyện model", bấm "Huấn luyện" rồi bấm
 *      "Tải model_weights.h"
 *   3. Ghi đè file này bằng file vừa tải, rồi nạp lại firmware:
 *      pio run -t upload
 *
 * Đây là bản MẶC ĐỊNH chưa huấn luyện: FALL_MODEL_TRAINED = 0 nên firmware biết
 * là chưa có model và sẽ chỉ dùng thuật toán sẵn trong chip radar. Hệ thống cảnh
 * báo vẫn hoạt động đầy đủ khi chưa huấn luyện model.
 */
#pragma once
#include <Arduino.h>

/// 0 = chưa huấn luyện (firmware bỏ qua model), 1 = đã có trọng số thật
#define FALL_MODEL_TRAINED 0

/// Phải khớp FallModel::FEATURE_SPEC_VERSION, nếu lệch firmware sẽ không dùng model
#define FALL_MODEL_SPEC_VERSION 1

/// Thông tin để hiện lên trang web và ghi vào báo cáo
#define FALL_MODEL_INFO "chua huan luyen"

/// Số cửa sổ LIÊN TIẾP phải vượt ngưỡng mới kết luận là té ngã (2 cửa sổ ≈ 0,5 giây).
/// Notebook mô phỏng firmware bằng đúng con số này nên nó đi cùng bộ trọng số.
#define FALL_MODEL_CONFIRM_WINDOWS 2

/// Ngưỡng xác suất để kết luận là té ngã
constexpr float FALL_MODEL_THRESHOLD = 0.5f;

/// Hệ số chặn (bias) của hồi quy logistic
constexpr float FALL_MODEL_BIAS = 0.0f;

/// Trọng số cho 10 đặc trưng, theo đúng thứ tự ghi trong src/fall_model.h
constexpr float FALL_MODEL_WEIGHTS[10] = {
    0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
    0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
};
