/**
 * @file  audio.h
 * @brief Phát file WAV qua mạch khuếch đại MAX98357A bằng giao thức I2S.
 *
 *  - Việc phát âm thanh chạy trong một task riêng vì hàm i2s_write() sẽ chặn
 *    (block) cho tới khi bộ đệm DMA còn chỗ trống. Nhờ vậy máy trạng thái và
 *    trang web vẫn chạy mượt trong lúc loa đang phát.
 *  - File WAV phải là PCM không nén, 16-bit. Mono hoặc stereo đều được; tần số
 *    lấy mẫu được đọc trực tiếp từ header nên 16k / 22,05k / 44,1k đều chạy.
 *  - Nếu không tìm thấy file, hệ thống phát 3 tiếng bíp thay thế để quy trình
 *    cảnh báo không bị im lặng (hữu ích khi chưa thu được giọng nói).
 */
#pragma once
#include <Arduino.h>

namespace Audio {

/// Cài driver I2S và tạo task phát. Gọi một lần trong setup().
bool begin();

/// Yêu cầu phát một file trong LittleFS, ví dụ "/ask.wav".
///
/// @param interrupt  false (mặc định): nếu loa đang phát dở thì bỏ qua yêu cầu
///                   mới, tránh chen ngang câu hỏi thăm đang nói.
///                   true: cắt ngay bản đang phát để phát bản mới — dùng khi
///                   chuyển sang thông báo quan trọng hơn (xác nhận, báo động).
bool play(const char* path, bool interrupt = false);

/// Dừng ngay bản đang phát.
void stop();

/// Đang có âm thanh phát ra hay không.
bool isPlaying();

/// Phát chuỗi tiếng bíp bằng I2S (dùng khi thiếu file WAV, hoặc để thử loa).
bool playBeeps(uint8_t count = 3, uint16_t freqHz = 880, uint16_t onMs = 180);

/// Phát một luồng MP3 tải trực tiếp từ URL (dùng cho câu trả lời TTS của trợ lý
/// hội thoại). Việc giải mã MP3 dùng thư viện ESP8266Audio, nhưng PHẦN GHI RA
/// loa vẫn dùng chung driver I2S_NUM_0 đã cài ở begin() nên không cài thêm
/// driver thứ hai (tránh xung đột với lúc phát WAV cảnh báo).
///
/// Hàm này CHẶN tới khi phát xong, vì vậy KHÔNG gọi từ loop() chính — chỉ nên
/// gọi từ task của trợ lý. Nếu loa đang bận phát WAV thì hàm trả về false ngay.
///
/// @return true nếu giải mã và phát được ít nhất một phần; false nếu lỗi.
bool playMp3Url(const char* url);

}  // namespace Audio
