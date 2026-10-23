#include "notifier.h"
#include "config.h"
#include "secrets.h"
#include "event_log.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <deque>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// secrets.h tạo từ bản mẫu CŨ (trước khi có Zalo Bot) không có hai dòng này ->
// coi như tắt Zalo, vẫn build được mà không phải sửa secrets.h.
#ifndef ZALO_BOT_TOKEN
#define ZALO_BOT_TOKEN ""
#endif
#ifndef ZALO_CHAT_ID
#define ZALO_CHAT_ID ""
#endif

// ===========================================================================
//  GỬI CẢNH BÁO QUA NHIỀU KÊNH (Telegram + Zalo Bot + Email Resend)
// ===========================================================================
//
//  Mỗi tin cảnh báo được gửi SONG SONG qua tất cả các kênh đang bật. Mỗi tin
//  giữ một "mặt nạ" (bitmask) cho biết kênh nào CÒN phải gửi. Khi một kênh gửi
//  xong thì tắt bit của nó đi; chỉ khi mọi kênh đã xong (hoặc không được bật)
//  thì tin mới bị lấy khỏi hàng đợi. Nhờ vậy nếu Telegram gửi được mà email
//  tạm lỗi thì lần thử lại CHỈ gửi email, không gửi trùng Telegram.
//
//  Hàng đợi được ghi xuống LittleFS sau mỗi thay đổi nên mất điện giữa chừng
//  thì bật lại tin vẫn còn và gửi tiếp.
//
//  NHIỀU NGƯỜI NHẬN TELEGRAM: TELEGRAM_CHAT_ID có thể là danh sách chat id cách
//  nhau dấu phẩy, ví dụ "111111111,222222222". Mỗi người nhận một tin riêng. Tin
//  giữ thêm mặt nạ tgLeft cho biết người nào CÒN chưa nhận, nên lần thử lại chỉ
//  gửi cho người đó, không gửi trùng cho người đã nhận. ZALO_CHAT_ID y hệt, mặt
//  nạ là zlLeft.
//
//  ZALO BOT (bot.zapps.me) là nền tảng bot CHÍNH THỨC của Zalo, tạo từ tài khoản
//  Zalo cá nhân, API gần giống Telegram: POST https://bot-api.zaloplatforms.com/
//  bot<TOKEN>/<method>. Khác Telegram ở chỗ: chat id là chuỗi (không phải số),
//  không nhận HTML (gửi văn thuần), tối đa 2000 ký tự, và getUpdates mỗi lần
//  trả MỘT tin, không có offset. Chat hai chiều Zalo chạy trong task riêng
//  (zaloTask) bằng long polling, không chen vào hàng đợi cảnh báo.
//
//  LỖI VĨNH VIỄN (sai chat id, người nhận chưa bấm Start hoặc đã chặn bot, sai
//  token, Resend từ chối địa chỉ nhận...) thì bỏ ngay người / kênh đó cho tin
//  này, không thử lại 8 lần: tin lỗi nằm đầu hàng đợi sẽ chặn các cảnh báo phía
//  sau tới khoảng 2 phút.
// ===========================================================================

