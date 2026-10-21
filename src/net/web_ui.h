/**
 * @file  web_ui.h
 * @brief Trang web giám sát do chính ESP32-S3 phục vụ.
 *
 *  - Trang HTML/CSS/JS nằm trong thư mục data/ và được nạp vào LittleFS
 *    bằng lệnh: pio run -t uploadfs
 *  - Dữ liệu cập nhật trực tiếp qua WebSocket (/ws). Nếu WebSocket bị ngắt,
 *    trang tự chuyển sang hỏi định kỳ qua /api/status nên vẫn hoạt động.
 *  - Các đường dẫn API:
 *      GET  /api/status      trạng thái hiện tại (JSON). Thêm ?tg=<giây> (5..120)
 *                            để dashboard thuê quyền đọc tin Telegram.
 *      GET  /api/events      danh sách sự kiện gần nhất (JSON)
 *      GET  /api/export.csv  toàn bộ nhật ký dạng CSV (mở bằng Excel)
 *      POST /api/action      thao tác: iamok | sos | simfall | present_on |
 *                            present_off | testvoice | testtg | clearlog |
 *                            assistant (kích hoạt trợ lý hội thoại)
 *      POST /api/say?from=<tên>  thân = nguyên file WAV (PCM 16-bit mono 16 kHz,
 *                            tối đa SAY_MAX_BYTES) để loa đọc lời nhắn người nhà.
 *                            202 đã nhận | 409 loa/lượt tải bận | 413 rỗng/quá lớn |
 *                            415 không phải WAV | 423 đang cảnh báo | 500 lỗi flash
 */
#pragma once
#include <Arduino.h>

namespace WebUi {

/// Khởi động máy chủ web + WebSocket trên cổng 80.
bool begin();

/// Gọi trong loop(): dọn client đã ngắt và đẩy trạng thái định kỳ.
void loop();

/// Đẩy trạng thái ngay lập tức (gọi khi máy trạng thái vừa đổi).
void pushNow();

/// Số trình duyệt đang mở trang giám sát.
uint32_t clientCount();

}  // namespace WebUi
