/**
 * @file  app_api.h
 * @brief Cầu nối giữa trang web và máy trạng thái (phần thân nằm ở main.cpp).
 *
 *  Máy chủ web của thư viện ESPAsyncWebServer chạy trong một task riêng, nên
 *  nó KHÔNG được phép tự ý đổi trạng thái hệ thống. Mọi thao tác bấm trên web
 *  chỉ bật một cờ yêu cầu; vòng loop() chính sẽ đọc cờ đó và xử lý. Cách này
 *  giữ cho máy trạng thái chỉ bị thay đổi ở một chỗ duy nhất.
 */
#pragma once
#include "app_types.h"

namespace App {

/// Thông tin trạng thái cho trang web
struct Status {
    SysState state         = ST_BOOT;
    uint32_t countdownS    = 0;   ///< số giây còn lại để bấm "Tôi ổn"
    uint32_t cooldownS     = 0;   ///< số giây còn lại của thời gian bỏ qua báo ngã
    uint32_t stateAgeS     = 0;   ///< đã ở trạng thái hiện tại bao lâu
    uint32_t lastAlertMs   = 0;   ///< thời điểm phát cảnh báo gần nhất
    uint32_t alertLatencyMs = 0;  ///< thời gian từ lúc phát hiện ngã tới lúc gửi tin
    bool     sayPending    = false;  ///< đang có lời nhắn người nhà chờ loa phát
};

Status status();

// --- Các yêu cầu từ trang web (chỉ bật cờ, loop() sẽ xử lý) ---
void requestIamOk();
void requestSos();
void requestSimulateFall();
void requestSimPresence(bool present);
void requestTestVoice();
void requestTestTelegram();   ///< gửi tin thử CHỈ qua Telegram
void requestTestEmail();      ///< gửi tin thử CHỈ qua Email
void requestTestZalo();       ///< gửi tin thử CHỈ qua Zalo
void requestClearLog();
void requestAssistant();      ///< kích hoạt một lượt trợ lý hội thoại

/// Xếp một lời nhắn người nhà chờ loa phát (file WAV trong LittleFS, vd.
/// AUDIO_FILE_SAY). Chỉ bật cờ nên gọi được từ MỌI task (web, Telegram);
/// loop() mới quyết định phát, chờ loa rảnh, hay bỏ vì đang cảnh báo.
/// @param from  tên người gửi (UTF-8, có thể rỗng), tự cắt còn tối đa 40 byte.
/// @return false nếu đã có một lời nhắn khác đang chờ (lời nhắn cũ giữ nguyên).
bool requestSay(const char* from, const char* path);

/// true nếu đang có lời nhắn chờ loa phát (chưa phát, chưa bị bỏ).
bool sayPending();

}  // namespace App
