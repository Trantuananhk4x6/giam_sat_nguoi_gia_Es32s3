#include "event_log.h"
#include "config.h"
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <deque>

namespace EventLog {

namespace {
std::deque<LogEntry> g_ram;
SemaphoreHandle_t    g_mutex = nullptr;
uint32_t             g_nextId = 1;
Stats                g_stats;
bool                 g_fsReady = false;

struct Lock {
    Lock()  { if (g_mutex) xSemaphoreTake(g_mutex, portMAX_DELAY); }
    ~Lock() { if (g_mutex) xSemaphoreGive(g_mutex); }
};

void entryToJson(const LogEntry& e, JsonObject o) {
    o["id"]     = e.id;
    o["ts"]     = (uint32_t)e.ts;
    o["uptime"] = e.uptimeMs / 1000;
    o["type"]   = eventCode(e.type);
    o["label"]  = eventLabelVi(e.type);
    o["src"]    = sourceCode(e.source);
    o["state"]  = stateName(e.state);
    o["note"]   = e.note;
}

EventSource parseSource(const char* s) {
    if (!s || !s[0]) return SRC_SYSTEM;
    for (uint8_t i = 0; i <= SRC_SYSTEM; ++i) {
        if (strcmp(s, sourceCode((EventSource)i)) == 0) return (EventSource)i;
    }
    return SRC_SYSTEM;
}

SysState parseState(const char* s) {
    if (!s || !s[0]) return ST_BOOT;
    for (uint8_t i = 0; i <= ST_EMERGENCY; ++i) {
        if (strcmp(s, stateName((SysState)i)) == 0) return (SysState)i;
    }
    return ST_BOOT;
}

/// Đọc ngược file để nạp các dòng cuối vào RAM khi mới bật nguồn.
void loadTail() {
    if (!LittleFS.exists(LOG_FILE)) return;
    File f = LittleFS.open(LOG_FILE, "r");
    if (!f) return;

    // File có thể lớn; chỉ đọc phần cuối (64KB là quá đủ cho 40 dòng).
    const size_t kTail = 64 * 1024;
    if (f.size() > kTail) f.seek(f.size() - kTail);

    while (f.available()) {
        String line = f.readStringUntil('\n');
        line.trim();
        if (line.length() < 5) continue;
        JsonDocument doc;
        if (deserializeJson(doc, line) != DeserializationError::Ok) continue;

        LogEntry e;
        e.id       = doc["id"] | 0;
        e.ts       = (time_t)(doc["ts"] | 0);
        e.uptimeMs = (uint32_t)(doc["uptime"] | 0) * 1000UL;
        e.source   = parseSource(doc["src"] | "");
        e.state    = parseState(doc["state"] | "");
        const char* type = doc["type"] | "";
        for (uint8_t i = 0; i <= EV_TEST; ++i) {
            if (strcmp(type, eventCode((EventType)i)) == 0) { e.type = (EventType)i; break; }
        }
        strlcpy(e.note, doc["note"] | "", sizeof(e.note));

        if (e.id >= g_nextId) g_nextId = e.id + 1;
        switch (e.type) {
            case EV_FALL_SUSPECT: g_stats.suspects++;  break;
            case EV_CANCELLED:    g_stats.cancelled++; break;
            case EV_EMERGENCY:    g_stats.emergency++; break;
            case EV_SOS:          g_stats.sos++;       break;
            default: break;
        }
        g_ram.push_back(e);
        if (g_ram.size() > LOG_RAM_ENTRIES) g_ram.pop_front();
    }
    f.close();
}

/// Khi file vượt LOG_MAX_BYTES thì đổi tên thành file .old để không đầy flash.
void rotateIfNeeded() {
    File f = LittleFS.open(LOG_FILE, "r");
    if (!f) return;
    const size_t sz = f.size();
    f.close();
    if (sz < LOG_MAX_BYTES) return;
    if (LittleFS.exists(LOG_FILE_OLD)) LittleFS.remove(LOG_FILE_OLD);
    LittleFS.rename(LOG_FILE, LOG_FILE_OLD);
    Serial.println("[LOG] Đã xoay vòng file nhật ký");
}
}  // namespace

bool begin() {
    if (!g_mutex) g_mutex = xSemaphoreCreateMutex();
    // true = tự format nếu phân vùng chưa có hệ thống file
    g_fsReady = LittleFS.begin(true);
    if (!g_fsReady) {
        Serial.println("[LOG] LỖI: không mở được LittleFS");
        return false;
    }
    Lock lk;
    loadTail();
    Serial.printf("[LOG] LittleFS %u/%u byte, đã nạp %u sự kiện\n",
                  (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes(),
                  (unsigned)g_ram.size());
    return true;
}

void add(EventType type, EventSource src, SysState state, const char* note) {
    LogEntry e;
    e.ts       = time(nullptr);
    e.uptimeMs = millis();
    e.type     = type;
    e.source   = src;
    e.state    = state;
    strlcpy(e.note, note ? note : "", sizeof(e.note));

    {
        Lock lk;
        e.id = g_nextId++;
        g_ram.push_back(e);
        if (g_ram.size() > LOG_RAM_ENTRIES) g_ram.pop_front();
        switch (type) {
            case EV_FALL_SUSPECT: g_stats.suspects++;  break;
            case EV_CANCELLED:    g_stats.cancelled++; break;
            case EV_EMERGENCY:    g_stats.emergency++; break;
            case EV_SOS:          g_stats.sos++;       break;
            default: break;
        }

        if (g_fsReady) {
            rotateIfNeeded();
            File f = LittleFS.open(LOG_FILE, "a");
            if (f) {
                JsonDocument doc;
                entryToJson(e, doc.to<JsonObject>());
                serializeJson(doc, f);
                f.println();
                f.close();
            }
        }
    }

    Serial.printf("[EV] #%lu %-14s src=%-6s state=%-16s %s\n",
                  (unsigned long)e.id, eventCode(type), sourceCode(src),
                  stateName(state), e.note);
}

std::vector<LogEntry> recent() {
    Lock lk;
    std::vector<LogEntry> out(g_ram.rbegin(), g_ram.rend());  // mới nhất đứng đầu
    return out;
}

String recentJson() {
    Lock lk;
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (auto it = g_ram.rbegin(); it != g_ram.rend(); ++it) {
        entryToJson(*it, arr.add<JsonObject>());
    }
    String out;
    serializeJson(doc, out);
    return out;
}

String exportCsv() {
    String csv = "id,thoi_gian,uptime_s,su_kien,nguon,trang_thai,ghi_chu\n";
    auto appendFile = [&csv](const char* path) {
        if (!LittleFS.exists(path)) return;
        File f = LittleFS.open(path, "r");
        if (!f) return;
        while (f.available()) {
            String line = f.readStringUntil('\n');
            line.trim();
            if (line.length() < 5) continue;
            JsonDocument doc;
            if (deserializeJson(doc, line) != DeserializationError::Ok) continue;
            time_t ts = (time_t)(doc["ts"] | 0);
            char when[24] = "";
            if (ts > 1600000000) {
                struct tm tmv;
                localtime_r(&ts, &tmv);
                strftime(when, sizeof(when), "%Y-%m-%d %H:%M:%S", &tmv);
            }
            csv += String(doc["id"] | 0) + "," + when + "," +
                   String(doc["uptime"] | 0) + "," + (const char*)(doc["type"] | "") + "," +
                   (const char*)(doc["src"] | "") + "," + (const char*)(doc["state"] | "") + ",\"" +
                   (const char*)(doc["note"] | "") + "\"\n";
        }
        f.close();
    };
    Lock lk;
    appendFile(LOG_FILE_OLD);
    appendFile(LOG_FILE);
    return csv;
}

void clear() {
    Lock lk;
    g_ram.clear();
    g_stats = Stats{};
    if (g_fsReady) {
        LittleFS.remove(LOG_FILE);
        LittleFS.remove(LOG_FILE_OLD);
    }
}

Stats stats() {
    Lock lk;
    return g_stats;
}

}  // namespace EventLog
