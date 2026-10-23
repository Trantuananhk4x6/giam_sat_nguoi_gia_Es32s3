/**
 * @file  nn_weights.h
 * @brief Trọng số hai mạng nơ-ron nhỏ (té ngã + tư thế). FILE NÀY ĐƯỢC SINH TỰ ĐỘNG.
 *
 * ĐỪNG SỬA TAY. Cách tạo file này:
 *   1. Chạy `tools/kaggle/huan_luyen_model_te_nga.ipynb` trên Kaggle (Run All)
 *   2. Tab *Output*: tải `nn_weights.h`
 *   3. Ghi đè file này, rồi nạp lại firmware: `pio run -t upload`
 *
 * Đây là bản MẶC ĐỊNH chưa huấn luyện: NN_MODEL_TRAINED = 0 nên firmware bỏ qua
 * hai mạng này. Hệ thống cảnh báo vẫn hoạt động đầy đủ (thuật toán trong chip
 * radar + hồi quy logistic nếu đã có `model_weights.h`).
 *
 * Xem thêm: src/core/nn_model.h và docs/huan_luyen_model.md
 */
#pragma once
#include <Arduino.h>

/// 0 = chưa huấn luyện (firmware bỏ qua mạng nơ-ron), 1 = đã có trọng số thật
#define NN_MODEL_TRAINED 0

/// Phải khớp FallModel::FEATURE_SPEC_VERSION, lệch thì firmware không dùng mạng
#define NN_MODEL_SPEC_VERSION 1

/// Thông tin để hiện lên trang web và ghi vào báo cáo
#define NN_MODEL_INFO "chua huan luyen"

/// Số nơ-ron lớn nhất của một lớp trong hai mạng (kích thước vùng đệm khi tính)
constexpr int NN_MAX_UNITS = 32;

/// Ngưỡng xác suất để mạng té ngã kết luận "có ngã"
constexpr float NN_FALL_THRESHOLD = 0.5f;

/// Số cửa sổ liên tiếp phải vượt ngưỡng mới báo (giống hồi quy logistic)
constexpr uint8_t NN_CONFIRM_WINDOWS = 2;