namespace Notifier {

namespace {

// --- Mặt nạ kênh ---
constexpr uint8_t CH_TELEGRAM = 1 << 0;
constexpr uint8_t CH_EMAIL    = 1 << 1;
constexpr uint8_t CH_ZALO     = 1 << 2;

// Qua so lan thu nay thi bo tin de mot kenh hong vinh vien khong chan ca hang doi.
constexpr uint8_t MAX_TRIES_PER_ITEM = 8;

// --- Người nhận Telegram, tách từ TELEGRAM_CHAT_ID (xem đầu file) ---
constexpr uint8_t MAX_TG_CHATS = 8;   ///< vừa một byte mặt nạ Item::tgLeft
String  g_tgChats[MAX_TG_CHATS];
uint8_t g_tgCount  = 0;
bool    g_tgParsed = false;

// --- Zalo Bot ---
constexpr const char* ZALO_API_BASE = "https://bot-api.zaloplatforms.com/bot";
constexpr uint8_t  MAX_ZL_CHATS        = 8;      ///< vừa một byte mặt nạ Item::zlLeft
/// Zalo giới hạn 2000 ký tự (đơn vị UTF-16). Tiếng Việt tốn 1–3 byte UTF-8 mỗi
/// ký tự, nên cắt theo byte ở mức này là luôn nằm dưới giới hạn đó.
constexpr size_t   ZALO_TEXT_MAX_BYTES = 1800;
/// Tin người nhà gửi đã chờ quá lâu (thiết bị mất mạng / vừa bật lại) thì bỏ qua
/// thay vì trả lời dồn dập một loạt tin cũ.
constexpr int64_t  ZALO_STALE_S        = 10 * 60;
String  g_zlChats[MAX_ZL_CHATS];
uint8_t g_zlCount  = 0;
bool    g_zlParsed = false;

/// Kết quả một lần gửi tới một người / một kênh.
enum class SendResult : uint8_t {
    Ok,       ///< đã gửi
    Retry,    ///< lỗi tạm (mất mạng, máy chủ bận, gửi nhanh quá) -> thử lại sau
    GiveUp    ///< lỗi vĩnh viễn -> bỏ người / kênh này cho tin này
};

struct Item {
    time_t  ts       = 0;
    String  text;              ///< nội dung (định dạng HTML, dùng chung mọi kênh)
    uint8_t pending  = 0;      ///< các kênh CÒN phải gửi (mặt nạ CH_*)
    uint8_t tgLeft   = 0;      ///< người nhận Telegram CÒN phải gửi (bit i = g_tgChats[i])
    uint8_t zlLeft   = 0;      ///< người nhận Zalo CÒN phải gửi (bit i = g_zlChats[i])
    uint8_t tries    = 0;      ///< so lan da thu gui item nay (chong ket hang doi)
    bool    delivered = false; ///< đã tới được ít nhất một người / một kênh
};

std::deque<Item>  g_queue;
SemaphoreHandle_t g_mutex = nullptr;
TaskHandle_t      g_task  = nullptr;
uint32_t          g_sent  = 0;     ///< số tin đã gửi xong TẤT CẢ kênh
uint32_t          g_lastOk = 0;
char              g_lastResult[96] = "chua gui lan nao";

// --- Chat hai chiều với người nhà ---
ReplyBuilder g_replyBuilder = nullptr;   ///< hàm dựng câu trả lời (do main.cpp cấp)
int64_t      g_updateOffset = 0;         ///< update_id tiếp theo cần lấy (Telegram)
bool         g_primed       = false;     ///< đã bỏ qua backlog tin cũ sau khi khởi động chưa
uint32_t     g_nextPoll     = 0;         ///< millis() lần hỏi tin mới kế tiếp

// --- Quyền đọc tin Telegram mà dashboard "thuê" (xem notifier.h) ---
// Task web ghi, task notifier/loop đọc (có thể ở hai core khác nhau) nên mọi
// lần đọc-ghi cặp biến này đều nằm trong spinlock, tránh đọc nửa cũ nửa mới.
portMUX_TYPE      g_leaseMux   = portMUX_INITIALIZER_UNLOCKED;
volatile bool     g_leaseOn    = false;  ///< dashboard đang giữ quyền đọc tin
volatile uint32_t g_leaseUntil = 0;      ///< millis() lúc hết hạn thuê
bool              g_afterLease = false;  ///< vừa lấy lại quyền -> bỏ tin quá cũ (chỉ task notifier dùng)

// --- Quyền đọc tin Zalo (cùng spinlock g_leaseMux) ---
volatile bool     g_zlLeaseOn    = false;
volatile uint32_t g_zlLeaseUntil = 0;
/// Task Zalo đang trong một lượt hỏi/trả lời tin. Khi cờ này bật, ESP32 vẫn báo
/// "device" dù dashboard đã xin quyền: lượt hỏi dở có thể nhận tin và Zalo không
/// trả lại tin đó cho ai khác nữa.
volatile bool     g_zlInFlight   = false;
TaskHandle_t      g_zlTask       = nullptr;
char              g_zlPollResult[64] = "chua hoi lan nao";

/// Người lạ đã được báo mã chat lúc nào (chỉ task Zalo dùng), để không trả lời
/// quá 1 lần / 10 phút cho cùng một người.
struct RefusedChat { String chat; uint32_t at = 0; };
RefusedChat g_zlRefused[4];

struct Lock {
    Lock()  { if (g_mutex) xSemaphoreTake(g_mutex, portMAX_DELAY); }
    ~Lock() { if (g_mutex) xSemaphoreGive(g_mutex); }
};

/// Tách chuỗi "id1,id2,..." thành danh sách người nhận (bỏ khoảng trắng, mục
/// rỗng, mục trùng), tối đa `maxCount` người.
void parseChatList(const char* list, String* out, uint8_t& count, uint8_t maxCount) {
    const String all = list;
    int start = 0;
    while (start <= (int)all.length() && count < maxCount) {
        int comma = all.indexOf(',', start);
        if (comma < 0) comma = all.length();
        String id = all.substring(start, comma);
        id.trim();
        bool dup = false;
        for (uint8_t i = 0; i < count; ++i) if (out[i] == id) dup = true;
        if (id.length() >= 3 && !dup) out[count++] = id;
        start = comma + 1;
    }
}

/// Tách TELEGRAM_CHAT_ID thành danh sách người nhận. Chạy một lần; begin() gọi
/// đầu tiên, trước khi có task nào đọc.
void parseTelegramChats() {
    if (g_tgParsed) return;
    g_tgParsed = true;
    parseChatList(TELEGRAM_CHAT_ID, g_tgChats, g_tgCount, MAX_TG_CHATS);
}

/// Tách ZALO_CHAT_ID (chat id Zalo là chuỗi chữ số hex, ví dụ 3becaa50ae12474c1e03).
void parseZaloChats() {
    if (g_zlParsed) return;
    g_zlParsed = true;
    parseChatList(ZALO_CHAT_ID, g_zlChats, g_zlCount, MAX_ZL_CHATS);
}

/// Mặt nạ "mọi người nhận Telegram": bit i ứng với g_tgChats[i].
uint8_t allTelegramChats() {
    parseTelegramChats();
    return g_tgCount >= 8 ? 0xFF : (uint8_t)((1u << g_tgCount) - 1u);
}

/// Chat này có trong TELEGRAM_CHAT_ID không (chat hai chiều chỉ trả lời các chat này).
bool isFamilyChat(const String& chatId) {
    parseTelegramChats();
    for (uint8_t i = 0; i < g_tgCount; ++i) if (g_tgChats[i] == chatId) return true;
    return false;
}

/// Người nhận Telegram cho một tin mới gửi qua các kênh `channels` (send/sendOne
/// nằm ngoài namespace ẩn danh nên không gọi thẳng CH_TELEGRAM ở đó được: tên này
/// trùng với hằng công khai trong notifier.h).
uint8_t telegramTargets(uint8_t channels) {
    return (channels & CH_TELEGRAM) ? allTelegramChats() : 0;
}

/// Mặt nạ "mọi người nhận Zalo": bit i ứng với g_zlChats[i].
uint8_t allZaloChats() {
    parseZaloChats();
    return g_zlCount >= 8 ? 0xFF : (uint8_t)((1u << g_zlCount) - 1u);
}

/// Chat Zalo này có trong ZALO_CHAT_ID không.
bool isZaloFamilyChat(const String& chatId) {
    parseZaloChats();
    for (uint8_t i = 0; i < g_zlCount; ++i) if (g_zlChats[i] == chatId) return true;
    return false;
}

/// Người nhận Zalo cho một tin mới gửi qua các kênh `channels`.
uint8_t zaloTargets(uint8_t channels) {
    return (channels & CH_ZALO) ? allZaloChats() : 0;
}

// --- Kênh nào đang được bật (đọc từ secrets.h) ---
bool telegramConfigured() {
    parseTelegramChats();
    return strlen(TELEGRAM_BOT_TOKEN) >= 20 && g_tgCount > 0;
}
bool emailConfigured() {
    return strlen(RESEND_API_KEY) >= 10 && strlen(EMAIL_TO) >= 5;
}
/// Đã khai token Zalo Bot (dạng "<số>:<chuỗi bí mật>").
bool zaloTokenSet() {
    return strlen(ZALO_BOT_TOKEN) >= 20;
}
/// Gửi cảnh báo qua Zalo được không: cần token + ít nhất một người nhận.
bool zaloConfigured() {
    parseZaloChats();
    return zaloTokenSet() && g_zlCount > 0;
}

/// Chat hai chiều có chạy không (bật chu kỳ hỏi tin + đã cấu hình Telegram).
bool pollingEnabled() {
    return TELEGRAM_POLL_MS > 0 && telegramConfigured();
}

/// Chat hai chiều Zalo: chỉ cần token, chưa có người nhận cũng chạy, để người
/// nhà nhắn cho bot là được báo lại mã chat của mình (bước lấy ZALO_CHAT_ID).
bool zaloPollingEnabled() {
    return ZALO_POLL_TIMEOUT_S > 0 && zaloTokenSet();
}

/// Dashboard còn giữ quyền đọc tin Zalo không. PHẢI gọi trong g_leaseMux.
bool zaloLeaseActiveLocked() {
    if (g_zlLeaseOn && (int32_t)(g_zlLeaseUntil - millis()) <= 0) g_zlLeaseOn = false;
    return g_zlLeaseOn;
}

/// Dashboard còn giữ quyền đọc tin không. So sánh kiểu int32 để qua mốc tràn
/// millis() (49,7 ngày) vẫn đúng; hết hạn thì xóa luôn cờ, vì nếu cứ giữ cờ thì
/// sau 24,8 ngày phép so sánh đó đổi dấu và quyền đã hết từ lâu lại "sống lại".
bool leaseActive() {
    const uint32_t now = millis();
    portENTER_CRITICAL(&g_leaseMux);
    if (g_leaseOn && (int32_t)(g_leaseUntil - now) <= 0) g_leaseOn = false;
    const bool on = g_leaseOn;
    portEXIT_CRITICAL(&g_leaseMux);
    return on;
}

/// Mặt nạ tất cả các kênh đang bật tại thời điểm xếp tin vào hàng đợi.
uint8_t enabledChannels() {
    uint8_t m = 0;
    if (telegramConfigured()) m |= CH_TELEGRAM;
    if (emailConfigured())    m |= CH_EMAIL;
    if (zaloConfigured())     m |= CH_ZALO;
    return m;
}

/// Bỏ thẻ HTML đơn giản để lấy bản văn thuần (dùng cho Zalo và tiêu đề email).
/// Chỉ cần đủ dùng cho các thẻ mà firmware tự sinh: <b> </b> <i> </i> <br>.
String stripHtml(const String& html) {
    String out;
    out.reserve(html.length());
    bool inTag = false;
    for (size_t i = 0; i < html.length(); ++i) {
        const char c = html[i];
        if (c == '<')      { inTag = true;  continue; }
        if (c == '>')      { inTag = false; continue; }
        if (!inTag)        out += c;
    }
    // Khôi phục vài entity hay dùng; "&amp;" để CUỐI để "&amp;lt;" ra đúng "&lt;"
    out.replace("&lt;", "<");
    out.replace("&gt;", ">");
    out.replace("&quot;", "\"");
    out.replace("&#39;", "'");
    out.replace("&amp;", "&");
    return out;
}

/// Bản văn thuần để gửi Zalo: bỏ thẻ HTML, cắt cho vừa giới hạn độ dài của Zalo
/// (cắt ở ranh giới ký tự UTF-8 để không làm vỡ chữ có dấu).
String zaloText(const String& html) {
    String t = stripHtml(html);
    if (t.length() > ZALO_TEXT_MAX_BYTES) {
        size_t cut = ZALO_TEXT_MAX_BYTES;
        while (cut > 0 && (((uint8_t)t[cut]) & 0xC0) == 0x80) --cut;
        t = t.substring(0, cut);
        t += "\xE2\x80\xA6";   // …
    }
    return t;
}

/// Thoat ky tu dac biet de nhet chuoi vao HTML an toan (dung cho template email).
String escHtml(const String& s) {
    String o;
    o.reserve(s.length() + 8);
    for (size_t i = 0; i < s.length(); ++i) {
        const char c = s[i];
        if      (c == '&') o += "&amp;";
        else if (c == '<') o += "&lt;";
        else if (c == '>') o += "&gt;";
        else if (c == '"') o += "&quot;";
        else               o += c;
    }
    return o;
}

// ---------------------------------------------------------------------------
//  Ghi / đọc hàng đợi xuống flash (giữ cả mặt nạ kênh)
// ---------------------------------------------------------------------------

/// Phải được gọi khi ĐANG giữ mutex.
void persistLocked() {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (const auto& it : g_queue) {
        JsonObject o = arr.add<JsonObject>();
        o["ts"]      = (uint32_t)it.ts;
        o["text"]    = it.text;
        o["pending"] = it.pending;
        o["tg"]      = it.tgLeft;
        o["zl"]      = it.zlLeft;
        o["ok"]      = it.delivered;
    }
    File f = LittleFS.open(QUEUE_FILE, "w");
    if (!f) return;
    serializeJson(doc, f);
    f.close();
}

void loadQueue() {
    if (!LittleFS.exists(QUEUE_FILE)) return;
    File f = LittleFS.open(QUEUE_FILE, "r");
    if (!f) return;
    JsonDocument doc;
    const auto err = deserializeJson(doc, f);
    f.close();
    if (err) return;
    for (JsonObject o : doc.as<JsonArray>()) {
        Item it;
        it.ts      = (time_t)(o["ts"] | 0);
        it.text    = (const char*)(o["text"] | "");
        // Tin cũ (trước khi có đa kênh) không có "pending" -> coi như cần gửi
        // lại qua mọi kênh đang bật.
        it.pending = (uint8_t)(o["pending"] | enabledChannels());
        it.pending &= enabledChannels();   // bỏ bit của kênh giờ đã tắt (tránh kẹt)
        // Tin cũ (trước khi có nhiều người nhận) không có "tg" -> gửi cho mọi người.
        // Danh sách người nhận có thể đã đổi sau khi nạp lại firmware -> cắt cho vừa.
        it.tgLeft  = (uint8_t)(o["tg"] | allTelegramChats());
        it.tgLeft &= allTelegramChats();
        if (!(it.pending & CH_TELEGRAM)) it.tgLeft = 0;
        else if (it.tgLeft == 0)         it.pending &= (uint8_t)~CH_TELEGRAM;
        // Zalo y hệt (tin cũ từ thời Zalo OA không có "zl" -> gửi cho mọi người nhận).
        it.zlLeft  = (uint8_t)(o["zl"] | allZaloChats());
        it.zlLeft &= allZaloChats();
        if (!(it.pending & CH_ZALO)) it.zlLeft = 0;
        else if (it.zlLeft == 0)     it.pending &= (uint8_t)~CH_ZALO;
        it.delivered = o["ok"] | false;
        it.tries   = (uint8_t)(o["tries"] | 0);
        // Chỉ nạp lại tin còn kênh để gửi; tin không còn kênh nào thì bỏ.
        if (it.text.length() && it.pending != 0) g_queue.push_back(it);
        if (g_queue.size() >= QUEUE_MAX_ITEMS) break;
    }
    if (!g_queue.empty())
        Serial.printf("[TB] Con %u tin ton tu lan chay truoc\n", (unsigned)g_queue.size());
}

// ---------------------------------------------------------------------------
//  Gửi thật theo từng kênh. Mỗi hàm CHẶN 1–3 giây nên chỉ gọi trong task.
//  Mọi kênh trả SendResult (gửi được / thử lại sau / bỏ hẳn).
// ---------------------------------------------------------------------------

/// Kênh 1: Telegram Bot API, gửi tới MỘT người nhận (chatId).
SendResult postToTelegram(const Item& item, const String& chatId) {
    WiFiClientSecure client;
    client.setInsecure();          // đủ dùng cho đồ án (xem chú thích bên dưới)
    client.setTimeout(10);

    const String url = String("https://api.telegram.org/bot") + TELEGRAM_BOT_TOKEN + "/sendMessage";

    JsonDocument body;
    body["chat_id"]    = chatId;
    body["text"]       = item.text;
    body["parse_mode"] = "HTML";
    String payload;
    serializeJson(body, payload);

    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(client, url)) {
        strlcpy(g_lastResult, "Telegram: khong mo duoc HTTPS", sizeof(g_lastResult));
        return SendResult::Retry;
    }
    http.addHeader("Content-Type", "application/json");
    const int code = http.POST(payload);
    const String resp = (code > 0) ? http.getString() : String();
    http.end();

