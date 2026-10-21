# -*- coding: utf-8 -*-
"""Port tung dong cua RadarFrame::Parser ban BO DEM (src/radar_frame.cpp)."""

H1, H2, T1, T2 = 0x53, 0x59, 0x54, 0x43
DATA_CAP = 24
HEADER_BYTES = 6
OVERHEAD = 9
BUF_CAP = 64


def checksum(buf):
    return sum(buf) & 0xFF


def build(ctrl, cmd, data=b"\x0f"):
    body = bytes([H1, H2, ctrl, cmd, 0, len(data)]) + bytes(data)
    return body + bytes([checksum(body), T1, T2])


class Parser:
    def __init__(self):
        self.buf = bytearray()
        self.good = 0
        self.bad = 0

    def drop(self, n):
        if n >= len(self.buf):
            self.buf = bytearray()
        else:
            del self.buf[:n]

    def feed(self, byte):
        if len(self.buf) >= BUF_CAP:
            self.drop(1)
        self.buf.append(byte)
        return self.extract()

    def extract(self):
        while True:
            start = -1
            for i in range(max(0, len(self.buf) - 1)):
                if self.buf[i] == H1 and self.buf[i + 1] == H2:
                    start = i
                    break
            if start < 0:
                if len(self.buf) > 1:
                    self.drop(len(self.buf) - 1)
                if len(self.buf) == 1 and self.buf[0] != H1:
                    self.buf = bytearray()
                return None
            if start > 0:
                self.drop(start)

            if len(self.buf) < HEADER_BYTES:
                return None

            lenH, lenL = self.buf[4], self.buf[5]
            if lenH != 0 or lenL > DATA_CAP:
                self.bad += 1
                self.drop(1)
                continue

            total = OVERHEAD + lenL
            if len(self.buf) < total:
                return None

            want = checksum(self.buf[: HEADER_BYTES + lenL])
            valid = (self.buf[HEADER_BYTES + lenL] == want
                     and self.buf[total - 2] == T1
                     and self.buf[total - 1] == T2)
            if not valid:
                self.bad += 1
                self.drop(1)
                continue

            out = (self.buf[2], self.buf[3],
                   bytes(self.buf[HEADER_BYTES:HEADER_BYTES + lenL]))
            self.good += 1
            self.drop(total)
            return out


def run(name, stream, expect, expect_bad=None):
    p = Parser()
    got = []
    for b in stream:
        r = p.feed(b)
        if r:
            got.append(r)
    ok = got == expect and (expect_bad is None or p.bad == expect_bad)
    print(("  PASS  " if ok else "  FAIL  ") + name)
    if not ok:
        print("        nhan:", got, "bad =", p.bad)
        print("        doi :", expect, "bad =", expect_bad)
    return ok


print("Kiem chung RadarFrame::Parser (ban bo dem)")
ok = True
f_fall = build(0x83, 0x81, b"\x01")
F_FALL = (0x83, 0x81, b"\x01")

ok &= run("khung hop le", f_fall, [F_FALL], 0)
ok &= run("khung tu bao 0x80/0x01", build(0x80, 0x01, b"\x01"), [(0x80, 0x01, b"\x01")], 0)
ok &= run("rac truoc khung", bytes([0, 0xFF, 0xAA, 0x12]) + f_fall, [F_FALL], 0)
ok &= run("hai khung lien tiep", f_fall + build(0x80, 0x84, b"\x01\x2c"),
          [F_FALL, (0x80, 0x84, b"\x01\x2c")], 0)

bad = bytearray(f_fall); bad[-3] ^= 0xFF
ok &= run("sai checksum roi khung tot", bytes(bad) + f_fall, [F_FALL])

ok &= run("0x53 lap truoc khung", bytes([H1]) + f_fall, [F_FALL], 0)
ok &= run("len_h khac 0", bytes([H1, H2, 0x80, 0x81, 1, 1, 1, 0, T1, T2]) + f_fall, [F_FALL])

# Day la ca da lam lo ra loi o ban truoc
ok &= run("khung bi cat giua duong", f_fall[:5] + f_fall, [F_FALL])
ok &= run("khung bi cat o nhieu diem",
          f_fall[:3] + f_fall[:7] + f_fall + f_fall[:2] + f_fall,
          [F_FALL, F_FALL])

ok &= run("khung quy dao 4 byte", build(0x83, 0x8E, b"\x01\x02\x03\x04"),
          [(0x83, 0x8E, b"\x01\x02\x03\x04")], 0)
ok &= run("khung len = 0", build(0x80, 0x81, b""), [(0x80, 0x81, b"")], 0)
ok &= run("do dai vo ly len=99", bytes([H1, H2, 0x80, 0x81, 0, 99]) + f_fall, [F_FALL])
ok &= run("0x53 0x59 gia trong du lieu",
          build(0x83, 0x8E, b"\x53\x59\x03\x04") + f_fall,
          [(0x83, 0x8E, b"\x53\x59\x03\x04"), F_FALL], 0)

# Tran bo dem: rac rat dai roi moi den khung thuc
ok &= run("64+ byte rac roi khung thuc", bytes([0x11] * 80) + f_fall, [F_FALL])

# Byte le 0x53 o cuoi luong phai duoc giu lai cho khung sau
p = Parser()
for b in bytes([H1]):
    p.feed(b)
kept = len(p.buf) == 1 and p.buf[0] == H1
print(("  PASS  " if kept else "  FAIL  ") + "giu lai 0x53 le o cuoi luong")
ok &= kept

ok &= run("kiem tra khong mat khung khi dinh 3 khung",
          f_fall + f_fall + f_fall, [F_FALL, F_FALL, F_FALL], 0)

print()
print("KET QUA:", "TAT CA PASS" if ok else "CO BAI FAIL")
