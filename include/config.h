/**
 * @file  config.h
 * @brief Toàn bộ thông số có thể chỉnh của hệ thống nằm trong file này.
 *        Sơ đồ chân lấy theo mục 3 của bản kế hoạch đồ án.
 *
 * LƯU Ý QUAN TRỌNG VỀ PHẦN CỨNG
 *   - Radar C1001 dùng nguồn 5V. Mức logic chân TX của radar là 3,3V (an toàn
 *     cho ESP32). Hãy đo lại bằng đồng hồ vạn năng trước khi nối: nếu đo được
 *     ~5V thì phải thêm cầu chia áp (1k8 + 3k3) hoặc mạch chuyển mức.
 *   - Gắn tụ 470–1000µF/16V sát chân nguồn của radar và của mạch MAX98357A.
 */
#pragma once
#include <Arduino.h>

// Nhắc việc hay bị quên nhất khi mới tải project về: chưa tạo file secrets.h
#if !__has_include("secrets.h")
#error "Thieu file include/secrets.h -> hay chay lenh: copy include\\secrets.h.example include\\secrets.h roi dien Wi-Fi va token Telegram."
#endif

// ============================== SƠ ĐỒ CHÂN ==================================
// --- Radar C1001 qua UART1 ---
// Nối: radar TX -> ESP32 RX (GPIO18) ; radar RX -> ESP32 TX (GPIO17)
constexpr int PIN_RADAR_RX   = 18;   // ESP32 nhận
constexpr int PIN_RADAR_TX   = 17;   // ESP32 gửi
constexpr uint32_t RADAR_BAUD = 115200;

// --- Mạch khuếch đại âm thanh MAX98357A (chuẩn I2S) ---
constexpr int PIN_I2S_BCLK   = 4;    // BCLK (xung bit)
constexpr int PIN_I2S_LRC    = 5;    // LRC / WS (chọn kênh trái-phải)
constexpr int PIN_I2S_DIN    = 6;    // DIN (dữ liệu âm thanh)

// --- Micro INMP441 (I2S, cho trợ lý hội thoại kiểu Xiaozhi) ---
// Dùng cổng I2S_NUM_1 RIÊNG để không đụng loa (loa dùng I2S_NUM_0). INMP441 là
// mic MEMS I2S 24-bit. Nối: VDD->3V3, GND->GND, L/R->GND (chọn kênh trái).
// Đặt PIN_MIC_SD = -1 nếu KHÔNG gắn mic (trợ lý sẽ chỉ nói, không nghe được).
constexpr int PIN_MIC_SCK    = 7;    // BCLK của mic (xung bit)
constexpr int PIN_MIC_WS     = 8;    // WS/LRCL của mic (chọn kênh)
constexpr int PIN_MIC_SD     = 9;    // DOUT của mic (dữ liệu vào ESP32); -1 = không gắn

// --- Hai nút nhấn (nối GND, dùng điện trở kéo lên nội) ---
constexpr int PIN_BTN_OK     = 15;   // Nút XANH: "Tôi ổn"
constexpr int PIN_BTN_SOS    = 16;   // Nút ĐỎ:   gọi cứu trợ

// --- LED trạng thái + còi ---
constexpr int PIN_LED_GREEN  = 10;   // Xanh:  hệ thống bình thường
constexpr int PIN_LED_YELLOW = 11;   // Vàng:  đang nghi ngờ té ngã / chờ phản hồi
constexpr int PIN_LED_RED    = 12;   // Đỏ:    đã phát cảnh báo khẩn cấp
constexpr int PIN_BUZZER     = 13;   // Còi (đặt -1 nếu không gắn còi)

// --- Mạch thu RF 433 MHz cho nút SOS đeo tay (đặt -1 nếu không gắn) ---
// Dùng loại SIÊU NGOẠI SAI (RXB6 / SRX882), KHÔNG dùng loại rẻ MX-RM-5V vì nó
// nhiễu nặng và hay tự kích. Cấp nguồn 3,3V để chân DATA xuất đúng mức 3,3V.
// Nhớ hàn một đoạn dây 17,3 cm vào chân ANT, thiếu nó thì tầm chỉ còn vài mét.
constexpr int PIN_RF_433     = 14;

