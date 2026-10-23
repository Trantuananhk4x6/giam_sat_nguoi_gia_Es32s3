/**
 * @file  wifi_mgr.h
 * @brief Bộ quản lý ĐA WI-FI v2 cho ESP32 (thay cho Wi-Fi hardcode trong secrets.h).
 *
 *  Thiết bị lưu NHIỀU mạng Wi-Fi trong bộ nhớ bền (NVS qua Preferences) và tự
 *  nối mạng tốt nhất đang có mặt. Không nối được mạng nào trong
 *  CONFIG_PORTAL_AFTER_MS (hoặc chưa lưu mạng nào) thì TỰ BẬT AP cấu hình kèm
 *  captive portal: điện thoại nối vào AP là tự hiện trang chọn mạng — không phải
 *  nạp lại firmware, không phải sửa secrets.h khi mang thiết bị đi nơi khác.
 *
 *  RÀNG BUỘC SỐ 1: loop() KHÔNG BAO GIỜ CHẶN (không delay, không quét đồng bộ,
 *  không vòng chờ). Bản cũ dùng WiFiMulti::run(): mỗi lần mất mạng nó quét đồng
 *  bộ 2–3 s rồi đứng chờ tới 5 s, làm máy trạng thái té ngã và nút OK/SOS đứng
 *  theo. Bản này tự làm máy trạng thái phi chặn: quét async, mỗi lượt thử chỉ
 *  gọi WiFi.begin() rồi theo dõi kết quả bằng sự kiện + millis().
 *
 *  AN TOÀN ĐA TASK: mọi lệnh điều khiển driver (begin/disconnect/mode/scan/softAP,
 *  DNS) CHỈ chạy trong loop() (task Arduino). Các hàm gọi từ task web (add,
 *  remove, connectTo, setPortal, các hàm ...Json, fillStatus) chỉ đặt cờ yêu cầu
 *  và đọc trạng thái dưới một mutex — gọi được từ bất kỳ task nào.
 *
 *  Tương thích ngược: giữ nguyên namespace NVS "wifinets" và các key "n",
 *  "ssid<i>", "pass<i>" của bản cũ (mạng đã lưu vẫn dùng được). NVS CHƯA TỪNG
 *  lưu danh sách (chưa có key "n") thì seed bằng WIFI_SSID/WIFI_PASSWORD trong
 *  secrets.h (bỏ qua giá trị mẫu); người dùng đã xóa hết mạng thì không seed lại.
 */
#pragma once
#include <Arduino.h>
#include <IPAddress.h>
#include <ArduinoJson.h>

