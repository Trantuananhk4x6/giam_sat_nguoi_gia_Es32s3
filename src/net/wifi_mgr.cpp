/**
 * @file  wifi_mgr.cpp
 * @brief Thân bộ quản lý đa Wi-Fi v2 (xem wifi_mgr.h).
 *
 *  LUỒNG CHẠY (máy trạng thái phi chặn, mỗi vòng loop() chỉ vài chục µs)
 *
 *      khởi động ──(có "last")──> thử thẳng mạng dùng gần nhất (không quét, 8 s)
 *          │                                     │ hỏng
 *          v                                     v
 *      quét async ──> thử lần lượt các ứng viên ──────────> ĐÃ NỐI
 *          ^                  │ hết ứng viên                   │ mất WL_CONNECTED > 1,5 s
 *          └─ chờ 3/6/12/24/30 s ─┘                            v
 *                                       thử nhanh lại đúng mạng đó rồi mới quét lại
 *
 *  VÌ SAO PHẢI "NGHỈ" 250 ms SAU MỖI LƯỢT HỎNG
 *    Lõi arduino-esp32 2.0.17 tự gọi WiFi.disconnect(); WiFi.begin() THÊM một lần
 *    ở lần ngắt đầu tiên sau khi bật nguồn (cờ first_connect), kể cả khi đã tắt
 *    autoReconnect. Nên sau mỗi lượt hỏng ta chủ động WiFi.disconnect() (hủy lượt
 *    tự thử đó) rồi chờ 250 ms — bằng trạng thái, không delay — cho driver nhả hẳn
 *    lượt cũ trước khi quét/thử tiếp. Bộ đếm sự kiện ngắt được chụp ngay trước
 *    WiFi.begin(); chỉ sự kiện có số lớn hơn mới tính cho lượt hiện tại, nên sự
 *    kiện "trễ" của lượt cũ không bị tính nhầm.
 *
 *  CHIA VIỆC GIỮA CÁC TASK
 *    - loop() (task Arduino): DUY NHẤT nơi gọi lệnh điều khiển driver + DNS.
 *    - Task web (async_tcp): chỉ đặt cờ yêu cầu và đọc trạng thái dưới g_mtx.
 *    - Callback sự kiện Wi-Fi (task sự kiện): chỉ ghi một biến atomic.
 *    - Ghi NVS (có thể mất vài chục ms) KHÔNG làm khi đang giữ g_mtx; các lần
 *      ghi xếp hàng bằng g_nvsMtx. Thứ tự khóa luôn là g_nvsMtx -> g_mtx. Task
 *      web được chờ g_nvsMtx; loop() chỉ thử lấy (timeout 0), bận thì để vòng sau.
 *
 *  LƯU NVS (namespace "wifinets", tương thích bản cũ): "n" = số mạng,
 *  "ssid<i>"/"pass<i>" = mạng thứ i, "last" = SSID nối thành công gần nhất (chỉ
 *  ghi khi đổi). Kết quả thử từng mạng (last/lastAgo trong API) chỉ giữ trong RAM.
 *  add()/remove() ghi NVS TRƯỚC rồi mới đổi RAM: ghi lỗi = không có gì thay đổi.
 *
 *  ĐỔI MẬT KHẨU MẠNG ĐÃ LƯU (có đường lùi)
 *    Sắp thử mạng đó (đang nối đúng mạng đó, connect=1, hoặc chưa có mạng) thì
 *    mật khẩu mới nằm riêng ở g_trial, g_nets vẫn giữ mật khẩu cũ, NVS chưa đổi.
 *    Lượt thử của người dùng nối được -> chép sang g_nets + ghi NVS; hỏng hoặc bị
 *    hủy -> bỏ mật khẩu mới (attempt.rolledBack) rồi thử nhanh lại bằng mật khẩu
 *    cũ (hoặc quay về mạng vừa dùng nếu người dùng đang đổi sang mạng khác).
 *
 *  TẠM DỪNG NỀN KHI CÓ NGƯỜI ĐANG DÙNG TRANG CẤU HÌNH (xem updatePause())
 *    AP tự bật + có yêu cầu HTTP từ phía AP trong 30 s gần nhất -> ngừng quét/thử
 *    theo chu trình (STA nối router khác kênh sẽ kéo AP đổi kênh, điện thoại rớt
 *    khỏi trang). Thử nhanh vẫn chạy; dừng liên tục tối đa 5 phút.
 */
#include "wifi_mgr.h"
#include "config.h"
#include "secrets.h"

#include <WiFi.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <atomic>
#include <ctype.h>
#include <string.h>