// Nếu LED nối kiểu anode chung (sáng khi chân ở mức LOW) thì đổi thành true
constexpr bool LED_ACTIVE_LOW = false;

// ========================== THAM SỐ CẤU HÌNH RADAR ==========================
// Chiều cao lắp radar tính từ MẶT SÀN lên, đơn vị cm (DFRobot khuyên 2,4–2,8 m)
constexpr uint16_t RADAR_INSTALL_HEIGHT_CM = 270;
// Thời gian radar phải thấy người ở trạng thái ngã liên tục trước khi báo (giây)
// Để nhỏ thì nhạy nhưng dễ báo nhầm; để lớn thì cảnh báo chậm.
constexpr uint32_t RADAR_FALL_TIME_S       = 5;
// Thời gian chờ trước khi radar báo "không còn người" (giây)
constexpr uint32_t RADAR_UNMANNED_TIME_S   = 3;
// Độ nhạy phát hiện té ngã: 0..3 (càng lớn càng nhạy)
constexpr uint32_t RADAR_FALL_SENSITIVITY  = 3;
// Thời gian nằm im một chỗ thì radar báo "lưu trú tĩnh" (giây)
constexpr uint32_t RADAR_RESIDENCE_TIME_S  = 200;

// ---- Cách đọc radar: nhanh (tự viết) hay chậm (thư viện) ----
// Thư viện DFRobot đọc theo kiểu hỏi–đáp, bên trong có delay(50) cho MỖI byte,
// nên một câu lệnh mất 0,5–0,7 giây; đọc đủ 6 thông tin mất 3–4 giây. Firmware
// này mặc định dùng bộ đọc UART không chặn tự viết (src/radar_frame.*): vẫn gửi
// lệnh bằng đúng định dạng khung của hãng, nhưng không chờ byte nào.
//
// An toàn: nếu sau RADAR_FAST_PROBE_MS mà không giải mã được khung hợp lệ nào,
// firmware TỰ ĐỘNG quay về dùng thư viện (chậm nhưng chắc chắn chạy).
// Đặt true ở dòng dưới để bắt buộc dùng thư viện ngay từ đầu.
constexpr bool     RADAR_FORCE_LIBRARY     = false;
constexpr uint32_t RADAR_FAST_PROBE_MS     = 8000;

// Khoảng cách giữa hai câu lệnh gửi xuống radar (ms). Cứ hai lệnh thì có một
// lệnh hỏi trạng thái té ngã, nên trạng thái ngã được cập nhật mỗi ~300 ms.
constexpr uint32_t RADAR_QUERY_INTERVAL_MS = 150;

// Chu kỳ đọc radar khi phải dùng thư viện (ms)
constexpr uint32_t RADAR_POLL_INTERVAL_MS  = 500;

// ---- Chuỗi đặc trưng phục vụ huấn luyện model (xem src/fall_model.*) ----
// Chu kỳ lấy một mẫu đặc trưng (ms) và số mẫu giữ trong RAM.
// 250 ms x 400 mẫu = 100 giây dữ liệu gần nhất.
constexpr uint32_t FEATURE_PERIOD_MS       = 250;
constexpr size_t   FEATURE_RING_SIZE       = 400;

// ==================== CHẾ ĐỘ GIẤC NGỦ (nhịp tim, nhịp thở) ==================
//
// Mô-đun C1001 chỉ chạy MỘT chế độ tại một thời điểm: phát hiện té ngã HOẶC
// theo dõi giấc ngủ. Đổi chế độ mất khoảng 12-15 giây và TRONG KHOẢNG ĐÓ KHÔNG
// PHÁT HIỆN ĐƯỢC TÉ NGÃ. Vì vậy tính năng này MẶC ĐỊNH TẮT — bật lên là bạn
// chấp nhận đánh đổi, và phải ghi rõ hạn chế đó trong báo cáo.
//
// Khi bật: ban đêm, nếu radar thấy người nằm im đủ lâu thì chuyển sang chế độ
// giấc ngủ để đo nhịp tim / nhịp thở; thấy người ra khỏi giường thì lập tức
// chuyển về chế độ phát hiện té ngã.
constexpr bool     ENABLE_SLEEP_MODE        = false;

