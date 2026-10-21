#include "audio.h"
#include "config.h"
#include <LittleFS.h>
#include <driver/i2s.h>
#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

// --- Giải mã MP3 cho câu trả lời TTS của trợ lý hội thoại (xem playMp3Url) ---
// Chỉ dùng bộ GIẢI MÃ + nguồn HTTP của ESP8266Audio; phần ghi ra loa tự viết để
// dùng chung driver I2S_NUM_0 đã cài ở begin() (không cài driver thứ hai).
#include <AudioGeneratorMP3.h>
#include <AudioFileSourceHTTPStream.h>
#include <AudioFileSourceBuffer.h>
#include <AudioOutput.h>

namespace Audio {

namespace {

constexpr i2s_port_t I2S_PORT     = I2S_NUM_0;
constexpr uint32_t   DEFAULT_RATE = 16000;
constexpr size_t     FRAMES       = 256;   // số mẫu xử lý mỗi lượt

TaskHandle_t  g_task     = nullptr;
QueueHandle_t g_queue    = nullptr;        // hàng đợi yêu cầu phát
volatile bool g_playing  = false;
volatile bool g_stopReq  = false;
bool          g_driverOk = false;

struct PlayRequest {
    char     path[32];
    uint8_t  beeps;    // > 0 nghĩa là phát bíp thay vì phát file
    uint16_t freqHz;
    uint16_t onMs;
};

/// Nhân âm lượng, có chặn tràn số (clipping)
inline int16_t applyVolume(int16_t sample) {
    int32_t v = ((int32_t)sample * (int32_t)AUDIO_VOLUME_PERCENT) / 100;
    if (v > 32767)  v = 32767;
    if (v < -32768) v = -32768;
    return (int16_t)v;
}

bool installDriver() {
    i2s_config_t cfg = {};
    cfg.mode            = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    cfg.sample_rate     = DEFAULT_RATE;
    cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    // Luôn chạy stereo rồi tự nhân đôi mẫu mono trong code: cách này tránh được
    // các khác biệt khó lường của chế độ mono trên driver I2S.
    cfg.channel_format       = I2S_CHANNEL_FMT_RIGHT_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1;
    cfg.dma_buf_count        = 8;
    cfg.dma_buf_len          = 256;
    cfg.use_apll             = false;
    cfg.tx_desc_auto_clear   = true;
    cfg.fixed_mclk           = 0;

    if (i2s_driver_install(I2S_PORT, &cfg, 0, nullptr) != ESP_OK) {
        Serial.println("[AUDIO] LOI: khong cai duoc driver I2S");
        return false;
    }

    i2s_pin_config_t pins = {};
    pins.mck_io_num   = I2S_PIN_NO_CHANGE;   // MAX98357A khong can MCLK
    pins.bck_io_num   = PIN_I2S_BCLK;
    pins.ws_io_num    = PIN_I2S_LRC;
    pins.data_out_num = PIN_I2S_DIN;
    pins.data_in_num  = I2S_PIN_NO_CHANGE;

    if (i2s_set_pin(I2S_PORT, &pins) != ESP_OK) {
        Serial.println("[AUDIO] LOI: khong gan duoc chan I2S");
        return false;
    }
    i2s_zero_dma_buffer(I2S_PORT);
    return true;
}

/// Thông tin lấy từ header WAV
struct WavInfo {
    uint32_t sampleRate = 0;
    uint16_t channels   = 0;
    uint16_t bits       = 0;
    uint32_t dataBytes  = 0;
};

/// Đọc header WAV và đặt con trỏ file vào đầu khối dữ liệu âm thanh.
/// Duyệt lần lượt từng chunk nên vẫn đọc được file có thêm chunk LIST/fact.
bool parseWavHeader(File& f, WavInfo& info) {
    char riff[12];
    if (f.read((uint8_t*)riff, 12) != 12) return false;
    if (memcmp(riff, "RIFF", 4) != 0 || memcmp(riff + 8, "WAVE", 4) != 0) {
        Serial.println("[AUDIO] File khong phai dinh dang WAV");
        return false;
    }

    bool haveFmt = false;
    while (f.available() >= 8) {
        char     id[4];
        uint32_t size = 0;
        if (f.read((uint8_t*)id, 4) != 4) return false;
        if (f.read((uint8_t*)&size, 4) != 4) return false;

        if (memcmp(id, "fmt ", 4) == 0) {
            uint8_t fmt[16] = {0};
            const uint32_t want = size < sizeof(fmt) ? size : sizeof(fmt);
            if (f.read(fmt, want) != (int)want) return false;
            const uint16_t audioFormat = fmt[0] | (fmt[1] << 8);
            info.channels   = fmt[2] | (fmt[3] << 8);
            info.sampleRate = (uint32_t)fmt[4] | ((uint32_t)fmt[5] << 8) |
                              ((uint32_t)fmt[6] << 16) | ((uint32_t)fmt[7] << 24);
            info.bits = fmt[14] | (fmt[15] << 8);
            if (audioFormat != 1) {
                Serial.printf("[AUDIO] WAV bi nen (format=%u), can WAV PCM\n", audioFormat);
                return false;
            }
            if (size > want) f.seek(f.position() + (size - want));
            haveFmt = true;
        } else if (memcmp(id, "data", 4) == 0) {
            info.dataBytes = size;
            return haveFmt && info.bits == 16 && info.channels >= 1 && info.channels <= 2;
        } else {
            f.seek(f.position() + size + (size & 1));  // chunk luon chan byte
        }
    }
    return false;
}

void playBeepsBlocking(uint8_t count, uint16_t freqHz, uint16_t onMs);

void playFile(const char* path) {
    File f = LittleFS.open(path, "r");
    if (!f) {
        Serial.printf("[AUDIO] Khong mo duoc %s -> phat bip thay the\n", path);
        playBeepsBlocking(3, 880, 180);
        return;
    }

    WavInfo info;
    if (!parseWavHeader(f, info)) {
        Serial.printf("[AUDIO] Header WAV khong hop le (%s). Can WAV PCM 16-bit.\n", path);
        f.close();
        playBeepsBlocking(3, 880, 180);
        return;
    }

    Serial.printf("[AUDIO] Phat %s - %lu Hz, %u kenh, %lu byte\n", path,
                  (unsigned long)info.sampleRate, info.channels,
                  (unsigned long)info.dataBytes);

    i2s_set_clk(I2S_PORT, info.sampleRate, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
    i2s_start(I2S_PORT);

    static int16_t in[FRAMES * 2];    // đệm đọc từ file
    static int16_t out[FRAMES * 2];   // đệm ghi ra I2S (luôn stereo)
    uint32_t remain = info.dataBytes;

    while (remain > 0 && !g_stopReq) {
        const size_t want = (info.channels == 1) ? FRAMES * sizeof(int16_t)
                                                 : FRAMES * 2 * sizeof(int16_t);
        const size_t toRead = remain < want ? remain : want;
        const int    got    = f.read((uint8_t*)in, toRead);
        if (got <= 0) break;
        remain -= got;

        const size_t samples  = got / sizeof(int16_t);
        size_t       outCount = 0;
        if (info.channels == 1) {
            for (size_t i = 0; i < samples; ++i) {   // mono -> nhân đôi ra 2 kênh
                const int16_t s = applyVolume(in[i]);
                out[outCount++] = s;
                out[outCount++] = s;
            }
        } else {
            for (size_t i = 0; i < samples; ++i) out[outCount++] = applyVolume(in[i]);
        }

        size_t written = 0;
        i2s_write(I2S_PORT, out, outCount * sizeof(int16_t), &written, portMAX_DELAY);
    }

    f.close();
    i2s_zero_dma_buffer(I2S_PORT);
    i2s_stop(I2S_PORT);
}

void playBeepsBlocking(uint8_t count, uint16_t freqHz, uint16_t onMs) {
    i2s_set_clk(I2S_PORT, DEFAULT_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
    i2s_start(I2S_PORT);

    static int16_t buf[FRAMES * 2];
    const float    step  = 2.0f * (float)PI * (float)freqHz / (float)DEFAULT_RATE;
    float          phase = 0.0f;

    for (uint8_t b = 0; b < count && !g_stopReq; ++b) {
        // Phần có tiếng
        uint32_t frames = (uint32_t)DEFAULT_RATE * onMs / 1000;
        while (frames > 0 && !g_stopReq) {
            const uint32_t n = frames < FRAMES ? frames : FRAMES;
            for (uint32_t i = 0; i < n; ++i) {
                const int16_t s = applyVolume((int16_t)(sinf(phase) * 9000.0f));
                buf[i * 2]     = s;
                buf[i * 2 + 1] = s;
                phase += step;
                if (phase > 2.0f * (float)PI) phase -= 2.0f * (float)PI;
            }
            size_t written = 0;
            i2s_write(I2S_PORT, buf, n * 2 * sizeof(int16_t), &written, portMAX_DELAY);
            frames -= n;
        }
        // Khoảng lặng giữa hai tiếng bíp
        memset(buf, 0, sizeof(buf));
        uint32_t silence = (uint32_t)DEFAULT_RATE * 120 / 1000;
        while (silence > 0 && !g_stopReq) {
            const uint32_t n       = silence < FRAMES ? silence : FRAMES;
            size_t         written = 0;
            i2s_write(I2S_PORT, buf, n * 2 * sizeof(int16_t), &written, portMAX_DELAY);
            silence -= n;
        }
    }

    i2s_zero_dma_buffer(I2S_PORT);
    i2s_stop(I2S_PORT);
}

/**
 * AudioOutput tùy biến: nhận mẫu PCM 16-bit từ bộ giải mã MP3 của ESP8266Audio
 * rồi ghi thẳng ra driver I2S_NUM_0 SẴN CÓ (do installDriver() cài). Nhờ vậy
 * không phải cài driver I2S thứ hai -> không xung đột với lúc phát WAV cảnh báo.
 *
 * Bộ giải mã có thể đẩy mono hoặc stereo; ta luôn nhân đôi ra 2 kênh cho khớp
 * với cấu hình RIGHT_LEFT của driver, giống hệt cách playFile() làm.
 */
class I2sSharedOutput : public AudioOutput {
public:
    bool begin() override { return true; }

    bool ConsumeSample(int16_t sample[2]) override {
        // Mỗi lần nhận 1 khung (trái/phải). Với nguồn mono, thư viện tự đặt
        // sample[0] == sample[1]. Áp âm lượng phần mềm giống phát WAV.
        int16_t out[2];
        out[0] = applyVolume(sample[0]);
        out[1] = applyVolume(sample[1]);
        size_t written = 0;
        // Chờ tối đa 100 ms để có chỗ trong DMA; tránh chặn vô hạn nếu bị dừng.
        const esp_err_t e = i2s_write(I2S_PORT, out, sizeof(out), &written,
                                      pdMS_TO_TICKS(100));
        return e == ESP_OK && written == sizeof(out);
    }

    bool SetRate(int hz) override {
        if (hz > 0 && (uint32_t)hz != curRate_) {
            curRate_ = (uint32_t)hz;
            i2s_set_clk(I2S_PORT, curRate_, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
        }
        return AudioOutput::SetRate(hz);
    }
    bool SetBitsPerSample(int) override { return true; }   // luôn xử lý ở 16-bit
    bool SetChannels(int) override { return true; }        // luôn xuất stereo
    bool stop() override { return true; }

private:
    uint32_t curRate_ = 0;
};

void audioTask(void*) {
    PlayRequest req;
    for (;;) {
        if (xQueueReceive(g_queue, &req, portMAX_DELAY) == pdTRUE) {
            g_playing = true;
            g_stopReq = false;
            if (req.beeps > 0) playBeepsBlocking(req.beeps, req.freqHz, req.onMs);
            else               playFile(req.path);
            g_stopReq = false;
            g_playing = false;
        }
    }
}

}  // namespace

bool begin() {
    g_driverOk = installDriver();
    if (!g_driverOk) return false;
    g_queue = xQueueCreate(3, sizeof(PlayRequest));
    if (!g_queue) return false;
    // Task phát âm thanh ghim vào core 1 (cùng core với loop), ưu tiên vừa phải
    xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 3, &g_task, 1);
    Serial.println("[AUDIO] San sang (I2S + MAX98357A)");
    return true;
}

bool play(const char* path, bool interrupt) {
    if (!g_driverOk || !g_queue) return false;
    if (g_playing) {
        if (!interrupt) return false;      // đang phát thì bỏ qua yêu cầu mới
        // Cắt bản đang phát rồi vẫn xếp bản mới vào hàng đợi. Task phát sẽ tự
        // xóa cờ dừng trước khi lấy bản tiếp theo, nên bản mới không bị cắt oan.
        g_stopReq = true;
    }
    PlayRequest req = {};
    strlcpy(req.path, path, sizeof(req.path));
    req.beeps = 0;
    return xQueueSend(g_queue, &req, 0) == pdTRUE;
}

bool playBeeps(uint8_t count, uint16_t freqHz, uint16_t onMs) {
    if (!g_driverOk || !g_queue) return false;
    // Nếu được gọi từ chính task audio thì phát ngay, không đẩy vào hàng đợi
    if (xTaskGetCurrentTaskHandle() == g_task) {
        playBeepsBlocking(count, freqHz, onMs);
        return true;
    }
    if (g_playing) return false;
    PlayRequest req = {};
    req.beeps  = count;
    req.freqHz = freqHz;
    req.onMs   = onMs;
    return xQueueSend(g_queue, &req, 0) == pdTRUE;
}

void stop() { g_stopReq = true; }

bool isPlaying() { return g_playing; }

bool playMp3Url(const char* url) {
    if (!g_driverOk || url == nullptr || url[0] == '\0') return false;
    // Loa chỉ có một đường I2S; nếu đang bận phát WAV/bíp thì không chen vào.
    if (g_playing) {
        Serial.println("[AUDIO] Dang ban, bo qua yeu cau phat MP3");
        return false;
    }

    g_playing = true;
    g_stopReq = false;

    // Nguồn HTTP -> đệm -> bộ giải mã MP3 -> ghi ra loa qua driver I2S sẵn có.
    AudioFileSourceHTTPStream* src = nullptr;
    AudioFileSourceBuffer*     buf = nullptr;
    AudioGeneratorMP3*         mp3 = nullptr;
    I2sSharedOutput            out;
    bool decodedSomething = false;

    src = new AudioFileSourceHTTPStream(url);
    if (!src) { g_playing = false; return false; }
    // Đệm 8 KB trong PSRAM giúp phát mượt khi mạng LAN giật nhẹ.
    buf = new AudioFileSourceBuffer(src, 8 * 1024);
    mp3 = new AudioGeneratorMP3();

    i2s_start(I2S_PORT);
    Serial.printf("[AUDIO] Giai ma MP3 tu %s\n", url);

    if (buf && mp3 && mp3->begin(buf, &out)) {
        const uint32_t t0 = millis();
        while (mp3->isRunning() && !g_stopReq) {
            if (!mp3->loop()) break;          // hết dữ liệu hoặc lỗi giải mã
            decodedSomething = true;
            // Chốt an toàn: không để một lượt phát kéo dài quá mức hợp lý.
            if (millis() - t0 > (ASSISTANT_MAX_REC_S + 20) * 1000UL) {
                Serial.println("[AUDIO] MP3 qua dai -> dung");
                break;
            }
        }
        mp3->stop();
    } else {
        Serial.println("[AUDIO] LOI: khong bat dau giai ma duoc MP3");
    }

    // Dọn dẹp theo đúng thứ tự (generator -> buffer -> source).
    if (mp3) delete mp3;
    if (buf) delete buf;
    if (src) delete src;

    i2s_zero_dma_buffer(I2S_PORT);
    i2s_stop(I2S_PORT);
    g_stopReq = false;
    g_playing = false;
    return decodedSomething;
}

}  // namespace Audio