    if (code == 200) {
        strlcpy(g_lastResult, "Telegram: OK", sizeof(g_lastResult));
        return SendResult::Ok;
    }
    // 400 = chat id sai / tin hỏng, 403 = người nhận chưa bấm Start hoặc đã chặn
    // bot, 401/404 = token sai: thử lại cũng vô ích -> bỏ người nhận này cho tin
    // này. Còn lại (mất mạng, 429 gửi nhanh quá, lỗi 5xx) thì thử lại sau.
    const bool permanent = (code == 400 || code == 401 || code == 403 || code == 404);
    snprintf(g_lastResult, sizeof(g_lastResult), "Telegram %s HTTP %d %.40s",
             chatId.c_str(), code, resp.c_str());
    Serial.printf("[TG] Gui that bai%s: %s\n", permanent ? " (bo, khong thu lai)" : "", g_lastResult);
    return permanent ? SendResult::GiveUp : SendResult::Retry;
}

/// Dựng email HTML đầy đủ (có khung, màu theo mức độ) từ nội dung tin.
///
/// Nội dung tin (item.text) vốn ở định dạng Telegram: dòng đầu là tiêu đề có
/// emoji, các dòng sau là chi tiết, dùng thẻ <b>/<i> và xuống dòng \n. Ta suy
/// ra MỨC ĐỘ từ emoji đầu để chọn màu, rồi bọc vào một mẫu email dùng CSS nội
/// tuyến + bố cục bảng (cách duy nhất chạy ổn trên mọi ứng dụng email, vì
/// Gmail/Outlook bỏ thẻ <style> và nhiều CSS hiện đại).
String buildEmailHtml(const String& content, String& subjectOut) {
    // --- Chọn chủ đề màu theo emoji mở đầu ---
    String accent = "#2563eb";   // xanh dương (thông tin)
    String badge  = "Thông báo";
    String emoji  = "\xE2\x84\xB9\xEF\xB8\x8F";   // ℹ️
    if (content.indexOf("\xF0\x9F\x9A\xA8") >= 0) {         // 🚨 khẩn cấp
        accent = "#e23d4b"; badge = "CẢNH BÁO KHẨN CẤP"; emoji = "\xF0\x9F\x9A\xA8";
    } else if (content.indexOf("\xE2\x9A\xA0") >= 0) {      // ⚠️ cảnh báo
        accent = "#e8930c"; badge = "Cảnh báo"; emoji = "\xE2\x9A\xA0\xEF\xB8\x8F";
    } else if (content.indexOf("\xE2\x9C\x85") >= 0) {      // ✅ an toàn
        accent = "#17a673"; badge = "Đã an toàn"; emoji = "\xE2\x9C\x85";
    }

    // --- Tách dòng đầu làm tiêu đề, phần còn lại làm nội dung ---
    String title = content;
    String rest;
    const int nl = content.indexOf('\n');
    if (nl >= 0) { title = content.substring(0, nl); rest = content.substring(nl + 1); }
    title = stripHtml(title); title.trim();
    if (title.length() == 0) title = "Thông báo từ hệ thống giám sát";

    subjectOut = title;
    if (subjectOut.length() > 90) subjectOut = subjectOut.substring(0, 90);

    // Chuyển phần nội dung còn lại: \n -> <br>, giữ <b>/<i> của Telegram.
    String bodyHtml = rest;
    bodyHtml.replace("\n", "<br>");

    // --- Dựng email (CSS nội tuyến, bố cục bảng) ---
    String h;
    h.reserve(2200);
    h += "<!DOCTYPE html><html lang=\"vi\"><head><meta charset=\"utf-8\">";
    h += "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>";
    h += "<body style=\"margin:0;padding:0;background:#f4f6fb;\">";
    h += "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" "
         "style=\"background:#f4f6fb;padding:24px 12px;\"><tr><td align=\"center\">";
    // Khung thẻ chính
    h += "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" "
         "style=\"max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;"
         "box-shadow:0 6px 24px rgba(22,34,64,.08);font-family:'Segoe UI',Arial,sans-serif;\">";
    // Thanh tiêu đề màu theo mức độ
    h += "<tr><td style=\"background:"; h += accent;
    h += ";padding:18px 24px;\">";
    h += "<div style=\"font-size:13px;letter-spacing:.08em;text-transform:uppercase;"
         "color:#ffffff;opacity:.9;font-weight:700;\">"; h += emoji; h += " "; h += badge; h += "</div>";
    h += "<div style=\"font-size:20px;color:#ffffff;font-weight:800;margin-top:4px;\">";
    h += escHtml(title); h += "</div></td></tr>";
    // Dòng người được giám sát + vị trí
    h += "<tr><td style=\"padding:20px 24px 4px;\">";
    h += "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">";
    h += "<tr><td style=\"font-size:13px;color:#6b7688;padding:4px 0;\">Người được giám sát</td>"
         "<td align=\"right\" style=\"font-size:14px;color:#1f2733;font-weight:700;padding:4px 0;\">";
    h += escHtml(PATIENT_NAME); h += "</td></tr>";
    h += "<tr><td style=\"font-size:13px;color:#6b7688;padding:4px 0;\">Vị trí</td>"
         "<td align=\"right\" style=\"font-size:14px;color:#1f2733;font-weight:600;padding:4px 0;\">";
    h += escHtml(DEVICE_PLACE); h += "</td></tr></table></td></tr>";
    // Nội dung chi tiết
    h += "<tr><td style=\"padding:8px 24px 20px;\">";
    h += "<div style=\"height:1px;background:#eef1f8;margin:4px 0 16px;\"></div>";
    h += "<div style=\"font-size:15px;line-height:1.6;color:#1f2733;\">"; h += bodyHtml; h += "</div>";
    h += "</td></tr>";
    // Chân trang
    h += "<tr><td style=\"background:#f8fafc;padding:14px 24px;border-top:1px solid #eef1f8;\">";
    h += "<div style=\"font-size:12px;color:#9aa4b6;line-height:1.5;\">"
         "Hệ thống giám sát &amp; cảnh báo té ngã · Radar 60 GHz + ESP32-S3<br>"
         "Email tự động, vui lòng không trả lời thư này.</div>";
    h += "</td></tr></table></td></tr></table></body></html>";
    return h;
}

/// Kênh 2: Email qua Resend (POST https://api.resend.com/emails).
SendResult postToEmail(const Item& item) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(10);

