/**
 * @file  assistant.cpp
 * @brief Trợ lý hội thoại kiểu "Xiaozhi" — xem mô tả đầy đủ trong assistant.h.
 *
 *  Toàn bộ một lượt nói (ghi âm -> upload -> phát trả lời) chạy trong MỘT task
 *  riêng ghim vào core 1, ưu tiên THẤP hơn task âm thanh và máy trạng thái, nên
 *  không bao giờ cạnh tranh làm trễ radar hay nút bấm. loop() chính chỉ việc
 *  gọi startListening() khi người dùng kích hoạt; mọi việc nặng nằm trong task.
 */
#include "assistant.h"
#include "config.h"
#include "audio.h"

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

namespace Assistant {

namespace {

// --- Thông số ghi âm (khớp hợp đồng API: WAV PCM 16-bit mono 16000 Hz) ---
constexpr i2s_port_t MIC_PORT     = I2S_NUM_1;   // RIÊNG, loa dùng I2S_NUM_0
constexpr uint32_t   MIC_RATE     = 16000;       // 16 kHz
constexpr uint16_t   MIC_BITS     = 16;          // PCM 16-bit sau khi lấy 16 bit cao
constexpr uint16_t   MIC_CHANNELS = 1;           // mono
constexpr size_t     I2S_CHUNK    = 512;         // số mẫu 32-bit đọc mỗi lượt

// Kích thước bộ đệm ghi âm tối đa = thời lượng tối đa * tần số * 2 byte/mẫu.
constexpr size_t REC_MAX_BYTES = (size_t)ASSISTANT_MAX_REC_S * MIC_RATE * 2;

// Trạng thái chung (task đọc/ghi, nhưng chỉ task trợ lý mới đổi khi đang chạy).
volatile State g_state     = AS_DISABLED;
bool           g_enabled   = false;
bool           g_micOk     = false;

TaskHandle_t      g_task   = nullptr;
SemaphoreHandle_t g_trigger = nullptr;   // "đèn báo" kích hoạt một lượt nói
volatile bool     g_busy   = false;      // đang xử lý một lượt

// Bộ đệm PCM 16-bit cho một lượt ghi âm (cấp phát trong PSRAM 8 MB).
int16_t* g_pcm      = nullptr;   // con trỏ tới REC_MAX_BYTES byte
size_t   g_pcmCap   = 0;         // số MẪU chứa được

// ------------------------- Cài / gỡ driver mic I2S -------------------------

/// Cài driver I2S RX cho mic INMP441 trên cổng I2S_NUM_1. Trả false nếu lỗi.
bool installMic() {
    i2s_config_t cfg = {};
    cfg.mode            = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
    cfg.sample_rate     = MIC_RATE;
    // INMP441 xuất 24-bit trong khung 32-bit; đọc 32-bit rồi tự lấy 16 bit cao.
    cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
    // INMP441 nối L/R -> GND nên nói ở KÊNH TRÁI. Dùng ONLY_LEFT để chỉ lấy
    // kênh trái, tránh xen lẫn khung rỗng của kênh phải.
    cfg.channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1;
    cfg.dma_buf_count        = 6;
    cfg.dma_buf_len          = 256;
    cfg.use_apll             = false;
    cfg.tx_desc_auto_clear   = false;
    cfg.fixed_mclk           = 0;

    if (i2s_driver_install(MIC_PORT, &cfg, 0, nullptr) != ESP_OK) {
        Serial.println("[TRO LY] LOI: khong cai duoc driver I2S cho mic");
        return false;
    }

    i2s_pin_config_t pins = {};
    pins.mck_io_num   = I2S_PIN_NO_CHANGE;
    pins.bck_io_num   = PIN_MIC_SCK;        // BCLK của mic
    pins.ws_io_num    = PIN_MIC_WS;         // WS/LRCL của mic
    pins.data_out_num = I2S_PIN_NO_CHANGE;  // mic chỉ VÀO, không ra
    pins.data_in_num  = PIN_MIC_SD;         // DOUT của mic -> ESP32

    if (i2s_set_pin(MIC_PORT, &pins) != ESP_OK) {
        Serial.println("[TRO LY] LOI: khong gan duoc chan I2S cho mic");
        i2s_driver_uninstall(MIC_PORT);
        return false;
    }
    return true;
}

// ------------------------------ Ghi âm mic ---------------------------------

/**
 * Ghi âm từ mic vào g_pcm tối đa ASSISTANT_MAX_REC_S giây.
 * @return số MẪU 16-bit đã ghi được (0 nếu lỗi).
 */
size_t recordOnce() {
    if (!g_micOk || g_pcm == nullptr) return 0;

    i2s_zero_dma_buffer(MIC_PORT);
    i2s_start(MIC_PORT);

    static int32_t raw[I2S_CHUNK];   // khung 32-bit thô từ INMP441
    size_t total = 0;                // số mẫu 16-bit đã lưu
    const uint32_t t0 = millis();
    const uint32_t limitMs = ASSISTANT_MAX_REC_S * 1000UL;

    while (total < g_pcmCap && (millis() - t0) < limitMs) {
        size_t bytesRead = 0;
        const esp_err_t e = i2s_read(MIC_PORT, raw, sizeof(raw), &bytesRead,
                                     pdMS_TO_TICKS(200));
        if (e != ESP_OK || bytesRead == 0) continue;

        const size_t got = bytesRead / sizeof(int32_t);
        for (size_t i = 0; i < got && total < g_pcmCap; ++i) {
            // Lấy 16 BIT CAO của mẫu 24-bit-trong-32-bit (chuẩn I2S Philips).
            g_pcm[total++] = (int16_t)(raw[i] >> 16);
        }
    }

    i2s_stop(MIC_PORT);
    Serial.printf("[TRO LY] Ghi am %u mau (~%.1f giay)\n",
                  (unsigned)total, total / (float)MIC_RATE);
    return total;
}

// --------------------------- Header WAV 44 byte ----------------------------

/// Ghi 44 byte header WAV PCM 16-bit mono vào buf cho dataBytes byte dữ liệu.
void writeWavHeader(uint8_t* buf, uint32_t dataBytes) {
    const uint32_t sampleRate = MIC_RATE;
    const uint16_t channels   = MIC_CHANNELS;
    const uint16_t bits       = MIC_BITS;
    const uint32_t byteRate   = sampleRate * channels * (bits / 8);
    const uint16_t blockAlign = channels * (bits / 8);
    const uint32_t riffSize   = 36 + dataBytes;

    auto put32 = [&](size_t o, uint32_t v) {
        buf[o] = v & 0xFF; buf[o + 1] = (v >> 8) & 0xFF;
        buf[o + 2] = (v >> 16) & 0xFF; buf[o + 3] = (v >> 24) & 0xFF;
    };
    auto put16 = [&](size_t o, uint16_t v) {
        buf[o] = v & 0xFF; buf[o + 1] = (v >> 8) & 0xFF;
    };

    memcpy(buf + 0,  "RIFF", 4);
    put32(4, riffSize);
    memcpy(buf + 8,  "WAVE", 4);
    memcpy(buf + 12, "fmt ", 4);
    put32(16, 16);            // kích thước khối fmt
    put16(20, 1);             // PCM không nén
    put16(22, channels);
    put32(24, sampleRate);
    put32(28, byteRate);
    put16(32, blockAlign);
    put16(34, bits);
    memcpy(buf + 36, "data", 4);
    put32(40, dataBytes);
}

// --------------- Gửi WAV lên /api/assistant (multipart) --------------------

/**
 * Upload bộ đệm PCM (đã ghi âm) dưới dạng WAV qua multipart/form-data, field
 * "audio". Phân tích JSON trả về và lấy "reply" vào out.
 * @return true nếu nhận được câu trả lời; false nếu lỗi mạng/server.
 */
bool uploadAndGetReply(size_t samples, String& heardOut, String& replyOut) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[TRO LY] Chua co Wi-Fi -> khong gui duoc");
        return false;
    }

