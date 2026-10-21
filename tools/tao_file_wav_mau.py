#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tạo 3 file WAV mẫu trong thư mục data/ để thử ngay đường tín hiệu âm thanh
(ESP32-S3 -> I2S -> MAX98357A -> loa) khi chưa thu được giọng nói thật.

    python tools/tao_file_wav_mau.py

Sau đó nạp vào LittleFS:   pio run -t uploadfs

=== KHI ĐÃ THU ĐƯỢC GIỌNG NÓI THẬT ===
Thu bằng điện thoại, chép về máy rồi chuyển đúng định dạng mà firmware cần
(WAV PCM 16-bit, 16000 Hz, 1 kênh) bằng ffmpeg:

    ffmpeg -i ghiam.m4a -ar 16000 -ac 1 -c:a pcm_s16le data/ask.wav

Nội dung gợi ý cho từng file:
    ask.wav    "Ông bà có ổn không? Nếu ổn, xin hãy bấm nút màu xanh."
    ok.wav     "Đã ghi nhận. Cảm ơn ông bà."
    alert.wav  "Hệ thống đang gọi người thân, xin chờ trong giây lát."

Lưu ý: file càng dài càng tốn flash. Với 16 kHz mono thì 1 giây ~ 32 KB,
phân vùng LittleFS trong đồ án này gần 8 MB nên hoàn toàn đủ.
"""

import math
import os
import struct
import wave

RATE = 16000  # tần số lấy mẫu (Hz) - khớp với ghi chú trong config.h


def tone(freq, ms, volume=0.45, fade_ms=12):
    """Tạo một đoạn hình sin có vuốt biên độ ở hai đầu để không bị tiếng 'tách'."""
    n = int(RATE * ms / 1000)
    fade = max(1, int(RATE * fade_ms / 1000))
    out = []
    for i in range(n):
        amp = volume
        if i < fade:
            amp *= i / fade
        elif i > n - fade:
            amp *= (n - i) / fade
        out.append(int(amp * 32767 * math.sin(2 * math.pi * freq * i / RATE)))
    return out


def silence(ms):
    return [0] * int(RATE * ms / 1000)


def write_wav(path, samples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)       # mono
        w.setsampwidth(2)       # 16-bit
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", s) for s in samples))
    secs = len(samples) / RATE
    print(f"  {path:22s} {secs:4.2f} giay  {os.path.getsize(path) / 1024:6.1f} KB")


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    data = os.path.join(root, "data")
    print("Dang tao file WAV mau:")

    # ask.wav - hai hồi "ding-dong" dịu, lặp 2 lần để người già dễ nhận ra
    ask = []
    for _ in range(2):
        ask += tone(784, 320) + silence(40) + tone(523, 420) + silence(320)
    write_wav(os.path.join(data, "ask.wav"), ask)

    # ok.wav - hai tiếng đi lên, nghĩa là "đã ghi nhận"
    write_wav(os.path.join(data, "ok.wav"),
              tone(659, 130) + silence(50) + tone(988, 220))

    # alert.wav - ba tiếng gấp, cao, nghĩa là "đang gọi người thân"
    alert = []
    for _ in range(3):
        alert += tone(1175, 160, volume=0.55) + silence(90)
    write_wav(os.path.join(data, "alert.wav"), alert)

    print("Xong. Nap vao board bang lenh:  pio run -t uploadfs")


if __name__ == "__main__":
    main()
