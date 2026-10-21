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

// ===========================================================================
//  GỬI CẢNH BÁO QUA NHIỀU KÊNH (Telegram + Email Resend + Zalo OA tùy chọn)
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
// ===========================================================================

namespace Notifier {

namespace {

// --- Mặt nạ kênh ---
constexpr uint8_t CH_TELEGRAM = 1 << 0;
constexpr uint8_t CH_EMAIL    = 1 << 1;
constexpr uint8_t CH_ZALO     = 1 << 2;

// Qua so lan thu nay thi bo tin de mot kenh hong vinh vien khong chan ca hang doi.
constexpr uint8_t MAX_TRIES_PER_ITEM = 8;

struct Item {
    time_t  ts       = 0;
    String  text;              ///< nội dung (định dạng HTML, dùng chung mọi kênh)
    uint8_t pending  = 0;      ///< các kênh CÒN phải gửi (mặt nạ CH_*)
    uint8_t tries    = 0;      ///< so lan da thu gui item nay (chong ket hang doi)
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

struct Lock {
    Lock()  { if (g_mutex) xSemaphoreTake(g_mutex, portMAX_DELAY); }
    ~Lock() { if (g_mutex) xSemaphoreGive(g_mutex); }
};

// --- Kênh nào đang được bật (đọc từ secrets.h) ---
bool telegramConfigured() {
    return strlen(TELEGRAM_BOT_TOKEN) >= 20 && strlen(TELEGRAM_CHAT_ID) >= 3;
}
bool emailConfigured() {
    return strlen(RESEND_API_KEY) >= 10 && strlen(EMAIL_TO) >= 5;
}
bool zaloConfigured() {
    return strlen(ZALO_OA_TOKEN) >= 10 && strlen(ZALO_USER_ID) >= 1;
}

/// Chat hai chiều có chạy không (bật chu kỳ hỏi tin + đã cấu hình Telegram).
bool pollingEnabled() {
    return TELEGRAM_POLL_MS > 0 && telegramConfigured();
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
    // Khôi phục vài entity hay dùng
    out.replace("&amp;", "&");
    out.replace("&lt;", "<");
    out.replace("&gt;", ">");
    return out;
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
//  Trả về true nếu gửi thành công (hoặc kênh không cần gửi nữa).
// ---------------------------------------------------------------------------

/// Kênh 1: Telegram Bot API.
bool postToTelegram(const Item& item) {
    WiFiClientSecure client;
    client.setInsecure();          // đủ dùng cho đồ án (xem chú thích bên dưới)
    client.setTimeout(10);

    const String url = String("https://api.telegram.org/bot") + TELEGRAM_BOT_TOKEN + "/sendMessage";

    JsonDocument body;
    body["chat_id"]    = TELEGRAM_CHAT_ID;
    body["text"]       = item.text;
    body["parse_mode"] = "HTML";
    String payload;
    serializeJson(body, payload);

    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(client, url)) {
        strlcpy(g_lastResult, "Telegram: khong mo duoc HTTPS", sizeof(g_lastResult));
        return false;
    }
    http.addHeader("Content-Type", "application/json");
    const int code = http.POST(payload);
    const String resp = (code > 0) ? http.getString() : String();
    http.end();

    if (code == 200) {
        strlcpy(g_lastResult, "Telegram: OK", sizeof(g_lastResult));
        return true;
    }
    // 401 = token sai, 400 = chat id sai
    snprintf(g_lastResult, sizeof(g_lastResult), "Telegram HTTP %d %.40s", code, resp.c_str());
    Serial.printf("[TG] Gui that bai: %s\n", g_lastResult);
    return false;
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
bool postToEmail(const Item& item) {
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
        return false;
    }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + RESEND_API_KEY);
    const int code = http.POST(payload);
    const String resp = (code > 0) ? http.getString() : String();
    http.end();

    // Resend trả 200 hoặc 201 kèm id của email khi thành công.
    if (code == 200 || code == 201) {
        strlcpy(g_lastResult, "Email: OK", sizeof(g_lastResult));
        return true;
    }
    // 403 = chưa xác minh tên miền / gửi tới địa chỉ lạ; 401 = API key sai
    snprintf(g_lastResult, sizeof(g_lastResult), "Email HTTP %d %.40s", code, resp.c_str());
    Serial.printf("[MAIL] Gui that bai: %s\n", g_lastResult);
    return false;
}

/// Kênh 3 (tùy chọn): Zalo Official Account — gửi tin văn bản cho user đã quan
/// tâm OA. API: POST https://openapi.zalo.me/v3.0/oa/message/cs
bool postToZaloOA(const Item& item) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(10);