// Khung giờ cho phép vào chế độ giấc ngủ (giờ địa phương, 22h -> 6h)
constexpr uint8_t  SLEEP_WINDOW_START_HOUR  = 22;
constexpr uint8_t  SLEEP_WINDOW_END_HOUR    = 6;
// Phải nằm im liên tục bao lâu mới chuyển sang chế độ giấc ngủ (giây)
constexpr uint32_t SLEEP_ENTER_AFTER_STILL_S = 300;
// Chu kỳ đọc nhịp tim / nhịp thở khi đang ở chế độ giấc ngủ (ms)
constexpr uint32_t VITALS_QUERY_INTERVAL_MS  = 500;

// --- Ngưỡng cảnh báo sinh hiệu (ĐỂ RỘNG, tránh báo động giả ban đêm) ---
// LƯU Ý: đây là ƯỚC LƯỢNG bằng sóng milimet, KHÔNG phải thiết bị y tế.
// Tuyệt đối không dùng để chẩn đoán; trong báo cáo phải ghi rõ điều này.
constexpr uint8_t  HR_ALERT_MIN             = 40;   // nhịp/phút
constexpr uint8_t  HR_ALERT_MAX             = 130;
constexpr uint8_t  BREATHE_ALERT_MIN        = 8;    // lần/phút
constexpr uint8_t  BREATHE_ALERT_MAX        = 30;
// Phải vượt ngưỡng liên tục bao lâu mới gửi cảnh báo (giây)
constexpr uint32_t VITALS_ALERT_AFTER_S     = 60;
// Sau khi gửi một cảnh báo sinh hiệu, nghỉ bao lâu mới gửi tiếp (giây)
constexpr uint32_t VITALS_ALERT_COOLDOWN_S  = 900;

// ======================== THAM SỐ QUY TRÌNH CẢNH BÁO ========================
// Thời gian đếm ngược chờ người dùng bấm "Tôi ổn" trước khi báo động (giây)
constexpr uint32_t CONFIRM_WINDOW_S        = 30;
// Khoảng cách giữa 2 lần phát lại câu hỏi thăm trong lúc đếm ngược (giây)
constexpr uint32_t VOICE_REPEAT_EVERY_S    = 10;
// Sau khi người dùng bấm "Tôi ổn", bỏ qua mọi báo ngã mới trong bao lâu (giây)
// -> tránh loa hỏi thăm lặp lại liên tục khi radar báo ngã dai dẳng.
constexpr uint32_t FALL_COOLDOWN_S         = 60;
// Số lần bấm/nhấn giữ nút để coi là hợp lệ (chống dội phím), đơn vị ms
constexpr uint32_t BTN_DEBOUNCE_MS         = 40;

// ============================== ÂM THANH ====================================
// File WAV nằm trong thư mục data/ (nạp bằng: pio run -t uploadfs)
// Yêu cầu: WAV PCM, 16-bit, 16000 Hz, 1 kênh (mono).
#define AUDIO_FILE_ASK   "/ask.wav"      // "Ông/bà có ổn không? Bấm nút xanh nếu ổn."
#define AUDIO_FILE_OK    "/ok.wav"       // "Đã ghi nhận, cảm ơn ông/bà." (không bắt buộc)
#define AUDIO_FILE_ALERT "/alert.wav"    // "Đang gọi người thân." (không bắt buộc)
// Lời nhắn của người nhà phát ra loa. /say.wav KHÔNG nằm trong data/: dashboard
// tổng hợp giọng đọc rồi đẩy xuống qua POST /api/say. /hoitham.wav thì phải tự
// đặt vào data/ (nạp bằng uploadfs) — đây là câu dự phòng khi laptop tắt.
#define AUDIO_FILE_SAY   "/say.wav"      // lời nhắn người nhà do dashboard đẩy xuống
#define AUDIO_FILE_GREET "/hoitham.wav"  // lời hỏi thăm thu sẵn, dùng khi dashboard tắt
constexpr size_t SAY_MAX_BYTES = 700 * 1024;  // ~22 giây WAV 16 kHz mono 16-bit
// Âm lượng phần mềm 0..100 (nhân vào mẫu tín hiệu; >100 sẽ gây rè)
constexpr uint8_t AUDIO_VOLUME_PERCENT = 70;

