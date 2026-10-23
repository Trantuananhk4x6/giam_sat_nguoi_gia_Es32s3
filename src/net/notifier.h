/**
 * @file  notifier.h
 * @brief Gửi cảnh báo qua bot Telegram, Zalo Bot và email, có hàng đợi chống mất
 *        tin khi rớt mạng; chat hai chiều với người nhà qua Telegram và Zalo.
 *
 * CÁCH XỬ LÝ TÌNH HUỐNG "MẤT WI-FI" (yêu cầu ở mục 4 của bản kế hoạch)
 *   Mọi tin nhắn đều được đẩy vào hàng đợi trước, rồi một task riêng mới lấy ra
 *   gửi đi. Nhờ vậy máy trạng thái không phải chờ 1–3 giây bắt tay HTTPS.
 *   Hàng đợi được ghi xuống LittleFS sau mỗi lần thay đổi, nên nếu mất điện
 *   giữa lúc chưa gửi được thì khi bật lại tin vẫn còn và được gửi tiếp.
 */
#pragma once
#include <Arduino.h>

namespace Notifier {

/// Nạp lại hàng đợi còn tồn từ flash và tạo task gửi tin.
bool begin();

/// Đưa một tin vào hàng đợi (an toàn khi gọi từ task khác). Trả về false nếu đầy.
/// Tin sẽ được fan-out ra MỌI kênh đang bật; Telegram / Zalo thì tới MỌI chat id
/// trong TELEGRAM_CHAT_ID / ZALO_CHAT_ID (mỗi người một tin riêng, lỗi tạm ở người
/// nào thì thử lại người đó).
bool send(const String& text);

// --- Mặt nạ kênh (công khai) để gọi sendOne() gửi thử riêng từng kênh ---
constexpr uint8_t CH_TELEGRAM = 1 << 0;
constexpr uint8_t CH_EMAIL    = 1 << 1;
constexpr uint8_t CH_ZALO     = 1 << 2;

/// Đưa một tin vào hàng đợi nhưng CHỈ gửi qua kênh chỉ định (channelMask), dùng
/// lại hàng đợi + cơ chế thử lại sẵn có. Mặt nạ được giao với các kênh đang bật
/// nên kênh chưa cấu hình trong secrets.h sẽ bị bỏ. Trả về false nếu kênh đó
/// chưa bật (không có gì để gửi) hoặc hàng đợi đầy. Dùng để thử từng kênh khi demo.
bool sendOne(const String& text, uint8_t channelMask);

/// Số tin đang chờ gửi.
size_t pending();

/// Tổng số tin đã gửi thành công kể từ lúc bật nguồn.
uint32_t sentCount();

/// Mô tả kết quả lần gửi gần nhất (hiện trên trang web để dò lỗi token/chat id).
const char* lastResult();

/// Thời điểm (millis) gửi thành công gần nhất, 0 nếu chưa từng gửi được.
uint32_t lastSuccessMs();

/// Mô tả ngắn các kênh đang bật, ví dụ "Telegram, Email" (để hiện trên web).
/// Trả về "chua bat kenh nao" nếu secrets.h chưa điền kênh nào.
const char* channelsText();

// ===========================================================================
//  CHAT HAI CHIỀU VỚI NGƯỜI NHÀ (Telegram + Zalo)
// ===========================================================================
//
//  Người nhà nhắn cho bot (ví dụ "dạo này ông bà thế nào?") -> firmware đọc tin
//  qua getUpdates, gọi hàm dựng câu trả lời (do main.cpp cung cấp) rồi gửi lại.
//  Chỉ chấp nhận tin từ các chat id khai trong TELEGRAM_CHAT_ID / ZALO_CHAT_ID
//  (secrets.h; nhiều người thì cách nhau dấu phẩy), nên người lạ biết tên bot
//  cũng không hỏi được tình hình người thân của bạn. Riêng Zalo, người lạ được
//  báo lại "mã chat" của họ (tối đa 1 lần / 10 phút) để người nhà mới tự lấy mã.
//
//  Kiểu hàm dựng trả lời: nhận tin người nhà gửi (gồm cả bản gốc lẫn bản chữ
//  thường, tên người gửi), trả về chuỗi HTML để gửi lại (Zalo không nhận HTML
//  nên firmware tự bỏ thẻ). main.cpp đăng ký hàm này trong setup(). Hàm có thể
//  được gọi từ task Telegram và task Zalo cùng lúc nên chỉ được ĐỌC trạng thái.

/// Một tin nhắn của người nhà, đã lọc đúng chat id được phép.
struct FamilyMessage {
    String text;       ///< nguyên văn (giữ hoa/thường, dùng khi cần trích lại lời nhắn)
    String lower;      ///< bản chữ thường để so khớp lệnh / từ khóa
    String fromName;   ///< tên người gửi (Telegram first_name / Zalo display_name), có thể rỗng
    String chatId;     ///< chat id đã đối chiếu với danh sách TELEGRAM_CHAT_ID / ZALO_CHAT_ID
};

/// Kiểu con trỏ hàm dựng câu trả lời cho tin nhắn của người nhà.
typedef String (*ReplyBuilder)(const FamilyMessage& msg);

/// Đăng ký hàm dựng câu trả lời. Gọi một lần trong setup() (trước begin() cũng được).
void onFamilyMessage(ReplyBuilder fn);

// ===========================================================================
//  NHƯỜNG QUYỀN ĐỌC TIN TELEGRAM CHO DASHBOARD
// ===========================================================================
//
//  Bot Telegram chỉ nên có MỘT bên gọi getUpdates: hai bên cùng đọc thì một tin
//  có thể bị trả lời hai lần. Khi laptop chạy dashboard, nó gọi
//  GET /api/status?tg=<giây> định kỳ để "thuê" quyền đọc tin; trong thời gian
//  thuê ESP32 ngừng gọi getUpdates (vẫn gửi cảnh báo bình thường). Laptop tắt
//  -> hết hạn thuê -> ESP32 tự đọc và trả lời tin như cũ, không cần ai can thiệp.

/// Dashboard xin quyền đọc tin trong `seconds` giây (kẹp vào 5..120). Gọi lại
/// trước khi hết hạn để gia hạn. An toàn khi gọi từ task web.
void grantDashboardLease(uint32_t seconds);

/// Ai đang đọc tin Telegram: "off" (tắt chat hai chiều hoặc chưa cấu hình
/// Telegram), "dashboard" (đang trong thời gian thuê) hoặc "device" (ESP32).
const char* telegramPoller();

// ---------------------------------------------------------------------------
//  Zalo: cùng cơ chế thuê, nhưng dashboard xin qua GET /api/status?zl=<giây>.
//  Zalo getUpdates không có "offset": tin nào đã trả cho một bên là bên đó phải
//  xử lý, không trả lại được như Telegram. Vì vậy ESP32 chỉ báo "dashboard" khi
//  ĐÃ thật sự ngừng hỏi (không còn lượt chờ tin nào đang dở), để hai bên không
//  bao giờ cùng chờ tin một lúc.
// ---------------------------------------------------------------------------

/// Dashboard xin quyền đọc tin Zalo trong `seconds` giây (kẹp vào 5..120).
void grantZaloLease(uint32_t seconds);

/// Ai đang đọc tin Zalo: "off" (tắt / chưa khai ZALO_BOT_TOKEN), "dashboard"
/// (ESP32 đã nhường) hoặc "device" (ESP32 đang tự đọc và trả lời).
const char* zaloPoller();

/// Số người nhận cảnh báo Zalo đã khai trong ZALO_CHAT_ID.
uint8_t zaloChatCount();

/// Kết quả lượt hỏi tin Zalo gần nhất (để dò lỗi token trên trang web).
const char* zaloPollResult();

}  // namespace Notifier
