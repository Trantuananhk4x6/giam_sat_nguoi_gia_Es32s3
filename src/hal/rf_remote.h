/**
 * @file  rf_remote.h
 * @brief Nhận nút SOS đeo tay qua sóng RF 433 MHz.
 *
 * ================== VÌ SAO CẦN NÚT ĐEO TAY ==================
 *
 * Thiết kế ban đầu có một lỗ thật: nút SOS gắn cố định trên hộp điều khiển.
 * Người đã té ngã rồi thì bò tới nút bấm kiểu gì? Nhất là trong nhà vệ sinh —
 * nơi hay ngã nhất và cũng là nơi radar khó quét tới.
 *
 * Nút đeo tay bịt đúng lỗ đó, và cho hệ thống HAI ĐƯỜNG ĐỘC LẬP:
 *   1. radar tự phát hiện  (không cần người dùng làm gì)
 *   2. người dùng tự gọi   (không cần radar hoạt động)
 * Một đường chết thì còn đường kia — đúng nguyên tắc của hệ thống an toàn.
 *
 * Quan trọng khi trình bày: radar vẫn là phương tiện phát hiện CHÍNH. Nút đeo
 * là kênh dự phòng, nên lý do chọn radar (không phải đeo, bảo vệ riêng tư) vẫn
 * giữ nguyên giá trị.
 *
 * ================== PHẦN CỨNG ==================
 *
 *   RXB6 / SRX882 (siêu ngoại sai)        ESP32-S3
 *   ─────────────────────────────────────────────────
 *   VCC  ──────────────────────────────►  3V3
 *   GND  ──────────────────────────────►  GND
 *   DATA ──────────────────────────────►  GPIO14 (PIN_RF_433)
 *   ANT  ──── dây đồng 17,3 cm
 *
 * Cấp 3,3V (không phải 5V) để chân DATA xuất đúng mức 3,3V, an toàn cho ESP32.
 * Đoạn dây 17,3 cm là ăng-ten 1/4 bước sóng của 433 MHz — thiếu nó thì tầm thu
 * chỉ còn vài mét thay vì 20–50 m.
 *
 * ĐỪNG mua mạch thu rẻ nhất (MX-RM-5V / XY-MK-5V, loại siêu tái sinh) vì nó
 * nhiễu nặng, tầm ngắn và hay tự kích — với hệ thống cảnh báo thì tự kích là
 * lỗi nghiêm trọng.
 *
 * ================== CÁCH LẤY MÃ NÚT ==================
 *
 * Lần nạp đầu để RF_REMOTE_CODE_1 = 0 trong secrets.h. Firmware sẽ in mã của
 * MỌI nút bấm nhận được ra cổng serial:
 *
 *     [RF] Nhan duoc ma 5592332 (24 bit) -- chua khai trong secrets.h
 *
 * Bấm nút của bạn vài lần, lấy con số đó dán vào secrets.h rồi nạp lại. Từ đó
 * firmware chỉ nhận đúng nút của bạn; remote cửa cuốn của nhà bên cạnh bấm
 * cũng không kích được hệ thống.
 */
#pragma once
#include <Arduino.h>

namespace RfRemote {

/// Cài chân và bật bộ nhận. Trả về false nếu không gắn mạch thu (PIN_RF_433 < 0).
bool begin();

/// Gọi liên tục trong loop(). Trả về true đúng MỘT lần cho mỗi lần bấm nút hợp lệ.
bool takePress();

/// Đã gắn mạch thu và đang hoạt động hay không
bool enabled();

/// Tổng số lần bấm hợp lệ đã nhận (hiện trên trang web)
uint32_t pressCount();

/// Tổng số mã lạ đã bỏ qua — nếu con số này tăng nhanh thì có nguồn nhiễu gần đó
uint32_t rejectedCount();

/// Mã nhận được gần nhất (kể cả mã lạ), để tiện lấy mã lúc mới lắp
uint32_t lastCode();

}  // namespace RfRemote