    const uint32_t dataBytes = (uint32_t)samples * 2;   // 16-bit = 2 byte/mẫu

    // Dựng phần đầu/đuôi của multipart. Thân là: header WAV (44B) + PCM.
    const String boundary = "----troLyBoundary7MA4YWxkTrZu0gW";
    String head;
    head.reserve(200);
    head += "--"; head += boundary; head += "\r\n";
    head += "Content-Disposition: form-data; name=\"audio\"; filename=\"rec.wav\"\r\n";
    head += "Content-Type: audio/wav\r\n\r\n";
    const String tail = String("\r\n--") + boundary + "--\r\n";

    uint8_t wavHdr[44];
    writeWavHeader(wavHdr, dataBytes);

    const size_t bodyLen = head.length() + sizeof(wavHdr) + dataBytes + tail.length();

    const String url = String(ASSISTANT_SERVER) + "/api/assistant";

    // Dùng WiFiClient trần để tự đẩy thân theo từng mảnh (không dựng cả body
    // trong RAM). HTTPClient của Arduino không tiện gửi body cực lớn từng mảnh,
    // nên ở đây viết HTTP/1.1 thủ công — vẫn gọn và đủ dùng trong mạng LAN.
    //
    // Tách host/port/path từ ASSISTANT_SERVER (dạng http://IP:PORT).
    String host; uint16_t port = 80; String path = "/api/assistant";
    {
        String s = ASSISTANT_SERVER;
        int p = s.indexOf("://");
        if (p >= 0) s = s.substring(p + 3);
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);   // bỏ path nếu có
        int colon = s.indexOf(':');
        if (colon >= 0) {
            host = s.substring(0, colon);
            port = (uint16_t)s.substring(colon + 1).toInt();
        } else {
            host = s;
            port = 80;
        }
    }
    if (host.length() == 0) { Serial.println("[TRO LY] ASSISTANT_SERVER sai dinh dang"); return false; }

    WiFiClient client;
    client.setTimeout(10000);
    if (!client.connect(host.c_str(), port)) {
        Serial.printf("[TRO LY] Khong ket noi duoc %s:%u\n", host.c_str(), port);
        return false;
    }

    // --- Dòng yêu cầu + header ---
    client.printf("POST %s HTTP/1.1\r\n", path.c_str());
    client.printf("Host: %s:%u\r\n", host.c_str(), port);
    client.print("Connection: close\r\n");
    client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str());
    client.printf("Content-Length: %u\r\n\r\n", (unsigned)bodyLen);

    // --- Thân: phần mở đầu multipart + header WAV + PCM theo mảnh + đuôi ---
    client.print(head);
    client.write(wavHdr, sizeof(wavHdr));
    {
        const uint8_t* pcm = (const uint8_t*)g_pcm;
        size_t remain = dataBytes;
        while (remain > 0) {
            const size_t n = remain < 1024 ? remain : 1024;
            if (client.write(pcm, n) != n) { client.stop(); 
                Serial.println("[TRO LY] Loi khi gui du lieu am thanh"); return false; }
            pcm += n; remain -= n;
        }
    }
    client.print(tail);

    // --- Đọc dòng trạng thái HTTP ---
    const uint32_t t0 = millis();
    while (!client.available() && client.connected() && millis() - t0 < 15000) delay(5);

    String statusLine = client.readStringUntil('\n');
    int httpCode = 0;
    {
        int sp1 = statusLine.indexOf(' ');
        if (sp1 >= 0) httpCode = statusLine.substring(sp1 + 1).toInt();
    }

    // Bỏ qua các header tới dòng trống; đọc Content-Length nếu có.
    while (client.connected() || client.available()) {
        String line = client.readStringUntil('\n');
        if (line == "\r" || line.length() == 0) break;
    }

    // Đọc toàn bộ phần thân (JSON ngắn).
    String body;
    body.reserve(256);
    while ((client.connected() || client.available()) && body.length() < 4096) {
        if (client.available()) body += (char)client.read();
        else delay(2);
        if (!client.connected() && !client.available()) break;
    }
    client.stop();

    Serial.printf("[TRO LY] /api/assistant HTTP %d\n", httpCode);
    if (httpCode != 200) {
        Serial.printf("[TRO LY] Server tra loi loi: %s\n", body.c_str());
        return false;
    }

    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, body);
    if (err) {
        Serial.printf("[TRO LY] JSON loi: %s\n", err.c_str());
        return false;
    }
    heardOut = doc["heard"] | "";
    replyOut = doc["reply"] | "";
    if (replyOut.length() == 0) {
        Serial.println("[TRO LY] Khong co 'reply' trong phan hoi");
        return false;
    }
    return true;
}

