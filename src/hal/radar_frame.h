/**
 * @file  radar_frame.h
 * @brief Bộ mã hóa / giải mã khung dữ liệu UART của radar C1001 (SEN0623).
 *
 * VÌ SAO PHẢI TỰ VIẾT PHẦN NÀY?
 *   Thư viện DFRobot_HumanDetection đọc theo kiểu hỏi – đáp, bên trong có
 *   delay(50) cho MỖI byte nhận được. Một câu lệnh vì thế mất 0,5–0,7 giây.
 *   Muốn biết đủ 6 thông tin thì một vòng đọc mất 3–4 giây, tức là trễ phát
 *   hiện té ngã bị cộng thêm tới 4 giây — quá nhiều với một hệ thống cảnh báo.
 *
 *   Bộ giải mã dưới đây không chặn: nạp từng byte vừa đến, khi nào đủ một khung
 *   hợp lệ thì trả về. Nhờ vậy vừa đọc được các khung mô-đun tự báo, vừa nhận
 *   được trả lời của câu lệnh ta gửi, mà không mất một mili-giây chờ đợi nào.
 *
 * ĐỊNH DẠNG KHUNG (giống ở cả hai chiều gửi và nhận)
 *
 *   ┌──────┬──────┬──────┬──────┬───────┬───────┬────────────┬──────┬──────┬──────┐
 *   │ 0x53 │ 0x59 │ ctrl │ cmd  │ len_h │ len_l │ data[len]  │ csum │ 0x54 │ 0x43 │
 *   └──────┴──────┴──────┴──────┴───────┴───────┴────────────┴──────┴──────┴──────┘
 *
 *   csum = tổng tất cả các byte đứng trước nó, lấy 8 bit thấp.
 *
 * QUY ƯỚC MÃ LỆNH (đọc ra từ mã nguồn thư viện chính chủ trong lib/)
 *   Lệnh ĐỌC dùng cmd có bit cao bật (0x81, 0x82…), còn khung mô-đun TỰ BÁO
 *   dùng cmd không có bit cao (0x01, 0x02…). Bộ giải mã nhận cả hai dạng.
 */
#pragma once
#include <Arduino.h>

namespace RadarFrame {

// --- Byte mở đầu và kết thúc khung ---
constexpr uint8_t HEAD_1 = 0x53;
constexpr uint8_t HEAD_2 = 0x59;
constexpr uint8_t TAIL_1 = 0x54;
constexpr uint8_t TAIL_2 = 0x43;

// --- Nhóm lệnh (control) ---
constexpr uint8_t CTRL_HUMAN   = 0x80;  ///< thông tin về người trong phòng
constexpr uint8_t CTRL_BREATHE = 0x81;  ///< nhịp thở (chỉ ở chế độ giấc ngủ)
constexpr uint8_t CTRL_FALL    = 0x83;  ///< thông tin liên quan té ngã
constexpr uint8_t CTRL_SLEEP   = 0x84;  ///< trạng thái giấc ngủ (chế độ giấc ngủ)
constexpr uint8_t CTRL_HEART   = 0x85;  ///< nhịp tim (chỉ ở chế độ giấc ngủ)

// --- Mã lệnh, ghi theo dạng KHÔNG có bit cao; so sánh thì bỏ bit 0x80 đi ---
constexpr uint8_t CMD_PRESENCE   = 0x01;  ///< 0 = không người, 1 = có người
constexpr uint8_t CMD_MOTION     = 0x02;  ///< 0 không, 1 nằm/ngồi im, 2 hoạt động
constexpr uint8_t CMD_BODY_MOVE  = 0x03;  ///< biên độ chuyển động 0..100
constexpr uint8_t CMD_DISTANCE   = 0x04;  ///< khoảng cách, 2 byte, đơn vị cm
constexpr uint8_t CMD_SEAT_DIST  = 0x0D;  ///< khoảng cách ngang khi ngồi
constexpr uint8_t CMD_MOVE_DIST  = 0x0E;  ///< khoảng cách ngang khi di chuyển

constexpr uint8_t CMD_FALL_STATE = 0x01;  ///< 0 = không ngã, 1 = đã ngã
constexpr uint8_t CMD_STATIC_RES = 0x05;  ///< nằm im một chỗ quá lâu
constexpr uint8_t CMD_TRACK      = 0x0E;  ///< điểm quỹ đạo (x, y), 4 byte
constexpr uint8_t CMD_BREAK_HIGH = 0x11;  ///< ngưỡng chiều cao coi là ngã

// --- Mã lệnh của CHẾ ĐỘ GIẤC NGỦ (chỉ dùng được khi mô-đun ở eSleepMode) ---
constexpr uint8_t CMD_BREATHE_STATE = 0x01;  ///< nhóm 0x81: 1 bình thường, 2 nhanh, 3 chậm, 4 không thấy
constexpr uint8_t CMD_BREATHE_VALUE = 0x02;  ///< nhóm 0x81: số lần thở mỗi phút
constexpr uint8_t CMD_HEART_RATE    = 0x02;  ///< nhóm 0x85: số nhịp tim mỗi phút
constexpr uint8_t CMD_IN_BED        = 0x01;  ///< nhóm 0x84: 0 ngoài giường, 1 trên giường
constexpr uint8_t CMD_SLEEP_STATE   = 0x02;  ///< nhóm 0x84: 0 ngủ sâu, 1 ngủ nông, 2 tỉnh, 3 không có người
constexpr uint8_t CMD_SLEEP_SCORE   = 0x10;  ///< nhóm 0x84: điểm chất lượng giấc ngủ 0..100
constexpr uint8_t CMD_STRUGGLE      = 0x11;  ///< nhóm 0x84: 1 = vùng vẫy bất thường

/// Một khung đã giải mã xong và đã kiểm tra tổng kiểm (checksum)
struct Frame {
    uint8_t ctrl = 0;
    uint8_t cmd  = 0;       ///< giữ nguyên như nhận được (có thể có bit cao)
    uint8_t len  = 0;
    uint8_t data[24] = {0};