    // Tiêu đề lấy dòng đầu của nội dung (bỏ thẻ HTML), gọn và rõ trong hộp thư.
    String subject = stripHtml(item.text);
    const int nl = subject.indexOf('\n');
    if (nl > 0) subject = subject.substring(0, nl);
    subject.trim();
    if (subject.length() == 0) subject = "Canh bao he thong giam sat te nga";
    if (subject.length() > 90) subject = subject.substring(0, 90);

    // Resend nhận HTML trực tiếp. Chuyển xuống dòng \n thành <br> để email dễ đọc.
    String html = item.text;
    html.replace("\n", "<br>");

    JsonDocument body;
    body["from"]    = EMAIL_FROM;
    body["to"]      = EMAIL_TO;
    body["subject"] = subject;
    body["html"]    = html;
    String payload;
    serializeJson(body, payload);

    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(client, "https://api.resend.com/emails")) {
        strlcpy(g_lastResult, "Email: khong mo duoc HTTPS", sizeof(g_lastResult));
        return SendResult::Retry;
    }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + RESEND_API_KEY);
    const int code = http.POST(payload);
    const String resp = (code > 0) ? http.getString() : String();
    http.end();

    // Resend trả 200 hoặc 201 kèm id của email khi thành công.
    if (code == 200 || code == 201) {
        strlcpy(g_lastResult, "Email: OK", sizeof(g_lastResult));
        return SendResult::Ok;
    }
    // 403 = chưa xác minh tên miền / gửi tới địa chỉ lạ (Resend chỉ cho gửi tới email
    // chủ tài khoản), 401 = API key sai, 400/422 = dữ liệu sai: thử lại cũng vô ích
    // -> bỏ email cho tin này. Còn lại (mất mạng, 429, lỗi 5xx) thì thử lại sau.
    const bool permanent = (code == 400 || code == 401 || code == 403 || code == 404 || code == 422);
    snprintf(g_lastResult, sizeof(g_lastResult), "Email HTTP %d %.40s", code, resp.c_str());
    Serial.printf("[MAIL] Gui that bai%s: %s\n", permanent ? " (bo, khong thu lai)" : "", g_lastResult);
    return permanent ? SendResult::GiveUp : SendResult::Retry;
}

