#include "radar_frame.h"

namespace RadarFrame {

uint8_t checksum(const uint8_t* buf, size_t len) {
    uint16_t sum = 0;
    for (size_t i = 0; i < len; ++i) sum += buf[i];
    return (uint8_t)(sum & 0xFF);
}

size_t build(uint8_t* out, size_t cap, uint8_t ctrl, uint8_t cmd,
             const uint8_t* data, size_t len) {
    const size_t total = 9 + len;
    if (cap < total || len > 24) return 0;

    out[0] = HEAD_1;
    out[1] = HEAD_2;
    out[2] = ctrl;
    out[3] = cmd;
    out[4] = (uint8_t)((len >> 8) & 0xFF);
    out[5] = (uint8_t)(len & 0xFF);
    for (size_t i = 0; i < len; ++i) out[6 + i] = data[i];
    out[6 + len] = checksum(out, 6 + len);
    out[7 + len] = TAIL_1;
    out[8 + len] = TAIL_2;
    return total;
}

size_t buildRead(uint8_t* out, size_t cap, uint8_t ctrl, uint8_t cmd) {
    const uint8_t probe = 0x0F;   // byte giữ chỗ, giống thư viện chính chủ
    return build(out, cap, ctrl, cmd, &probe, 1);
}

void Parser::drop(uint8_t n) {
    if (n >= _len) {
        _len = 0;
        return;
    }
    for (uint8_t i = 0; i + n < _len; ++i) _buf[i] = _buf[i + n];
    _len -= n;
}

bool Parser::feed(uint8_t byte, Frame& out) {
    if (_len >= BUF_CAP) drop(1);   // bộ đệm đầy mà chưa ra khung nào -> trượt đi 1 byte
    _buf[_len++] = byte;
    return extract(out);
}

bool Parser::extract(Frame& out) {
    while (true) {
        // 1. Dò cặp byte mở đầu 0x53 0x59, bỏ mọi thứ đứng trước nó
        int start = -1;
        for (uint8_t i = 0; i + 1 < _len; ++i) {
            if (_buf[i] == HEAD_1 && _buf[i + 1] == HEAD_2) {
                start = i;
                break;
            }
        }
        if (start < 0) {
            // Chưa thấy đầu khung. Giữ lại byte cuối vì nó có thể là 0x53 mở đầu.
            if (_len > 1) drop((uint8_t)(_len - 1));
            if (_len == 1 && _buf[0] != HEAD_1) _len = 0;
            return false;
        }
        if (start > 0) drop((uint8_t)start);   // byte rác đứng trước đầu khung

        // 2. Chờ đủ phần header mới biết được độ dài
        if (_len < HEADER_BYTES) return false;

        const uint8_t lenH = _buf[4];
        const uint8_t lenL = _buf[5];
        if (lenH != 0 || lenL > sizeof(out.data)) {
            // Độ dài vô lý -> đây là đầu khung giả, bỏ 1 byte rồi dò lại
            _bad++;
            drop(1);
            continue;
        }

        const uint8_t total = (uint8_t)(OVERHEAD + lenL);
        if (_len < total) return false;        // chưa nhận đủ, chờ thêm byte

        // 3. Kiểm tổng kiểm và 2 byte kết thúc
        const uint8_t wantCsum = checksum(_buf, (size_t)(HEADER_BYTES + lenL));
        const bool valid = _buf[HEADER_BYTES + lenL] == wantCsum &&
                           _buf[total - 2] == TAIL_1 &&
                           _buf[total - 1] == TAIL_2;
        if (!valid) {
            _bad++;
            drop(1);
            continue;
        }

        // 4. Khung hợp lệ
        out.ctrl = _buf[2];
        out.cmd  = _buf[3];
        out.len  = lenL;
        for (uint8_t i = 0; i < lenL; ++i) out.data[i] = _buf[HEADER_BYTES + i];
        for (uint8_t i = lenL; i < sizeof(out.data); ++i) out.data[i] = 0;
        _good++;
        drop(total);
        return true;
    }
}

}  // namespace RadarFrame