// ------------------------- URL-encode cho /api/tts -------------------------

/// Mã hóa URL (percent-encoding) cho phần text đưa vào query string.
String urlEncode(const String& s) {
    String out;
    out.reserve(s.length() * 3);
    const char* hex = "0123456789ABCDEF";
    for (size_t i = 0; i < s.length(); ++i) {
        const uint8_t c = (uint8_t)s[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0x0F];
        }
    }
    return out;
}

// --------------------------- Một lượt nói hoàn chỉnh ------------------------

void runOneTurn() {
    g_busy = true;

    // 1) Ghi âm
    g_state = AS_LISTENING;
    Serial.println("[TRO LY] Bat dau nghe...");
    const size_t samples = recordOnce();
    if (samples < MIC_RATE / 4) {   // dưới ~0,25 giây coi như hỏng/ngắn quá
        Serial.println("[TRO LY] Ghi am qua ngan hoac that bai");
        Audio::playBeeps(2, 440, 150);
        g_state = AS_IDLE;
        g_busy  = false;
        return;
    }

    // 2) Gửi lên dashboard, nhận câu trả lời
    g_state = AS_THINKING;
    Serial.println("[TRO LY] Gui len dashboard, cho tra loi...");
    String heard, reply;
    if (!uploadAndGetReply(samples, heard, reply)) {
        Serial.println("[TRO LY] That bai khi xin tra loi -> bip 2 tieng");
        Audio::playBeeps(2, 440, 150);
        g_state = AS_IDLE;
        g_busy  = false;
        return;
    }
    Serial.printf("[TRO LY] Nghe duoc: \"%s\"\n", heard.c_str());
    Serial.printf("[TRO LY] Tra loi : \"%s\"\n", reply.c_str());

    // 3) Phát câu trả lời (TTS dạng MP3 từ /api/tts)
    g_state = AS_SPEAKING;
    const String ttsUrl = String(ASSISTANT_SERVER) + "/api/tts?text=" + urlEncode(reply);
    const bool spoke = Audio::playMp3Url(ttsUrl.c_str());
    if (!spoke) {
        // FALLBACK: không phát được giọng (loa bận, lỗi giải mã, hoặc mạng).
        // Vẫn báo cho người dùng biết "đã có trả lời" bằng 1 tiếng bíp + in Serial.
        // TODO (nang cap sau): neu MP3 hay gap van de, co the doi /api/tts sang
        // tra ve WAV PCM 16-bit mono 16000 Hz roi dung lai duong phat WAV san co.
        Serial.println("[TRO LY] Khong phat duoc giong -> bip 1 tieng bao da co tra loi");
        Audio::playBeeps(1, 1200, 200);
    }

    g_state = AS_IDLE;
    g_busy  = false;
}