/// Gọi một phương thức Zalo Bot API (POST JSON). An toàn khi hai task gọi cùng
/// lúc (mỗi task dùng client riêng). Trả về "mã hiệu dụng":
///   200      thành công ({"ok":true,...})
///   > 0      HTTP status nếu khác 200, hoặc "error_code" trong thân JSON khi
///            ok=false (Zalo hay trả HTTP 200 kèm {"ok":false,"error_code":408}
///            nghĩa là hết lượt chờ mà không có tin mới)
///   <= 0     lỗi kết nối (mã lỗi âm của HTTPClient)
/// `client` có thể đang giữ kết nối từ lần gọi trước (keep-alive): nếu kết nối
/// cũ đã bị máy chủ đóng thì tự mở kết nối mới và thử lại đúng một lần.
int zaloCall(WiFiClientSecure& client, const char* method, const String& payload,
             uint32_t timeoutMs, String* respOut) {
    const String url = String(ZALO_API_BASE) + ZALO_BOT_TOKEN + "/" + method;
    int    code = 0;
    String resp;
    for (int attempt = 0; attempt < 2; ++attempt) {
        const bool reused = client.connected();
        HTTPClient http;
        http.setReuse(true);
        http.setTimeout((uint16_t)(timeoutMs > 60000 ? 60000 : timeoutMs));
        if (!http.begin(client, url)) { client.stop(); return -1; }
        http.addHeader("Content-Type", "application/json");
        code = http.POST(payload);
        resp = (code > 0) ? http.getString() : String();
        http.end();
        if (code > 0) break;
        client.stop();              // kết nối hỏng: lần sau mở mới
        if (!reused) break;         // không phải do kết nối cũ -> khỏi thử lại
    }
    if (respOut) *respOut = resp;
    if (code <= 0) return code;

    JsonDocument filter;
    filter["ok"]         = true;
    filter["error_code"] = true;
    JsonDocument doc;
    if (deserializeJson(doc, resp, DeserializationOption::Filter(filter))) {
        return code == 200 ? 502 : code;   // thân không phải JSON: coi như máy chủ trục trặc
    }
    if (code == 200 && (doc["ok"] | false)) return 200;
    if (code != 200) return code;
    const int ec = doc["error_code"] | 0;
    return ec > 0 ? ec : 400;              // ok=false mà không ghi mã -> coi như bị từ chối
}

/// Lỗi gửi Zalo nào là VĨNH VIỄN (thử lại vô ích): máy chủ đã trả lời và từ chối
/// (sai token, sai chat id, người nhận chưa nhắn cho bot / đã chặn bot...). Còn
/// mất mạng, 408, 429 gửi nhanh quá, lỗi 5xx thì thử lại sau.
bool zaloPermanent(int code) {
    return code > 0 && code != 408 && code != 429 && code < 500;
}

/// Kênh Zalo Bot: gửi tới MỘT người nhận (chatId). Zalo không nhận HTML nên gửi
/// bản văn thuần.
SendResult postToZalo(const Item& item, const String& chatId) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(10);

    JsonDocument body;
    body["chat_id"] = chatId;
    body["text"]    = zaloText(item.text);
    String payload;
    serializeJson(body, payload);

    String resp;
    const int code = zaloCall(client, "sendMessage", payload, 12000, &resp);
    client.stop();
    if (code == 200) {
        strlcpy(g_lastResult, "Zalo: OK", sizeof(g_lastResult));
        return SendResult::Ok;
    }
    const bool permanent = zaloPermanent(code);
    snprintf(g_lastResult, sizeof(g_lastResult), "Zalo %.24s loi %d %.36s",
             chatId.c_str(), code, resp.c_str());
    Serial.printf("[ZL] Gui that bai%s: %s\n", permanent ? " (bo, khong thu lai)" : "", g_lastResult);
    return permanent ? SendResult::GiveUp : SendResult::Retry;
}

// ---------------------------------------------------------------------------
//  Chat hai chiều: đọc tin người nhà gửi rồi trả lời
// ---------------------------------------------------------------------------

/// Gửi một tin HTML tới đúng chat_id (dùng để trả lời người nhà, không qua hàng đợi).
void replyToChat(const String& chatId, const String& html) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(10);
    const String url = String("https://api.telegram.org/bot") + TELEGRAM_BOT_TOKEN + "/sendMessage";

    JsonDocument body;
    body["chat_id"]    = chatId;
    body["text"]       = html;
    body["parse_mode"] = "HTML";
    String payload;
    serializeJson(body, payload);

    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(client, url)) return;
    http.addHeader("Content-Type", "application/json");
    http.POST(payload);
    http.end();
}

/// Hỏi Telegram một lượt xem có tin mới từ người nhà không. Mỗi tin hợp lệ (đúng
/// chat id) được chuyển cho g_replyBuilder để dựng câu trả lời rồi gửi lại.
void pollUpdatesOnce() {
    if (!g_replyBuilder) return;                 // main.cpp chưa đăng ký -> bỏ
    if (!telegramConfigured()) return;
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(10);

    // offset = update_id + 1 để Telegram chỉ trả tin CHƯA xử lý. timeout=0 (hỏi
    // nhanh rồi về, không giữ kết nối lâu làm nghẽn việc gửi cảnh báo).
    String url = String("https://api.telegram.org/bot") + TELEGRAM_BOT_TOKEN +
                 "/getUpdates?timeout=0&limit=5&allowed_updates=[\"message\"]";
    if (g_updateOffset > 0) { url += "&offset="; url += String((long long)g_updateOffset); }

    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(client, url)) return;
    const int code = http.GET();
    if (code != 200) { http.end(); return; }
    const String resp = http.getString();
    http.end();

    // Trong 1–3 giây chờ Telegram trả lời, dashboard có thể vừa nhận quyền đọc
    // tin. Khi đó bỏ cả lô này: ESP32 chưa xác nhận offset nên Telegram vẫn giao
    // đúng các tin đó cho dashboard -> mỗi tin chỉ được trả lời một lần.
    if (leaseActive()) return;

    // Giải mã. Dùng filter để chỉ giữ các trường cần, tiết kiệm RAM.
    JsonDocument filter;
    filter["result"][0]["update_id"]           = true;
    filter["result"][0]["message"]["text"]     = true;
    filter["result"][0]["message"]["date"]     = true;
    filter["result"][0]["message"]["chat"]["id"] = true;
    filter["result"][0]["message"]["from"]["first_name"] = true;
    JsonDocument doc;
    if (deserializeJson(doc, resp, DeserializationOption::Filter(filter))) return;

    // Vừa lấy lại quyền đọc tin từ dashboard: tin nằm chờ quá lâu thì dashboard
    // có thể đã trả lời rồi, hoặc người nhà không còn chờ nữa -> không trả lời.
    // Chỉ xét được khi đồng hồ đã đồng bộ NTP.
    const time_t nowEpoch = time(nullptr);
    const bool   dropOld  = g_afterLease && nowEpoch > 1600000000;
    size_t       count    = 0;

    for (JsonObject upd : doc["result"].as<JsonArray>()) {
        ++count;
        // Ép kiểu 64-bit: "| 0" (kiểu int) trả về 0 khi số vượt 2^31, mà id của
        // tài khoản Telegram mới, của supergroup (-100...) đều vượt mức đó.
        const int64_t id = upd["update_id"] | (int64_t)0;
        if (id >= g_updateOffset) g_updateOffset = id + 1;   // đã xử lý tới đây
        // Lần hỏi ĐẦU TIÊN sau khi khởi động: chỉ nuốt backlog (tin cũ Telegram
        // còn giữ), KHÔNG trả lời, để sau reboot bot không nhắn lại hàng loạt tin cũ.
        if (!g_primed) continue;

        const char* text = upd["message"]["text"] | "";
        const int64_t chatId = upd["message"]["chat"]["id"] | (int64_t)0;
        if (!text[0]) continue;

        // CHỈ trả lời các chat id khai trong TELEGRAM_CHAT_ID (secrets.h).
        const String chatStr = String((long long)chatId);
        if (!isFamilyChat(chatStr)) {
            Serial.printf("[TG] Bo qua tin tu chat la: %s\n", chatStr.c_str());
            continue;
        }

        if (dropOld) {
            const int64_t age = (int64_t)nowEpoch - (upd["message"]["date"] | (int64_t)0);
            if (age > 120) {
                Serial.printf("[TG] Bo qua tin cu (%lds) sau khi dashboard tra quyen\n",
                              (long)age);
                continue;
            }
        }

        FamilyMessage m;
        m.text     = text;
        m.lower    = m.text;
        m.lower.toLowerCase();
        m.fromName = (const char*)(upd["message"]["from"]["first_name"] | "");
        m.chatId   = chatStr;
        const String reply = g_replyBuilder(m);
        if (reply.length()) replyToChat(chatStr, reply);
    }
    // Lô ít hơn limit=5 tin (xem URL) nghĩa là đã đọc hết tin tồn lúc thuê ->
    // từ giờ trả lời mọi tin như bình thường (kể cả tin đến trễ vì mất Wi-Fi).
    if (count < 5) g_afterLease = false;
    g_primed = true;   // từ lần hỏi kế tiếp trở đi mới trả lời tin nhắn
}

