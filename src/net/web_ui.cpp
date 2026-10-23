#include "web_ui.h"
#include "config.h"
#include "secrets.h"
#include "app_api.h"
#include "radar.h"
#include "notifier.h"
#include "event_log.h"
#include "audio.h"
#include "assistant.h"
#include "fall_model.h"
#include "nn_model.h"
#include "rf_remote.h"
#include "wifi_mgr.h"
#include "wifi_portal_page.h"   // WIFI_PORTAL_HTML: trang cấu hình Wi-Fi nhúng sẵn trong firmware

#include <WiFi.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>

namespace WebUi {

namespace {

AsyncWebServer g_server(80);
AsyncWebSocket g_ws("/ws");
uint32_t       g_nextPush = 0;

/// Có đặt mật khẩu trang web hay không (khai trong secrets.h)
inline bool authEnabled() { return strlen(WEB_USER) > 0; }

/// Trả về true nếu yêu cầu đã bị chặn vì thiếu/sai mật khẩu.
bool blocked(AsyncWebServerRequest* request) {
    if (!authEnabled()) return false;
    if (request->authenticate(WEB_USER, WEB_PASS)) return false;
    request->requestAuthentication();
    return true;
}

String statusJson() {
    const RadarSnapshot r  = Radar::snapshot();
    const App::Status    a = App::status();
    const auto           s = EventLog::stats();

    JsonDocument doc;
    doc["state"]      = stateName(a.state);
    doc["stateVi"]    = stateNameVi(a.state);
    doc["countdown"]  = a.countdownS;
    doc["cooldown"]   = a.cooldownS;
    doc["stateAge"]   = a.stateAgeS;
    doc["latencyMs"]  = a.alertLatencyMs;
    doc["simulate"]   = SIMULATE_RADAR;
    doc["confirmWin"] = CONFIRM_WINDOW_S;
    doc["voice"]      = Audio::isPlaying();
    // Lời nhắn người nhà đang chờ loa phát: dashboard chờ hết "pending" mới đẩy
    // lời nhắn kế tiếp, khỏi bị trả 409 vì loa bận.
    doc["say"]["pending"] = App::sayPending();

    JsonObject jr = doc["radar"].to<JsonObject>();
    jr["online"]   = r.online;
    jr["present"]  = r.present;
    jr["movement"] = r.movement;
    jr["range"]    = r.movingRange;
    jr["distance"] = r.distanceCm;
    jr["fall"]     = r.fallFlag;
    jr["static"]   = r.staticStay;
    jr["falls"]    = r.fallEdges;
    jr["errors"]   = r.readErrors;
    // Bọc String() để sao chép nội dung ngay: chuỗi này do task radar ghi,
    // nếu giữ con trỏ thì có thể bị sửa giữa lúc đang đóng gói JSON.
    jr["health"]   = String(Radar::healthText());
    jr["fastMode"] = r.fastMode;
    jr["frames"]   = r.framesGood;
    jr["badFrames"] = r.framesBad;
    jr["fallAgeMs"] = r.fallAgeMs;
    jr["trackX"]   = r.trackX;
    jr["trackY"]   = r.trackY;
    jr["ageMs"]    = r.lastUpdate ? (millis() - r.lastUpdate) : 0;

    // Che do lam viec cua radar. Mo-dun chi chay MOT che do tai mot thoi diem:
    // phat hien te nga HOAC theo doi giac ngu (nhip tim, nhip tho).
    JsonObject jmode = doc["mode"].to<JsonObject>();
    jmode["code"]     = radarModeName(r.mode);
    jmode["vi"]       = radarModeVi(r.mode);
    jmode["sinceS"]   = r.modeSince ? (millis() - r.modeSince) / 1000 : 0;
    jmode["switches"] = r.modeSwitches;
    jmode["blindMs"]  = r.blindMs;       // tong thoi gian "mu" vi doi che do
    jmode["enabled"]  = ENABLE_SLEEP_MODE;

    // Sinh hieu - CHI co o che do giac ngu. Day la UOC LUONG bang song radar,
    // KHONG phai thiet bi y te.
    JsonObject jv = doc["vitals"].to<JsonObject>();
    jv["valid"]        = r.vitals.valid;
    jv["heartRate"]    = r.vitals.heartRate;
    jv["breatheValue"] = r.vitals.breatheValue;
    jv["breatheState"] = r.vitals.breatheState;
    jv["inBed"]        = r.vitals.inBed;
    jv["sleepState"]   = r.vitals.sleepState;
    jv["sleepScore"]   = r.vitals.sleepScore;
    jv["struggle"]     = r.vitals.struggle;
    jv["ageMs"]        = r.vitals.lastUpdate ? (millis() - r.vitals.lastUpdate) : 0;

    // Nut SOS deo tay qua song 433 MHz
    JsonObject jrf = doc["remote"].to<JsonObject>();
    jrf["enabled"]  = RfRemote::enabled();
    jrf["presses"]  = RfRemote::pressCount();
    jrf["rejected"] = RfRemote::rejectedCount();
    jrf["lastCode"] = RfRemote::lastCode();

    // Ket qua model tu huan luyen (xem src/fall_model.h)
    JsonObject jm = doc["model"].to<JsonObject>();
    jm["ready"] = r.modelReady;
    jm["fall"]  = r.modelFall;
    jm["prob"]  = r.modelProb;
    jm["info"]  = String(FallModel::info());
    jm["spec"]  = FallModel::FEATURE_SPEC_VERSION;
    jm["window"] = FallModel::WINDOW_SIZE;
    jm["periodMs"] = FEATURE_PERIOD_MS;

    // Ket qua hai mang no-ron nho (xem src/core/nn_model.h). Manh hon hoi quy
    // logistic o tren nhieu nhung van chay tren chinh ESP32.
    JsonObject jn = doc["nn"].to<JsonObject>();
    jn["ready"]       = r.nnReady;
    jn["fall"]        = r.nnFall;
    jn["prob"]        = r.nnProb;
    jn["posture"]     = r.nnPosture;
    jn["postureName"] = String(NnModel::postureName(r.nnPosture));
    jn["postureProb"] = r.nnPostureProb;
    jn["floorProb"]   = r.nnFloorProb;
    jn["info"]        = String(NnModel::info());

    // Cau hinh dang nap trong firmware. Dashboard doc de (1) biet do tre xac nhan
    // nga ma gan nhan dung cho du lieu huan luyen, (2) canh bao neu nguoi do khai
    // chieu cao / do nhay khac voi firmware thuc te.
    JsonObject jc = doc["config"].to<JsonObject>();
    jc["installHeightCm"] = RADAR_INSTALL_HEIGHT_CM;
    jc["sensitivity"]     = RADAR_FALL_SENSITIVITY;
    jc["fallTimeS"]       = RADAR_FALL_TIME_S;
    jc["unmannedTimeS"]   = RADAR_UNMANNED_TIME_S;
    jc["confirmWindowS"]  = CONFIRM_WINDOW_S;
    jc["cooldownS"]       = FALL_COOLDOWN_S;
    jc["queryIntervalMs"] = RADAR_QUERY_INTERVAL_MS;
    jc["sleepModeOn"]     = ENABLE_SLEEP_MODE;
    jc["sleepFromHour"]   = SLEEP_WINDOW_START_HOUR;
    jc["sleepToHour"]     = SLEEP_WINDOW_END_HOUR;
    jc["hrAlertMin"]      = HR_ALERT_MIN;
    jc["hrAlertMax"]      = HR_ALERT_MAX;

    // Tro ly hoi thoai kieu Xiaozhi (mic INMP441 -> dashboard STT/LLM/TTS -> loa)
    JsonObject ja = doc["assistant"].to<JsonObject>();
    ja["enabled"] = Assistant::isEnabled();
    ja["busy"]    = Assistant::isBusy();
    const char* asState = "tat";
    switch (Assistant::state()) {
        case Assistant::AS_IDLE:      asState = "san sang"; break;
        case Assistant::AS_LISTENING: asState = "dang nghe"; break;
        case Assistant::AS_THINKING:  asState = "dang xu ly"; break;
        case Assistant::AS_SPEAKING:  asState = "dang noi"; break;
        default:                      asState = "tat"; break;
    }
    ja["state"] = asState;

    // Khối Wi-Fi: giữ trường cũ { up, ssid ("-"), rssi, ip ("-"), saved, portal, ap }
    // và thêm { phase, trying, bars, channel, apIp, apClients, attempt } (API Wi-Fi v2).
    // Lấy từ bản chụp của WifiMgr dưới khóa, không gọi thẳng driver từ task web.
    WifiMgr::fillStatus(doc["wifi"].to<JsonObject>());

    JsonObject jt = doc["telegram"].to<JsonObject>();
    jt["pending"]  = Notifier::pending();
    jt["sent"]     = Notifier::sentCount();
    jt["last"]     = Notifier::lastResult();
    jt["channels"] = String(Notifier::channelsText());
    // Bên nào đang đọc tin Telegram: "off" | "dashboard" (đang thuê qua ?tg=) |
    // "device". Dashboard chỉ nên gọi getUpdates khi thấy "dashboard".
    jt["poller"]   = Notifier::telegramPoller();

    // Zalo Bot: tương tự, thuê qua ?zl=. "dashboard" chỉ hiện khi ESP32 đã ngừng
    // hẳn lượt chờ tin (Zalo không trả lại tin đã giao cho bên kia).
    JsonObject jz = doc["zalo"].to<JsonObject>();
    jz["poller"] = Notifier::zaloPoller();
    jz["chats"]  = Notifier::zaloChatCount();
    jz["last"]   = Notifier::zaloPollResult();

    JsonObject js = doc["stats"].to<JsonObject>();
    js["suspects"]  = s.suspects;
    js["cancelled"] = s.cancelled;
    js["emergency"] = s.emergency;
    js["sos"]       = s.sos;

    JsonObject jd = doc["device"].to<JsonObject>();
    jd["name"]     = PATIENT_NAME;
    jd["place"]    = DEVICE_PLACE;
    jd["uptimeS"]  = millis() / 1000;
    jd["heap"]     = ESP.getFreeHeap();
    jd["psram"]    = ESP.getFreePsram();
    jd["clients"]  = g_ws.count();
    const time_t now = time(nullptr);
    jd["epoch"] = (uint32_t)now;
    char when[24] = "chua dong bo gio";
    if (now > 1600000000) {
        struct tm tmv;
        localtime_r(&now, &tmv);
        strftime(when, sizeof(when), "%d/%m/%Y %H:%M:%S", &tmv);
    }
    jd["clock"] = when;

    String out;
    serializeJson(doc, out);
    return out;
}

void onWsEvent(AsyncWebSocket*, AsyncWebSocketClient* client, AwsEventType type,
               void*, uint8_t*, size_t) {
    if (type == WS_EVT_CONNECT) {
        client->text(statusJson());
        client->text(String("{\"events\":") + EventLog::recentJson() + "}");
    }
}

void handleAction(AsyncWebServerRequest* request) {
    if (blocked(request)) return;
    // Chong gia mao yeu cau tu trang la (CSRF): bat buoc header "X-OALPHA" giong cac
    // lenh ghi Wi-Fi. The <img> / form tu submit cua trang la khong dat duoc header
    // tuy bien; fetch kem header nay thi trinh duyet phai preflight ma firmware khong
    // tra CORS nen bi chan. Chi xet header CO MAT.
    if (!request->hasHeader("X-OALPHA")) {
        request->send(403, "application/json",
                      "{\"ok\":false,\"err\":\"Thieu header X-OALPHA (chong gia mao CSRF)\"}");
        return;
    }
    String name;
    if (request->hasParam("name"))             name = request->getParam("name")->value();
    else if (request->hasParam("name", true))  name = request->getParam("name", true)->value();

    bool ok = true;
    if      (name == "iamok")       App::requestIamOk();
    else if (name == "sos")         App::requestSos();
    else if (name == "simfall")     App::requestSimulateFall();
    else if (name == "present_on")  App::requestSimPresence(true);
    else if (name == "present_off") App::requestSimPresence(false);
    else if (name == "testvoice")   App::requestTestVoice();
    else if (name == "testtg")      App::requestTestTelegram();
    else if (name == "testmail")    App::requestTestEmail();
    else if (name == "testzalo")    App::requestTestZalo();
    else if (name == "clearlog")    App::requestClearLog();
    else if (name == "assistant")   App::requestAssistant();   // kich hoat tro ly hoi thoai
    else ok = false;

    if (!ok) { request->send(400, "application/json", "{\"ok\":false,\"err\":\"thao tac la\"}"); return; }
    request->send(200, "application/json", "{\"ok\":true}");
}

// ---------------------------------------------------------------------------
//  POST /api/say?from=<tên> — dashboard đẩy lời nhắn người nhà (WAV) xuống loa
// ---------------------------------------------------------------------------
//  Thân yêu cầu là NGUYÊN file WAV (Content-Type: audio/wav), không bọc
//  multipart cho khỏi phải tách biên. Thư viện gọi onSayBody() theo từng mảnh
//  TCP, rồi gọi onSayRequest() khi đã nhận đủ Content-Length byte — chỉ lúc đó
//  mới được trả lời. Dữ liệu ghi ra file tạm rồi mới đổi tên, để loa không bao
//  giờ đọc phải một file đang ghi dở.
//
//  Mọi callback của máy chủ web chạy trong CÙNG một task (async_tcp) nên g_say
//  không cần khóa. Mỗi lúc chỉ nhận MỘT bản: file 700 KB ghi flash mất vài giây.

constexpr const char* SAY_TMP_FILE        = "/say.tmp";
constexpr uint32_t    SAY_UPLOAD_STALE_MS = 20000;   ///< bản tải lâu hơn coi như treo
constexpr size_t      WAV_MIN_BYTES       = 44;      ///< header WAV PCM nhỏ nhất

struct SayUpload {
    bool                   active    = false;
    AsyncWebServerRequest* owner     = nullptr;   ///< yêu cầu đang giữ lượt tải
    fs::File               file;
    bool                   opened    = false;     ///< đã tạo file tạm (để biết có cần xóa)
    size_t                 written   = 0;
    size_t                 total     = 0;
    uint32_t               startedAt = 0;
    int                    err       = 0;         ///< mã HTTP lỗi, 0 = chưa lỗi
    const char*            errMsg    = "";
    uint8_t                head[12]  = {};        ///< 12 byte đầu, phải là "RIFF????WAVE"
    size_t                 headLen   = 0;
};
SayUpload g_say;

void sendSayError(AsyncWebServerRequest* request, int code, const char* err) {
    Serial.printf("[SAY] Tu choi %d: %s\n", code, err);
    String body = "{\"ok\":false,\"err\":\"";
    body += err;
    body += "\"}";
    request->send(code, "application/json", body);
}

/// Bỏ lượt tải hiện tại: đóng file, xóa file tạm nếu còn, nhả lượt cho bản sau.
void sayReset() {
    if (g_say.file) g_say.file.close();
    if (g_say.opened) LittleFS.remove(SAY_TMP_FILE);
    g_say = SayUpload{};
}

/// Ghi nhận lỗi đầu tiên; ngừng ghi flash ngay, phần thân còn lại bị bỏ qua.
void sayFail(int code, const char* msg) {
    if (g_say.err) return;
    g_say.err    = code;
    g_say.errMsg = msg;
    if (g_say.file) g_say.file.close();
    if (g_say.opened) { LittleFS.remove(SAY_TMP_FILE); g_say.opened = false; }
}

bool alerting() {
    const SysState st = App::status().state;
    return st == ST_SUSPECT_FALL || st == ST_EMERGENCY;
}

void onSayBody(AsyncWebServerRequest* request, uint8_t* data, size_t len,
               size_t index, size_t total) {
    if (index == 0) {
        // Chưa đăng nhập: không ghi gì, không giữ lượt; onSayRequest() trả 401.
        if (authEnabled() && !request->authenticate(WEB_USER, WEB_PASS)) return;

        // Đánh dấu "thân WAV thô đã tới đây" (thư viện tự free() khi hủy yêu cầu)
        // để onSayRequest() phân biệt bị từ chối vì bận (409) với gửi sai kiểu (415).
        if (!request->_tempObject) request->_tempObject = malloc(1);

        if (g_say.active) {
            // owner == request mà index = 0: yêu cầu cũ đã bị hủy, vùng nhớ của nó
            // vừa được cấp lại cho yêu cầu này -> chắc chắn là bản treo.
            const bool stale = g_say.owner == request ||
                               millis() - g_say.startedAt >= SAY_UPLOAD_STALE_MS;
            if (!stale) return;   // đang nhận bản khác -> onSayRequest() trả 409
            Serial.println("[SAY] Ban tai truoc treo qua 20s -> huy, nhan ban moi");
            sayReset();
        }

        g_say.active    = true;
        g_say.owner     = request;
        g_say.total     = total;
        g_say.startedAt = millis();
        // Client ngắt giữa chừng -> nhả lượt ngay, bản sau khỏi phải chờ 20 giây.
        request->onDisconnect([request]() {
            if (g_say.active && g_say.owner == request) {
                Serial.println("[SAY] Client ngat giua chung -> huy ban tai");
                sayReset();
            }
        });

        // Kiểm tra trước khi ghi flash. Cảnh báo xét trước loa bận: lúc nghi ngã
        // loa cũng đang bận hỏi thăm, mà dashboard cần biết lý do thật (423).
        if (total > SAY_MAX_BYTES)       sayFail(413, "file qua lon");
        else if (total < WAV_MIN_BYTES)  sayFail(415, "khong phai WAV");
        else if (alerting())             sayFail(423, "dang canh bao");
        else if (App::sayPending() || Audio::isPlaying() || Assistant::isBusy())
                                         sayFail(409, "loa dang ban");
        else {
            g_say.file   = LittleFS.open(SAY_TMP_FILE, "w");
            g_say.opened = (bool)g_say.file;
            if (!g_say.opened) sayFail(500, "khong ghi duoc flash");
        }
    }

    // Không phải chủ lượt tải, hoặc đã lỗi -> bỏ dữ liệu (thư viện vẫn nhận hết thân).
    if (!g_say.active || g_say.owner != request || g_say.err) return;

    // Gom 12 byte đầu (mảnh đầu tiên có thể ngắn hơn 12 byte) rồi xét chữ ký WAV.
    if (g_say.headLen < sizeof(g_say.head)) {
        size_t n = sizeof(g_say.head) - g_say.headLen;
        if (n > len) n = len;
        memcpy(g_say.head + g_say.headLen, data, n);
        g_say.headLen += n;
        if (g_say.headLen == sizeof(g_say.head) &&
            (memcmp(g_say.head, "RIFF", 4) != 0 || memcmp(g_say.head + 8, "WAVE", 4) != 0)) {
            sayFail(415, "khong phai WAV");
            return;
        }
    }

    if (g_say.file.write(data, len) != len) {
        sayFail(500, "khong ghi duoc flash");   // thường là đầy LittleFS
        return;
    }
    g_say.written += len;
}

void onSayRequest(AsyncWebServerRequest* request) {
    if (blocked(request)) return;   // thiếu/sai mật khẩu -> 401 như mọi API khác

    if (!g_say.active || g_say.owner != request) {
        // Thân rỗng (Content-Length = 0) thì onSayBody() không hề được gọi.
        if (request->contentLength() == 0) sendSayError(request, 413, "thieu du lieu WAV");
        // Đã tới onSayBody() mà không giữ được lượt: bản khác đang tải (hoặc đã
        // giành lượt của bản này sau 20 giây treo).
        else if (request->_tempObject)     sendSayError(request, 409, "dang nhan ban khac");
        // Thân gửi dạng form (application/x-www-form-urlencoded) thì thư viện tự
        // tách thành tham số, không chuyển cho onSayBody().
        else                               sendSayError(request, 415, "can than WAV tho (audio/wav)");
        return;
    }

    int         code = g_say.err;
    const char* msg  = g_say.errMsg;
    if (!code && g_say.written != g_say.total) { code = 500; msg = "nhan thieu du lieu"; }
    // Tải lên mất vài giây: xét lại, lỡ trong lúc đó có cảnh báo hay loa bị chiếm.
    // Loa đang phát thì cũng KHÔNG được thay /say.wav (có thể chính nó đang đọc).
    if (!code && alerting()) { code = 423; msg = "dang canh bao"; }
    if (!code && (App::sayPending() || Audio::isPlaying())) { code = 409; msg = "loa dang ban"; }
    if (!code) {
        g_say.file.close();
        if (LittleFS.exists(AUDIO_FILE_SAY)) LittleFS.remove(AUDIO_FILE_SAY);
        if (LittleFS.rename(SAY_TMP_FILE, AUDIO_FILE_SAY)) g_say.opened = false;   // file tạm đã thành file chính
        else { code = 500; msg = "khong doi ten duoc file"; }
    }
    if (!code) {
        const String from = request->hasParam("from") ? request->getParam("from")->value() : String();
        if (!App::requestSay(from.c_str(), AUDIO_FILE_SAY)) { code = 409; msg = "loa dang ban"; }
    }

    const size_t bytes = g_say.written;
    sayReset();
    if (code) { sendSayError(request, code, msg); return; }
    Serial.printf("[SAY] Da nhan %u byte -> cho loa phat\n", (unsigned)bytes);
    request->send(202, "application/json", "{\"ok\":true}");
}

// ---------------------------------------------------------------------------
//  Wi-Fi: cổng cấu hình (captive portal) + API Wi-Fi v2
// ---------------------------------------------------------------------------
//  Các handler ở đây CHỈ đặt cờ yêu cầu và đọc trạng thái qua WifiMgr; mọi lệnh
//  điều khiển driver Wi-Fi chạy trong loop(), nên task web không bao giờ bị chặn
//  bởi việc quét hay nối mạng.

constexpr const char* JSON_UTF8 = "application/json; charset=utf-8";

/// Trang gợi ý khi LittleFS chưa có giao diện (quên chạy uploadfs).
const char NO_UI_HTML[] =
    "<!doctype html><html lang=vi><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Chưa nạp giao diện web</title>"
    "<body style='font-family:system-ui,sans-serif;max-width:36em;margin:2em auto;padding:0 1em'>"
    "<h2>Chưa nạp giao diện web…</h2>"
    "<p>Hãy chạy lệnh <code>pio run -t uploadfs</code> để nạp thư mục <code>data/</code> vào LittleFS.</p>"
    "<p>Trong lúc chờ, vẫn cấu hình Wi-Fi được tại <a href='/wifi'>trang Wi-Fi</a>.</p>"
    "</body></html>";

/// Yêu cầu đến từ phía AP cấu hình (điện thoại đang nối thẳng vào Wi-Fi do thiết bị phát)?
bool portalSide(AsyncWebServerRequest* request) {
    if (!WifiMgr::portalActive()) return false;
    AsyncClient* c = request->client();
    return c != nullptr && c->localIP() == WifiMgr::apIp();
}

/// Host là của chính thiết bị (IP AP, tên mDNS)? Bỏ ":cổng", không phân biệt hoa thường.
bool isOwnHost(const String& hostHeader) {
    String h = hostHeader;
    const int colon = h.indexOf(':');
    if (colon >= 0) h.remove(colon);
    h.trim();
    if (h.isEmpty()) return true;
    if (h.equalsIgnoreCase(WifiMgr::apIp().toString())) return true;
    return h.equalsIgnoreCase(HOSTNAME) || h.equalsIgnoreCase(HOSTNAME ".local");
}

void redirectToPortal(AsyncWebServerRequest* request) {
    String url = "http://";
    url += WifiMgr::apIp().toString();
    url += "/";
    request->redirect(url);
}

/**
 * Bắt MỌI yêu cầu từ phía AP có Host lạ (connectivitycheck.gstatic.com,
 * captive.apple.com, www.msftconnecttest.com...) rồi chuyển về trang cấu hình.
 * Nhờ DNS của WifiMgr trả mọi tên miền về IP của AP, điện thoại tưởng mạng có
 * "trang đăng nhập" nên tự bật trang cấu hình lên. Đăng ký ĐẦU TIÊN vì thư viện
 * chọn handler theo thứ tự đăng ký.
 */
class CaptiveRedirect : public AsyncWebHandler {
public:
    bool canHandle(AsyncWebServerRequest* request) override {
        if (!portalSide(request)) return false;
        // Handler này đứng ĐẦU danh sách nên được hỏi với MỌI yêu cầu: báo WifiMgr
        // "có người đang dùng trang cấu hình" cho mọi yêu cầu phía AP (dò captive,
        // /wifi, /api/wifi/*...) kể cả khi handler khác xử lý -> tạm dừng tự nối nền.
        WifiMgr::notePortalActivity();
        const String& host = request->host();
        return host.length() > 0 && !isOwnHost(host);
    }
    void handleRequest(AsyncWebServerRequest* request) override { redirectToPortal(request); }
};
CaptiveRedirect g_captive;

/// GET /wifi (và GET / từ phía AP khi cổng cấu hình bật): trang chọn mạng nhúng sẵn.
void sendPortalPage(AsyncWebServerRequest* request) {
    if (blocked(request)) return;
    AsyncWebServerResponse* res =
        request->beginResponse_P(200, "text/html; charset=utf-8", WIFI_PORTAL_HTML);
    res->addHeader("Cache-Control", "no-store");
    request->send(res);
}

/// Lỗi theo hợp đồng: mã 4xx/5xx + {"ok":false,"err":"<câu tiếng Việt>"} (ArduinoJson thoát chuỗi).
void sendWifiError(AsyncWebServerRequest* request, int code, const char* err) {
    JsonDocument doc;
    doc["ok"]  = false;
    doc["err"] = err;
    String out;
    serializeJson(doc, out);
    request->send(code, JSON_UTF8, out);
}

/// Chỉ lấy tham số trong THÂN form POST: mật khẩu không lộ trên URL (log, lịch sử
/// trình duyệt) và trang lạ không đổi được Wi-Fi bằng một thẻ <img src=...>.
bool formParam(AsyncWebServerRequest* request, const char* name, String& out) {
    const AsyncWebParameter* p = request->getParam(name, true);
    if (p == nullptr) return false;
    out = p->value();
    return true;
}

/// Lấy ssid bắt buộc; thiếu thì trả 400 và trả về false.
bool requireSsid(AsyncWebServerRequest* request, String& ssid) {
    if (formParam(request, "ssid", ssid) && ssid.length() > 0) return true;
    sendWifiError(request, 400, "Thiếu tên mạng (ssid)");
    return false;
}

/**
 * Chống giả mạo yêu cầu từ trang lạ (CSRF) cho các lệnh ghi Wi-Fi: phải có header
 * tùy biến "X-OALPHA: 1". Form tự submit hay thẻ <img> của trang lạ không đặt được
 * header; fetch() kèm header tùy biến thì trình duyệt phải hỏi trước (preflight
 * OPTIONS) mà firmware không trả header CORS nào, nên trình duyệt chặn luôn. Chỉ xét
 * header CÓ MẶT (giá trị không mang thêm an toàn; thư viện còn cắt giá trị theo
 * mẫu "Tên: giá trị" nên "X-OALPHA:1" thiếu dấu cách sẽ ra rỗng). Handler đăng ký
 * bằng on() giữ mọi header (AsyncCallbackWebHandler gọi addInterestingHeader("ANY")).
 * Thiếu -> 403 và trả về true. Gọi SAU blocked().
 */
bool csrfBlocked(AsyncWebServerRequest* request) {
    if (request->hasHeader("X-OALPHA")) return false;
    sendWifiError(request, 403, "Thiếu header X-OALPHA (chống giả mạo yêu cầu từ trang lạ)");
    return true;
}

void handleWifiAdd(AsyncWebServerRequest* request) {
    if (blocked(request)) return;
    if (csrfBlocked(request)) return;
    String ssid, pass, connect;
    if (!requireSsid(request, ssid)) return;
    formParam(request, "pass", pass);         // không có = mạng mở
    formParam(request, "connect", connect);
    bool connecting = false;
    switch (WifiMgr::add(ssid, pass, connect == "1", &connecting)) {
        case WifiMgr::ADD_OK:
            break;
        case WifiMgr::ADD_BAD_SSID:
            sendWifiError(request, 400, "Tên mạng phải dài từ 1 đến 32 byte");
            return;
        case WifiMgr::ADD_BAD_PASS:
            sendWifiError(request, 400, "Mật khẩu phải dài 8–63 ký tự hoặc đúng 64 ký tự hex "
                                        "(để trống nếu mạng không đặt mật khẩu)");
            return;
        case WifiMgr::ADD_FULL: {
            char msg[112];
            snprintf(msg, sizeof msg, "Đã lưu đủ %u mạng, hãy xóa bớt một mạng rồi thêm lại",
                     (unsigned)WIFI_MAX_SAVED);
            sendWifiError(request, 507, msg);
            return;
        }
        case WifiMgr::ADD_STORAGE:   // không có gì thay đổi: không lưu, không thử nối
            sendWifiError(request, 500, "Không ghi được vào bộ nhớ trong");
            return;
    }
    request->send(200, JSON_UTF8, connecting ? "{\"ok\":true,\"connecting\":true}"
                                             : "{\"ok\":true,\"connecting\":false}");
}

void handleWifiRemove(AsyncWebServerRequest* request) {
    if (blocked(request)) return;
    if (csrfBlocked(request)) return;
    String ssid;
    if (!requireSsid(request, ssid)) return;
    switch (WifiMgr::remove(ssid)) {
        case WifiMgr::REMOVE_OK:
            break;
        case WifiMgr::REMOVE_NOT_FOUND:
            sendWifiError(request, 404, "Không có mạng này trong danh sách đã lưu");
            return;
        case WifiMgr::REMOVE_STORAGE:   // không có gì thay đổi: mạng vẫn còn
            sendWifiError(request, 500, "Không ghi được vào bộ nhớ trong");
            return;
    }
    request->send(200, JSON_UTF8, "{\"ok\":true}");
}

void handleWifiConnect(AsyncWebServerRequest* request) {
    if (blocked(request)) return;
    if (csrfBlocked(request)) return;
    String ssid;
    if (!requireSsid(request, ssid)) return;
    if (!WifiMgr::connectTo(ssid)) {
        sendWifiError(request, 404, "Không có mạng này trong danh sách đã lưu");
        return;
    }
    request->send(200, JSON_UTF8, "{\"ok\":true}");
}

void handleWifiPortal(AsyncWebServerRequest* request) {
    if (blocked(request)) return;
    if (csrfBlocked(request)) return;
    String on;
    if (!formParam(request, "on", on) || (on != "1" && on != "0")) {
        sendWifiError(request, 400, "Tham số on phải là 1 (bật) hoặc 0 (tắt)");
        return;
    }
    const bool want = on == "1";
    WifiMgr::setPortal(want);   // loop() bật/tắt thật ở vòng kế tiếp
    request->send(200, JSON_UTF8, want ? "{\"ok\":true,\"portal\":true}"
                                       : "{\"ok\":true,\"portal\":false}");
}

}  // namespace

bool begin() {
    // Cổng cấu hình: Host lạ từ phía AP -> về trang cấu hình. PHẢI đứng ĐẦU TIÊN
    // (thư viện chọn handler theo thứ tự đăng ký).
    g_server.addHandler(&g_captive);

    g_ws.onEvent(onWsEvent);
    g_server.addHandler(&g_ws);

    g_server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        // ?tg=<giây>: dashboard đang chạy xin (gia hạn) quyền đọc tin Telegram.
        // Xét SAU kiểm tra mật khẩu để người lạ không "giành" được quyền đọc tin;
        // cấp TRƯỚC khi dựng JSON để telegram.poller trả về phản ánh ngay.
        if (request->hasParam("tg")) {
            const String v = request->getParam("tg")->value();
            Notifier::grantDashboardLease((uint32_t)strtoul(v.c_str(), nullptr, 10));
        }
        // ?zl=<giây>: cũng vậy cho bot Zalo
        if (request->hasParam("zl")) {
            const String v = request->getParam("zl")->value();
            Notifier::grantZaloLease((uint32_t)strtoul(v.c_str(), nullptr, 10));
        }
        request->send(200, "application/json", statusJson());
    });

    g_server.on("/api/events", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        request->send(200, "application/json", EventLog::recentJson());
    });

    g_server.on("/api/export.csv", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        AsyncWebServerResponse* res =
            request->beginResponse(200, "text/csv; charset=utf-8", EventLog::exportCsv());
        res->addHeader("Content-Disposition", "attachment; filename=\"nhat_ky_te_nga.csv\"");
        request->send(res);
    });

    // Chuoi mau dac trung de dashboard thu thap tap du lieu huan luyen.
    // Tham so ?since=<millis cua thiet bi> de chi lay nhung mau moi.
    g_server.on("/api/features", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        uint32_t since = 0;
        if (request->hasParam("since")) {
            since = (uint32_t)strtoul(request->getParam("since")->value().c_str(), nullptr, 10);
        }

        // Moi lan tra toi da MAX_OUT mau; dashboard hoi tiep bang ?since= de lay het.
        constexpr size_t MAX_OUT = 150;
        static Radar::FeatureSample buf[MAX_OUT];
        const size_t n = Radar::copyFeatures(buf, MAX_OUT, since);

        JsonDocument doc;
        doc["now"]   = millis();
        doc["total"] = Radar::featureCount();
        doc["spec"]  = FallModel::FEATURE_SPEC_VERSION;
        doc["window"] = FallModel::WINDOW_SIZE;
        doc["periodMs"] = FEATURE_PERIOD_MS;
        JsonArray arr = doc["samples"].to<JsonArray>();
        for (size_t i = 0; i < n; ++i) {
            JsonArray row = arr.add<JsonArray>();
            row.add(buf[i].t);            // 0 thoi diem (millis cua thiet bi)
            row.add(buf[i].present);      // 1 co nguoi
            row.add(buf[i].movement);     // 2 kieu chuyen dong
            row.add(buf[i].range);        // 3 bien do chuyen dong
            row.add(buf[i].staticStay);   // 4 nam im mot cho
            row.add(buf[i].distanceCm);   // 5 khoang cach
            row.add(buf[i].trackX);       // 6 toa do quy dao x
            row.add(buf[i].trackY);       // 7 toa do quy dao y
        }
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });

    g_server.on("/api/action", HTTP_POST, handleAction);

    // Lời nhắn người nhà: thân là nguyên file WAV, loa đọc khi rảnh (xem onSayBody)
    g_server.on("/api/say", HTTP_POST, onSayRequest, nullptr, onSayBody);

    // ---------------------- QUẢN LÝ ĐA WI-FI (API Wi-Fi v2) ----------------------
    // Các đường dò mạng của điện thoại/máy tính khi đang nối AP cấu hình (Host của
    // chính thiết bị; Host lạ đã bị g_captive bắt) -> chuyển về trang cấu hình.
    static const char* const CAPTIVE_PROBES[] = {
        "/generate_204", "/gen_204",                       // Android / Chrome
        "/hotspot-detect.html", "/library/test/success.html",   // iOS / macOS
        "/connecttest.txt", "/ncsi.txt", "/redirect",     // Windows
        "/fwlink", "/canonical.html", "/success.txt",     // Windows cũ / Firefox / Ubuntu
    };
    for (const char* path : CAPTIVE_PROBES)
        g_server.on(path, HTTP_ANY, redirectToPortal).setFilter(portalSide);

    // Trang chọn mạng nhúng trong firmware: luôn có ở /wifi (kể cả khi chưa uploadfs),
    // và là trang chủ "/" khi truy cập từ phía AP cấu hình. Cả hai PHẢI đăng ký
    // TRƯỚC serveStatic, nếu không "/" sẽ trả index.html.
    g_server.on("/wifi", HTTP_GET, sendPortalPage);
    g_server.on("/", HTTP_GET, sendPortalPage).setFilter(portalSide);

    // Trạng thái đầy đủ của bộ quản lý Wi-Fi.
    g_server.on("/api/wifi/state", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        request->send(200, JSON_UTF8, WifiMgr::stateJson());
    });

    // Mạng xung quanh: trả cache NGAY (không bao giờ chặn); ?fresh=1 xin quét lại.
    g_server.on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        const bool fresh = request->hasParam("fresh") && request->getParam("fresh")->value() == "1";
        request->send(200, JSON_UTF8, WifiMgr::scanJson(fresh));
    });

    // Mạng ĐÃ LƯU kèm kết quả thử gần nhất (KHÔNG BAO GIỜ kèm mật khẩu).
    g_server.on("/api/wifi/list", HTTP_GET, [](AsyncWebServerRequest* request) {
        if (blocked(request)) return;
        request->send(200, JSON_UTF8, WifiMgr::listJson());
    });

    // Chỉ POST (form): bản cũ có thêm GET nên mật khẩu lộ trên URL và trang lạ có
    // thể đổi Wi-Fi của thiết bị chỉ bằng một thẻ <img>. Thêm nữa phải có header
    // "X-OALPHA: 1" (thiếu -> 403), để form tự submit từ trang lạ cũng bị chặn.
    g_server.on("/api/wifi/add",     HTTP_POST, handleWifiAdd);
    g_server.on("/api/wifi/remove",  HTTP_POST, handleWifiRemove);
    g_server.on("/api/wifi/connect", HTTP_POST, handleWifiConnect);
    g_server.on("/api/wifi/portal",  HTTP_POST, handleWifiPortal);

    // Trang tĩnh trong LittleFS (data/index.html)
    auto& stat = g_server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
    if (authEnabled()) stat.setAuthentication(WEB_USER, WEB_PASS);

    g_server.onNotFound([](AsyncWebServerRequest* request) {
        // Từ phía AP cấu hình: mọi đường lạ đều dẫn về trang chọn mạng.
        if (portalSide(request)) { redirectToPortal(request); return; }
        if (!LittleFS.exists("/index.html")) {
            request->send(200, "text/html; charset=utf-8", NO_UI_HTML);
            return;
        }
        request->send(404, "text/plain; charset=utf-8", "Không tìm thấy");
    });

    g_server.begin();
    // Lúc này Wi-Fi thường chưa nối xong (WifiMgr nối dần trong loop()) nên không in IP.
    Serial.printf("[WEB] May chu web: http://%s.local/  |  cau hinh Wi-Fi: http://%s.local/wifi"
                  "  (qua AP cau hinh: http://192.168.4.1/)\n", HOSTNAME, HOSTNAME);
    return true;
}

void loop() {
    g_ws.cleanupClients();
    if (g_ws.count() == 0) return;
    if (millis() < g_nextPush) return;
    g_nextPush = millis() + 1000;
    g_ws.textAll(statusJson());
}

void pushNow() {
    if (g_ws.count() == 0) return;
    g_ws.textAll(statusJson());
    g_ws.textAll(String("{\"events\":") + EventLog::recentJson() + "}");
    g_nextPush = millis() + 1000;
}

uint32_t clientCount() { return g_ws.count(); }

}  // namespace WebUi