// -------------------------------- Task chính -------------------------------

void assistantTask(void*) {
    for (;;) {
        // Chờ tín hiệu kích hoạt (giữ nút xanh / web action). Không tốn CPU.
        if (xSemaphoreTake(g_trigger, portMAX_DELAY) == pdTRUE) {
            runOneTurn();
        }
    }
}

}  // namespace

// =============================== API công khai =============================

void begin() {
    // Điều kiện bật: phải có địa chỉ dashboard VÀ có gắn mic.
    const bool hasServer = (strlen(ASSISTANT_SERVER) > 0);
    const bool hasMic    = (PIN_MIC_SD >= 0);

    if (!hasServer || !hasMic) {
        g_enabled = false;
        g_state   = AS_DISABLED;
        Serial.printf("[TRO LY] tro ly tat (%s%s)\n",
                      hasServer ? "" : "chua dat ASSISTANT_SERVER",
                      hasMic ? "" : (hasServer ? "khong gan mic" : ", khong gan mic"));
        return;
    }

    // Cấp bộ đệm ghi âm trong PSRAM (board N16R8 có 8 MB). Nếu không có PSRAM
    // thì thử heap thường; thiếu RAM thì tắt trợ lý cho an toàn.
    g_pcm = (int16_t*)ps_malloc(REC_MAX_BYTES);
    if (g_pcm == nullptr) g_pcm = (int16_t*)malloc(REC_MAX_BYTES);
    if (g_pcm == nullptr) {
        Serial.println("[TRO LY] tro ly tat (thieu RAM cho bo dem ghi am)");
        g_enabled = false;
        g_state   = AS_DISABLED;
        return;
    }
    g_pcmCap = REC_MAX_BYTES / 2;   // số mẫu 16-bit

    g_micOk = installMic();
    if (!g_micOk) {
        Serial.println("[TRO LY] tro ly tat (khong cai duoc mic I2S)");
        free(g_pcm); g_pcm = nullptr;
        g_enabled = false;
        g_state   = AS_DISABLED;
        return;
    }

    g_trigger = xSemaphoreCreateBinary();
    if (!g_trigger) {
        Serial.println("[TRO LY] tro ly tat (khong tao duoc semaphore)");
        g_enabled = false; g_state = AS_DISABLED; return;
    }

    // Task ghim core 1, ưu tiên 2 (THẤP hơn audio=3): trợ lý không được tranh
    // CPU với âm thanh cảnh báo hay máy trạng thái. Stack 8 KB đủ cho HTTP+JSON.
    xTaskCreatePinnedToCore(assistantTask, "assistant", 8192, nullptr, 2, &g_task, 1);

    g_enabled = true;
    g_state   = AS_IDLE;
    Serial.printf("[TRO LY] San sang. Server=%s, mic SD=GPIO%d, toi da %lus/luot\n",
                  ASSISTANT_SERVER, PIN_MIC_SD, (unsigned long)ASSISTANT_MAX_REC_S);
}

void loop() {
    // Mọi việc nặng nằm trong task riêng; loop() không cần làm gì. Để trống cho
    // rõ ý: trợ lý KHÔNG bao giờ chặn vòng loop() chính.
}

bool isEnabled() { return g_enabled; }

void startListening() {
    if (!g_enabled) return;
    if (g_busy) {
        Serial.println("[TRO LY] Dang ban mot luot, bo qua yeu cau moi");
        return;
    }
    // Đánh thức task xử lý. Nếu semaphore đã có sẵn tín hiệu thì give() vẫn an
    // toàn (không xếp chồng vì là binary semaphore).
    xSemaphoreGive(g_trigger);
}

State state()   { return g_state; }
bool  isBusy()  { return g_busy; }

}  // namespace Assistant