// ---------------------------------------------------------------------------
//  Chat hai chiều qua Zalo (task riêng, long polling)
// ---------------------------------------------------------------------------
//
//  Mỗi lượt getUpdates, máy chủ Zalo giữ kết nối tối đa ZALO_POLL_TIMEOUT_S giây:
//  có tin là trả về ngay (một tin mỗi lượt), hết giờ mà không có tin thì trả mã
//  408. Task này chỉ ĐỌC trạng thái (qua g_replyBuilder) và gửi trả lời trực
//  tiếp, không đụng tới hàng đợi cảnh báo.

static_assert(ZALO_POLL_TIMEOUT_S <= 45,
              "ZALO_POLL_TIMEOUT_S qua lon: thoi gian cho HTTP (toi da 60s) phai dai hon luot cho tin");

/// Chuỗi id trong JSON của Zalo (thường là chuỗi hex; phòng khi là số).
String jsonId(JsonVariantConst v) {
    if (v.is<const char*>()) return String(v.as<const char*>());
    if (v.is<int64_t>())     return String((long long)v.as<int64_t>());
    return String();
}

/// Gửi một tin văn thuần tới chat Zalo (trả lời người nhà, không qua hàng đợi).
void zaloReply(WiFiClientSecure& client, const String& chatId, const String& text) {
    JsonDocument body;
    body["chat_id"] = chatId;
    body["text"]    = text;
    String payload;
    serializeJson(body, payload);
    String resp;
    const int code = zaloCall(client, "sendMessage", payload, 12000, &resp);
    if (code != 200) {
        snprintf(g_zlPollResult, sizeof(g_zlPollResult), "tra loi loi %d %.32s", code, resp.c_str());
        Serial.printf("[ZL] Tra loi %s that bai: %s\n", chatId.c_str(), g_zlPollResult);
    }
}

/// Người lạ nhắn bot: báo mã chat của họ tối đa 1 lần / 10 phút mỗi người, để
/// người nhà mới tự lấy được mã mà bot không thành vòng spam.
bool shouldTellStranger(const String& chatId) {
    const uint32_t now = millis();
    uint8_t slot = 0;
    for (uint8_t i = 0; i < 4; ++i) {
        RefusedChat& r = g_zlRefused[i];
        if (r.chat == chatId) {
            if (now - r.at < 10UL * 60UL * 1000UL) return false;
            r.at = now;
            return true;
        }
        if (r.chat.length() == 0) { slot = i; break; }   // ô trống: các ô sau cũng trống
        if ((int32_t)(r.at - g_zlRefused[slot].at) < 0) slot = i;   // ô cũ nhất
    }
    g_zlRefused[slot].chat = chatId;
    g_zlRefused[slot].at   = now;
    return true;
}

/// Xử lý MỘT tin Zalo.
void handleZaloUpdate(WiFiClientSecure& client, JsonObject upd) {
    JsonObject msg = upd["message"];
    if (msg.isNull() || (msg["from"]["is_bot"] | false)) return;
    const String chatId = jsonId(msg["chat"]["id"]);
    if (chatId.length() == 0) return;
    const String fromName = (const char*)(msg["from"]["display_name"] | "");
    const String event    = (const char*)(upd["event_name"] | "");
    const char*  text     = msg["text"] | "";

    if (!isZaloFamilyChat(chatId)) {
        Serial.printf("[ZL] Tin tu chat chua duoc phep: %s (%s)\n", chatId.c_str(), fromName.c_str());
        if (shouldTellStranger(chatId)) {
            String s = "Xin lỗi, bot này chỉ phục vụ gia đình đã đăng ký.\nMã chat Zalo của anh/chị là: ";
            s += chatId;
            s += "\nNếu anh/chị là người nhà, hãy gửi mã này cho người cài đặt thiết bị để được thêm vào danh sách.";
            zaloReply(client, chatId, s);
        }
        return;
    }

    // Mốc thời gian của Zalo tính bằng MILI giây. Tin nằm chờ quá lâu (thiết bị
    // mất mạng, vừa bật lại) thì bỏ qua, không trả lời dồn một loạt tin cũ.
    const int64_t dateMs = msg["date"] | (int64_t)0;
    const time_t  nowS   = time(nullptr);
    if (dateMs > 0 && nowS > 1600000000) {
        const int64_t ageS = (int64_t)nowS - dateMs / 1000;
        if (ageS > ZALO_STALE_S) {
            Serial.printf("[ZL] Bo qua tin cu (%ld giay) tu %s\n", (long)ageS, chatId.c_str());
            return;
        }
    }

    // Ảnh, nhãn dán, hoặc tin Zalo không cho bot đọc nội dung
    if (event != "message.text.received" || !text[0]) {
        zaloReply(client, chatId,
                  "Em mới đọc được tin nhắn chữ thôi ạ. Anh/chị gõ \"tình hình\" để hỏi, "
                  "hoặc /hoitham <lời nhắn> để nhờ loa ở nhà nói giúp nhé.");
        return;
    }

    FamilyMessage m;
    m.text     = text;
    m.lower    = m.text;
    m.lower.toLowerCase();
    m.fromName = fromName;
    m.chatId   = chatId;
    const String reply = g_replyBuilder(m);
    if (reply.length()) zaloReply(client, chatId, zaloText(reply));
}

/// Một lượt hỏi tin Zalo. Trả về số ms nên nghỉ trước lượt sau (0 = hỏi tiếp ngay).
uint32_t pollZaloOnce(WiFiClientSecure& client) {
    char body[32];
    snprintf(body, sizeof(body), "{\"timeout\":\"%lu\"}", (unsigned long)ZALO_POLL_TIMEOUT_S);
    String resp;
    const int code = zaloCall(client, "getUpdates", body, (ZALO_POLL_TIMEOUT_S + 10) * 1000UL, &resp);
    if (code == 408) {                       // hết lượt chờ, không có tin mới
        strlcpy(g_zlPollResult, "OK", sizeof(g_zlPollResult));
        return 0;
    }
    if (code != 200) {
        snprintf(g_zlPollResult, sizeof(g_zlPollResult), "getUpdates loi %d %.32s", code, resp.c_str());
        if (code == 401 || code == 403 || code == 404) {
            Serial.printf("[ZL] Zalo tu choi token (%d) -> kiem tra ZALO_BOT_TOKEN\n", code);
            return 60000;                    // sai token: đừng hỏi dồn
        }
        return 5000;                         // mất mạng / máy chủ bận
    }
    strlcpy(g_zlPollResult, "OK", sizeof(g_zlPollResult));
    JsonDocument doc;
    if (deserializeJson(doc, resp)) return 1000;
    // Zalo trả MỘT tin (object); vẫn nhận mảng phòng khi API đổi giống Telegram.
    JsonVariant res = doc["result"];
    if (res.is<JsonArray>()) {
        for (JsonObject u : res.as<JsonArray>()) handleZaloUpdate(client, u);
    } else if (res.is<JsonObject>()) {
        handleZaloUpdate(client, res.as<JsonObject>());
    }
    return 0;
}

