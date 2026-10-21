/**
 * @file  event_log.h
 * @brief Ghi nhật ký sự kiện vào LittleFS theo định dạng JSONL (mỗi dòng 1 JSON).
 *        Giữ thêm LOG_RAM_ENTRIES sự kiện gần nhất trong RAM để trang web
 *        hiển thị tức thì mà không phải đọc lại file.
 */
#pragma once
#include "app_types.h"
#include <vector>

namespace EventLog {

/// Khởi tạo LittleFS và nạp các sự kiện gần nhất vào RAM. Trả về false nếu lỗi FS.
bool begin();

/// Ghi một sự kiện (vào cả RAM và file). An toàn khi gọi từ nhiều task.
void add(EventType type, EventSource src, SysState state, const char* note = "");

/// Lấy bản sao danh sách sự kiện trong RAM, mới nhất ở đầu.
std::vector<LogEntry> recent();

/// Chuỗi JSON mảng các sự kiện gần nhất (dùng cho WebSocket / API).
String recentJson();

/// Toàn bộ nhật ký dạng CSV để tải về làm số liệu thực nghiệm (Excel).
String exportCsv();

/// Xóa sạch nhật ký (dùng trước mỗi phiên đo số liệu).
void clear();

/// Thống kê nhanh cho trang web
struct Stats {
    uint32_t suspects  = 0;  ///< số lần nghi ngờ té ngã
    uint32_t cancelled = 0;  ///< số lần người dùng bấm "Tôi ổn"
    uint32_t emergency = 0;  ///< số lần phát cảnh báo
    uint32_t sos       = 0;  ///< số lần bấm SOS
};
Stats stats();

}  // namespace EventLog