    /// Mã lệnh đã bỏ bit cao, để so sánh với các hằng số CMD_* ở trên
    uint8_t baseCmd() const { return cmd & 0x7F; }
    bool    is(uint8_t c, uint8_t baseCommand) const {
        return ctrl == c && baseCmd() == baseCommand;
    }
    /// Số nguyên 16 bit từ 2 byte dữ liệu đầu (thứ tự byte cao trước)
    uint16_t u16() const { return (uint16_t)((data[0] << 8) | data[1]); }
};

/// Tổng kiểm: cộng dồn tất cả byte rồi lấy 8 bit thấp
uint8_t checksum(const uint8_t* buf, size_t len);

/**
 * Tạo khung lệnh để gửi xuống radar.
 * @param out     bộ đệm đích, cần ít nhất 9 + len byte
 * @param ctrl    nhóm lệnh (CTRL_*)
 * @param cmd     mã lệnh ĐẦY ĐỦ, ví dụ 0x81 để đọc trạng thái hiện diện
 * @param data    dữ liệu kèm theo (lệnh đọc thường gửi một byte 0x0F)
 * @return số byte đã ghi vào out, hoặc 0 nếu bộ đệm quá nhỏ
 */
size_t build(uint8_t* out, size_t cap, uint8_t ctrl, uint8_t cmd,
             const uint8_t* data, size_t len);

/// Tạo khung ĐỌC (gửi kèm một byte 0x0F như thư viện chính chủ vẫn làm)
size_t buildRead(uint8_t* out, size_t cap, uint8_t ctrl, uint8_t cmd);

/**
 * Bộ giải mã khung, nạp vào từng byte một.
 *
 * Cách dùng:
 * @code
 *   RadarFrame::Parser parser;
 *   RadarFrame::Frame  frame;
 *   while (Serial1.available()) {
 *       if (parser.feed(Serial1.read(), frame)) handleFrame(frame);
 *   }
 * @endcode
 *
 * CÁCH LÀM: GOM VÀO BỘ ĐỆM RỒI DÒ LẠI ĐẦU KHUNG
 *   Phiên bản đầu tôi viết theo kiểu máy trạng thái đọc thẳng từng byte, và nó
 *   có một lỗi thật: nếu một khung bị cắt giữa đường (nhiễu, mất byte) thì byte
 *   0x53 mở đầu khung KẾ TIẾP sẽ bị ăn mất vào ô "độ dài", làm mất luôn cả khung
 *   sau đó. Bài kiểm thử "khung bị cắt giữa đường" đã lộ ra lỗi này.
 *
 *   Nên bộ giải mã gom byte vào một bộ đệm nhỏ, rồi tìm cặp 0x53 0x59 trong đó.
 *   Khi một khung không hợp lệ, nó chỉ bỏ ĐÚNG MỘT byte mở đầu giả rồi dò lại từ
 *   byte kế tiếp — nhờ vậy không bao giờ làm mất khung đứng sau.
 */
class Parser {
public:
    /// Nạp một byte. Trả về true (và điền `out`) khi vừa nhận đủ một khung hợp lệ.
    bool feed(uint8_t byte, Frame& out);

    uint32_t goodFrames() const { return _good; }
    /// Số lần phải bỏ byte vì sai tổng kiểm / lệch khung — dùng để đo chất lượng dây
    uint32_t badFrames()  const { return _bad; }
    void     reset()            { _len = 0; }

private:
    /// Thử lấy một khung hợp lệ ra khỏi bộ đệm. Trả về true nếu được.
    bool extract(Frame& out);
    /// Bỏ `n` byte ở đầu bộ đệm
    void drop(uint8_t n);

    static constexpr uint8_t HEADER_BYTES = 6;   ///< 2 mở đầu + ctrl + cmd + 2 độ dài
    static constexpr uint8_t OVERHEAD     = 9;   ///< header + tổng kiểm + 2 byte kết
    static constexpr uint8_t BUF_CAP      = 64;  ///< khung dài nhất là 9 + 24 = 33 byte

    uint8_t  _buf[BUF_CAP] = {0};
    uint8_t  _len  = 0;
    uint32_t _good = 0;
    uint32_t _bad  = 0;
};

}  // namespace RadarFrame
