/**
 * @file  app_types.h
 * @brief Các kiểu dữ liệu dùng chung giữa các khối của chương trình.
 */
#pragma once
#include <Arduino.h>

/// Máy trạng thái chính (đúng theo bảng ở mục 4 của bản kế hoạch)
enum SysState : uint8_t {
    ST_BOOT = 0,      ///< Đang khởi động, chưa đọc được radar
    ST_NO_PERSON,     ///< Radar báo không có người trong phòng
    ST_PRESENT,       ///< Có người, sinh hoạt bình thường
    ST_SUSPECT_FALL,  ///< Radar báo té ngã -> loa hỏi thăm, đang đếm ngược
    ST_EMERGENCY      ///< Đã gửi cảnh báo cho người thân
};

inline const char* stateName(SysState s) {
    switch (s) {
        case ST_BOOT:          return "KHOI_DONG";
        case ST_NO_PERSON:     return "KHONG_NGUOI";
        case ST_PRESENT:       return "CO_NGUOI";
        case ST_SUSPECT_FALL:  return "NGHI_NGO_TE_NGA";
        case ST_EMERGENCY:     return "KHAN_CAP";
    }
    return "?";
}

inline const char* stateNameVi(SysState s) {
    switch (s) {
        case ST_BOOT:          return "Đang khởi động";
        case ST_NO_PERSON:     return "Không có người";
        case ST_PRESENT:       return "Có người – bình thường";
        case ST_SUSPECT_FALL:  return "NGHI NGỜ TÉ NGÃ – đang chờ phản hồi";
        case ST_EMERGENCY:     return "KHẨN CẤP – đã gửi cảnh báo";
    }
    return "?";
}

/// Chế độ làm việc của mô-đun radar. Mô-đun chỉ chạy MỘT chế độ tại một thời
/// điểm — không thể vừa phát hiện té ngã vừa đo nhịp tim.
enum RadarMode : uint8_t {
    RM_FALL = 0,    ///< Phát hiện té ngã (chế độ chính, luôn ưu tiên)
    RM_SLEEP,       ///< Theo dõi giấc ngủ: nhịp tim, nhịp thở, trạng thái ngủ
    RM_SWITCHING    ///< Đang đổi chế độ — KHÔNG phát hiện được té ngã lúc này
};

inline const char* radarModeName(RadarMode m) {
    switch (m) {
        case RM_FALL:      return "TE_NGA";
        case RM_SLEEP:     return "GIAC_NGU";
        case RM_SWITCHING: return "DANG_DOI_CHE_DO";
    }
    return "?";
}

inline const char* radarModeVi(RadarMode m) {
    switch (m) {
        case RM_FALL:      return "Phát hiện té ngã";
        case RM_SLEEP:     return "Theo dõi giấc ngủ";
        case RM_SWITCHING: return "Đang đổi chế độ (tạm không phát hiện té ngã)";
    }
    return "?";
}

/// Sinh hiệu đo được ở chế độ giấc ngủ.
/// LƯU Ý: đây là ƯỚC LƯỢNG bằng sóng milimet, KHÔNG phải thiết bị y tế.
struct VitalsSnapshot {
    bool     valid        = false;  ///< Đã đọc được số liệu hợp lệ chưa
    uint8_t  heartRate    = 0;      ///< nhịp/phút (0 = chưa đo được)
    uint8_t  breatheValue = 0;      ///< lần/phút
    uint8_t  breatheState = 0;      ///< 1 bình thường, 2 nhanh, 3 chậm, 4 không phát hiện
    uint8_t  inBed        = 0;      ///< 0 ngoài giường, 1 trên giường
    uint8_t  sleepState   = 0;      ///< 0 ngủ sâu, 1 ngủ nông, 2 tỉnh, 3 không có người
    uint8_t  sleepScore   = 0;      ///< điểm chất lượng giấc ngủ 0..100
    uint8_t  struggle     = 0;      ///< 1 = vùng vẫy bất thường
    uint32_t lastUpdate   = 0;      ///< millis() của lần đọc gần nhất
};