// ============================ LƯU TRỮ / NHẬT KÝ =============================
#define LOG_FILE        "/events.jsonl"      // nhật ký sự kiện (1 dòng JSON / sự kiện)
#define LOG_FILE_OLD    "/events.old.jsonl"  // file xoay vòng khi file chính đầy
#define QUEUE_FILE      "/queue.json"        // hàng đợi tin Telegram chưa gửi được
constexpr size_t   LOG_MAX_BYTES    = 192 * 1024;  // xoay vòng khi vượt mức này
constexpr size_t   LOG_RAM_ENTRIES  = 40;          // số sự kiện giữ trong RAM cho web
constexpr size_t   QUEUE_MAX_ITEMS  = 20;          // số tin chờ gửi tối đa

// ============================== MẠNG / GIỜ ==================================
#define HOSTNAME        "canhbao-tenga"
#define NTP_SERVER_1    "pool.ntp.org"
#define NTP_SERVER_2    "time.google.com"
#define TIMEZONE_VN     "<+07>-7"            // Giờ Việt Nam (UTC+7), không đổi giờ mùa
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 10000;  // thử kết nối lại mỗi 10s
constexpr uint32_t TELEGRAM_RETRY_MS      = 15000;  // thử gửi lại tin trong hàng đợi

// Chu kỳ hỏi tin nhắn mới từ người nhà qua Telegram (ms). Để 0 thì TẮT hẳn tính
// năng chat hai chiều (chỉ gửi cảnh báo đi, không nhận hỏi đáp).
constexpr uint32_t TELEGRAM_POLL_MS       = 4000;

// ===================== TRỢ LÝ HỘI THOẠI (kiểu Xiaozhi) =====================
// ESP32 ghi âm từ mic INMP441 rồi gửi lên "bộ não" chạy trên dashboard (Next.js)
// để nhận dạng giọng nói (STT) -> hỏi mô hình ngôn ngữ (LLM) -> tổng hợp tiếng
// nói (TTS). Dashboard trả câu trả lời dạng WAV, ESP32 phát ra loa MAX98357A.
// ESP32 KHÔNG tự chạy STT/TTS vì quá nặng; làm theo kiểu client-server giống
// chính Xiaozhi.
//
// ASSISTANT_SERVER: địa chỉ dashboard trong mạng LAN (http://IP_LAPTOP:3000).
// Để "" thì TẮT hẳn trợ lý hội thoại trên ESP32 (vẫn giữ mọi chức năng cảnh báo).
#define ASSISTANT_SERVER   ""            // vd "http://192.168.1.10:3000" — để "" nếu không dùng
// Giữ nút "Tôi ổn"/SOS bao lâu (ms) để coi là bấm-giữ kích hoạt nói? 0 = tắt.
// Khi gắn mic, có thể dùng nút xanh làm nút "bấm-giữ-để-nói" (push to talk).
constexpr uint32_t ASSISTANT_PTT_HOLD_MS  = 700;
// Thời lượng ghi âm tối đa mỗi lượt nói (giây)
constexpr uint32_t ASSISTANT_MAX_REC_S    = 8;

// ======================== CHẾ ĐỘ CHẠY KHÔNG CÓ RADAR ========================
// Đặt true để chạy thử toàn bộ hệ thống khi radar chưa về tới (tuần 2–3).
// Khi bật, radar không được đọc; dùng nút "Mô phỏng té ngã" trên trang web.
constexpr bool SIMULATE_RADAR = false;
