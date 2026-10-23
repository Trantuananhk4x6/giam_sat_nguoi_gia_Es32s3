/**
 * @file secrets.h
 * @brief Thông tin riêng tư của thiết bị. ĐÃ ĐƯỢC .gitignore BỎ QUA.
 *
 * File này được tạo tự động từ secrets.h.example để project build được ngay.
 * HÃY ĐIỀN THÔNG TIN THẬT CỦA BẠN vào các dòng bên dưới trước khi nạp firmware:
 *   - Wi-Fi 2,4 GHz
 *   - Token + chat id của bot Telegram
 *   - (tùy chọn) mật khẩu web, mã nút SOS đeo tay, tên người được giám sát
 */
#pragma once

// ------------------------------- Wi-Fi --------------------------------------
// ESP32 chỉ bắt được Wi-Fi 2,4 GHz. Nếu router phát chung tên cho cả 2,4 và 5 GHz
// mà không kết nối được thì hãy tách tên mạng 2,4 GHz ra riêng.
#define WIFI_SSID      "TEN_WIFI_CUA_BAN"
#define WIFI_PASSWORD  "MAT_KHAU_WIFI"

// ------------------------------ Telegram ------------------------------------
// 1. Mở Telegram, chat với @BotFather -> /newbot -> lấy token
// 2. Chat một câu bất kỳ với bot vừa tạo, rồi mở:
//    https://api.telegram.org/bot<TOKEN>/getUpdates  -> lấy "chat":{"id":...}
#define TELEGRAM_BOT_TOKEN  "8845801204:AAHWV8hbpWpybz-w9yZn52yXs43l4eNW-i0"  // @Jamleet1_bot
// Nhiều người nhận: các chat id cách nhau dấu phẩy (mỗi người phải nhắn cho bot trước).
#define TELEGRAM_CHAT_ID    "6098508829,6772682924"

// --------------------------- Email qua Resend -------------------------------
// Kênh cảnh báo thứ hai (song song với Telegram). Để RESEND_API_KEY = "" nếu
// không dùng email.
//
// CÁCH LẤY:
//   1. Đăng ký tài khoản ở https://resend.com (miễn phí 3.000 email/tháng)
//   2. Vào mục API Keys -> tạo key, dán vào RESEND_API_KEY (bắt đầu bằng "re_")
//   3. Người nhận: EMAIL_TO là email người thân sẽ nhận cảnh báo.
//
// LƯU Ý QUAN TRỌNG (hay vướng nhất):
//   - Khi CHƯA xác minh tên miền riêng, Resend bắt buộc gửi TỪ
//     "onboarding@resend.dev" và CHỈ gửi được TỚI chính email đã đăng ký tài
//     khoản Resend (gửi địa chỉ khác sẽ bị trả lỗi 403). Để demo cho nhanh,
//     đặt EMAIL_TO = đúng email bạn đăng ký Resend.
//   - Muốn gửi tới email bất kỳ (email người thân thật): vào Resend thêm và xác
//     minh tên miền của bạn, rồi đổi EMAIL_FROM thành địa chỉ thuộc tên miền đó.
#define RESEND_API_KEY   "re_F6BudCFc_NdC9vv9Y3WciCpqA7mwJfV1U"  // "re_xxxxxxxx" — để "" nếu không dùng
#define EMAIL_FROM       "onboarding@resend.dev"   // đổi sau khi đã xác minh tên miền
#define EMAIL_TO         "ban@example.com"         // email người thân nhận cảnh báo

// ----------------- Zalo Official Account (tùy chọn, nâng cao) ----------------
// LƯU Ý: Zalo KHÔNG có API chính thức cho tài khoản CÁ NHÂN. Chỉ Zalo Official
// Account (OA — tài khoản dành cho tổ chức/doanh nghiệp) mới có API gửi tin hợp
// lệ. Gửi tin qua tài khoản cá nhân bằng công cụ không chính thức rất dễ bị
// KHÓA tài khoản và không đáng tin cho một thiết bị an toàn — vì vậy firmware
// này KHÔNG hỗ trợ hướng đó.
//
// Nếu bạn lập được Zalo OA và có access token, điền vào đây để bật kênh Zalo.
// Để trống ("") nếu không dùng. OA chỉ gửi tin được cho user đã quan tâm OA và
// trong khung thời gian cho phép của Zalo.
#define ZALO_OA_TOKEN    ""                        // access token của Zalo OA — để "" nếu không dùng
#define ZALO_USER_ID     ""                        // user id (người đã quan tâm OA) sẽ nhận tin

// ------------------- Mật khẩu trang web giám sát (tùy chọn) ------------------
// Để trống ("") nếu không muốn đặt mật khẩu khi demo.
#define WEB_USER  ""
#define WEB_PASS  ""

// ------------------- Nút SOS đeo tay 433 MHz (tùy chọn) ---------------------
// Để 0 trong lần nạp đầu: firmware sẽ in mã của mọi nút bấm nhận được ra cổng
// serial. Bấm nút của bạn, copy con số in ra, dán vào đây rồi nạp lại.
#define RF_REMOTE_CODE_1  0
#define RF_REMOTE_CODE_2  0

// ----------------------- Tên người được giám sát ----------------------------
// Dùng trong nội dung tin nhắn cảnh báo.
#define PATIENT_NAME  "Ba Nguyen Thi A"
#define DEVICE_PLACE  "Phong ngu tang 1"

// ------------------------- Zalo Bot (tùy chọn) ------------------------------
// Thêm cùng bản firmware có Zalo Bot. Hướng dẫn đầy đủ: include/secrets.h.example
// (mục "Zalo Bot"). Để "" nếu không dùng. ZALO_OA_TOKEN / ZALO_USER_ID ở trên là
// cách cũ (Zalo OA), firmware không dùng nữa.
//   1. Zalo -> tìm OA "Zalo Bot Manager" -> "Tạo bot" (tên bắt đầu bằng "Bot") ->
//      Zalo nhắn Bot Token về tài khoản của bạn -> dán vào ZALO_BOT_TOKEN.
//   2. Nạp firmware, mỗi người nhà nhắn cho bot một câu -> bot báo "Mã chat Zalo"
//      -> ghi vào ZALO_CHAT_ID (nhiều người cách nhau dấu phẩy) rồi nạp lại.
#define ZALO_BOT_TOKEN   ""
#define ZALO_CHAT_ID     ""
