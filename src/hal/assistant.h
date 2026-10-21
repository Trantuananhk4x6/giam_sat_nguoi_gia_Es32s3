/**
 * @file  assistant.h
 * @brief Trợ lý hội thoại kiểu "Xiaozhi": ESP32 chỉ là CLIENT thu/phát âm thanh,
 *        còn "bộ não" (STT + LLM + TTS) chạy trên dashboard trong mạng LAN.
 *
 *  LUỒNG MỘT LƯỢT NÓI
 *    1. Người dùng kích hoạt (giữ nút xanh lâu, hoặc bấm nút "Trợ lý" trên web).
 *    2. ESP32 ghi âm từ mic INMP441 qua I2S (cổng RIÊNG I2S_NUM_1 để KHÔNG đụng
 *       loa đang dùng I2S_NUM_0) ở 16000 Hz mono, 16-bit, tối đa
 *       ASSISTANT_MAX_REC_S giây.
 *    3. Bọc dữ liệu thành WAV rồi POST multipart/form-data (field "audio") lên
 *       {ASSISTANT_SERVER}/api/assistant. Dashboard trả JSON { heard, reply }.
 *    4. Gọi GET {ASSISTANT_SERVER}/api/tts?text=<reply> nhận MP3, giải mã rồi
 *       phát ra loa MAX98357A.
 *
 *  AN TOÀN: trợ lý là tính năng PHỤ. Mọi bước chạy trong một task riêng, có
 *  timeout, không bao giờ chặn loop() chính hay làm ảnh hưởng tới radar / máy
 *  trạng thái / nút "Tôi ổn" / SOS. Lỗi mạng hay lỗi server chỉ phát 2 tiếng bíp
 *  và in Serial.
 *
 *  TẮT HOÀN TOÀN khi ASSISTANT_SERVER == "" hoặc PIN_MIC_SD < 0 (không gắn mic).
 */
#pragma once
#include <Arduino.h>

namespace Assistant {

/// Trạng thái để HMI/LED biết trợ lý đang làm gì (hiện tại dùng cho log/web).
enum State : uint8_t {
    AS_DISABLED = 0,   ///< tắt (thiếu server hoặc thiếu mic)
    AS_IDLE,           ///< rảnh, sẵn sàng nghe
    AS_LISTENING,      ///< đang ghi âm từ mic
    AS_THINKING,       ///< đang gửi lên dashboard và chờ trả lời
    AS_SPEAKING        ///< đang phát câu trả lời ra loa
};

/// Cài mic I2S và tạo task xử lý. Gọi một lần trong setup().
/// Nếu bị tắt (thiếu server/mic) thì chỉ in log "tro ly tat" và không làm gì.
void begin();

/// Gọi liên tục trong loop(); rất nhẹ, không chặn. Khi tắt thì không làm gì.
void loop();

/// Trợ lý có được bật hay không (đủ server + mic).
bool isEnabled();

/// Bắt đầu MỘT lượt nói: ghi âm -> gửi dashboard -> phát câu trả lời.
/// An toàn khi gọi nhiều lần: nếu đang bận một lượt thì yêu cầu mới bị bỏ qua.
void startListening();

/// Trạng thái hiện tại của trợ lý (cho HMI/web).
State state();

/// true nếu trợ lý đang bận một lượt (nghe/suy nghĩ/nói).
bool isBusy();

}  // namespace Assistant
