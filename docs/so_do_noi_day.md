# Sơ đồ nối dây, lưu đồ và máy trạng thái

Tài liệu này viết để chép thẳng vào **chương 3 (Thiết kế)** của báo cáo. Khi vẽ
lại bằng Fritzing hoặc EasyEDA, hãy dùng đúng các bảng dưới đây.

---

## 1. Sơ đồ khối

```
                           ┌──────────────── Nguồn Adapter 5V / 2A ────────────────┐
                           │                                                      │
                   5V ─────┼──────────┬──────────────┬──────────────┐             │
                           │          │              │              │             │
                      ┌────┴─────┐ ┌──┴───────┐ ┌────┴─────┐  ┌─────┴──────┐      │
                      │  Radar   │ │ ESP32-S3 │ │MAX98357A │  │ Tụ lọc     │      │
                      │  C1001   │ │  N16R8   │ │   (I2S)  │  │470–1000µF  │      │
                      └────┬─────┘ └──┬───┬───┘ └────┬─────┘  └─────┬──────┘      │
                           │          │   │          │              │             │
                   UART1 ──┘          │   └── I2S ───┘         Loa 3W 4Ω          │
                (GPIO18/17)           │                                           │
                                      ├── GPIO15 ── Nút xanh "Tôi ổn" ── GND      │
                                      ├── GPIO16 ── Nút đỏ  "SOS"     ── GND      │
                                      ├── GPIO10/11/12 ── LED xanh/vàng/đỏ ──┐    │
                                      ├── GPIO13 ── Còi buzzer               │    │
                                      ├── GPIO14 ── Mạch thu RF 433 MHz      │    │
                                      │             ◄~~~ nút SOS đeo tay     │    │
                                      │                              R 220Ω ─┘    │
                   GND ────────────────┴──────────────────────────────────────────┘
                                      │
                                      └── Wi-Fi 2,4 GHz ──► Bot Telegram
                                                        └──► Trang web giám sát
```

Điểm quan trọng: **tất cả các khối phải chung một điểm GND**. Thiếu chung GND là
nguyên nhân số một làm UART đọc ra rác và loa kêu rè.

---

## 2. Bảng nối dây chi tiết

### 2.1. Radar C1001 (SEN0623) — giao tiếp UART

| Chân radar | Chân ESP32-S3 | Màu dây gợi ý | Ghi chú |
|---|---|---|---|
| VCC | 5V | đỏ | Dòng tiêu thụ ≤ 100 mA |
| GND | GND | đen | |
| TX (radar gửi) | **GPIO18** = RX của ESP32 | vàng | |
| RX (radar nhận) | **GPIO17** = TX của ESP32 | xanh lá | |

Tốc độ UART cố định **115200, 8N1**.

> **Phải đo trước khi nối.** Dùng đồng hồ vạn năng đo điện áp chân TX của radar
> lúc nó đang phát dữ liệu. Nếu là 3,3V thì nối trực tiếp. Nếu là 5V thì bắt buộc
> thêm cầu chia áp, vì chân vào của ESP32 chỉ chịu 3,3V:
>
> ```
>   Radar TX ──[ 1k8 ]──┬──► GPIO18 (ESP32)
>                       │
>                     [ 3k3 ]
>                       │
>                      GND
> ```

Vì radar gắn trên cao (2,4–2,8 m) nên dùng dây 4 lõi dài 2–3 m. Dây dài dễ nhiễu:
xoắn đôi dây tín hiệu với dây GND, và nhớ gắn tụ 470–1000 µF/16V ngay tại chân
nguồn của radar.

### 2.2. MAX98357A — giao tiếp I2S

| Chân | Nối tới | Ghi chú |
|---|---|---|
| VIN | 5V | Dùng 5V cho loa to hơn |
| GND | GND | |
| BCLK | GPIO4 | xung đồng hồ bit |
| LRC | GPIO5 | chọn kênh trái/phải |
| DIN | GPIO6 | dữ liệu âm thanh |
| GAIN | để trống | mặc định 9 dB |
| SD | để trống | chế độ trộn (L+R)/2 — đúng với firmware này |
| OUT+ / OUT− | loa 3W 4Ω | **không** nối chân nào của loa xuống GND |