namespace WifiMgr {

namespace {

// ===========================================================================
//  Hằng số nội bộ
// ===========================================================================
constexpr const char* NVS_NAMESPACE    = "wifinets";
constexpr const char* NVS_KEY_COUNT    = "n";
constexpr const char* NVS_KEY_LAST     = "last";
constexpr const char* SEED_PLACEHOLDER = "TEN_WIFI_CUA_BAN";   ///< giá trị mẫu trong secrets.h.example

constexpr size_t SSID_MAX = 32;   ///< chuẩn 802.11: SSID tối đa 32 byte
constexpr size_t PASS_MAX = 64;   ///< 63 ký tự passphrase hoặc 64 ký tự hex (PSK thô)

constexpr uint32_t SETTLE_MS             = 250;     ///< nghỉ sau disconnect trước việc kế tiếp
/// Lượt của người dùng hỏng: nghỉ lâu hơn để kết quả (kể cả rolledBack) còn trên
/// API tới khi trang web (hỏi mỗi 1 s lúc đang theo dõi) kịp đọc, trước khi lượt
/// kế tiếp (thử nhanh về mạng/mật khẩu cũ, chu trình) ghi đè "attempt".
constexpr uint32_t USER_RESULT_HOLD_MS   = 1500;
constexpr uint32_t LINK_LOST_MS          = 1500;    ///< mất WL_CONNECTED liên tục bao lâu thì coi là mất mạng
constexpr uint32_t BACKOFF_FIRST_MS      = 3000;    ///< giãn cách 3 s, 6 s, 12 s, 24 s ...
constexpr uint32_t BACKOFF_MAX_MS        = 30000;   ///< ... tối đa 30 s
constexpr uint8_t  BACKOFF_MAX_STEP      = 4;
constexpr uint32_t PORTAL_CYCLE_MS       = 30000;   ///< AP bật, không ai nối: chu trình nền mỗi 30 s
constexpr uint32_t PORTAL_CLOSE_EMPTY_MS = 5000;    ///< có mạng mà AP không còn ai: tắt sau 5 s
constexpr uint32_t CLIENT_RECENT_MS      = 10000;   ///< coi như "còn client" nếu vừa thấy trong 10 s
constexpr uint32_t PORTAL_RETRY_MS       = 5000;    ///< bật AP lỗi thì thử lại sau 5 s
constexpr uint32_t POLL_MS               = 1000;    ///< chu kỳ đọc RSSI/kênh/số client AP
constexpr uint32_t PORTAL_ACTIVE_MS      = 30000;   ///< có HTTP từ phía AP trong 30 s = có người đang dùng trang cấu hình
constexpr uint32_t PAUSE_MAX_MS          = 5UL * 60 * 1000;   ///< tạm dừng nền liên tục tối đa 5 phút
constexpr uint32_t DNS_POLL_MS           = 15;      ///< DNS captive: mỗi 15 ms (parsePacket() malloc/free 1460 B mỗi lần gọi)
constexpr uint32_t NVS_RETRY_MS          = 30000;   ///< loop() ghi NVS lỗi thì thử lại sau 30 s
constexpr uint32_t LOOP_WINDOW_MS        = 60000;   ///< cửa sổ đo thời gian lớn nhất của một vòng loop()
constexpr uint32_t LOOP_WARN_US          = 20000;   ///< một vòng loop() quá 20 ms thì in cảnh báo ...
constexpr uint32_t LOOP_WARN_GAP_MS      = 1000;    ///< ... tối đa một dòng mỗi giây (gộp, in giá trị lớn nhất)

constexpr uint32_t SCAN_MS_PER_CHAN      = 200;     ///< quét chủ động, tối đa 200 ms/kênh
constexpr uint8_t  SCAN_RETRY_MAX        = 3;       ///< quét lỗi (-2) thì thử lại tối đa 3 lần ...
constexpr uint32_t SCAN_RETRY_MS         = 1000;    ///< ... cách nhau 1 s
/// Quét quá 15 s chưa xong mới coi là hỏng. KHÔNG dựa vào -2 của scanComplete():
/// lõi 2.0.17 trả -2 sau 20 × max_ms_per_chan (= 4 s) dù driver vẫn đang quét.
constexpr uint32_t SCAN_HANG_MS          = 15000;
constexpr uint32_t SCAN_REUSE_MS         = 3000;    ///< vừa có lượt quét MỚI (< 3 s) thì chu trình dùng luôn, khỏi quét
constexpr uint32_t SCAN_EXPIRE_MS        = 30UL * 60 * 1000;   ///< cache quá 30 phút thì bỏ hẳn
constexpr uint32_t SCAN_FRESH_MIN_MS     = 3000;    ///< ?fresh=1 trong 3 s sau lượt quét vừa xong thì không quét lại
constexpr size_t   SCAN_CACHE_MAX        = 32;      ///< số SSID (đã gộp trùng) giữ trong cache
constexpr size_t   SCAN_JSON_MAX         = 25;      ///< số mạng tối đa trả cho trang web

constexpr uint32_t HINT_MAX_AGE_MS       = 60000;            ///< cache trẻ hơn 60 s thì dùng kênh/BSSID
constexpr uint32_t SEEN_MAX_AGE_MS       = 5UL * 60 * 1000;  ///< "seen" trong /list: cache trẻ hơn 5 phút
constexpr uint32_t WRONG_PASS_MEMORY_MS  = 10UL * 60 * 1000; ///< nhớ "sai mật khẩu" 10 phút để hạ điểm
constexpr int      SCORE_LAST_BONUS      = 8;       ///< cộng điểm cho mạng nối được gần nhất
constexpr int      SCORE_WRONG_PASS      = 30;      ///< trừ điểm mạng vừa báo sai mật khẩu
constexpr int      SCORE_BLIND           = -1000;   ///< mạng không thấy khi quét luôn xếp sau cùng
constexpr uint8_t  BLIND_EVERY_CYCLES    = 3;       ///< mỗi 3 chu trình thử mù các mạng không thấy (SSID ẩn)

// Mã lý do ngắt của ESP-IDF (wifi_err_reason_t) cần xử lý riêng, ép về uint8_t
// cho khớp kiểu trường reason của sự kiện.
constexpr uint8_t  REASON_ASSOC_LEAVE    = static_cast<uint8_t>(WIFI_REASON_ASSOC_LEAVE);     // 8
constexpr uint8_t  REASON_BEACON_TIMEOUT = static_cast<uint8_t>(WIFI_REASON_BEACON_TIMEOUT);  // 200
constexpr uint8_t  REASON_ASSOC_FAIL     = static_cast<uint8_t>(WIFI_REASON_ASSOC_FAIL);      // 203

constexpr uint8_t  AP_MAX_CLIENTS        = 4;
/// AP_PASSWORD ngắn hơn 8 ký tự thì chuẩn WPA2 không chấp nhận -> phát AP MỞ.
constexpr bool     AP_SECURE             = sizeof(AP_PASSWORD) > 8;

// ===========================================================================
//  Kiểu dữ liệu
// ===========================================================================

/// Kết quả một lượt thử (khớp kiểu Result của hợp đồng API Wi-Fi v2).
enum Result : uint8_t { RES_NONE = 0, RES_TRYING, RES_OK, RES_WRONG_PASS, RES_NOT_FOUND, RES_TIMEOUT, RES_FAIL };

/// Pha công khai (khớp kiểu Phase của hợp đồng API Wi-Fi v2).
enum Phase : uint8_t { PH_IDLE = 0, PH_SCANNING, PH_CONNECTING, PH_CONNECTED, PH_WAITING };

/// Bước nội bộ của máy trạng thái (chỉ loop() đọc/ghi).
enum Step : uint8_t {
    S_IDLE,       ///< không có việc: chưa lưu mạng nào, hoặc tạm dừng vì có người dùng trang cấu hình
    S_SETTLE,     ///< vừa disconnect, chờ g_settleMs (SETTLE_MS / USER_RESULT_HOLD_MS) cho driver nhả hẳn lượt cũ
    S_SCAN,       ///< chờ lượt quét của chu trình
    S_ATTEMPT,    ///< đang thử nối một mạng
    S_CONNECTED,  ///< đã nối
    S_WAIT,       ///< giãn cách giữa hai chu trình
};

/// Loại lượt thử -> quyết định làm gì khi nó hỏng.
enum Kind : uint8_t {
    K_CAND,   ///< ứng viên của chu trình nền -> hỏng thì sang ứng viên kế
    K_FAST,   ///< thử nhanh không quét (mạng vừa mất / mạng dùng gần nhất) -> hỏng thì quét
    K_USER,   ///< người dùng yêu cầu -> hỏng thì quay về mạng vừa dùng (nếu có)
};

enum PortalReason : uint8_t { PR_NONE = 0, PR_AUTO, PR_MANUAL };

struct SavedNet {
    char     ssid[SSID_MAX + 1];
    char     pass[PASS_MAX + 1];
    Result   last;     ///< kết quả lần thử gần nhất (chỉ RAM)
    uint32_t lastAt;   ///< millis() lúc có kết quả đó (lúc bắt đầu nếu đang thử)
};

struct ScanNet {
    char    ssid[SSID_MAX + 1];
    int8_t  rssi;
    uint8_t ch;
    bool    enc;       ///< true = có mật khẩu
    uint8_t bssid[6];  ///< BSSID mạnh nhất của SSID này
};

struct Attempt {
    uint32_t id;          ///< tăng 1 mỗi lần WiFi.begin(); 0 = chưa có lượt nào
    char     ssid[SSID_MAX + 1];
    Result   result;
    uint8_t  reason;      ///< mã lý do ngắt của ESP-IDF, 0 nếu không có
    bool     user;
    bool     cancelled;   ///< bị hủy giữa chừng (người dùng đổi mạng / mạng bị xóa)
    bool     rolledBack;  ///< lượt thử mật khẩu MỚI hỏng/bị hủy -> đã giữ lại mật khẩu cũ
    uint32_t startedAt;
    uint32_t endedAt;
};

/// Mật khẩu MỚI của một mạng ĐÃ LƯU đang chờ thử (chưa ghi NVS). g_nets vẫn giữ
/// mật khẩu cũ; chỉ khi lượt thử của người dùng nối được mới chép sang + ghi NVS.
struct Trial {
    uint32_t seq;                  ///< 0 = không có; mỗi lần add() đặt mật khẩu chờ thử thì nhận số mới
    char     ssid[SSID_MAX + 1];
    char     pass[PASS_MAX + 1];
};

struct Candidate {
    char    ssid[SSID_MAX + 1];
    uint8_t ch;
    uint8_t bssid[6];
    bool    hint;    ///< có kênh/BSSID từ cache quét -> nối thẳng, khỏi để driver quét lại
    int16_t score;
};

/// Bản chụp trạng thái cho task web (loop() ghi dưới khóa, web đọc dưới khóa).
struct Pub {
    Phase        phase;
    bool         up;
    char         ssid[SSID_MAX + 1];
    uint32_t     ip;
    int8_t       rssi;
    uint8_t      channel;
    char         trying[SSID_MAX + 1];
    bool         portal;
    PortalReason reason;
    uint32_t     apIp;
    uint8_t      apClients;
    uint32_t     closeAt;    ///< millis() AP sẽ tự tắt, 0 = không hẹn
    bool         scanning;
    bool         paused;     ///< đang tạm dừng tự nối nền vì có người dùng trang cấu hình
};

// ===========================================================================
//  Khóa
// ===========================================================================
SemaphoreHandle_t g_mtx    = nullptr;   ///< bảo vệ toàn bộ "dữ liệu dùng chung" bên dưới
SemaphoreHandle_t g_nvsMtx = nullptr;   ///< xếp hàng các lần ghi NVS (task web + loop())

/// Khóa RAII: giữ g_mtx trong phạm vi khối. KHÔNG lồng nhau (mutex không đệ quy).
struct Lock {
    Lock()  { if (g_mtx) xSemaphoreTake(g_mtx, portMAX_DELAY); }
    ~Lock() { if (g_mtx) xSemaphoreGive(g_mtx); }
    Lock(const Lock&)            = delete;
    Lock& operator=(const Lock&) = delete;
};

// ===========================================================================
//  Dữ liệu dùng chung — CHỈ đọc/ghi khi giữ Lock (trừ chú thích khác)
// ===========================================================================
SavedNet g_nets[WIFI_MAX_SAVED];
size_t   g_count = 0;
char     g_last[SSID_MAX + 1] = "";   ///< SSID nối thành công gần nhất (bản RAM của key "last")

// Cache quét: CHỈ loop() ghi (dưới khóa), nên loop() được đọc không khóa.
ScanNet  g_scan[SCAN_CACHE_MAX];
size_t   g_scanCount = 0;
bool     g_scanHave  = false;
uint32_t g_scanAt    = 0;

// Lượt thử gần nhất: CHỈ loop() ghi (dưới khóa), nên loop() được đọc không khóa.
Attempt  g_att    = {};
uint32_t g_attSeq = 0;

// Yêu cầu từ task web, loop() lấy ra ở đầu mỗi vòng.
bool     g_reqScan    = false;
bool     g_reqConnect = false;
bool     g_reqForce   = false;   ///< true = mật khẩu có thể vừa đổi -> nối lại kể cả khi đang nối đúng mạng đó
char     g_reqSsid[SSID_MAX + 1] = "";
int8_t   g_reqPortal  = -1;      ///< -1 không có yêu cầu, 0 tắt, 1 bật
bool     g_reqRemoved = false;   ///< vừa xóa mạng -> loop() kiểm lại các tham chiếu

Trial    g_trial    = {};        ///< mật khẩu mới chờ thử (add() đặt, loop() xác nhận/bỏ)
uint32_t g_trialSeq = 0;

Pub      g_pub = {};

/// Bản chụp danh sách để ghi NVS ngoài Lock. Chỉ dùng khi đang giữ g_nvsMtx.
SavedNet g_nvsCopy[WIFI_MAX_SAVED];

// --- Biến atomic: đọc/ghi không cần khóa ---
std::atomic<uint32_t> g_disc{0};          ///< (số sự kiện ngắt << 8) | mã lý do; task sự kiện ghi
std::atomic<uint32_t> g_reqAny{0};        ///< web vừa đặt yêu cầu -> loop() mới phải lấy khóa
std::atomic<bool>     g_lastDirty{false}; ///< "last" đổi, chờ loop() ghi NVS
std::atomic<bool>     g_listDirty{false}; ///< danh sách trong RAM khác NVS (mật khẩu mới vừa được xác nhận, hoặc lần ghi trước lỗi)
std::atomic<bool>     g_upFlag{false};
std::atomic<bool>     g_portalFlag{false};
std::atomic<uint32_t> g_apIpRaw{0};
std::atomic<uint32_t> g_portalActAt{0};   ///< millis() của yêu cầu HTTP gần nhất từ phía AP (0 = chưa có); task web ghi
std::atomic<uint32_t> g_loopMaxUs{0};     ///< vòng loop() lâu nhất trong 60 s gần nhất (µs); loop() ghi

// ===========================================================================
//  Trạng thái riêng của loop() — task khác KHÔNG được đụng
// ===========================================================================
Step     g_step      = S_IDLE;
uint32_t g_stepAt    = 0;
uint32_t g_settleMs  = SETTLE_MS;   ///< thời gian nghỉ của bước S_SETTLE hiện tại
bool     g_dirty     = true;    ///< cần cập nhật g_pub ở cuối vòng loop()
uint32_t g_nextPoll  = 0;

Kind     g_kind         = K_CAND;
uint32_t g_deadline     = 0;
uint32_t g_evtSnap      = 0;    ///< số thứ tự sự kiện ngắt lúc WiFi.begin()
Result   g_prevResult   = RES_NONE;
uint32_t g_prevResultAt = 0;
uint32_t g_attTrial     = 0;    ///< g_trial.seq mà lượt đang thử dùng (0 = dùng mật khẩu đã lưu)

bool     g_paused      = false; ///< đang tạm dừng việc nền (kết quả updatePause() của vòng này)
uint32_t g_pauseSince  = 0;     ///< lúc bắt đầu đợt tạm dừng liên tục hiện tại (0 = không có)
bool     g_pauseBreak  = false; ///< đã dừng đủ PAUSE_MAX_MS -> chạy hết MỘT chu trình rồi mới dừng tiếp

uint32_t g_lastRetryAt = 0;     ///< ghi "last" lỗi -> chờ tới mốc này mới thử lại
uint32_t g_listRetryAt = 0;     ///< ghi danh sách lỗi -> chờ tới mốc này mới thử lại

uint32_t g_loopWinAt    = 0;    ///< đầu cửa sổ đo 60 s hiện tại
uint32_t g_loopMaxCur   = 0;    ///< vòng lâu nhất trong cửa sổ hiện tại (µs)
uint32_t g_loopMaxPrev  = 0;    ///< ... trong cửa sổ trước
uint32_t g_loopWarnPend = 0;    ///< vòng quá LOOP_WARN_US chưa kịp in (lớn nhất)
uint32_t g_loopWarnAt   = 0;    ///< mốc được in cảnh báo kế tiếp

Candidate g_cand[WIFI_MAX_SAVED];
uint8_t   g_candN       = 0;
uint8_t   g_candPos     = 0;
uint32_t  g_candBuiltAt = 0;    ///< lúc lập danh sách ứng viên gần nhất
bool      g_cycleActive = false;
uint32_t  g_cycleNo     = 0;
uint8_t   g_backoff     = 0;
uint32_t  g_waitUntil   = 0;

bool     g_userPending = false;
char     g_userSsid[SSID_MAX + 1] = "";
char     g_fast[SSID_MAX + 1]     = "";   ///< lượt thử nhanh (không quét) kế tiếp
char     g_prevSsid[SSID_MAX + 1] = "";   ///< mạng đang dùng trước khi người dùng đổi
char     g_connSsid[SSID_MAX + 1] = "";   ///< mạng đang nối
bool     g_lost      = false;
uint32_t g_lostSince = 0;
uint32_t g_downSince = 0;                 ///< mốc tính CONFIG_PORTAL_AFTER_MS (khởi động / mất mạng)

struct ScanCtl {
    bool     pending;      ///< có yêu cầu quét chưa thực hiện
    bool     running;
    bool     lastFailed;   ///< yêu cầu gần nhất hỏng hẳn (hết lượt thử lại)
    uint8_t  fails;
    uint32_t startedAt;
    uint32_t retryAt;
    uint32_t seq;          ///< tăng mỗi khi có kết quả mới hoặc hỏng hẳn
};
ScanCtl  g_sc            = {};
uint32_t g_cycleScanSeq  = 0;
bool     g_firstScanDone = false;

DNSServer    g_dns;
bool         g_dnsOn          = false;
uint32_t     g_nextDns        = 0;
bool         g_portalOn       = false;
PortalReason g_portalReason   = PR_NONE;
uint32_t     g_portalOpenedAt = 0;
uint32_t     g_portalCloseAt  = 0;       ///< 0 = chưa hẹn tắt
int8_t       g_portalWant     = -1;      ///< yêu cầu tay đang chờ: -1 không, 0 tắt, 1 bật
bool         g_holdAuto       = false;   ///< vừa tắt tay lúc chưa có mạng -> tạm không tự bật lại
uint32_t     g_holdUntil      = 0;
bool         g_portalRetry    = false;   ///< vừa bật AP lỗi -> chờ tới g_portalRetryAt mới thử lại
uint32_t     g_portalRetryAt  = 0;
uint8_t      g_apClients      = 0;
bool         g_clientSeen     = false;
uint32_t     g_clientSeenAt   = 0;
uint32_t     g_nextApPoll     = 0;

// ===========================================================================
//  Tiện ích nhỏ
// ===========================================================================

/// true nếu đã tới/qua mốc t (an toàn khi millis() quay vòng sau 49 ngày).
inline bool due(uint32_t now, uint32_t t) { return (int32_t)(now - t) >= 0; }

inline void copySsid(char* dst, const char* src) { strlcpy(dst, src ? src : "", SSID_MAX + 1); }

/// ArduinoJson 7 chỉ GIỮ CON TRỎ với const char* -> bọc lại để nó CHÉP nội dung
/// (bộ đệm cục bộ / dữ liệu dùng chung có thể đổi trước lúc serialize).
inline JsonString copied(const char* s) { return JsonString(s, JsonString::Copied); }

/// Mức sóng 0..4 vạch theo RSSI. RSSI >= 0 nghĩa là "không biết" -> 0 vạch.
uint8_t bars(int rssi) {
    if (rssi >= 0)   return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -75) return 2;
    if (rssi >= -85) return 1;
    return 0;
}

const char* resultName(Result r) {
    switch (r) {
        case RES_TRYING:     return "trying";
        case RES_OK:         return "ok";
        case RES_WRONG_PASS: return "wrong_pass";
        case RES_NOT_FOUND:  return "not_found";
        case RES_TIMEOUT:    return "timeout";
        case RES_FAIL:       return "fail";
        default:           return "";
    }
}

const char* phaseName(Phase p) {
    switch (p) {
        case PH_SCANNING:   return "scanning";
        case PH_CONNECTING: return "connecting";
        case PH_CONNECTED:  return "connected";
        case PH_WAITING:    return "waiting";
        default:            return "idle";
    }
}

/// Đổi mã lý do ngắt của ESP-IDF sang Result của API.
Result mapReason(uint8_t reason) {
    switch (reason) {
        case WIFI_REASON_NO_AP_FOUND:            return RES_NOT_FOUND;    // 201
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:                         // 15
        case WIFI_REASON_AUTH_FAIL:                                      // 202
        case WIFI_REASON_HANDSHAKE_TIMEOUT:      return RES_WRONG_PASS;   // 204
        default:                                 return RES_FAIL;
    }
}

/// Câu tiếng Việt mô tả một lượt thử (trường "text" của Attempt).
void attemptText(const Attempt& a, char* out, size_t cap) {
    switch (a.result) {
        case RES_TRYING:     strlcpy(out, "Đang kết nối…", cap); return;
        case RES_OK:         strlcpy(out, "Đã kết nối", cap); return;
        case RES_WRONG_PASS: strlcpy(out, "Sai mật khẩu Wi-Fi", cap); return;
        case RES_NOT_FOUND:  strlcpy(out, "Không thấy mạng này (ESP32 chỉ bắt Wi-Fi 2,4 GHz)", cap); return;
        case RES_TIMEOUT:    strlcpy(out, "Quá thời gian chờ (sóng yếu hoặc router không cấp IP)", cap); return;
        default: break;
    }
    if (a.cancelled)                                  strlcpy(out, "Đã hủy lượt thử", cap);
    else if (a.reason == REASON_BEACON_TIMEOUT)       strlcpy(out, "Mất sóng giữa chừng", cap);
    else if (a.reason == REASON_ASSOC_FAIL)           strlcpy(out, "Router từ chối kết nối", cap);
    else snprintf(out, cap, "Không kết nối được (mã %u)", static_cast<unsigned>(a.reason));
}

/// Độ dài (1..4 byte) của ký tự UTF-8 hợp lệ tại s; 0 nếu là byte lỗi.
size_t utf8Len(const uint8_t* s, size_t avail) {
    const uint8_t c = s[0];
    if (c < 0x80) return 1;
    size_t  n;
    uint8_t lo = 0x80, hi = 0xBF;   // khoảng hợp lệ của byte thứ hai
    if      (c >= 0xC2 && c <= 0xDF) n = 2;
    else if (c >= 0xE0 && c <= 0xEF) { n = 3; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { n = 4; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    else return 0;
    if (avail < n || s[1] < lo || s[1] > hi) return 0;
    for (size_t i = 2; i < n; ++i)
        if ((s[i] & 0xC0) != 0x80) return 0;
    return n;
}

/**
 * Chép SSID sang dst, thay byte UTF-8 lỗi và ký tự điều khiển bằng '?'.
 * SSID quét được là byte tùy ý (router cũ hay dùng mã GBK/Latin-1); để nguyên
 * thì trình duyệt ĐÓNG kết nối WebSocket khi gặp UTF-8 lỗi trong gói trạng thái.
 */
void safeText(char* dst, size_t cap, const char* src) {
    const uint8_t* s   = reinterpret_cast<const uint8_t*>(src ? src : "");
    const size_t   len = strlen(reinterpret_cast<const char*>(s));
    size_t o = 0;
    for (size_t i = 0; i < len && o + 1 < cap;) {
        const size_t n = utf8Len(s + i, len - i);
        if (n == 0 || (n == 1 && (s[i] < 0x20 || s[i] == 0x7F))) { dst[o++] = '?'; ++i; continue; }
        if (o + n >= cap) break;
        memcpy(dst + o, s + i, n);
        o += n;
        i += n;
    }
    dst[o] = '\0';
}

void ipText(uint32_t raw, char* out, size_t cap) {
    if (raw == 0) { out[0] = '\0'; return; }
    const IPAddress ip(raw);
    snprintf(out, cap, "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
}

bool validSsid(const char* s, size_t len) {
    return len >= 1 && len <= SSID_MAX && strlen(s) == len;   // strlen khác len = có byte NUL lẫn vào
}

/// Mật khẩu hợp lệ: rỗng (mạng mở), 8..63 ký tự (passphrase) hoặc đúng 64 ký tự hex (PSK).
bool validPass(const char* p, size_t len) {
    if (strlen(p) != len) return false;
    if (len == 0) return true;
    if (len >= 8 && len <= 63) return true;
    if (len != 64) return false;
    for (size_t i = 0; i < len; ++i)
        if (!isxdigit(static_cast<unsigned char>(p[i]))) return false;
    return true;
}

/// GỌI KHI ĐANG GIỮ Lock.
int findSavedLocked(const char* ssid) {
    for (size_t i = 0; i < g_count; ++i)
        if (strcmp(g_nets[i].ssid, ssid) == 0) return static_cast<int>(i);
    return -1;
}

/// GỌI KHI ĐANG GIỮ Lock (hoặc từ loop(), là nơi duy nhất ghi cache).
const ScanNet* findScanLocked(const char* ssid) {
    for (size_t i = 0; i < g_scanCount; ++i)
        if (strcmp(g_scan[i].ssid, ssid) == 0) return &g_scan[i];
    return nullptr;
}

size_t savedCount() {
    Lock l;
    return g_count;
}

/// Đổi bước của máy trạng thái (mọi lần đổi bước đều đi qua đây).
void setStep(Step s, uint32_t now) {
    g_step   = s;
    g_stepAt = now;
    g_dirty  = true;
    g_upFlag.store(s == S_CONNECTED);
}

/// Vào bước nghỉ sau disconnect (SETTLE_MS, hoặc USER_RESULT_HOLD_MS sau lượt hỏng của người dùng).
void enterSettle(uint32_t now, uint32_t holdMs = SETTLE_MS) {
    g_settleMs = holdMs;
    setStep(S_SETTLE, now);
}

/**
 * Tính lại việc tạm dừng nền (gọi MỘT lần mỗi vòng loop(), trước máy trạng thái).
 *
 * Có người ĐANG DÙNG trang cấu hình thì ngừng quét/thử theo chu trình: STA nối
 * router khác kênh sẽ kéo AP đổi kênh theo, điện thoại rớt khỏi trang. Chỉ dừng khi:
 *   - AP TỰ BẬT (bật tay để trình diễn thì không dừng), và
 *   - có yêu cầu HTTP từ phía AP trong PORTAL_ACTIVE_MS (trang hỏi state mỗi
 *     ≤ 4 s; chỉ "đang liên kết AP" thì không tính — điện thoại người nhà tự nối
 *     lại AP sau mất điện không được làm thiết bị đứng mãi), và
 *   - chưa dừng liên tục quá PAUSE_MAX_MS: quá thì vẫn chạy hết MỘT chu trình
 *     (router lên lại là nối được) rồi mới được dừng tiếp.
 * Thử nhanh (g_fast) không bị dừng, xem decideNext().
 */
void updatePause(uint32_t now) {
    const uint32_t act = g_portalActAt.load();
    // Đang nối mạng thì không có gì để dừng. age < 0: task web vừa ghi mốc sau lúc
    // loop() đọc millis() -> vẫn là "vừa có".
    const bool active = g_portalOn && g_portalReason == PR_AUTO && g_step != S_CONNECTED && act != 0 &&
                        static_cast<int32_t>(now - act) < static_cast<int32_t>(PORTAL_ACTIVE_MS);
    bool paused = false;
    if (!active) {
        g_pauseSince = 0;
        g_pauseBreak = false;
    } else if (!g_pauseBreak) {
        if (g_pauseSince == 0) g_pauseSince = now ? now : 1;
        if (now - g_pauseSince >= PAUSE_MAX_MS) {
            g_pauseBreak = true;
            Serial.println("[WIFI] Da tam dung tu noi 5 phut -> van chay mot chu trinh roi moi dung tiep");
        } else {
            paused = true;
        }
    }
    if (paused == g_paused) return;
    g_paused = paused;
    g_dirty  = true;
    if (paused)       Serial.println("[WIFI] Co nguoi dang dung trang cau hinh -> tam dung tu noi nen (thu nhanh van chay)");
    else if (!active) Serial.println("[WIFI] Het tam dung tu noi nen");
}

/// Đang tạm dừng việc nền (kết quả updatePause() của vòng này).
inline bool backgroundPaused() { return g_paused; }

/// Chu trình chạy "bắt buộc" sau PAUSE_MAX_MS đã xong -> được tạm dừng tiếp (đếm lại từ đầu).
inline void endPauseBreak() {
    if (!g_pauseBreak) return;
    g_pauseBreak = false;
    g_pauseSince = 0;
}

/// Kết nối hiện tại có phải của lượt thử ssid? Ngay sau disconnect, WiFi.status()
/// có thể còn báo WL_CONNECTED của mạng CŨ thêm vài ms -> loại trường hợp driver
/// báo rõ một SSID khác. Không đọc được / SSID rỗng (mạng ẩn) thì chấp nhận.
bool linkMatches(const char* ssid) {
    wifi_ap_record_t info;
    if (esp_wifi_sta_get_ap_info(&info) != ESP_OK || info.ssid[0] == 0) return true;
    char cur[SSID_MAX + 1];
    memcpy(cur, info.ssid, SSID_MAX);
    cur[SSID_MAX] = '\0';
    return strcmp(cur, ssid) == 0;
}

// ===========================================================================
//  NVS
// ===========================================================================
void nvsKey(char* out, size_t cap, const char* prefix, size_t i) {
    snprintf(out, cap, "%s%u", prefix, static_cast<unsigned>(i));
}

/// Nạp danh sách + "last" từ NVS. Chỉ gọi trong begin() (chưa có task web).
/// Trả về true nếu NVS đã có key "n", tức từng lưu danh sách — kể cả khi người
/// dùng đã xóa hết mạng (khi đó KHÔNG được seed lại mạng mồi trong secrets.h).
bool loadFromNvs() {
    g_count   = 0;
    g_last[0] = '\0';
    Preferences p;
    if (!p.begin(NVS_NAMESPACE, /*readOnly=*/true)) return false;   // lần đầu: namespace chưa có
    const bool everSaved = p.isKey(NVS_KEY_COUNT);
    size_t n = p.getUInt(NVS_KEY_COUNT, 0);
    if (n > WIFI_MAX_SAVED) n = WIFI_MAX_SAVED;
    for (size_t i = 0; i < n; ++i) {
        char ks[12], kp[12];
        nvsKey(ks, sizeof ks, "ssid", i);
        nvsKey(kp, sizeof kp, "pass", i);
        SavedNet& s = g_nets[g_count];
        memset(&s, 0, sizeof s);
        // isKey() trước để khỏi in lỗi "nvs_get_str ... NOT_FOUND" ra Serial.
        if (!p.isKey(ks) || p.getString(ks, s.ssid, sizeof s.ssid) == 0 || s.ssid[0] == '\0') continue;
        if (p.isKey(kp) && p.getString(kp, s.pass, sizeof s.pass) == 0) {
            memset(&s, 0, sizeof s);   // mật khẩu hỏng/quá dài (dữ liệu bản cũ) -> bỏ mạng này
            continue;
        }
        bool dup = false;
        for (size_t k = 0; k < g_count; ++k)
            if (strcmp(g_nets[k].ssid, s.ssid) == 0) { dup = true; break; }
        if (dup) { memset(&s, 0, sizeof s); continue; }
        ++g_count;
    }
    if (p.isKey(NVS_KEY_LAST) && p.getString(NVS_KEY_LAST, g_last, sizeof g_last) == 0) g_last[0] = '\0';
    p.end();
    return everSaved;
}

/// Ghi danh sách vào NVS. Gọi khi đang giữ g_nvsMtx (hoặc trong begin()). Key "n"
/// chỉ ghi khi mọi ô đã ghi xong: lỗi giữa chừng thì lần khởi động sau vẫn đọc
/// theo số mạng cũ (ô mới ghi dở bị bỏ qua); người gọi lo ghi lại (g_listDirty).
bool writeListToNvs(const SavedNet* list, size_t n) {
    Preferences p;
    if (!p.begin(NVS_NAMESPACE, /*readOnly=*/false)) return false;
    bool ok = true;
    char ks[12], kp[12];
    for (size_t i = 0; ok && i < n; ++i) {
        nvsKey(ks, sizeof ks, "ssid", i);
        nvsKey(kp, sizeof kp, "pass", i);
        // putString trả số ký tự đã ghi (0 cả khi lỗi lẫn khi chuỗi rỗng) -> so với strlen.
        ok = p.putString(ks, list[i].ssid) == strlen(list[i].ssid) &&
             p.putString(kp, list[i].pass) == strlen(list[i].pass);
    }
    if (ok) ok = p.putUInt(NVS_KEY_COUNT, static_cast<uint32_t>(n)) == sizeof(uint32_t);
    // Dọn các ô thừa sau khi xóa mạng (không dùng clear(): nó xóa luôn key "last").
    for (size_t i = n; ok && i < WIFI_MAX_SAVED; ++i) {
        nvsKey(ks, sizeof ks, "ssid", i);
        nvsKey(kp, sizeof kp, "pass", i);
        if (p.isKey(ks)) p.remove(ks);
        if (p.isKey(kp)) p.remove(kp);
    }
    p.end();
    return ok;
}

/// Ghi bản chụp g_nvsCopy[0..n) vào NVS rồi xóa bản chụp (có mật khẩu). GỌI KHI
/// ĐANG GIỮ g_nvsMtx và KHÔNG giữ Lock (ghi flash mất vài chục ms; giữ Lock lâu
/// thì loop() phải đứng chờ). Lỗi -> g_listDirty: loop() ghi lại bản trong RAM
/// (NVS có thể đã ghi dở), có giãn cách.
bool writeCopyToNvs(size_t n) {
    const bool ok = writeListToNvs(g_nvsCopy, n);
    memset(g_nvsCopy, 0, sizeof g_nvsCopy);   // không để bản sao mật khẩu nằm lại trong RAM
    if (!ok) {
        g_listDirty.store(true);
        Serial.println("[WIFI] Loi: khong ghi duoc danh sach mang vao NVS");
    }
    return ok;
}

/// loop(): ghi lại danh sách khi RAM khác NVS (mật khẩu mới vừa được xác nhận,
/// hoặc lần ghi trước lỗi). Không chờ: NVS đang bận thì để vòng sau; ghi lỗi thì
/// thử lại sau NVS_RETRY_MS.
void flushList(uint32_t now) {
    if (!g_listDirty.load() || !due(now, g_listRetryAt)) return;
    if (g_nvsMtx && xSemaphoreTake(g_nvsMtx, 0) != pdTRUE) return;
    size_t n;
    {
        Lock l;
        g_listDirty.store(false);   // xóa TRƯỚC khi chụp: danh sách đổi trong lúc ghi thì vòng sau ghi tiếp
        n = g_count;
        memcpy(g_nvsCopy, g_nets, n * sizeof(SavedNet));
    }
    const bool ok = writeCopyToNvs(n);
    if (g_nvsMtx) xSemaphoreGive(g_nvsMtx);
    if (ok) Serial.println("[WIFI] Da ghi danh sach mang vao NVS");
    else    g_listRetryAt = now + NVS_RETRY_MS;
}

/// loop(): ghi key "last" khi nó đổi. Không chờ: NVS đang bận thì để vòng sau.
/// Ghi lỗi thì đặt lại cờ và thử lại sau NVS_RETRY_MS (không bỏ "last" âm thầm).
void flushLast(uint32_t now) {
    if (!g_lastDirty.load() || !due(now, g_lastRetryAt)) return;
    if (g_nvsMtx && xSemaphoreTake(g_nvsMtx, 0) != pdTRUE) return;
    char v[SSID_MAX + 1];
    {
        Lock l;
        g_lastDirty.store(false);   // xóa TRƯỚC khi chép: "last" đổi trong lúc ghi thì vòng sau ghi tiếp
        copySsid(v, g_last);
    }
    bool ok = false;
    Preferences p;
    if (p.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
        if (v[0]) ok = p.putString(NVS_KEY_LAST, v) == strlen(v);
        else      ok = !p.isKey(NVS_KEY_LAST) || p.remove(NVS_KEY_LAST);
        p.end();
    }
    if (g_nvsMtx) xSemaphoreGive(g_nvsMtx);
    if (ok) return;
    g_lastDirty.store(true);
    g_lastRetryAt = now + NVS_RETRY_MS;
    Serial.println("[WIFI] Loi: khong ghi duoc \"last\" vao NVS -> thu lai sau 30 s");
}

/// NVS CHƯA TỪNG lưu danh sách (chưa có key "n": lần đầu chạy firmware đa Wi-Fi)
/// -> seed bằng mạng "mồi" trong secrets.h. Người dùng đã xóa hết mạng thì "n" = 0
/// vẫn còn, begin() không gọi hàm này nên mạng mồi không tự quay lại.
void seedFromSecrets() {
    const char* ssid = WIFI_SSID;
    const char* pass = WIFI_PASSWORD;
    if (ssid[0] == '\0' || strcmp(ssid, SEED_PLACEHOLDER) == 0) {
        Serial.println("[WIFI] Chua luu mang nao va secrets.h chua dien Wi-Fi -> se bat AP cau hinh sau lan quet dau");
        return;
    }
    if (!validSsid(ssid, strlen(ssid)) || !validPass(pass, strlen(pass))) {
        Serial.println("[WIFI] WIFI_SSID/WIFI_PASSWORD trong secrets.h khong hop le "
                       "(SSID 1-32 byte; mat khau rong, 8-63 ky tu hoac 64 hex) -> bo qua");
        return;
    }
    SavedNet& s = g_nets[0];
    memset(&s, 0, sizeof s);
    copySsid(s.ssid, ssid);
    strlcpy(s.pass, pass, sizeof s.pass);
    g_count = 1;
    if (writeListToNvs(g_nets, 1))
        Serial.printf("[WIFI] NVS chua tung luu mang -> seed mang moi tu secrets.h: \"%s\"\n", ssid);
    else
        Serial.println("[WIFI] Loi: khong ghi duoc mang moi vao NVS (van dung duoc toi lan khoi dong sau)");
}

// ===========================================================================
//  Sự kiện Wi-Fi (chạy trong task sự kiện: CHỈ ghi biến atomic)
// ===========================================================================
void onStaDisconnected(arduino_event_t* e) {
    const uint8_t reason = e->event_info.wifi_sta_disconnected.reason;
    // 8 = ASSOC_LEAVE: do chính ta gọi WiFi.disconnect() (hoặc begin() đổi cấu hình).
    if (reason == REASON_ASSOC_LEAVE) return;
    // Chỉ một task ghi biến này nên load + store là đủ (không cần RMW nguyên tử).
    const uint32_t cnt = (g_disc.load() >> 8) + 1;
    g_disc.store((cnt << 8) | reason);
}

// ===========================================================================
//  Quét async
// ===========================================================================

/// Xin một lượt quét (không trùng nếu đang có lượt chờ/đang chạy).
void requestScan() {
    if (g_sc.running || g_sc.pending) return;
    g_sc.pending = true;
    g_sc.fails   = 0;
    g_sc.retryAt = millis();
    g_dirty      = true;
}

/// Chép kết quả quét vào cache: bỏ SSID rỗng (mạng ẩn), gộp trùng tên giữ BSSID
/// mạnh nhất, sắp RSSI giảm dần. Đọc thẳng bản ghi của driver, không tạo String.
void storeScan(int16_t n, uint32_t now) {
    Lock l;
    g_scanCount = 0;
    for (int16_t i = 0; i < n; ++i) {
        const wifi_ap_record_t* r = static_cast<const wifi_ap_record_t*>(WiFi.getScanInfoByIndex(i));
        if (r == nullptr || r->ssid[0] == 0) continue;
        char ssid[SSID_MAX + 1];
        memcpy(ssid, r->ssid, SSID_MAX);
        ssid[SSID_MAX] = '\0';

        ScanNet* slot = nullptr;
        for (size_t k = 0; k < g_scanCount; ++k)
            if (strcmp(g_scan[k].ssid, ssid) == 0) { slot = &g_scan[k]; break; }
        if (slot != nullptr) {
            if (r->rssi <= slot->rssi) continue;          // đã có BSSID mạnh hơn
        } else if (g_scanCount < SCAN_CACHE_MAX) {
            slot = &g_scan[g_scanCount++];
            copySsid(slot->ssid, ssid);
        } else {
            size_t weak = 0;                               // đầy: thay mạng yếu nhất
            for (size_t k = 1; k < g_scanCount; ++k)
                if (g_scan[k].rssi < g_scan[weak].rssi) weak = k;
            if (r->rssi <= g_scan[weak].rssi) continue;
            slot = &g_scan[weak];
            copySsid(slot->ssid, ssid);
        }
        slot->rssi = r->rssi;
        slot->ch   = r->primary;
        slot->enc  = r->authmode != WIFI_AUTH_OPEN;
        memcpy(slot->bssid, r->bssid, sizeof slot->bssid);
    }
    for (size_t i = 1; i < g_scanCount; ++i) {             // sắp chèn: tối đa 32 phần tử
        const ScanNet t = g_scan[i];
        size_t j = i;
        while (j > 0 && g_scan[j - 1].rssi < t.rssi) { g_scan[j] = g_scan[j - 1]; --j; }
        g_scan[j] = t;
    }
    g_scanHave = true;
    g_scanAt   = now;
}

void scanFailed(uint32_t now) {
    g_dirty = true;
    if (++g_sc.fails <= SCAN_RETRY_MAX) {
        g_sc.pending = true;
        g_sc.retryAt = now + SCAN_RETRY_MS;
        Serial.printf("[WIFI] Quet loi -> thu lai lan %u sau 1 s\n", static_cast<unsigned>(g_sc.fails));
        return;
    }
    g_sc.fails      = 0;
    g_sc.lastFailed = true;
    g_sc.seq++;
    g_firstScanDone = true;
    Serial.println("[WIFI] Quet loi nhieu lan lien tiep -> tam bo qua, dung cache cu");
}

void startScanNow(uint32_t now) {
    g_sc.pending = false;
    const int16_t r = WiFi.scanNetworks(/*async=*/true, /*show_hidden=*/false,
                                        /*passive=*/false, SCAN_MS_PER_CHAN);
    if (r == WIFI_SCAN_RUNNING) {
        g_sc.running   = true;
        g_sc.startedAt = now;
        g_dirty        = true;
        return;
    }
    scanFailed(now);   // -2: thường do STA đang bận nối
}

/// IDF từ chối quét khi STA đang nối, nên chỉ quét lúc không có lượt thử nào.
inline bool scanAllowed() { return g_step != S_ATTEMPT && g_step != S_SETTLE; }

void serviceScan(uint32_t now) {
    if (g_sc.running) {
        const int16_t n = WiFi.scanComplete();
        if (n >= 0) {
            storeScan(n, now);
            WiFi.scanDelete();             // giải phóng bản ghi của driver ngay
            g_sc.running    = false;
            g_sc.fails      = 0;
            g_sc.lastFailed = false;
            g_sc.seq++;
            g_firstScanDone = true;
            g_dirty         = true;
            Serial.printf("[WIFI] Quet xong: %d diem phat, %u ten mang (%lu ms)\n", n,
                          static_cast<unsigned>(g_scanCount),
                          static_cast<unsigned long>(now - g_sc.startedAt));
            return;
        }
        // -1 (đang quét) hoặc -2: lõi 2.0.17 trả -2 ngay khi quá _scanTimeout =
        // 20 × max_ms_per_chan (4 s) dù driver VẪN đang quét; SCAN_DONE tới sau đó
        // thì scanComplete() trả lại số mạng. Nên cứ chờ (KHÔNG scanDelete(), nó vứt
        // kết quả về muộn) tới SCAN_HANG_MS mới coi là hỏng.
        if (now - g_sc.startedAt < SCAN_HANG_MS) return;
        esp_wifi_scan_stop();              // treo thật: dừng hẳn lượt quét của driver
        WiFi.scanDelete();
        g_sc.running = false;
        Serial.printf("[WIFI] Quet qua %lu s chua xong (ma %d)\n",
                      static_cast<unsigned long>(SCAN_HANG_MS / 1000), static_cast<int>(n));
        scanFailed(now);
        return;
    }
    if (g_sc.pending && due(now, g_sc.retryAt) && scanAllowed()) startScanNow(now);
}

// ===========================================================================
//  Các lượt thử nối
// ===========================================================================

/// Dựng ứng viên cho một SSID. allowHint: dùng kênh/BSSID nếu cache còn trẻ.
void makeCandidate(const char* ssid, bool allowHint, uint32_t now, Candidate& c) {
    memset(&c, 0, sizeof c);
    copySsid(c.ssid, ssid);
    if (!allowHint || !g_scanHave || now - g_scanAt > HINT_MAX_AGE_MS) return;
    const ScanNet* sn = findScanLocked(ssid);   // loop() là nơi duy nhất ghi cache
    if (sn == nullptr) return;
    c.hint = true;
    c.ch   = sn->ch;
    memcpy(c.bssid, sn->bssid, sizeof c.bssid);
}

/// Bắt đầu một lượt thử. false nếu mạng không còn trong danh sách (vừa bị xóa).
bool startAttempt(const Candidate& c, Kind kind, uint32_t timeoutMs, uint32_t now) {
    char     pass[PASS_MAX + 1];
    uint32_t id;
    uint32_t trial = 0;
    {
        Lock l;
        const int i = findSavedLocked(c.ssid);
        if (i < 0) return false;
        // Lượt của người dùng cho mạng đang có mật khẩu MỚI chờ thử -> thử mật khẩu
        // đó (chưa ghi NVS, g_nets vẫn giữ mật khẩu cũ để lùi về khi hỏng).
        if (kind == K_USER && g_trial.seq != 0 && strcmp(g_trial.ssid, c.ssid) == 0) {
            strlcpy(pass, g_trial.pass, sizeof pass);
            trial = g_trial.seq;
        } else {
            strlcpy(pass, g_nets[i].pass, sizeof pass);
        }
        g_prevResult      = g_nets[i].last;   // để trả lại nếu lượt này bị hủy giữa chừng / thử mật khẩu mới hỏng
        g_prevResultAt    = g_nets[i].lastAt;
        g_nets[i].last    = RES_TRYING;
        g_nets[i].lastAt  = now;
        g_att             = {};
        g_att.id          = ++g_attSeq;
        copySsid(g_att.ssid, c.ssid);
        g_att.result      = RES_TRYING;
        g_att.user        = kind == K_USER;
        g_att.startedAt   = now;
        id                = g_att.id;
    }
    g_kind     = kind;
    g_attTrial = trial;
    g_deadline = now + timeoutMs;
    g_evtSnap  = g_disc.load() >> 8;   // chụp TRƯỚC begin(): chỉ sự kiện mới hơn mới tính
    const char* pw = pass[0] ? pass : nullptr;   // mạng mở: truyền nullptr
    if (c.hint) WiFi.begin(c.ssid, pw, c.ch, c.bssid);
    else        WiFi.begin(c.ssid, pw);
    memset(pass, 0, sizeof pass);
    setStep(S_ATTEMPT, now);

    const char* why = trial ? "thu mat khau moi"
                            : (kind == K_USER ? "nguoi dung yeu cau" : (kind == K_FAST ? "thu nhanh" : "chu trinh"));
    if (c.hint) Serial.printf("[WIFI] Thu #%lu \"%s\" (%s, kenh %u)\n",
                              static_cast<unsigned long>(id), c.ssid, why, static_cast<unsigned>(c.ch));
    else        Serial.printf("[WIFI] Thu #%lu \"%s\" (%s, khong quet truoc)\n",
                              static_cast<unsigned long>(id), c.ssid, why);
    return true;
}

void schedulePortalClose(uint32_t now);

/// Bỏ mật khẩu chờ thử, giữ mật khẩu cũ trong g_nets (NVS chưa từng đổi). GỌI KHI ĐANG GIỮ Lock.
void discardTrialLocked() {
    memset(&g_trial, 0, sizeof g_trial);   // xóa luôn bản sao mật khẩu
}

/// Lượt hiện tại đang thử đúng mật khẩu chờ thử MỚI NHẤT? (add() đặt lại mật khẩu
/// khác giữa chừng thì không: mật khẩu mới hơn sẽ có lượt thử riêng.) GỌI KHI ĐANG GIỮ Lock.
inline bool attemptOwnsTrialLocked() { return g_attTrial != 0 && g_trial.seq == g_attTrial; }

void attemptSucceeded(uint32_t now) {
    bool committed = false;
    {
        Lock l;
        g_att.result  = RES_OK;
        g_att.reason  = 0;
        g_att.endedAt = now;
        const int i = findSavedLocked(g_att.ssid);
        if (i >= 0) {
            g_nets[i].last   = RES_OK;
            g_nets[i].lastAt = now;
            if (strcmp(g_last, g_att.ssid) != 0) {   // nối được mạng khác "last" -> ghi NVS
                copySsid(g_last, g_att.ssid);
                g_lastDirty.store(true);
            }
        }
        // Mật khẩu mới nối được -> giờ mới thay mật khẩu cũ và ghi NVS (flushList()).
        if (attemptOwnsTrialLocked()) {
            if (i >= 0) {
                strlcpy(g_nets[i].pass, g_trial.pass, sizeof g_nets[i].pass);
                g_listDirty.store(true);
                committed = true;
            }
            discardTrialLocked();
        }
    }
    g_attTrial    = 0;
    if (committed) g_listRetryAt = now;   // ghi ngay ở cuối vòng này (khỏi chờ giãn cách của lần lỗi trước)
    copySsid(g_connSsid, g_att.ssid);
    g_lost        = false;
    g_backoff     = 0;
    g_cycleActive = false;
    g_fast[0]     = '\0';
    g_prevSsid[0] = '\0';
    g_holdAuto    = false;
    endPauseBreak();
    setStep(S_CONNECTED, now);
    if (g_portalOn) schedulePortalClose(now);
    Serial.printf("[WIFI] Thu #%lu \"%s\" -> OK sau %lu ms%s\n", static_cast<unsigned long>(g_att.id),
                  g_att.ssid, static_cast<unsigned long>(now - g_att.startedAt),
                  committed ? " -> mat khau moi dung, luu vao NVS" : "");
}

void finishAttempt(Result r, uint8_t reason, uint32_t now) {
    bool rolledBack = false;
    {
        Lock l;
        g_att.result  = r;
        g_att.reason  = reason;
        g_att.endedAt = now;
        // Thử mật khẩu MỚI mà hỏng -> bỏ nó, giữ mật khẩu cũ (NVS chưa từng đổi).
        if (attemptOwnsTrialLocked()) {
            discardTrialLocked();
            rolledBack = true;
        }
        g_att.rolledBack = rolledBack;
        const int i = findSavedLocked(g_att.ssid);
        if (i >= 0) {
            // Lùi mật khẩu: kết quả vừa rồi là của mật khẩu MỚI, không phải của mật khẩu
            // đang lưu -> trả lại kết quả cũ (khỏi bị trừ điểm "sai mật khẩu" oan).
            if (rolledBack) { g_nets[i].last = g_prevResult; g_nets[i].lastAt = g_prevResultAt; }
            else            { g_nets[i].last = r;            g_nets[i].lastAt = now; }
        }
    }
    g_attTrial = 0;
    Serial.printf("[WIFI] Thu #%lu \"%s\" -> %s (ma %u) sau %lu ms\n",
                  static_cast<unsigned long>(g_att.id), g_att.ssid, resultName(r),
                  static_cast<unsigned>(reason), static_cast<unsigned long>(now - g_att.startedAt));
    // Hủy cả lượt tự thử lại "first_connect" của lõi Arduino (nếu có) rồi nghỉ.
    WiFi.disconnect();
    if (g_kind == K_USER) {
        // Người dùng đổi sang mạng khác mà hỏng -> quay về mạng vừa dùng trước (thử nhanh).
        // Đổi mật khẩu hỏng (không có mạng khác để về) -> thử nhanh lại bằng mật khẩu cũ:
        // đang dùng đúng mạng đó thì đây chính là lượt nối lại.
        const bool backToPrev = g_prevSsid[0] && strcmp(g_prevSsid, g_att.ssid) != 0;
        if (backToPrev)      copySsid(g_fast, g_prevSsid);
        else if (rolledBack) copySsid(g_fast, g_att.ssid);
        if (rolledBack)
            Serial.printf("[WIFI] Mat khau moi cua \"%s\" khong dung -> giu lai mat khau cu, thu nhanh \"%s\"\n",
                          g_att.ssid, g_fast);
    } else if (g_kind == K_FAST) {
        g_prevSsid[0] = '\0';
    }
    enterSettle(now, g_kind == K_USER ? USER_RESULT_HOLD_MS : SETTLE_MS);
}

/// Hủy lượt đang thử (người dùng đổi mạng / mạng bị xóa). Đang thử mật khẩu mới
/// thì cũng bỏ mật khẩu mới, giữ mật khẩu cũ.
void abortAttempt(uint32_t now) {
    WiFi.disconnect();
    bool rolledBack = false;
    {
        Lock l;
        g_att.result    = RES_FAIL;
        g_att.cancelled = true;
        g_att.endedAt   = now;
        if (attemptOwnsTrialLocked()) {
            discardTrialLocked();
            rolledBack = true;
        }
        g_att.rolledBack = rolledBack;
        const int i = findSavedLocked(g_att.ssid);
        if (i >= 0) { g_nets[i].last = g_prevResult; g_nets[i].lastAt = g_prevResultAt; }
    }
    g_attTrial = 0;
    Serial.printf("[WIFI] Huy luot thu #%lu \"%s\"%s\n", static_cast<unsigned long>(g_att.id), g_att.ssid,
                  rolledBack ? " -> giu lai mat khau cu" : "");
    enterSettle(now);
}

/// Rời trạng thái đã nối (mất mạng thật, hoặc người dùng đổi mạng).
void leaveConnected(uint32_t now) {
    WiFi.disconnect();
    g_connSsid[0]   = '\0';
    g_lost          = false;
    g_downSince     = now;
    g_portalCloseAt = 0;
    enterSettle(now);
}

/// Driver đã có IP mà máy trạng thái không chờ (phòng xa) -> nhận luôn kết nối.
void adoptConnection(uint32_t now) {
    char ssid[SSID_MAX + 1] = "";
    wifi_ap_record_t info;
    if (esp_wifi_sta_get_ap_info(&info) == ESP_OK) copySsid(ssid, reinterpret_cast<const char*>(info.ssid));
    {
        Lock l;
        if (findSavedLocked(ssid) >= 0 && strcmp(g_last, ssid) != 0) {
            copySsid(g_last, ssid);
            g_lastDirty.store(true);
        }
    }
    copySsid(g_connSsid, ssid);
    g_lost        = false;
    g_backoff     = 0;
    g_cycleActive = false;
    g_fast[0]     = '\0';
    g_prevSsid[0] = '\0';
    g_holdAuto    = false;
    endPauseBreak();
    setStep(S_CONNECTED, now);
    if (g_portalOn) schedulePortalClose(now);
    Serial.printf("[WIFI] Driver tu noi \"%s\" -> nhan ket noi\n", ssid);
}

// ===========================================================================
//  Chu trình nền
// ===========================================================================

inline bool blindThisCycle() { return (g_cycleNo % BLIND_EVERY_CYCLES) == 0 && !backgroundPaused(); }

/// Lập danh sách ứng viên từ cache quét. Điểm = RSSI (+8 nếu là "last", −30 nếu
/// vừa sai mật khẩu trong 10 phút); mạng không thấy chỉ thêm khi includeBlind.
void buildCandidates(uint32_t now, bool includeBlind) {
    uint8_t seen = 0;
    {
        Lock l;
        const bool cacheOk = g_scanHave && now - g_scanAt <= HINT_MAX_AGE_MS;
        g_candN = 0;
        for (size_t i = 0; i < g_count && g_candN < WIFI_MAX_SAVED; ++i) {
            const SavedNet& s = g_nets[i];
            int score = 0;
            if (strcmp(s.ssid, g_last) == 0) score += SCORE_LAST_BONUS;
            if (s.last == RES_WRONG_PASS && now - s.lastAt <= WRONG_PASS_MEMORY_MS) score -= SCORE_WRONG_PASS;
            const ScanNet* sn = cacheOk ? findScanLocked(s.ssid) : nullptr;
            Candidate&     c  = g_cand[g_candN];
            memset(&c, 0, sizeof c);
            if (sn != nullptr) {
                c.hint = true;
                c.ch   = sn->ch;
                memcpy(c.bssid, sn->bssid, sizeof c.bssid);
                score += sn->rssi;
                ++seen;
            } else if (includeBlind) {
                score += SCORE_BLIND;   // thử mù: không kênh/BSSID -> nối được cả SSID ẩn
            } else {
                continue;
            }
            copySsid(c.ssid, s.ssid);
            c.score = static_cast<int16_t>(score);
            ++g_candN;
        }
    }
    for (uint8_t i = 1; i < g_candN; ++i) {   // sắp chèn, giảm dần, giữ thứ tự khi bằng điểm
        const Candidate t = g_cand[i];
        uint8_t j = i;
        while (j > 0 && g_cand[j - 1].score < t.score) { g_cand[j] = g_cand[j - 1]; --j; }
        g_cand[j] = t;
    }
    g_candPos     = 0;
    g_candBuiltAt = now;
    g_cycleActive = true;
    Serial.printf("[WIFI] Chu trinh #%lu: %u ung vien (%u thay khi quet)\n",
                  static_cast<unsigned long>(g_cycleNo), static_cast<unsigned>(g_candN),
                  static_cast<unsigned>(seen));
}

void enterWait(uint32_t now) {
    endPauseBreak();   // hết một chu trình -> tạm dừng nền lại được (nếu người dùng còn ở trang cấu hình)
    if (savedCount() == 0) { setStep(S_IDLE, now); return; }
    uint32_t d;
    if (g_portalOn) {
        d = PORTAL_CYCLE_MS;
    } else {
        d = BACKOFF_FIRST_MS << g_backoff;
        if (d > BACKOFF_MAX_MS) d = BACKOFF_MAX_MS;
        if (g_backoff < BACKOFF_MAX_STEP) ++g_backoff;
    }
    g_waitUntil = now + d;
    setStep(S_WAIT, now);
    Serial.printf("[WIFI] Chua noi duoc mang nao -> thu lai sau %lu s\n", static_cast<unsigned long>(d / 1000));
}

void decideNext(uint32_t now);

/// Bắt đầu chu trình mới: quét async rồi thử lần lượt (cache vừa quét < 3 s thì dùng luôn).
void startCycle(uint32_t now) {
    if (savedCount() == 0 && g_firstScanDone) {   // chưa có mạng nào để thử
        g_cycleActive = false;
        endPauseBreak();
        setStep(S_IDLE, now);
        return;
    }
    ++g_cycleNo;
    g_prevSsid[0] = '\0';   // đã quay về chu trình bình thường
    // Có lượt quét MỚI hơn lần lập ứng viên trước (thường do trang web vừa xin) và
    // còn trẻ -> dùng luôn. Kết quả cũ của chính chu trình trước thì không dùng lại.
    const bool freshScan = g_scanHave && now - g_scanAt <= SCAN_REUSE_MS &&
                           (g_candBuiltAt == 0 || (int32_t)(g_scanAt - g_candBuiltAt) > 0);
    if (freshScan && !g_sc.pending) {
        buildCandidates(now, blindThisCycle());
        decideNext(now);    // buildCandidates() đã bật g_cycleActive -> không đệ quy vòng lại đây
        return;
    }
    g_cycleScanSeq = g_sc.seq;
    requestScan();          // đang có lượt quét chạy thì dùng luôn kết quả của nó
    setStep(S_SCAN, now);
}

/**
 * Chọn việc kế tiếp khi máy trạng thái rảnh. Thứ tự ưu tiên:
 *   yêu cầu người dùng > quét do trang web xin > thử nhanh > (tạm dừng nền?) >
 *   ứng viên kế > (hết ứng viên) chờ > chu trình mới.
 */
void decideNext(uint32_t now) {
    if (g_sc.running) return;   // lượt quét không hủy giữa chừng được -> đợi xong

    if (g_userPending) {
        g_userPending = false;
        g_fast[0]     = '\0';
        g_dirty       = true;
        Candidate c;
        makeCandidate(g_userSsid, /*allowHint=*/true, now, c);
        if (startAttempt(c, K_USER, WIFI_ATTEMPT_TIMEOUT_MS, now)) return;
    }

    // Trang web đang chờ danh sách mạng -> quét trước rồi mới thử nền.
    if (g_sc.pending && due(now, g_sc.retryAt)) {
        startScanNow(now);
        if (g_sc.running) return;
    }

    // Thử nhanh đứng TRƯỚC kiểm tra tạm dừng: nối lại đúng mạng vừa rớt, hoặc quay
    // về mạng cũ / mật khẩu cũ sau khi người dùng đổi hỏng. AP đang chạy đúng kênh
    // của mạng đó nên lượt này không kéo AP đổi kênh, điện thoại không bị rớt.
    if (g_fast[0]) {
        Candidate c;
        makeCandidate(g_fast, /*allowHint=*/false, now, c);
        g_fast[0] = '\0';
        if (startAttempt(c, K_FAST, WIFI_FAST_RETRY_MS, now)) return;
    }

    if (backgroundPaused()) {
        g_cycleActive = false;
        setStep(S_IDLE, now);
        return;
    }

    while (g_cycleActive && g_candPos < g_candN) {
        const Candidate& c = g_cand[g_candPos++];
        if (startAttempt(c, K_CAND, WIFI_ATTEMPT_TIMEOUT_MS, now)) return;
    }

    if (g_cycleActive) {
        g_cycleActive = false;
        enterWait(now);
        return;
    }
    startCycle(now);
}

// ===========================================================================
//  Yêu cầu từ task web
// ===========================================================================

void handleUserRequest(const char* ssid, bool force, uint32_t now) {
    {
        Lock l;
        if (g_trial.seq != 0 && strcmp(g_trial.ssid, ssid) == 0) {
            // Mạng này có mật khẩu mới chờ thử -> phải thử thật, kể cả khi đang nối
            // đúng mạng này (connectTo() gửi sau add() có thể đã đè mất cờ force).
            force = true;
        } else if (g_trial.seq != 0 && !attemptOwnsTrialLocked()) {
            // Mật khẩu chờ thử của mạng KHÁC chưa kịp thử mà người dùng đã chọn mạng
            // này -> bỏ, giữ mật khẩu cũ. (Đang thử dở thì abortAttempt() lo việc này.)
            discardTrialLocked();
        }
    }
    if (g_step == S_CONNECTED && !force && strcmp(g_connSsid, ssid) == 0) {
        // Đang nối đúng mạng này: báo thành công luôn, khỏi ngắt kết nối vô ích.
        Lock l;
        g_att = {};
        g_att.id        = ++g_attSeq;
        copySsid(g_att.ssid, ssid);
        g_att.result    = RES_OK;
        g_att.user      = true;
        g_att.startedAt = now;
        g_att.endedAt   = now;
        const int i = findSavedLocked(ssid);
        if (i >= 0) { g_nets[i].last = RES_OK; g_nets[i].lastAt = now; }
        g_dirty = true;
        return;
    }
    copySsid(g_userSsid, ssid);
    g_userPending = true;
    g_fast[0]     = '\0';
    g_backoff     = 0;
    g_dirty       = true;
    if (g_step == S_CONNECTED) {
        copySsid(g_prevSsid, g_connSsid);
        Serial.printf("[WIFI] Nguoi dung chon \"%s\" -> roi mang \"%s\"\n", ssid, g_connSsid);
        leaveConnected(now);
    } else if (g_step == S_ATTEMPT) {
        abortAttempt(now);   // giành quyền ngay; decideNext() chạy yêu cầu này sau 250 ms
    }
    // S_SCAN / S_WAIT / S_IDLE / S_SETTLE: decideNext() ưu tiên yêu cầu này khi rảnh.
}

/// Vừa có mạng bị xóa: bỏ mọi tham chiếu tới mạng không còn lưu.
void dropRemovedRefs(uint32_t now) {
    bool attSaved, userSaved, fastSaved, prevSaved;
    {
        Lock l;
        attSaved  = findSavedLocked(g_att.ssid) >= 0;
        userSaved = findSavedLocked(g_userSsid) >= 0;
        fastSaved = findSavedLocked(g_fast) >= 0;
        prevSaved = findSavedLocked(g_prevSsid) >= 0;
    }
    if (g_userPending && !userSaved) { g_userPending = false; g_dirty = true; }
    if (!fastSaved) g_fast[0] = '\0';
    if (!prevSaved) g_prevSsid[0] = '\0';
    if (g_step == S_ATTEMPT && !attSaved) abortAttempt(now);
}

void takeRequests(uint32_t now) {
    bool   connect = false, force = false, scan = false, removed = false;
    int8_t portal  = -1;
    char   ssid[SSID_MAX + 1];
    {
        Lock l;
        if (g_reqConnect) {
            connect      = true;
            force        = g_reqForce;
            copySsid(ssid, g_reqSsid);
            g_reqConnect = false;
        }
        if (g_reqScan) {
            scan          = true;
            g_reqScan     = false;
            g_pub.scanning = true;   // để web không thấy "khoảng hở" rồi xin quét trùng
        }
        removed      = g_reqRemoved;
        g_reqRemoved = false;
        portal       = g_reqPortal;
        g_reqPortal  = -1;
    }
    if (scan) requestScan();
    if (portal >= 0) g_portalWant = portal;
    if (removed) dropRemovedRefs(now);
    if (connect) handleUserRequest(ssid, force, now);
}

// ===========================================================================
//  Máy trạng thái chính
// ===========================================================================
void serviceMachine(uint32_t now, bool linkUp) {
    if (linkUp && g_step != S_CONNECTED && g_step != S_ATTEMPT && g_step != S_SETTLE) {
        adoptConnection(now);
        return;
    }

    switch (g_step) {
        case S_IDLE:
            // Thử nhanh không bị tạm dừng nền (xem decideNext()).
            if (g_userPending || g_fast[0] ||
                (!backgroundPaused() && (!g_firstScanDone || savedCount() > 0)))
                decideNext(now);
            break;

        case S_SETTLE:
            // Người dùng vừa ra lệnh mới thì chỉ cần nghỉ tối thiểu, khỏi chờ hết lúc giữ kết quả.
            if (now - g_stepAt >= (g_userPending ? SETTLE_MS : g_settleMs)) decideNext(now);
            break;

        case S_SCAN:
            if (g_sc.running || g_sc.pending) break;   // chưa xong
            if (g_userPending) {                       // người dùng chen ngang lúc đang quét
                g_cycleActive = false;
                decideNext(now);
                break;
            }
            // Quét hỏng hẳn -> dựa vào cache cũ + thử mù mọi mạng đã lưu.
            buildCandidates(now, blindThisCycle() || g_sc.seq == g_cycleScanSeq || g_sc.lastFailed);
            decideNext(now);
            break;

        case S_ATTEMPT: {
            if (linkUp && linkMatches(g_att.ssid)) { attemptSucceeded(now); break; }
            const uint32_t evt = g_disc.load();
            if ((evt >> 8) != g_evtSnap) {             // driver báo ngắt cho lượt này
                const uint8_t reason = static_cast<uint8_t>(evt & 0xFF);
                finishAttempt(mapReason(reason), reason, now);
                break;
            }
            if (due(now, g_deadline)) finishAttempt(RES_TIMEOUT, 0, now);
            break;
        }

        case S_CONNECTED:
            if (linkUp) { g_lost = false; break; }
            if (!g_lost) { g_lost = true; g_lostSince = now; break; }
            if (now - g_lostSince < LINK_LOST_MS) break;
            {
                // Mất mạng thật -> thử nhanh lại đúng mạng đó (không quét) rồi mới chu trình đầy đủ.
                bool saved;
                {
                    Lock l;
                    saved = findSavedLocked(g_connSsid) >= 0;
                }
                Serial.printf("[WIFI] Mat ket noi \"%s\" (ma %u) -> %s\n", g_connSsid,
                              static_cast<unsigned>(g_disc.load() & 0xFF),
                              saved ? "thu nhanh lai" : "mang da bi xoa, quet tim mang khac");
                if (saved) copySsid(g_fast, g_connSsid);
                leaveConnected(now);
            }
            break;

        case S_WAIT:
            if (g_userPending || due(now, g_waitUntil)) decideNext(now);
            break;
    }
}

// ===========================================================================
//  AP cấu hình + captive portal
// ===========================================================================

/// Kênh cho AP: đang có mạng thì PHẢI trùng kênh STA; chưa có thì lấy kênh của
/// mạng mạnh nhất vừa quét (người dùng nhiều khả năng chọn nó -> lúc STA nối,
/// AP khỏi phải đổi kênh làm rớt điện thoại); không có gì thì kênh 1.
uint8_t pickApChannel() {
    if (g_step == S_CONNECTED) {
        const int32_t ch = WiFi.channel();
        if (ch >= 1 && ch <= 13) return static_cast<uint8_t>(ch);
    }
    if (g_scanHave && g_scanCount > 0 && g_scan[0].ch >= 1 && g_scan[0].ch <= 13) return g_scan[0].ch;
    return 1;
}

/// Hẹn giờ tắt AP khi đang có mạng: còn (hoặc vừa có) người nối -> PORTAL_LINGER_MS
/// cho điện thoại kịp thấy kết quả + IP mới; không ai -> 5 s. Bật tay thì giữ ít
/// nhất tới PORTAL_MANUAL_MAX_MS kể từ lúc bật.
void schedulePortalClose(uint32_t now) {
    g_dirty = true;
    if (!g_portalOn || g_step != S_CONNECTED) { g_portalCloseAt = 0; return; }
    const bool hadClient = g_apClients > 0 || (g_clientSeen && now - g_clientSeenAt < CLIENT_RECENT_MS);
    uint32_t t = now + (hadClient ? PORTAL_LINGER_MS : PORTAL_CLOSE_EMPTY_MS);
    if (g_portalReason == PR_MANUAL) {
        const uint32_t manualEnd = g_portalOpenedAt + PORTAL_MANUAL_MAX_MS;
        if ((int32_t)(manualEnd - t) > 0) t = manualEnd;
    }
    g_portalCloseAt = t ? t : 1;
}

bool openPortal(PortalReason reason, uint32_t now) {
    const IPAddress apAddr(192, 168, 4, 1);
    const IPAddress apMask(255, 255, 255, 0);
    const uint8_t   ch = pickApChannel();

    WiFi.mode(WIFI_AP_STA);   // giữ STA: vẫn thử nối mạng thật trong lúc phát AP
    WiFi.softAPConfig(apAddr, apAddr, apMask);
    if (!WiFi.softAP(AP_SSID, AP_SECURE ? AP_PASSWORD : nullptr, ch, /*ssid_hidden=*/0, AP_MAX_CLIENTS)) {
        Serial.println("[WIFI] Loi: khong bat duoc AP cau hinh -> thu lai sau 5 s");
        WiFi.mode(WIFI_STA);
        g_portalRetry   = true;
        g_portalRetryAt = now + PORTAL_RETRY_MS;
        return false;
    }
    g_portalRetry = false;
    if (!AP_SECURE)
        Serial.println("[WIFI] CANH BAO: AP_PASSWORD ngan hon 8 ky tu -> AP cau hinh MO (khong mat khau). "
                       "Hay doi AP_PASSWORD trong config.h!");

    const IPAddress ip = WiFi.softAPIP();
    // Trả lời MỌI tên miền bằng IP của AP: điện thoại dò mạng (generate_204,
    // hotspot-detect...) bị dẫn về trang cấu hình. TTL ngắn để rời AP là hết cache.
    g_dns.setErrorReplyCode(DNSReplyCode::NoError);
    g_dns.setTTL(30);
    g_dnsOn = g_dns.start(53, "*", ip);
    if (!g_dnsOn) Serial.println("[WIFI] Loi: khong mo duoc DNS cong 53 -> dien thoai se khong tu hien trang cau hinh");

    g_portalOn       = true;
    g_portalReason   = reason;
    g_portalOpenedAt = now;
    g_apClients      = 0;
    g_clientSeen     = false;
    g_nextApPoll     = now + POLL_MS;
    g_nextDns        = now;
    g_portalActAt.store(0);                       // mốc HTTP của lần bật AP trước không tính
    g_apIpRaw.store(static_cast<uint32_t>(ip));   // IP trước, cờ sau: bộ lọc web không thấy cờ bật mà IP rỗng
    g_portalFlag.store(true);
    schedulePortalClose(now);
    Serial.printf("[WIFI] Bat AP cau hinh \"%s\" kenh %u (%s, %s) -> noi dien thoai vao AP roi mo http://%s/\n",
                  AP_SSID, static_cast<unsigned>(ch), reason == PR_MANUAL ? "bang tay" : "tu dong",
                  AP_SECURE ? "co mat khau" : "MO", ip.toString().c_str());
    return true;
}

void closePortal(const char* why) {
    if (g_dnsOn) { g_dns.stop(); g_dnsOn = false; }
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);      // giữ nguyên kết nối STA
    g_portalOn      = false;
    g_portalReason  = PR_NONE;
    g_portalCloseAt = 0;
    g_apClients     = 0;
    g_clientSeen    = false;
    g_portalFlag.store(false);   // cờ trước, IP sau (ngược thứ tự lúc bật)
    g_apIpRaw.store(0);
    g_portalActAt.store(0);
    g_dirty = true;
    Serial.printf("[WIFI] Tat AP cau hinh (%s)\n", why);
}

/// Bật AP lỗi lần trước thì chờ PORTAL_RETRY_MS rồi mới thử lại.
bool portalRetryOk(uint32_t now) {
    if (!g_portalRetry) return true;
    if (!due(now, g_portalRetryAt)) return false;
    g_portalRetry = false;
    return true;
}

void servicePortal(uint32_t now) {
    if (g_portalOn) {
        // Mỗi lần gọi, WiFiUDP::parsePacket() malloc/free 1460 B kể cả khi không có
        // gói -> chỉ phục vụ DNS mỗi DNS_POLL_MS (đủ nhanh cho captive portal).
        if (g_dnsOn && due(now, g_nextDns)) {
            g_nextDns = now + DNS_POLL_MS;
            g_dns.processNextRequest();
        }
        if (due(now, g_nextApPoll)) {
            g_nextApPoll = now + POLL_MS;
            const uint8_t n = WiFi.softAPgetStationNum();
            if (n != g_apClients) {
                Serial.printf("[WIFI] AP cau hinh: %u thiet bi dang noi\n", static_cast<unsigned>(n));
                g_apClients = n;
                g_dirty     = true;
            }
            if (n) { g_clientSeen = true; g_clientSeenAt = now; }
        }
    }

    // Đổi chế độ driver giữa lúc đang nối/quét dễ làm hỏng lượt đó -> chỉ đổi lúc rảnh.
    const bool quiet = g_step != S_ATTEMPT && !g_sc.running;
    const bool up    = g_step == S_CONNECTED;

    if (g_portalWant == 0 && (!g_portalOn || quiet)) {
        if (g_portalOn) closePortal("nguoi dung tat");
        // Tắt tay lúc chưa có mạng: đừng tự bật lại ngay trước mặt người vừa tắt.
        if (!up) { g_holdAuto = true; g_holdUntil = now + PORTAL_MANUAL_MAX_MS; }
        g_portalWant = -1;
    }
    if (g_portalWant == 1) {
        if (g_portalOn) {
            g_portalReason   = PR_MANUAL;     // đang tự bật -> chuyển thành bật tay
            g_portalOpenedAt = now;
            schedulePortalClose(now);
            g_portalWant     = -1;
        } else if (quiet && portalRetryOk(now)) {
            g_holdAuto = false;
            if (openPortal(PR_MANUAL, now)) g_portalWant = -1;
        }
    }

    if (!g_portalOn) {
        if (up || !quiet || g_portalWant >= 0 || !portalRetryOk(now)) return;
        if (g_holdAuto) {
            if (!due(now, g_holdUntil)) return;
            g_holdAuto = false;
        }
        const bool noNetworks = g_firstScanDone && savedCount() == 0;
        if (noNetworks || now - g_downSince >= CONFIG_PORTAL_AFTER_MS) openPortal(PR_AUTO, now);
        return;
    }
    if (up && quiet && g_portalCloseAt && due(now, g_portalCloseAt))
        closePortal(g_portalReason == PR_MANUAL ? "het thoi gian bat tay" : "da co mang");
}

// ===========================================================================
//  Bản chụp cho task web
// ===========================================================================
Phase phaseNow() {
    if (g_step == S_CONNECTED)              return PH_CONNECTED;
    if (g_step == S_ATTEMPT)                return PH_CONNECTING;
    if (g_sc.running || g_step == S_SCAN)   return PH_SCANNING;
    if (g_step == S_SETTLE || g_userPending) return PH_CONNECTING;
    if (g_step == S_WAIT)                   return PH_WAITING;
    return PH_IDLE;
}

void publish(uint32_t now) {
    const bool poll = due(now, g_nextPoll);
    if (!g_dirty && !poll) return;
    if (poll) g_nextPoll = now + POLL_MS;
    g_dirty = false;

    // Đọc driver NGOÀI khóa.
    const bool up      = g_step == S_CONNECTED;
    char       ssid[SSID_MAX + 1] = "";
    int8_t     rssi    = 0;
    uint8_t    channel = 0;
    uint32_t   ip      = 0;
    if (up) {
        wifi_ap_record_t info;
        if (esp_wifi_sta_get_ap_info(&info) == ESP_OK) {
            copySsid(ssid, reinterpret_cast<const char*>(info.ssid));
            rssi    = info.rssi;
            channel = info.primary;
        } else {
            copySsid(ssid, g_connSsid);
        }
        ip = static_cast<uint32_t>(WiFi.localIP());
    }

    Lock l;
    // Cache quá cũ (đang nối lâu ngày không quét) thì bỏ, khỏi dùng kênh/BSSID cũ
    // và khỏi lẫn khi millis() quay vòng.
    if (g_scanHave && now - g_scanAt > SCAN_EXPIRE_MS) {
        g_scanHave  = false;
        g_scanCount = 0;
    }
    g_pub.phase   = phaseNow();
    g_pub.up      = up;
    copySsid(g_pub.ssid, ssid);
    g_pub.rssi    = rssi;
    g_pub.channel = channel;
    g_pub.ip      = ip;
    if (g_step == S_ATTEMPT) copySsid(g_pub.trying, g_att.ssid);
    else if (g_userPending)  copySsid(g_pub.trying, g_userSsid);
    else                     g_pub.trying[0] = '\0';
    g_pub.portal    = g_portalOn;
    g_pub.reason    = g_portalReason;
    g_pub.apIp      = g_portalOn ? g_apIpRaw.load() : 0;
    g_pub.apClients = g_portalOn ? g_apClients : 0;
    g_pub.closeAt   = g_portalOn ? g_portalCloseAt : 0;
    g_pub.scanning  = g_sc.running || g_sc.pending;
    g_pub.paused    = g_paused;
}

/// Ghi khối "attempt" (hoặc null) vào obj. GỌI KHI ĐANG GIỮ Lock.
void putAttemptLocked(JsonObject obj, uint32_t now) {
    if (g_att.id == 0) { obj["attempt"] = nullptr; return; }
    JsonObject a = obj["attempt"].to<JsonObject>();
    // Đủ cho câu dài nhất + hậu tố (UTF-8 tiếng Việt 2–3 byte/chữ): cắt cụt giữa
    // một ký tự là ra UTF-8 lỗi, trình duyệt sẽ đóng WebSocket.
    char buf[192];
    a["id"] = g_att.id;
    safeText(buf, sizeof buf, g_att.ssid);
    a["ssid"]   = copied(buf);
    a["result"] = resultName(g_att.result);
    a["reason"] = g_att.reason;
    attemptText(g_att, buf, sizeof buf);
    if (g_att.rolledBack) strlcat(buf, " — đã giữ lại mật khẩu cũ", sizeof buf);
    a["text"]   = copied(buf);
    const uint32_t ref = g_att.result == RES_TRYING ? g_att.startedAt : g_att.endedAt;
    a["ago"]    = (now - ref) / 1000;
    a["user"]   = g_att.user;
    a["rolledBack"] = g_att.rolledBack;
}

/// Đo thời gian một vòng loop(): giữ giá trị lớn nhất của cửa sổ 60 s hiện tại và
/// cửa sổ trước (stateJson "loopMaxUs" = lớn hơn trong hai); vòng quá 20 ms thì in
/// "[WIFI] loop max ... us" (gộp tối đa một dòng mỗi giây, in giá trị lớn nhất).
void noteLoopTime(uint32_t now, uint32_t us) {
    if (now - g_loopWinAt >= LOOP_WINDOW_MS) {   // sang cửa sổ mới
        g_loopMaxPrev = g_loopMaxCur;
        g_loopMaxCur  = 0;
        g_loopWinAt   = now;
    }
    if (us > g_loopMaxCur) g_loopMaxCur = us;
    g_loopMaxUs.store(g_loopMaxCur > g_loopMaxPrev ? g_loopMaxCur : g_loopMaxPrev);
    if (us > LOOP_WARN_US && us > g_loopWarnPend) g_loopWarnPend = us;
    if (g_loopWarnPend != 0 && due(now, g_loopWarnAt)) {
        Serial.printf("[WIFI] loop max %u us\n", static_cast<unsigned>(g_loopWarnPend));
        g_loopWarnPend = 0;
        g_loopWarnAt   = now + LOOP_WARN_GAP_MS;
    }
}

/// Số giây tới lúc AP tự tắt (0 = không hẹn). GỌI KHI ĐANG GIỮ Lock.
uint32_t closesInLocked(uint32_t now) {
    if (!g_pub.portal || g_pub.closeAt == 0) return 0;
    const int32_t ms = static_cast<int32_t>(g_pub.closeAt - now);
    return ms <= 0 ? 1 : (static_cast<uint32_t>(ms) + 999) / 1000;   // đã tới hạn, chờ lúc rảnh để tắt
}

/// Xếp yêu cầu nối cho loop() (đè yêu cầu cũ chưa lấy). GỌI KHI ĐANG GIỮ Lock;
/// nhả khóa xong nhớ g_reqAny.store(1).
void queueConnectLocked(const char* ssid, bool force) {
    copySsid(g_reqSsid, ssid);
    g_reqForce   = force;
    g_reqConnect = true;
}

}  // namespace

// ==========================================================================
//  API công khai
// ==========================================================================

void begin() {
    if (!g_mtx)    g_mtx    = xSemaphoreCreateMutex();
    if (!g_nvsMtx) g_nvsMtx = xSemaphoreCreateMutex();

    // Chỉ seed mạng mồi khi NVS CHƯA TỪNG có danh sách (chưa có key "n"); người
    // dùng đã xóa hết mạng thì giữ nguyên danh sách rỗng (AP cấu hình tự bật).
    if (!loadFromNvs()) seedFromSecrets();
    else if (g_count == 0) Serial.println("[WIFI] Danh sach mang da luu dang trong -> khong seed lai tu secrets.h");
    {
        Lock l;
        if (g_last[0] && findSavedLocked(g_last) < 0) g_last[0] = '\0';   // "last" trỏ tới mạng đã xóa
    }

    WiFi.persistent(false);               // danh sách mạng do ta tự lưu, đừng để driver ghi flash
    WiFi.setHostname(HOSTNAME);           // PHẢI trước mode() thì DHCP mới gửi đúng tên
    if (!WiFi.mode(WIFI_STA)) Serial.println("[WIFI] Loi: khong bat duoc che do STA");
    WiFi.setAutoReconnect(false);         // tự quản lý việc nối lại (xem đầu file)
    WiFi.setSleep(false);                 // tắt tiết kiệm điện cho WebSocket mượt
    WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK);   // nhận cả router WPA đời cũ
    WiFi.onEvent(onStaDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

    const uint32_t now = millis();
    g_downSince = now;
    if (g_last[0]) copySsid(g_fast, g_last);   // có "last" -> thử thẳng, khỏi quét
    setStep(S_IDLE, now);
    if (g_last[0])
        Serial.printf("[WIFI] Co %u mang da luu -> thu ngay mang dung gan nhat \"%s\"\n",
                      static_cast<unsigned>(g_count), g_last);
    else
        Serial.printf("[WIFI] Co %u mang da luu -> quet tim mang manh nhat\n", static_cast<unsigned>(g_count));
}

void loop() {
    const uint32_t t0     = micros();   // đo cả vòng (kể cả ghi NVS, bật/tắt AP) -> "loopMaxUs"
    const uint32_t now    = millis();
    const bool     linkUp = WiFi.status() == WL_CONNECTED;
    if (g_reqAny.exchange(0) != 0) takeRequests(now);
    updatePause(now);
    serviceScan(now);
    serviceMachine(now, linkUp);
    servicePortal(now);
    publish(now);
    flushLast(now);
    flushList(now);
    noteLoopTime(now, micros() - t0);
}

bool isConnected() {
    return g_upFlag.load();
}

size_t count() {
    return savedCount();
}

AddResult add(const String& ssid, const String& pass, bool connectNow, bool* connecting) {
    if (connecting) *connecting = false;
    if (!validSsid(ssid.c_str(), ssid.length())) return ADD_BAD_SSID;
    if (!validPass(pass.c_str(), pass.length())) return ADD_BAD_PASS;
    const char* s = ssid.c_str();

    // Giữ g_nvsMtx suốt hàm: mọi thay đổi danh sách (add/remove) đều giữ nó, nên
    // danh sách không đổi giữa lúc chụp, lúc ghi NVS và lúc cập nhật RAM.
    if (g_nvsMtx) xSemaphoreTake(g_nvsMtx, portMAX_DELAY);
    AddResult res   = ADD_OK;
    bool      trial = false, isNew = false, start = false;
    size_t    n     = 0;
    {
        Lock l;
        int i = findSavedLocked(s);
        const bool current = g_pub.up && strcmp(g_pub.ssid, s) == 0;
        if (i >= 0 && (current || connectNow || !g_upFlag.load())) {
            // Đổi mật khẩu mạng ĐÃ LƯU mà sắp thử (mạng đang nối thì LUÔN thử, kể cả
            // connectNow = false): CHƯA ghi NVS. Mật khẩu mới chờ ở g_trial, g_nets
            // giữ mật khẩu cũ; loop() chỉ ghi NVS khi nối được, hỏng thì lùi về.
            if (++g_trialSeq == 0) g_trialSeq = 1;
            g_trial.seq = g_trialSeq;
            copySsid(g_trial.ssid, s);
            strlcpy(g_trial.pass, pass.c_str(), sizeof g_trial.pass);
            queueConnectLocked(s, /*force=*/true);
            trial = true;
        } else if (i < 0 && g_count >= WIFI_MAX_SAVED) {
            res = ADD_FULL;
        } else {
            // Mạng mới, hoặc đổi mật khẩu mạng không thử ngay: ghi NVS TRƯỚC bằng bản
            // chụp đã sửa; RAM chỉ đổi (và chỉ xếp lượt thử) khi ghi được.
            n = g_count;
            memcpy(g_nvsCopy, g_nets, n * sizeof(SavedNet));
            if (i < 0) {
                i = static_cast<int>(n++);
                memset(&g_nvsCopy[i], 0, sizeof(SavedNet));
                copySsid(g_nvsCopy[i].ssid, s);
                isNew = true;
            }
            strlcpy(g_nvsCopy[i].pass, pass.c_str(), sizeof g_nvsCopy[i].pass);
            start = connectNow || !g_upFlag.load();
            g_listDirty.store(false);   // bản chụp gồm mọi thay đổi tới giờ (ghi lỗi thì đặt lại)
        }
    }
    if (trial || res != ADD_OK) {
        if (g_nvsMtx) xSemaphoreGive(g_nvsMtx);
        if (!trial) return res;
        g_reqAny.store(1);
        Serial.printf("[WIFI] Doi mat khau mang \"%s\" -> thu ngay, chi luu NVS khi noi duoc\n", s);
        if (connecting) *connecting = true;
        return ADD_OK;
    }

    const bool ok    = writeCopyToNvs(n);
    size_t     total = 0;
    if (ok) {
        Lock l;
        int i = findSavedLocked(s);
        if (i < 0) {   // danh sách chỉ đổi khi giữ g_nvsMtx -> vẫn còn chỗ như lúc chụp
            i = static_cast<int>(g_count++);
            memset(&g_nets[i], 0, sizeof(SavedNet));
            copySsid(g_nets[i].ssid, s);
        }
        strlcpy(g_nets[i].pass, pass.c_str(), sizeof g_nets[i].pass);
        g_nets[i].last   = RES_NONE;   // mật khẩu mới -> quên kết quả "sai mật khẩu" cũ
        g_nets[i].lastAt = 0;
        // Mật khẩu vừa lưu thẳng là bản mới nhất -> bỏ mật khẩu chờ thử cũ của mạng này.
        if (g_trial.seq != 0 && strcmp(g_trial.ssid, s) == 0) discardTrialLocked();
        if (start) queueConnectLocked(s, /*force=*/true);
        total = g_count;
    }
    if (g_nvsMtx) xSemaphoreGive(g_nvsMtx);
    if (!ok) {
        Serial.printf("[WIFI] Khong luu duoc mang \"%s\" (loi ghi NVS) -> khong thay doi gi\n", s);
        return ADD_STORAGE;
    }
    if (start) g_reqAny.store(1);
    Serial.printf("[WIFI] %s mang \"%s\" (tong %u)%s\n", isNew ? "Da them" : "Da cap nhat mat khau",
                  s, static_cast<unsigned>(total), start ? " -> thu noi ngay" : "");
    if (connecting) *connecting = start;
    return ADD_OK;
}

RemoveResult remove(const String& ssid) {
    const char* s = ssid.c_str();
    if (g_nvsMtx) xSemaphoreTake(g_nvsMtx, portMAX_DELAY);   // như add(): danh sách đứng yên suốt hàm
    size_t n     = 0;
    bool   found = false;
    {
        Lock l;
        const int i = findSavedLocked(s);
        if (i >= 0) {
            // Ghi NVS TRƯỚC bằng bản chụp đã bỏ mạng này; RAM chỉ đổi khi ghi được.
            found = true;
            for (size_t k = 0; k < g_count; ++k)
                if (static_cast<int>(k) != i) g_nvsCopy[n++] = g_nets[k];
            g_listDirty.store(false);
        }
    }
    if (!found) {
        if (g_nvsMtx) xSemaphoreGive(g_nvsMtx);
        return REMOVE_NOT_FOUND;
    }
    const bool ok   = writeCopyToNvs(n);
    size_t     left = 0;
    if (ok) {
        Lock l;
        const int i = findSavedLocked(s);
        if (i >= 0) {
            for (size_t k = static_cast<size_t>(i); k + 1 < g_count; ++k) g_nets[k] = g_nets[k + 1];
            --g_count;
            memset(&g_nets[g_count], 0, sizeof(SavedNet));
        }
        if (strcmp(g_last, s) == 0) {
            g_last[0] = '\0';
            g_lastDirty.store(true);
        }
        if (g_reqConnect && strcmp(g_reqSsid, s) == 0) g_reqConnect = false;
        if (g_trial.seq != 0 && strcmp(g_trial.ssid, s) == 0) discardTrialLocked();
        g_reqRemoved = true;
        left = g_count;
    }
    if (g_nvsMtx) xSemaphoreGive(g_nvsMtx);
    if (!ok) {
        Serial.printf("[WIFI] Khong xoa duoc mang \"%s\" (loi ghi NVS) -> khong thay doi gi\n", s);
        return REMOVE_STORAGE;
    }
    g_reqAny.store(1);
    Serial.printf("[WIFI] Da xoa mang \"%s\" (con %u)\n", s, static_cast<unsigned>(left));
    return REMOVE_OK;
}

bool connectTo(const String& ssid) {
    {
        Lock l;
        if (findSavedLocked(ssid.c_str()) < 0) return false;
        queueConnectLocked(ssid.c_str(), /*force=*/false);
    }
    g_reqAny.store(1);
    return true;
}

void notePortalActivity() {
    const uint32_t t = millis();
    g_portalActAt.store(t ? t : 1);   // 0 = "chưa có"
}

void setPortal(bool on) {
    {
        Lock l;
        g_reqPortal = on ? 1 : 0;
    }
    g_reqAny.store(1);
}

String stateJson() {
    JsonDocument doc;
    JsonObject   root = doc.to<JsonObject>();
    {
        Lock l;
        const uint32_t now = millis();
        const bool     up  = g_pub.up;
        char buf[96];
        root["phase"] = phaseName(g_pub.phase);
        root["up"]    = up;
        safeText(buf, sizeof buf, up ? g_pub.ssid : "");
        root["ssid"]  = copied(buf);
        ipText(up ? g_pub.ip : 0, buf, sizeof buf);
        root["ip"]      = copied(buf);
        root["rssi"]    = up ? g_pub.rssi : 0;
        root["bars"]    = up ? bars(g_pub.rssi) : 0;
        root["channel"] = up ? g_pub.channel : 0;
        safeText(buf, sizeof buf, g_pub.trying);
        root["trying"]  = copied(buf);
        putAttemptLocked(root, now);
        root["portal"]       = g_pub.portal;
        root["portalReason"] = !g_pub.portal ? "" : (g_pub.reason == PR_MANUAL ? "manual" : "auto");
        root["ap"]           = g_pub.portal ? AP_SSID : "";
        ipText(g_pub.portal ? g_pub.apIp : 0, buf, sizeof buf);
        root["apIp"]      = copied(buf);
        root["apClients"] = g_pub.portal ? g_pub.apClients : 0;
        root["closesIn"]  = closesInLocked(now);
        root["saved"]     = static_cast<uint32_t>(g_count);
        root["max"]       = static_cast<uint32_t>(WIFI_MAX_SAVED);
        root["scanning"]  = g_pub.scanning || g_reqScan;
        root["hostname"]  = HOSTNAME;
        root["paused"]    = g_pub.paused;
    }
    root["loopMaxUs"] = g_loopMaxUs.load();
    String out;
    serializeJson(doc, out);
    return out;
}

/// HẠN CHẾ ĐÃ BIẾT: SSID không phải UTF-8 (router cũ dùng GBK/Latin-1) đi qua
/// safeText() nên byte lỗi thành '?'. Trang web gửi lại đúng tên đã đổi đó, nên
/// add() lưu một SSID không tồn tại (mọi lượt thử ra not_found), còn mạng đã lưu
/// có SSID như vậy (seed từ secrets.h) thì remove() trả 404. Muốn hỗ trợ cần gửi
/// kèm định danh thô (SSID dạng hex) cho các lệnh ghi — chưa làm.
String scanJson(bool fresh) {
    JsonDocument doc;
    JsonObject   root      = doc.to<JsonObject>();
    bool         requested = false;
    {
        Lock l;
        const uint32_t now   = millis();
        const uint32_t age   = g_scanHave ? now - g_scanAt : 0;
        const bool     busy  = g_pub.scanning || g_reqScan;
        const bool     stale = !g_scanHave || age > WIFI_SCAN_CACHE_MS || (fresh && age >= SCAN_FRESH_MIN_MS);
        if (stale && !busy) {          // xin loop() quét async, KHÔNG chờ ở đây
            g_reqScan = true;
            requested = true;
        }
        root["scanning"] = busy || requested;
        root["age"]      = g_scanHave ? static_cast<int32_t>(age / 1000) : -1;
        JsonArray nets   = root["nets"].to<JsonArray>();
        char buf[96];
        for (size_t i = 0; i < g_scanCount && i < SCAN_JSON_MAX; ++i) {
            const ScanNet& s = g_scan[i];
            JsonObject o = nets.add<JsonObject>();
            safeText(buf, sizeof buf, s.ssid);
            o["ssid"]  = copied(buf);
            o["rssi"]  = s.rssi;
            o["bars"]  = bars(s.rssi);
            o["enc"]   = s.enc;
            o["ch"]    = s.ch;
            o["saved"] = findSavedLocked(s.ssid) >= 0;
        }
    }
    if (requested) g_reqAny.store(1);
    String out;
    serializeJson(doc, out);
    return out;
}

String listJson() {
    JsonDocument doc;
    JsonArray    arr = doc.to<JsonArray>();
    {
        Lock l;
        const uint32_t now      = millis();
        const bool     cacheNew = g_scanHave && now - g_scanAt < SEEN_MAX_AGE_MS;
        char buf[96];
        for (size_t i = 0; i < g_count; ++i) {
            const SavedNet& n = g_nets[i];
            JsonObject o = arr.add<JsonObject>();
            safeText(buf, sizeof buf, n.ssid);
            o["ssid"] = copied(buf);
            const bool current = g_pub.up && strcmp(g_pub.ssid, n.ssid) == 0;
            o["current"] = current;
            o["open"]    = n.pass[0] == '\0';
            // Mạng đang nối thì hiển nhiên "thấy", lấy RSSI thật của kết nối.
            const ScanNet* s = cacheNew ? findScanLocked(n.ssid) : nullptr;
            const bool     seen = current || s != nullptr;
            const int      rssi = current ? g_pub.rssi : (s ? s->rssi : 0);
            o["seen"]    = seen;
            o["rssi"]    = seen ? rssi : 0;
            o["bars"]    = seen ? bars(rssi) : 0;
            o["last"]    = resultName(n.last);
            o["lastAgo"] = n.last == RES_NONE ? -1 : static_cast<int32_t>((now - n.lastAt) / 1000);
        }
    }
    String out;
    serializeJson(doc, out);
    return out;
}

void fillStatus(JsonObject o) {
    Lock l;
    const uint32_t now = millis();
    const bool     up  = g_pub.up;
    char buf[96];
    // --- Trường cũ (giữ nguyên ý nghĩa cho trang web/dashboard đời trước) ---
    o["up"] = up;
    if (up) { safeText(buf, sizeof buf, g_pub.ssid); o["ssid"] = copied(buf); }
    else    { o["ssid"] = "-"; }
    o["rssi"] = up ? g_pub.rssi : 0;
    if (up) { ipText(g_pub.ip, buf, sizeof buf); o["ip"] = copied(buf); }
    else    { o["ip"] = "-"; }
    o["saved"]  = static_cast<uint32_t>(g_count);
    o["portal"] = g_pub.portal;
    o["ap"]     = g_pub.portal ? AP_SSID : "";
    // --- Trường mới (hợp đồng API Wi-Fi v2) ---
    o["phase"] = phaseName(g_pub.phase);
    safeText(buf, sizeof buf, g_pub.trying);
    o["trying"]    = copied(buf);
    o["bars"]      = up ? bars(g_pub.rssi) : 0;
    o["channel"]   = up ? g_pub.channel : 0;
    ipText(g_pub.portal ? g_pub.apIp : 0, buf, sizeof buf);
    o["apIp"]      = copied(buf);
    o["apClients"] = g_pub.portal ? g_pub.apClients : 0;
    putAttemptLocked(o, now);
}

bool portalActive() {
    return g_portalFlag.load();
}

const char* apSsid() {
    return g_portalFlag.load() ? AP_SSID : "";
}

IPAddress apIp() {
    return IPAddress(g_apIpRaw.load());
}

String currentSsid() {
    Lock l;
    return g_pub.up ? String(g_pub.ssid) : String();
}

}  // namespace WifiMgr