void zaloTask(void*) {
    WiFiClientSecure client;   // giữ kết nối giữa các lượt (keep-alive), đỡ bắt tay HTTPS
    client.setInsecure();
    bool     leased  = false;
    uint32_t pauseMs = 0;
    for (;;) {
        if (pauseMs) { vTaskDelay(pdMS_TO_TICKS(pauseMs)); pauseMs = 0; }

        // Cần Wi-Fi và đồng hồ NTP (để nhận ra tin quá cũ) mới bắt đầu hỏi.
        if (!g_replyBuilder || WiFi.status() != WL_CONNECTED || time(nullptr) < 1600000000) {
            client.stop();
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        // Bật cờ "đang hỏi" TRƯỚC rồi mới xét quyền thuê, cùng trong spinlock:
        // dashboard xin quyền đúng lúc này thì hoặc ESP32 thấy và nhường, hoặc
        // ESP32 đã kịp bật cờ nên dashboard còn thấy "device" và chưa hỏi.
        portENTER_CRITICAL(&g_leaseMux);
        g_zlInFlight = true;
        const bool leasedNow = zaloLeaseActiveLocked();
        if (leasedNow) g_zlInFlight = false;
        portEXIT_CRITICAL(&g_leaseMux);

        if (leasedNow != leased) {
            leased = leasedNow;
            Serial.println(leased ? "[ZL] Dashboard nhan quyen doc tin Zalo"
                                  : "[ZL] Het han dashboard -> ESP32 tu doc tin Zalo");
            if (leased) client.stop();   // nhường hẳn: trả lại bộ nhớ của kết nối HTTPS
        }
        if (leased) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }

        pauseMs = pollZaloOnce(client);
        if (pauseMs) client.stop();

        portENTER_CRITICAL(&g_leaseMux);
        g_zlInFlight = false;
        portEXIT_CRITICAL(&g_leaseMux);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

/// Thử gửi một tin qua các kênh / người nhận còn lại của nó, ghi kết quả thẳng
/// vào it (pending, tgLeft, delivered). it.pending == 0 nghĩa là đã xong hết.
void deliver(Item& it) {
    if (it.pending & CH_TELEGRAM) {
        // Gửi lần lượt theo thứ tự trong TELEGRAM_CHAT_ID: người đầu tiên nhận trước.
        for (uint8_t i = 0; i < g_tgCount; ++i) {
            const uint8_t bit = (uint8_t)(1u << i);
            if (!(it.tgLeft & bit)) continue;
            const SendResult r = postToTelegram(it, g_tgChats[i]);
            if (r == SendResult::Ok) it.delivered = true;
            if (r != SendResult::Retry) it.tgLeft &= (uint8_t)~bit;
        }
        if (it.tgLeft == 0) it.pending &= (uint8_t)~CH_TELEGRAM;
    }
    // Zalo ngay sau Telegram (hai ứng dụng chat người nhà hay xem nhất), email sau cùng.
    if (it.pending & CH_ZALO) {
        for (uint8_t i = 0; i < g_zlCount; ++i) {
            const uint8_t bit = (uint8_t)(1u << i);
            if (!(it.zlLeft & bit)) continue;
            const SendResult r = postToZalo(it, g_zlChats[i]);
            if (r == SendResult::Ok) it.delivered = true;
            if (r != SendResult::Retry) it.zlLeft &= (uint8_t)~bit;
        }
        if (it.zlLeft == 0) it.pending &= (uint8_t)~CH_ZALO;
    }
    if (it.pending & CH_EMAIL) {
        const SendResult r = postToEmail(it);
        if (r == SendResult::Ok) it.delivered = true;
        if (r != SendResult::Retry) it.pending &= (uint8_t)~CH_EMAIL;
    }
}

void notifierTask(void*) {
    uint32_t nextTry = 0;
    bool     leased  = false;   ///< trạng thái thuê ở vòng trước, để chỉ in log khi đổi
    for (;;) {
        bool hasItem = false;
        Item head;
        {
            Lock lk;
            if (!g_queue.empty()) { head = g_queue.front(); hasItem = true; }
        }

        // --- Dashboard có đang giữ quyền đọc tin Telegram không ---
        const bool leasedNow = leaseActive();
        if (leasedNow != leased) {
            leased = leasedNow;
            if (pollingEnabled())
                Serial.println(leased ? "[TG] Dashboard nhan quyen doc tin Telegram"
                                      : "[TG] Het han dashboard -> ESP32 tu doc tin Telegram");
            // Đọc lại sau thời gian thuê: g_primed giữ nguyên (không nuốt backlog
            // như lúc khởi động), nhưng lô đầu sẽ bỏ các tin đã quá 120 giây.
            if (!leased) g_afterLease = true;
        }

        // --- Hỏi tin nhắn mới từ người nhà (chat hai chiều) ---
        // Đang cho dashboard thuê thì KHÔNG gọi getUpdates; hàng đợi cảnh báo
        // bên dưới vẫn chạy bình thường.
        if (TELEGRAM_POLL_MS > 0 && !leased && millis() >= g_nextPoll) {
            g_nextPoll = millis() + TELEGRAM_POLL_MS;
            pollUpdatesOnce();
        }

        if (hasItem && millis() >= nextTry) {
            // Không có Wi-Fi thì khỏi thử, chờ vòng sau.
            if (WiFi.status() != WL_CONNECTED) {
                strlcpy(g_lastResult, "chua co Wi-Fi", sizeof(g_lastResult));
                nextTry = millis() + TELEGRAM_RETRY_MS;
            } else {
                Item done = head;   // bản sao: gửi xong mới ghi kết quả lại vào hàng đợi
                deliver(done);
                Lock lk;
                if (!g_queue.empty()) {
                    if (done.pending == 0) {
                        // Mọi kênh / người nhận đã xong -> bỏ tin khỏi hàng đợi
                        g_queue.pop_front();
                        nextTry = 0;
                        if (done.delivered) {
                            g_sent++;
                            g_lastOk = millis();
                            Serial.printf("[TB] Da gui xong, con %u tin trong hang doi\n",
                                          (unsigned)g_queue.size());
                        } else {
                            // Mọi kênh đều lỗi vĩnh viễn: không tính là đã gửi (để
                            // không đo nhầm "trễ cảnh báo"); lý do nằm ở lastResult.
                            Serial.printf("[TB] Khong gui duoc toi ai, bo tin: %s\n", g_lastResult);
                        }
                    } else {
                        // Còn kênh / người nhận lỗi TẠM -> đếm số lần thử. Quá ngưỡng
                        // thì BỎ tin để một kênh hỏng lâu (mất mạng...) không chặn mãi
                        // các cảnh báo té ngã / SOS phía sau trong hàng đợi.
                        Item& front = g_queue.front();
                        front.pending   = done.pending;
                        front.tgLeft    = done.tgLeft;
                        front.zlLeft    = done.zlLeft;
                        front.delivered = done.delivered;
                        if (++front.tries >= MAX_TRIES_PER_ITEM) {
                            snprintf(g_lastResult, sizeof(g_lastResult),
                                     "bo tin sau %u lan loi (kenh con: 0x%02X)",
                                     (unsigned)MAX_TRIES_PER_ITEM, (unsigned)done.pending);
                            Serial.printf("[TB] %s\n", g_lastResult);
                            g_queue.pop_front();
                            nextTry = 0;
                        } else {
                            nextTry = millis() + TELEGRAM_RETRY_MS;
                        }
                    }
                    persistLocked();
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

}  // namespace

bool begin() {
    if (!g_mutex) g_mutex = xSemaphoreCreateMutex();
    // Đầu tiên: trước loadQueue() và trước khi có task nào đọc danh sách người nhận
    parseTelegramChats();
    parseZaloChats();
    {
        Lock lk;
        loadQueue();
    }

    // In ra kênh nào đang bật để lúc demo biết ngay cần sửa secrets.h hay chưa.
    Serial.printf("[TB] Kenh canh bao: Telegram=%s  Zalo=%s  Email=%s\n",
                  telegramConfigured() ? "BAT" : "tat",
                  zaloConfigured()     ? "BAT" : "tat",
                  emailConfigured()    ? "BAT" : "tat");
    if (g_tgCount > 1)
        Serial.printf("[TB] Telegram gui toi %u nguoi nhan\n", (unsigned)g_tgCount);
    if (g_zlCount > 1)
        Serial.printf("[TB] Zalo gui toi %u nguoi nhan\n", (unsigned)g_zlCount);
    if (zaloTokenSet() && g_zlCount == 0)
        Serial.println("[ZL] Da khai ZALO_BOT_TOKEN nhung chua co ZALO_CHAT_ID: nguoi nha nhan "
                       "cho bot mot cau de nhan ma chat, roi dien vao secrets.h");
    if (enabledChannels() == 0)
        Serial.println("[TB] CANH BAO: chua bat kenh nao -> hay dien secrets.h");

    // Task gửi tin cần stack lớn vì HTTPS/TLS tốn nhiều bộ nhớ
    const bool ok = xTaskCreatePinnedToCore(notifierTask, "notifier", 12288,
                                            nullptr, 2, &g_task, 1) == pdPASS;
    if (!ok) Serial.println("[TB] LOI: khong tao duoc task gui tin");

    // Task chat hai chiều Zalo: ưu tiên thấp nhất (1) và ghim core 0 để phần bắt
    // tay HTTPS không tranh CPU với máy trạng thái, âm thanh, gửi cảnh báo ở core 1.
    if (zaloPollingEnabled() && !g_zlTask) {
        if (xTaskCreatePinnedToCore(zaloTask, "zalo", 12288, nullptr, 1, &g_zlTask, 0) != pdPASS) {
            g_zlTask = nullptr;
            strlcpy(g_zlPollResult, "khong tao duoc task", sizeof(g_zlPollResult));
            Serial.println("[ZL] LOI: khong tao duoc task doc tin Zalo (thieu RAM?)");
        }
    }
    return ok;
}

bool send(const String& text) {
    const uint8_t channels = enabledChannels();
    if (channels == 0) {
        // Không bật kênh nào: vẫn ghi vào hàng đợi phòng khi người dùng điền
        // secrets.h rồi nạp lại? Không — tin sẽ không bao giờ gửi được. Ghi log
        // cảnh báo và bỏ qua để hàng đợi không phình mãi.
        Serial.println("[TB] Bo tin: chua bat kenh canh bao nao trong secrets.h");
        strlcpy(g_lastResult, "chua bat kenh nao (secrets.h)", sizeof(g_lastResult));
        return false;
    }

    Lock lk;
    if (g_queue.size() >= QUEUE_MAX_ITEMS) {
        Serial.println("[TB] Hang doi day, bo tin cu nhat");
        g_queue.pop_front();
    }
    Item it;
    it.ts      = time(nullptr);
    it.text    = text;
    it.pending = channels;
    it.tgLeft  = telegramTargets(channels);
    it.zlLeft  = zaloTargets(channels);
    g_queue.push_back(it);
    persistLocked();
    return true;
}

bool sendOne(const String& text, uint8_t channelMask) {
    // Chỉ gửi những kênh VỪA được yêu cầu VỪA đang bật trong secrets.h.
    const uint8_t channels = channelMask & enabledChannels();
    if (channels == 0) {
        // Kênh yêu cầu chưa cấu hình -> không đẩy tin, báo cho nơi gọi biết.
        Serial.println("[TB] Bo tin thu: kenh duoc chon chua bat trong secrets.h");
        strlcpy(g_lastResult, "kenh duoc chon chua bat (secrets.h)", sizeof(g_lastResult));
        return false;
    }

    Lock lk;
    if (g_queue.size() >= QUEUE_MAX_ITEMS) {
        Serial.println("[TB] Hang doi day, bo tin cu nhat");
        g_queue.pop_front();
    }
    Item it;
    it.ts      = time(nullptr);
    it.text    = text;
    it.pending = channels;   // CHỈ gửi đúng kênh được chọn
    it.tgLeft  = telegramTargets(channels);
    it.zlLeft  = zaloTargets(channels);
    g_queue.push_back(it);
    persistLocked();
    return true;
}

size_t      pending()       { Lock lk; return g_queue.size(); }
uint32_t    sentCount()     { return g_sent; }
const char* lastResult()    { return g_lastResult; }
uint32_t    lastSuccessMs() { return g_lastOk; }

const char* channelsText() {
    static char buf[48];
    buf[0] = '\0';
    bool first = true;
    auto add = [&](const char* name) {
        if (!first) strlcat(buf, ", ", sizeof(buf));
        strlcat(buf, name, sizeof(buf));
        first = false;
    };
    if (telegramConfigured()) {
        char tg[24];
        if (g_tgCount > 1) snprintf(tg, sizeof(tg), "Telegram (%u nguoi)", (unsigned)g_tgCount);
        else               strlcpy(tg, "Telegram", sizeof(tg));
        add(tg);
    }
    if (zaloConfigured()) {
        char zl[24];
        if (g_zlCount > 1) snprintf(zl, sizeof(zl), "Zalo (%u nguoi)", (unsigned)g_zlCount);
        else               strlcpy(zl, "Zalo", sizeof(zl));
        add(zl);
    }
    if (emailConfigured())    add("Email");
    if (first) strlcpy(buf, "chua bat kenh nao", sizeof(buf));
    return buf;
}

void onFamilyMessage(ReplyBuilder fn) { g_replyBuilder = fn; }

void grantDashboardLease(uint32_t seconds) {
    // Kẹp 5..120 giây: quá ngắn thì hai bên giành nhau liên tục, quá dài thì
    // laptop tắt đột ngột sẽ để người nhà nhắn mà không ai trả lời quá lâu.
    if (seconds < 5)   seconds = 5;
    if (seconds > 120) seconds = 120;
    const uint32_t until = millis() + seconds * 1000UL;
    portENTER_CRITICAL(&g_leaseMux);
    g_leaseUntil = until;
    g_leaseOn    = true;
    portEXIT_CRITICAL(&g_leaseMux);
}

const char* telegramPoller() {
    if (!pollingEnabled()) return "off";
    return leaseActive() ? "dashboard" : "device";
}

void grantZaloLease(uint32_t seconds) {
    if (seconds < 5)   seconds = 5;      // cùng mức kẹp với Telegram (xem trên)
    if (seconds > 120) seconds = 120;
    const uint32_t until = millis() + seconds * 1000UL;
    portENTER_CRITICAL(&g_leaseMux);
    g_zlLeaseUntil = until;
    g_zlLeaseOn    = true;
    portEXIT_CRITICAL(&g_leaseMux);
}

const char* zaloPoller() {
    if (!zaloPollingEnabled() || !g_zlTask) return "off";
    portENTER_CRITICAL(&g_leaseMux);
    const bool leased = zaloLeaseActiveLocked();
    const bool busy   = g_zlInFlight;
    portEXIT_CRITICAL(&g_leaseMux);
    // Chỉ báo "dashboard" khi ESP32 đã THẬT SỰ ngừng hỏi (xem notifier.h)
    return (leased && !busy) ? "dashboard" : "device";
}

uint8_t     zaloChatCount()  { parseZaloChats(); return g_zlCount; }
const char* zaloPollResult() { return g_zlPollResult; }

}  // namespace Notifier