### 2.3. Nút nhấn, LED, còi

| Thiết bị | Chân | Cách nối |
|---|---|---|
| Nút xanh “Tôi ổn” | GPIO15 | một chân nút → GPIO15, chân còn lại → GND |
| Nút đỏ “SOS” | GPIO16 | như trên |
| LED xanh | GPIO10 | GPIO → điện trở 220 Ω → anode LED, cathode → GND |
| LED vàng | GPIO11 | như trên |
| LED đỏ | GPIO12 | như trên |
| Còi buzzer | GPIO13 | loại thụ động (firmware tự phát tần số 2–2,6 kHz) |
| Mạch thu RF 433 MHz | GPIO14 | xem mục 2.4 bên dưới |

Firmware bật điện trở kéo lên bên trong ESP32 (`INPUT_PULLUP`) nên **không cần**
gắn thêm điện trở ngoài cho nút. Chống dội phím làm bằng phần mềm (40 ms).

### 2.4. Mạch thu RF 433 MHz (nút SOS đeo tay)

| Chân mạch thu | Nối tới | Ghi chú |
|---|---|---|
| VCC | **3V3** | Cấp 3,3V chứ không phải 5V, để chân DATA xuất đúng mức 3,3V |
| GND | GND | |
| DATA | GPIO14 | firmware gắn ngắt (interrupt) vào chân này |
| ANT | dây đồng **17,3 cm** | ăng-ten 1/4 bước sóng của 433 MHz |

Thiếu đoạn dây ăng-ten thì tầm thu chỉ còn vài mét thay vì 20–50 m. Dùng loại
**siêu ngoại sai** (RXB6 / SRX882); loại siêu tái sinh rẻ tiền (MX-RM-5V) nhiễu
nặng và hay tự kích.

```
    Nút đeo tay                Mạch thu RXB6              ESP32-S3
   ┌───────────┐  sóng 433MHz  ┌─────────────┐            ┌──────────┐
   │  [ SOS ]  │ ~~~~~~~~~~~~► │ ANT ── 17,3cm│           │          │
   │ pin CR2032│               │ DATA ────────┼──────────►│ GPIO14   │
   │  ~1 năm   │               │ VCC ─────────┼──────────►│ 3V3      │
   └───────────┘               │ GND ─────────┼──────────►│ GND      │
                               └─────────────┘            └──────────┘
```

---

### 2.5. Các chân không được dùng

| Chân | Lý do |
|---|---|
| GPIO 0, 3, 45, 46 | chân chọn chế độ khởi động (strapping) |
| GPIO 35, 36, 37 | board N16R8 dùng cho PSRAM 8MB |
| GPIO 19, 20 | USB D−/D+ |
| GPIO 26–32 | nối với chip flash SPI |

---

## 3. Lưu đồ quy trình cảnh báo

```
                        ┌──────────────────────────┐
                        │ Task radar đọc liên tục  │
                        │   (chu kỳ 500 ms)        │
                        └────────────┬─────────────┘
                                     │ cờ ngã chuyển 0 → 1
                                     ▼
                           ┌──────────────────┐     Có
                           │ Đang trong thời  ├────────► Ghi nhật ký "bỏ qua"
                           │ gian nghỉ 60 s ? │          rồi kết thúc
                           └────────┬─────────┘
                                    │ Không
                                    ▼
                        ┌───────────────────────────┐
                        │  Vào NGHI_NGỜ_TÉ_NGÃ      │
                        │  • LED vàng nháy, còi bíp │
                        │  • phát ask.wav           │
                        │  • bắt đầu đếm 30 giây    │
                        └───────────┬───────────────┘
                                    │
            ┌───────────────────────┼─────────────────────────┐
            │                       │                         │
   bấm nút xanh              mỗi 10 giây                hết 30 giây
            │                       │                  hoặc bấm SOS
            ▼                       ▼                         ▼
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
   │ Ghi log kèm thời │   │ Phát lại câu hỏi │   │ Vào KHẨN_CẤP             │
   │ gian phản hồi    │   │ thăm (tối đa 4   │   │ • LED đỏ, còi gấp        │
   │ Nghỉ 60 giây     │   │ lần)             │   │ • đẩy tin vào hàng đợi   │
   │ Về CÓ_NGƯỜI      │   └──────────────────┘   │ • task gửi Telegram      │
   └──────────────────┘                          │ • ghi log trễ cảnh báo   │
                                                 └────────────┬─────────────┘
                                                              │ bấm nút xanh
                                                              ▼
                                                 ┌──────────────────────────┐
                                                 │ Gửi tin "đã an toàn"     │
                                                 │ Về CÓ_NGƯỜI              │
                                                 └──────────────────────────┘
```

