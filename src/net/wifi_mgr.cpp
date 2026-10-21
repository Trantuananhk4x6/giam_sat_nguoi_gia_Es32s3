/**
 * @file  wifi_mgr.cpp
 * @brief Phần thân của bộ quản lý đa Wi-Fi (xem wifi_mgr.h).
 *
 *  Lưu danh sách mạng trong NVS (Preferences, namespace "wifinets") dạng cặp
 *  key: "n" = số mạng; "ssid<i>" / "pass<i>" = mạng thứ i. Dùng WiFiMulti để
 *  tự chọn mạng MẠNH NHẤT trong các mạng đã lưu đang hiện diện.
 *
 *  Máy trạng thái phi chặn, chia nhỏ theo millis(): không bao giờ chặn loop()
 *  quá vài ms. AP (cổng cấu hình) CHỈ bật khi không nối được mạng nào trong
 *  CONFIG_PORTAL_AFTER_MS, và TẮT ngay khi nối lại được mạng thật.
 */
#include "wifi_mgr.h"
#include "config.h"
#include "secrets.h"

#include <WiFi.h>
#include <WiFiMulti.h>
#include <Preferences.h>

namespace WifiMgr {

namespace {

constexpr const char* NVS_NAMESPACE = "wifinets";
constexpr const char* NVS_KEY_COUNT = "n";

// --- Danh sách mạng đã lưu (bản sao trong RAM để đỡ mở NVS liên tục) ---
struct Net {
    String ssid;
    String pass;
};
Net    g_nets[WIFI_MAX_SAVED];
size_t g_count = 0;

WiFiMulti g_multi;

// --- Máy trạng thái ---
enum Phase {
    PH_IDLE,        ///< chưa khởi động
    PH_CONNECTING,  ///< đang thử nối một trong các mạng đã lưu
    PH_CONNECTED,   ///< đã nối được, đang giữ kết nối
    PH_PORTAL,      ///< không nối được -> đang phát AP + vẫn thử lại STA ngầm
};
Phase    g_phase       = PH_IDLE;
uint32_t g_connectT0   = 0;   ///< millis() lúc bắt đầu cả đợt thử nối (để tính portal)
uint32_t g_nextMultiRun = 0;  ///< lần kế gọi g_multi.run() (giãn cách, phi chặn)
uint32_t g_apSince     = 0;   ///< millis() lúc bật AP

char g_apName[33] = "";       ///< SSID của AP (đặt khi vào portal)

// Chu kỳ gọi WiFiMulti.run() khi đang cố nối. run() tự quét nên hơi nặng,
// không gọi quá dày. 1,2 giây/lần là đủ nhanh mà không ngốn CPU.
constexpr uint32_t MULTI_RUN_INTERVAL_MS = 1200;

// --------------------------------------------------------------------------
//  NVS: nạp / lưu danh sách mạng
// --------------------------------------------------------------------------

/// Nạp danh sách mạng từ NVS vào g_nets[].
void loadFromNvs() {
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, /*readOnly=*/true);
    size_t n = prefs.getUInt(NVS_KEY_COUNT, 0);
    if (n > WIFI_MAX_SAVED) n = WIFI_MAX_SAVED;
    g_count = 0;
    for (size_t i = 0; i < n; ++i) {
        char ks[8], kp[8];
        snprintf(ks, sizeof(ks), "ssid%u", (unsigned)i);
        snprintf(kp, sizeof(kp), "pass%u", (unsigned)i);
        String ssid = prefs.getString(ks, "");
        String pass = prefs.getString(kp, "");
        if (ssid.length() == 0) continue;   // bỏ ô rỗng
        g_nets[g_count].ssid = ssid;
        g_nets[g_count].pass = pass;
        g_count++;
    }
    prefs.end();
}

/// Ghi toàn bộ danh sách g_nets[] xuống NVS.
void saveToNvs() {
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, /*readOnly=*/false);
    prefs.clear();                            // viết lại từ đầu cho gọn
    prefs.putUInt(NVS_KEY_COUNT, (uint32_t)g_count);
    for (size_t i = 0; i < g_count; ++i) {
        char ks[8], kp[8];
        snprintf(ks, sizeof(ks), "ssid%u", (unsigned)i);
        snprintf(kp, sizeof(kp), "pass%u", (unsigned)i);
        prefs.putString(ks, g_nets[i].ssid);
        prefs.putString(kp, g_nets[i].pass);
    }
    prefs.end();
}

