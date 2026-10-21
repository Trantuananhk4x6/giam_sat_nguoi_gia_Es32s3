/**
 * @file  hmi.h
 * @brief Giao tiếp người dùng tại chỗ: 2 nút nhấn, 3 đèn LED và còi buzzer.
 *
 *  - Nút nhấn được nối xuống GND và dùng điện trở kéo lên bên trong ESP32
 *    (INPUT_PULLUP), nên lúc nhả nút chân đọc được mức CAO, lúc bấm là mức THẤP.
 *  - Chống dội phím (debounce) bằng mốc thời gian: chỉ công nhận trạng thái mới
 *    khi nó giữ ổn định liên tục BTN_DEBOUNCE_MS. Cách này không cần delay() nên
 *    không làm nghẽn chương trình chính.
 *  - LED và còi chạy theo mẫu nháy (pattern) phi chặn: hàm update() tự bật/tắt
 *    theo thời gian, máy trạng thái chỉ cần khai báo "đang ở trạng thái nào".
 */
#pragma once
#include "app_types.h"

namespace Hmi {

/// Cài đặt chân vào/ra. Gọi một lần trong setup().
void begin();

/// Gọi liên tục trong loop(): đọc nút, nháy LED, điều khiển còi.
void update();

/// Trả về true đúng MỘT lần cho mỗi lần BẤM NGẮN nút xanh "Tôi ổn".
/// (Khi bật trợ lý, bấm ngắn được ghi nhận lúc NHẢ tay để phân biệt với giữ lâu.)
bool takeOkPress();

/// Trả về true đúng MỘT lần khi nút xanh được GIỮ LÂU >= ASSISTANT_PTT_HOLD_MS
/// — dùng làm "bấm-giữ-để-nói" cho trợ lý hội thoại. Khi giữ lâu, lần nhả tay
/// sau đó KHÔNG được tính là bấm ngắn (không kích hoạt nhầm "Tôi ổn").
bool takeOkHold();

/// Trả về true đúng MỘT lần cho mỗi lần bấm nút đỏ SOS.
bool takeSosPress();

/// Cho máy trạng thái biết trạng thái hiện tại để chọn mẫu nháy LED.
void setState(SysState s);

/// Bật/tắt chuỗi bíp còi báo động (dùng trong lúc đếm ngược và khi khẩn cấp).
void setAlarm(bool on, bool urgent = false);

/// Nháy ngắn LED vàng để báo "vừa nhận một thao tác" (phản hồi cho người dùng).
void blip();

}  // namespace Hmi