/// Ảnh chụp dữ liệu radar tại một thời điểm (task radar ghi, các khối khác đọc)
struct RadarSnapshot {
    bool     online      = false;  ///< Đã bắt tay được với radar chưa
    bool     present     = false;  ///< Có người trong vùng quét
    uint8_t  movement    = 0;      ///< 0 = không có, 1 = nằm/ngồi im, 2 = đang hoạt động
    uint8_t  movingRange = 0;      ///< Biên độ chuyển động 0..100
    uint16_t distanceCm  = 0;      ///< Khoảng cách tới người (cm)
    bool     fallFlag    = false;  ///< Trạng thái ngã hiện tại do radar báo
    bool     staticStay  = false;  ///< Nằm/ngồi im quá lâu (lưu trú tĩnh)
    uint32_t fallEdges   = 0;      ///< Bộ đếm số lần radar CHUYỂN sang trạng thái ngã
    uint32_t lastUpdate  = 0;      ///< millis() của lần đọc gần nhất
    uint32_t readErrors  = 0;      ///< Số lần đọc lỗi/quá thời gian chờ

    // --- Thông tin thêm, có được nhờ bộ đọc UART không chặn ---
    bool     fastMode    = false;  ///< true = đang dùng bộ đọc nhanh tự viết
    uint16_t trackX      = 0;      ///< Điểm quỹ đạo người (mô-đun tự báo)
    uint16_t trackY      = 0;
    uint16_t breakHeight = 0;      ///< Ngưỡng chiều cao mô-đun coi là ngã
    uint32_t framesGood  = 0;      ///< Số khung UART giải mã thành công
    uint32_t framesBad   = 0;      ///< Số khung lỗi (đo chất lượng đường dây)
    uint32_t fallAgeMs   = 0;      ///< Trạng thái ngã được làm mới cách đây bao lâu

    // --- Chế độ làm việc và sinh hiệu (xem ENABLE_SLEEP_MODE trong config.h) ---
    RadarMode      mode        = RM_FALL;
    uint32_t       modeSince   = 0;   ///< millis() lúc vào chế độ hiện tại
    uint32_t       blindMs     = 0;   ///< Tổng thời gian "mù" vì đổi chế độ (ms)
    uint32_t       modeSwitches = 0;  ///< Số lần đã đổi chế độ
    VitalsSnapshot vitals;

    // --- Kết quả của model tự huấn luyện (xem src/fall_model.*) ---
    bool     modelReady  = false;  ///< Đã nạp trọng số model chưa
    bool     modelFall   = false;  ///< Model cho rằng vừa có té ngã
    float    modelProb   = 0.0f;   ///< Xác suất model đưa ra, 0..1
};

/// Phân loại sự kiện để ghi nhật ký và hiển thị trên web
enum EventType : uint8_t {
    EV_BOOT = 0,
    EV_WIFI_UP,
    EV_WIFI_DOWN,
    EV_PRESENCE_IN,
    EV_PRESENCE_OUT,
    EV_FALL_SUSPECT,
    EV_CANCELLED,
    EV_SOS,
    EV_EMERGENCY,
    EV_TELEGRAM_OK,
    EV_TELEGRAM_FAIL,
    EV_RECOVERED,
    EV_RADAR_ERROR,
    EV_SOS_REMOTE,      ///< Bấm nút SOS đeo tay (qua RF 433 MHz)
    EV_MODE_SWITCH,     ///< Radar đổi chế độ làm việc
    EV_VITALS_ALERT,    ///< Nhịp tim / nhịp thở ngoài ngưỡng
    EV_MESSAGE,         ///< Loa đọc lời nhắn người nhà (dashboard đẩy xuống / lệnh /hoitham)
    // EV_TEST PHẢI đứng cuối: event_log.cpp duyệt "i <= EV_TEST" để đổi mã chữ
    // trong file nhật ký về lại kiểu sự kiện, thêm loại mới thì chèn lên trên.
    EV_TEST
};