---

## 4. Bảng máy trạng thái

| Trạng thái | Điều kiện vào | Hành động trong trạng thái | Chuyển tiếp |
|---|---|---|---|
| `KHOI_DONG` | vừa cấp nguồn | LED vàng nháy nhanh | khi radar có dữ liệu → `KHONG_NGUOI` / `CO_NGUOI` |
| `KHONG_NGUOI` | radar báo không có người | LED xanh nháy ngắn mỗi 3 s | thấy người → `CO_NGUOI`; cờ ngã → `NGHI_NGO_TE_NGA` |
| `CO_NGUOI` | radar báo có người | LED xanh sáng liên tục | không còn người → `KHONG_NGUOI`; cờ ngã (ngoài thời gian nghỉ) → `NGHI_NGO_TE_NGA` |
| `NGHI_NGO_TE_NGA` | radar báo té ngã | phát loa hỏi thăm, LED vàng nháy, còi bíp chậm, đếm ngược 30 s | bấm “Tôi ổn” → `CO_NGUOI` (nghỉ 60 s); hết giờ → `KHAN_CAP` |
| `KHAN_CAP` | hết thời gian chờ **hoặc** bấm SOS ở bất kỳ trạng thái nào | LED đỏ nháy, còi gấp, gửi Telegram, phát alert.wav | chỉ thoát khi bấm “Tôi ổn” → `CO_NGUOI` |

Trạng thái `KHAN_CAP` **cố ý không tự thoát** sau một khoảng thời gian: nếu người
bị ngã đã ngất thì hệ thống phải giữ báo động cho tới khi có người tới xác nhận.
Đây là một chi tiết nên nói rõ khi bảo vệ.

---

## 5. Thông số cần ghi vào báo cáo

| Thông số | Giá trị mặc định | Khai báo tại |
|---|---|---|
| Chiều cao lắp radar | 270 cm | `RADAR_INSTALL_HEIGHT_CM` |
| Độ nhạy phát hiện ngã | 3 (cao nhất) | `RADAR_FALL_SENSITIVITY` |
| Thời gian radar xác nhận ngã | 5 giây | `RADAR_FALL_TIME_S` |
| Chu kỳ đọc radar | 500 ms | `RADAR_POLL_INTERVAL_MS` |
| Thời gian chờ người dùng phản hồi | 30 giây | `CONFIRM_WINDOW_S` |
| Chu kỳ phát lại câu hỏi thăm | 10 giây | `VOICE_REPEAT_EVERY_S` |
| Thời gian nghỉ sau khi hủy báo động | 60 giây | `FALL_COOLDOWN_S` |
| Chống dội phím | 40 ms | `BTN_DEBOUNCE_MS` |
| Định dạng file âm thanh | WAV PCM 16-bit, 16 kHz, mono | `data/*.wav` |
| Tốc độ UART với radar | 115200 8N1 | `RADAR_BAUD` |

Tất cả nằm trong một file duy nhất: `include/config.h`. Khi thực nghiệm ở hai mức
độ nhạy hoặc hai chiều cao lắp đặt (để có số liệu so sánh), chỉ cần sửa file này
rồi nạp lại firmware.