/// Nạp lại tất cả mạng đã lưu vào WiFiMulti. Không có cách xóa từng mạng khỏi
/// WiFiMulti nên khi danh sách đổi thì chấp nhận thêm đè — lần begin() kế (hoặc
/// reboot) sẽ sạch. Với add/remove ta tạo lại WiFiMulti bằng cách gọi addAP hết.
void reloadMulti() {
    for (size_t i = 0; i < g_count; ++i) {
        g_multi.addAP(g_nets[i].ssid.c_str(), g_nets[i].pass.c_str());
    }
}

/// true nếu SSID đã có trong danh sách; trả chỉ số qua outIdx nếu khác null.
bool findSsid(const String& ssid, size_t* outIdx) {
    for (size_t i = 0; i < g_count; ++i) {
        if (g_nets[i].ssid == ssid) { if (outIdx) *outIdx = i; return true; }
    }
    return false;
}

// --------------------------------------------------------------------------
//  AP (cổng cấu hình) — chỉ bật khi cần
// --------------------------------------------------------------------------

/// Bật chế độ AP+STA: vẫn giữ STA để thử nối mạng thật ngầm, đồng thời phát AP
/// để người dùng vào trang cấu hình nhập mạng mới.
void startPortal() {
    // Tên AP: HOSTNAME cho dễ nhận. Mật khẩu AP đặt trong config (>= 8 ký tự).
    strlcpy(g_apName, HOSTNAME, sizeof(g_apName));
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(g_apName, AP_PASSWORD);
    g_apSince = millis();
    g_phase   = PH_PORTAL;
    Serial.printf("[WIFI] Khong noi duoc mang da luu -> bat AP cau hinh \"%s\" "
                  "(mat khau \"%s\"), IP = %s\n",
                  g_apName, AP_PASSWORD, WiFi.softAPIP().toString().c_str());
}

/// Tắt AP, quay về chỉ dùng STA (gọi khi đã nối lại được mạng thật).
void stopPortal() {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    g_apName[0] = '\0';
    Serial.println("[WIFI] Da noi lai mang that -> tat AP cau hinh");
}

}  // namespace

// ==========================================================================
//  API công khai
// ==========================================================================

void begin() {
    loadFromNvs();

    // Tương thích ngược: NVS rỗng thì seed bằng Wi-Fi "mồi" trong secrets.h.
    if (g_count == 0) {
        const String seedSsid = WIFI_SSID;
        if (seedSsid.length() > 0 && seedSsid != "TEN_WIFI_CUA_BAN") {
            g_nets[0].ssid = seedSsid;
            g_nets[0].pass = WIFI_PASSWORD;
            g_count = 1;
            saveToNvs();
            Serial.printf("[WIFI] NVS rong -> seed mang moi tu secrets.h: \"%s\"\n",
                          seedSsid.c_str());
        } else {
            Serial.println("[WIFI] Chua co mang nao luu va secrets.h chua dien "
                           "-> se bat AP cau hinh sau vai giay");
        }
    }

    WiFi.mode(WIFI_STA);
    WiFi.setHostname(HOSTNAME);
    WiFi.setSleep(false);              // tắt tiết kiệm điện cho WebSocket mượt
    WiFi.setAutoReconnect(true);

    reloadMulti();

    g_phase        = PH_CONNECTING;
    g_connectT0    = millis();
    g_nextMultiRun = 0;                // chạy run() ngay vòng loop() đầu
    Serial.printf("[WIFI] Co %u mang da luu -> dang quet va noi mang manh nhat\n",
                  (unsigned)g_count);
}

void loop() {
    const uint32_t now = millis();
    const bool up = WiFi.status() == WL_CONNECTED;

    switch (g_phase) {
        case PH_IDLE:
            break;

        case PH_CONNECTING:
            if (up) {
                g_phase = PH_CONNECTED;
                break;
            }
            // Thử nối (WiFiMulti tự quét + chọn mạng mạnh nhất), giãn cách phi chặn.
            if (now >= g_nextMultiRun) {
                g_nextMultiRun = now + MULTI_RUN_INTERVAL_MS;
                if (g_count > 0) g_multi.run();
            }
            // Hết thời gian chờ mà vẫn chưa nối -> mở cổng cấu hình (AP).
            if (now - g_connectT0 >= CONFIG_PORTAL_AFTER_MS) {
                startPortal();
            }
            break;

        case PH_CONNECTED:
            if (!up) {
                // Mất mạng -> quay lại thử nối. autoReconnect của lõi vẫn chạy,
                // nhưng ta cũng chủ động chạy WiFiMulti để chọn mạng khác nếu có.
                Serial.println("[WIFI] Mat ket noi -> dang thu noi lai");
                g_phase        = PH_CONNECTING;
                g_connectT0    = now;    // đếm lại từ đầu cho mốc bật AP
                g_nextMultiRun = 0;
            }
            break;

        case PH_PORTAL:
            // Đang phát AP nhưng VẪN cố nối STA ngầm: nối được mạng thật thì tắt AP.
            if (up) {
                stopPortal();
                g_phase = PH_CONNECTED;
                break;
            }
            if (now >= g_nextMultiRun) {
                g_nextMultiRun = now + MULTI_RUN_INTERVAL_MS;
                if (g_count > 0) g_multi.run();
            }
            break;
    }
}