inline const char* eventCode(EventType e) {
    switch (e) {
        case EV_BOOT:          return "BOOT";
        case EV_WIFI_UP:       return "WIFI_UP";
        case EV_WIFI_DOWN:     return "WIFI_DOWN";
        case EV_PRESENCE_IN:   return "PRESENCE_IN";
        case EV_PRESENCE_OUT:  return "PRESENCE_OUT";
        case EV_FALL_SUSPECT:  return "FALL_SUSPECT";
        case EV_CANCELLED:     return "CANCELLED";
        case EV_SOS:           return "SOS";
        case EV_EMERGENCY:     return "EMERGENCY";
        case EV_TELEGRAM_OK:   return "TELEGRAM_OK";
        case EV_TELEGRAM_FAIL: return "TELEGRAM_FAIL";
        case EV_RECOVERED:     return "RECOVERED";
        case EV_RADAR_ERROR:   return "RADAR_ERROR";
        case EV_SOS_REMOTE:    return "SOS_REMOTE";
        case EV_MODE_SWITCH:   return "MODE_SWITCH";
        case EV_VITALS_ALERT:  return "VITALS_ALERT";
        case EV_MESSAGE:       return "MESSAGE";
        case EV_TEST:          return "TEST";
    }
    return "?";
}

inline const char* eventLabelVi(EventType e) {
    switch (e) {
        case EV_BOOT:          return "Khởi động hệ thống";
        case EV_WIFI_UP:       return "Đã kết nối Wi-Fi";
        case EV_WIFI_DOWN:     return "Mất Wi-Fi";
        case EV_PRESENCE_IN:   return "Phát hiện có người";
        case EV_PRESENCE_OUT:  return "Người ra khỏi phòng";
        case EV_FALL_SUSPECT:  return "Nghi ngờ té ngã";
        case EV_CANCELLED:     return "Người dùng bấm \"Tôi ổn\"";
        case EV_SOS:           return "Bấm nút SOS";
        case EV_EMERGENCY:     return "Phát cảnh báo khẩn cấp";
        case EV_TELEGRAM_OK:   return "Gửi Telegram thành công";
        case EV_TELEGRAM_FAIL: return "Gửi Telegram thất bại";
        case EV_RECOVERED:     return "Đã xác nhận an toàn";
        case EV_RADAR_ERROR:   return "Lỗi đọc radar";
        case EV_SOS_REMOTE:    return "Bấm nút SOS đeo tay";
        case EV_MODE_SWITCH:   return "Radar đổi chế độ làm việc";
        case EV_VITALS_ALERT:  return "Sinh hiệu bất thường";
        case EV_MESSAGE:       return "Loa đọc lời nhắn người nhà";
        case EV_TEST:          return "Thao tác thử nghiệm";
    }
    return "?";
}

/// Nguồn gây ra sự kiện – để phân biệt số liệu thật và số liệu thử nghiệm
enum EventSource : uint8_t {
    SRC_RADAR = 0,   ///< do radar sinh ra
    SRC_BUTTON,      ///< do nút nhấn vật lý
    SRC_WEB,         ///< do thao tác trên trang web
    SRC_REMOTE,      ///< do nút SOS đeo tay (RF 433 MHz)
    SRC_SYSTEM       ///< do hệ thống (mạng, khởi động...)
};

inline const char* sourceCode(EventSource s) {
    switch (s) {
        case SRC_RADAR:  return "RADAR";
        case SRC_BUTTON: return "BUTTON";
        case SRC_WEB:    return "WEB";
        case SRC_REMOTE: return "REMOTE";
        case SRC_SYSTEM: return "SYSTEM";
    }
    return "?";
}

/// Một dòng nhật ký
struct LogEntry {
    uint32_t    id       = 0;
    time_t      ts       = 0;      ///< thời điểm (epoch, giờ Việt Nam khi hiển thị)
    uint32_t    uptimeMs = 0;
    EventType   type     = EV_BOOT;
    EventSource source   = SRC_SYSTEM;
    SysState    state    = ST_BOOT;
    char        note[64] = {0};    ///< ghi chú thêm (vd: thời gian phản hồi)
};
