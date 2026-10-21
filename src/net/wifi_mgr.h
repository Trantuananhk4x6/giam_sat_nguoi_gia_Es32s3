/**
 * @file  wifi_mgr.h
 * @brief Bộ quản lý ĐA WI-FI cho ESP32 (thay cho Wi-Fi hardcode trong secrets.h).
 *
 *  Ý tưởng: thiết bị lưu NHIỀU mạng Wi-Fi trong bộ nhớ bền (NVS qua thư viện
 *  Preferences). Khi khởi động, nạp mọi mạng đã lưu vào WiFiMulti rồi để nó tự
 *  QUÉT và chọn mạng MẠNH NHẤT đang có mặt. Nếu thử hết danh sách mà trong
 *  CONFIG_PORTAL_AFTER_MS vẫn không nối được mạng nào thì TỰ BẬT AP (phát Wi-Fi
 *  riêng) kèm trang cấu hình để người dùng nhập/chọn mạng mới tại chỗ — không
 *  phải nạp lại firmware, không phải sửa secrets.h khi mang thiết bị đi nơi khác.
 *
 *  Máy trạng thái phi chặn (dựa millis()): mỗi lần loop() chỉ tốn vài ms.
 *
 *  Tương thích ngược: nếu NVS rỗng (lần đầu chạy firmware mới), seed danh sách
 *  bằng WIFI_SSID/WIFI_PASSWORD trong secrets.h nếu khác rỗng — nên không cần
 *  làm gì thiết bị vẫn nối đúng mạng như trước.
 */
#pragma once
#include <Arduino.h>

namespace WifiMgr {

/// Nạp danh sách mạng từ NVS; seed bằng secrets.h nếu NVS rỗng; bật STA.
/// Gọi MỘT lần trong setup(), THAY cho startWifi() cũ.
void begin();

/// Máy trạng thái phi chặn: kết nối -> giữ kết nối -> (mất mạng) thử lại;
/// bật/tắt AP khi cần. Gọi mỗi vòng loop(), THAY cho serviceWifi() cũ.
void loop();

/// true nếu đang nối được một mạng STA (WL_CONNECTED).
bool isConnected();

/// Số mạng Wi-Fi đang lưu trong NVS.
size_t count();

/// Thêm/cập nhật một mạng. Nếu SSID đã có thì cập nhật mật khẩu. Lưu ngay vào
/// NVS và nạp lại WiFiMulti để lần quét kế dùng mạng mới. true nếu lưu được.
bool add(const String& ssid, const String& pass);

/// Xóa một mạng theo SSID khỏi NVS. true nếu có xóa.
bool remove(const String& ssid);

/// JSON mảng các mạng ĐÃ LƯU cho trang web: [{"ssid":...}]. KHÔNG kèm mật khẩu.
String listJson();

/// Quét các mạng xung quanh (đồng bộ, ngắn) -> JSON [{"ssid","rssi","enc"}].
/// Giải phóng kết quả quét ngay sau khi dựng JSON để đỡ tốn RAM.
String scanJson();

/// true nếu đang ở chế độ phát AP (cổng cấu hình đang mở).
bool portalActive();

/// Tên (SSID) của AP mà thiết bị phát khi vào chế độ cấu hình.
const char* apSsid();

/// SSID đang nối thật (chuỗi rỗng nếu chưa nối). Dùng cho status JSON.
String currentSsid();

}  // namespace WifiMgr