    // Zalo không nhận HTML -> gửi bản văn thuần.
    const String text = stripHtml(item.text);

    JsonDocument body;
    body["recipient"]["user_id"]      = ZALO_USER_ID;
    body["message"]["text"]           = text;
    String payload;
    serializeJson(body, payload);

    HTTPClient http;
    http.setTimeout(12000);
    if (!http.begin(client, "https://openapi.zalo.me/v3.0/oa/message/cs")) {
        strlcpy(g_lastResult, "Zalo: khong mo duoc HTTPS", sizeof(g_lastResult));
        return false;
    }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("access_token", ZALO_OA_TOKEN);
    const int code = http.POST(payload);
    const String resp = (code > 0) ? http.getString() : String();
    http.end();

    // Zalo trả HTTP 200; trong body có "error":0 nếu thành công.
    if (code == 200 && resp.indexOf("\"error\":0") >= 0) {
        strlcpy(g_lastResult, "Zalo: OK", sizeof(g_lastResult));
        return true;
    }
    snprintf(g_lastResult, sizeof(g_lastResult), "Zalo HTTP %d %.40s", code, resp.c_str());
    Serial.printf("[ZALO] Gui that bai: %s\n", g_lastResult);
    return false;
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

        // CHỈ trả lời đúng chat id đã khai trong secrets.h.
        const String chatStr = String((long long)chatId);
        if (chatStr != String(TELEGRAM_CHAT_ID)) {
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

/// Thử gửi một tin qua các kênh còn lại của nó. Trả về mặt nạ các kênh VẪN còn
/// phải gửi sau lần thử này (0 = đã xong hết).
uint8_t deliver(const Item& item) {
    uint8_t stillPending = item.pending;

    if (stillPending & CH_TELEGRAM) {
        if (postToTelegram(item)) stillPending &= ~CH_TELEGRAM;
    }
    if (stillPending & CH_EMAIL) {
        if (postToEmail(item)) stillPending &= ~CH_EMAIL;
    }
    if (stillPending & CH_ZALO) {
        if (postToZaloOA(item)) stillPending &= ~CH_ZALO;
    }
    return stillPending;
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
                const uint8_t stillPending = deliver(head);
                Lock lk;
                if (!g_queue.empty()) {
                    if (stillPending == 0) {
                        // Mọi kênh đã gửi xong -> bỏ tin khỏi hàng đợi
                        g_queue.pop_front();
                        g_sent++;
                        g_lastOk = millis();
                        nextTry = 0;
                        Serial.printf("[TB] Da gui xong, con %u tin trong hang doi\n",
                                      (unsigned)g_queue.size());
                    } else {
                        // Còn kênh lỗi -> đếm số lần thử. Quá ngưỡng thì BỎ tin để
                        // một kênh hỏng vĩnh viễn (sai key, token hết hạn...) không
                        // chặn mãi các cảnh báo té ngã / SOS phía sau trong hàng đợi.
                        Item& front = g_queue.front();
                        front.pending = stillPending;
                        if (++front.tries >= MAX_TRIES_PER_ITEM) {
                            snprintf(g_lastResult, sizeof(g_lastResult),
                                     "bo tin sau %u lan loi (kenh con: 0x%02X)",
                                     (unsigned)MAX_TRIES_PER_ITEM, (unsigned)stillPending);
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
    {
        Lock lk;
        loadQueue();
    }

    // In ra kênh nào đang bật để lúc demo biết ngay cần sửa secrets.h hay chưa.
    Serial.printf("[TB] Kenh canh bao: Telegram=%s  Email=%s  Zalo=%s\n",
                  telegramConfigured() ? "BAT" : "tat",
                  emailConfigured()    ? "BAT" : "tat",
                  zaloConfigured()     ? "BAT" : "tat");
    if (enabledChannels() == 0)
        Serial.println("[TB] CANH BAO: chua bat kenh nao -> hay dien secrets.h");

    // Task gửi tin cần stack lớn vì HTTPS/TLS tốn nhiều bộ nhớ
    const bool ok = xTaskCreatePinnedToCore(notifierTask, "notifier", 12288,
                                            nullptr, 2, &g_task, 1) == pdPASS;
    if (!ok) Serial.println("[TB] LOI: khong tao duoc task gui tin");
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
    if (telegramConfigured()) add("Telegram");
    if (emailConfigured())    add("Email");
    if (zaloConfigured())     add("Zalo");
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

}  // namespace Notifier