namespace WifiMgr {

/// Kết quả của add().
enum AddResult : uint8_t {
    ADD_OK,        ///< đã lưu (và có thể đang thử nối, xem *connecting)
    ADD_BAD_SSID,  ///< SSID phải dài 1..32 byte
    ADD_BAD_PASS,  ///< mật khẩu phải rỗng (mạng mở), 8..63 ký tự hoặc đúng 64 ký tự hex
    ADD_FULL,      ///< đã đủ WIFI_MAX_SAVED mạng mà SSID này là mạng mới
    ADD_STORAGE,   ///< ghi NVS lỗi -> KHÔNG có gì thay đổi (không lưu, không thử nối)
};

/// Kết quả của remove().
enum RemoveResult : uint8_t {
    REMOVE_OK,         ///< đã xóa (RAM + NVS)
    REMOVE_NOT_FOUND,  ///< không có mạng này trong danh sách đã lưu
    REMOVE_STORAGE,    ///< ghi NVS lỗi -> KHÔNG có gì thay đổi (mạng vẫn còn)
};

/// Nạp danh sách mạng từ NVS (seed từ secrets.h nếu NVS chưa từng lưu), bật STA.
/// Gọi MỘT lần trong setup(). Phi chặn: không chờ kết nối, việc nối diễn ra dần
/// trong loop().
void begin();

/// Máy trạng thái phi chặn (quét async, thử lần lượt, nối lại, AP cấu hình, DNS
/// của captive portal). Gọi mỗi vòng loop(); thường chỉ vài chục µs, lâu nhất là
/// các vòng có ghi NVS hoặc bật/tắt AP — đo bằng micros(), xem "loopMaxUs".
void loop();

/// true nếu đang nối một mạng STA (đã có IP). Mất sóng ngắn dưới 1,5 s chưa tính
/// là mất mạng.
bool isConnected();

/// Số mạng Wi-Fi đang lưu.
size_t count();

/// Thêm mạng mới hoặc đổi mật khẩu mạng đã lưu. *connecting (nếu khác null) = có
/// thử nối ngay không (theo dõi bằng attempt trong stateJson()).
///  - Mạng MỚI: ghi NVS ngay; ghi được mới lưu vào RAM và thử nối nếu connectNow
///    HOẶC đang chưa có mạng.
///  - Mạng ĐÃ LƯU sẽ được thử — đang nối đúng mạng đó (LUÔN thử, kể cả connectNow
///    = false), connectNow, hoặc chưa có mạng: CHƯA ghi NVS, mật khẩu cũ vẫn giữ
///    trong RAM. Nối được mới ghi NVS; hỏng/bị hủy thì giữ mật khẩu cũ
///    (attempt.rolledBack = true) rồi thử nhanh lại bằng mật khẩu cũ (hoặc quay
///    về mạng vừa dùng).
///  - Mạng ĐÃ LƯU, không thử (connectNow = false, đang nối mạng khác): ghi NVS ngay.
/// ADD_STORAGE = ghi NVS lỗi, KHÔNG có gì thay đổi.
AddResult add(const String& ssid, const String& pass, bool connectNow, bool* connecting = nullptr);

/// Xóa một mạng đã lưu: ghi NVS trước, ghi được mới xóa khỏi RAM. Đang nối đúng
/// mạng đó thì KHÔNG ngắt (chỉ không dùng lại lần sau); đang thử đúng mạng đó thì
/// hủy lượt thử. REMOVE_STORAGE = ghi NVS lỗi, KHÔNG có gì thay đổi.
RemoveResult remove(const String& ssid);

/// Chuyển sang một mạng ĐÃ LƯU ngay (giành quyền với lượt thử nền). Thất bại thì
/// tự quay về chu trình bình thường, ưu tiên mạng vừa dùng. false nếu chưa lưu.
bool connectTo(const String& ssid);

/// Bật/tắt AP cấu hình bằng tay. Bật tay khi đang có mạng: tự tắt sau
/// PORTAL_MANUAL_MAX_MS. Việc bật/tắt thật diễn ra ở vòng loop() kế tiếp.
void setPortal(bool on);

/// Task web báo vừa có một yêu cầu HTTP từ phía AP cấu hình (gọi cho MỌI yêu cầu
/// phía AP; không khóa, gọi được từ mọi task). Có yêu cầu trong 30 s gần nhất =
/// có người đang dùng trang cấu hình -> AP TỰ BẬT thì tạm dừng tự nối nền (tối
/// đa 5 phút liên tục; thử nhanh vẫn chạy) để điện thoại khỏi rớt khỏi AP.
void notePortalActivity();

/// GET /api/wifi/state — trạng thái đầy đủ (hợp đồng API Wi-Fi v2), thêm
/// "paused" (đang tạm dừng tự nối vì có người dùng trang cấu hình) và
/// "loopMaxUs" (vòng loop() lâu nhất trong 60 s gần nhất, µs).
String stateJson();

/// GET /api/wifi/scan — KHÔNG BAO GIỜ CHẶN: trả cache ngay; cache trống/cũ hơn
/// WIFI_SCAN_CACHE_MS/fresh = true thì xin loop() quét async (scanning: true).
String scanJson(bool fresh = false);

/// GET /api/wifi/list — các mạng đã lưu kèm kết quả thử gần nhất. KHÔNG có mật khẩu.
String listJson();

/// Ghi khối "wifi" cho /api/status và gói WebSocket (giữ trường cũ, thêm trường mới).
void fillStatus(JsonObject o);

/// true nếu AP cấu hình đang bật. Đọc không khóa, gọi được từ bộ lọc handler web.
bool portalActive();

/// SSID của AP cấu hình ("" nếu AP đang tắt).
const char* apSsid();

/// IP của AP cấu hình (0.0.0.0 nếu AP đang tắt).
IPAddress apIp();

/// SSID đang nối thật ("" nếu chưa nối).
String currentSsid();

}  // namespace WifiMgr
