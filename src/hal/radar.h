/**
 * @file  radar.h
 * @brief Đọc mô-đun radar 60 GHz DFRobot C1001 (SEN0623) qua UART.
 *
 * HAI CÁCH ĐỌC, TỰ CHỌN LÚC CHẠY
 *   1. Cách nhanh (mặc định) – dùng bộ giải mã khung tự viết ở src/radar_frame.*:
 *      gửi lệnh theo đúng định dạng khung của hãng rồi giải mã byte nào vừa đến,
 *      KHÔNG chờ. Trạng thái té ngã được làm mới mỗi ~300 ms.
 *   2. Cách chậm – dùng thư viện DFRobot_HumanDetection: bên trong có delay(50)
 *      cho mỗi byte nên một vòng đọc đủ 6 thông tin mất 3–4 giây.
 *
 *   Firmware luôn dùng thư viện để NẠP CẤU HÌNH lúc khởi động (chiều cao lắp,
 *   độ nhạy…) vì đó là việc làm một lần, chậm cũng không sao. Sau đó nó chuyển
 *   sang cách nhanh. Nếu sau RADAR_FAST_PROBE_MS mà không giải mã được khung hợp
 *   lệ nào (sai dây, firmware mô-đun khác định dạng…) thì tự quay về cách chậm —
 *   chậm nhưng chắc chắn hoạt động.
 *
 * TẠI SAO PHẢI LÀ TASK RIÊNG
 *   Giai đoạn nạp cấu hình chặn tới hơn 10 giây (hàm begin() của thư viện tự
 *   delay 10 giây). Đặt ở task riêng trên core 0 để loop(), web và âm thanh ở
 *   core 1 không bị ảnh hưởng.
 *
 * SỰ KIỆN TÉ NGÃ ĐƯỢC "CHỐT" LẠI
 *   Task đếm số lần cờ ngã chuyển từ 0 sang 1 (fallEdges). Máy trạng thái so
 *   sánh bộ đếm này nên không bao giờ bỏ sót, dù đọc trễ.
 */
#pragma once
#include "app_types.h"

namespace Radar {

/// Một mẫu đặc trưng dùng để huấn luyện / chạy model phát hiện té ngã.
/// KHÔNG chứa cờ ngã của radar — nếu đưa vào, model chỉ việc sao chép lại kết
/// quả của chip thì không còn ý nghĩa gì nữa (xem src/fall_model.h).
struct FeatureSample {
    uint32_t t          = 0;  ///< millis() lúc lấy mẫu
    uint8_t  present    = 0;  ///< 0/1 có người trong phòng
    uint8_t  movement   = 0;  ///< 0 không, 1 nằm/ngồi im, 2 đang hoạt động
    uint8_t  range      = 0;  ///< biên độ chuyển động 0..100
    uint8_t  staticStay = 0;  ///< 0/1 nằm im một chỗ quá lâu
    uint16_t distanceCm = 0;  ///< khoảng cách tới người
    uint16_t trackX     = 0;  ///< điểm quỹ đạo (chỉ có ở cách đọc nhanh)
    uint16_t trackY     = 0;
};

/// Mở UART1, nạp cấu hình và tạo task đọc. Trả về false nếu không tạo được task.
bool begin();

/// Lấy bản sao dữ liệu radar mới nhất (an toàn giữa các task).
RadarSnapshot snapshot();

/// Trả về true đúng một lần cho mỗi lần radar báo té ngã mới.
bool takeFallEvent();

/// Dùng cho chế độ thử nghiệm: tạo một sự kiện té ngã giả.
void injectFallEvent();

/// Dùng cho chế độ thử nghiệm: đặt trạng thái có người / không người.
void injectPresence(bool present);

/// Mô tả ngắn tình trạng radar để hiện trên trang web.
const char* healthText();

/**
 * Sao chép các mẫu đặc trưng có t > sinceMs vào `out`, cũ trước mới sau.
 * @return số mẫu đã ghi vào `out`
 */
size_t copyFeatures(FeatureSample* out, size_t cap, uint32_t sinceMs);

/// Tổng số mẫu đặc trưng đã lấy từ lúc khởi động.
uint32_t featureCount();

}  // namespace Radar