bool isConnected() {
    return WiFi.status() == WL_CONNECTED;
}

size_t count() {
    return g_count;
}

bool add(const String& ssid, const String& pass) {
    if (ssid.length() == 0) return false;

    size_t idx;
    if (findSsid(ssid, &idx)) {
        // Đã có -> cập nhật mật khẩu
        g_nets[idx].pass = pass;
    } else {
        if (g_count >= WIFI_MAX_SAVED) {
            Serial.printf("[WIFI] Danh sach day (%u mang), khong them \"%s\"\n",
                          (unsigned)WIFI_MAX_SAVED, ssid.c_str());
            return false;
        }
        g_nets[g_count].ssid = ssid;
        g_nets[g_count].pass = pass;
        g_count++;
    }
    saveToNvs();
    g_multi.addAP(ssid.c_str(), pass.c_str());   // dùng ngay cho lần quét kế

    // Vừa thêm mạng -> rời cổng cấu hình, thử nối ngay (đếm lại mốc bật AP).
    g_connectT0    = millis();
    g_nextMultiRun = 0;
    if (g_phase == PH_PORTAL || g_phase == PH_IDLE) g_phase = PH_CONNECTING;
    Serial.printf("[WIFI] Da luu mang \"%s\" (tong %u) -> thu noi\n",
                  ssid.c_str(), (unsigned)g_count);
    return true;
}

bool remove(const String& ssid) {
    size_t idx;
    if (!findSsid(ssid, &idx)) return false;
    for (size_t i = idx; i + 1 < g_count; ++i) g_nets[i] = g_nets[i + 1];
    g_count--;
    g_nets[g_count].ssid = "";
    g_nets[g_count].pass = "";
    saveToNvs();
    Serial.printf("[WIFI] Da xoa mang \"%s\" (con %u)\n",
                  ssid.c_str(), (unsigned)g_count);
    // WiFiMulti không cho xóa từng mạng; mạng vừa xóa chỉ thật sự biến mất sau
    // reboot. Vẫn an toàn: nếu nó không còn phát sóng thì không bị chọn nữa.
    return true;
}

String listJson() {
    String out = "[";
    for (size_t i = 0; i < g_count; ++i) {
        if (i) out += ',';
        out += "{\"ssid\":\"";
        // Thoát dấu " và \ cho JSON hợp lệ (SSID có thể chứa ký tự lạ).
        for (size_t k = 0; k < g_nets[i].ssid.length(); ++k) {
            const char c = g_nets[i].ssid[k];
            if (c == '"' || c == '\\') out += '\\';
            out += c;
        }
        out += "\"}";
    }
    out += "]";
    return out;
}

String scanJson() {
    // Quét ĐỒNG BỘ ngắn gọn rồi giải phóng ngay để tiết kiệm RAM (AP + web async
    // + các task đã chiếm nhiều). scanNetworks() chặn ~2-3 giây nhưng chỉ chạy
    // khi người dùng bấm "Quét" trên web nên chấp nhận được.
    const int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/false);
    String out = "[";
    for (int i = 0; i < n; ++i) {
        if (i) out += ',';
        out += "{\"ssid\":\"";
        const String s = WiFi.SSID(i);
        for (size_t k = 0; k < s.length(); ++k) {
            const char c = s[k];
            if (c == '"' || c == '\\') out += '\\';
            out += c;
        }
        out += "\",\"rssi\":";
        out += WiFi.RSSI(i);
        out += ",\"enc\":";
        out += (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "false" : "true";
        out += '}';
    }
    out += "]";
    WiFi.scanDelete();               // giải phóng kết quả quét ngay
    return out;
}

bool portalActive() {
    return g_phase == PH_PORTAL;
}

const char* apSsid() {
    return g_apName;
}

String currentSsid() {
    return (WiFi.status() == WL_CONNECTED) ? WiFi.SSID() : String("");
}

}  // namespace WifiMgr
