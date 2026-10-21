# Hệ thống giám sát và cảnh báo té ngã cho người cao tuổi

Firmware cho đồ án tổng hợp (402114): radar sóng milimet 60 GHz **DFRobot C1001
(SEN0623)** phát hiện té ngã, **ESP32-S3** chạy quy trình cảnh báo (loa hỏi thăm
→ chờ nút bấm → gửi cảnh báo đa kênh: Telegram + Email + Zalo) kèm trang web
giám sát tự phục vụ.

```
   ┌──────────────┐  UART 115200   ┌────────────────────┐   I2S    ┌───────────┐
   │ Radar C1001  │ ─────────────► │                    │ ───────► │ MAX98357A │──► Loa 3W
   │   60 GHz     │  có người /    │     ESP32-S3       │          └───────────┘
   │ (gắn trần)   │  té ngã        │   (N16R8)          │
   └──────────────┘                │                    │ ───────► LED xanh/vàng/đỏ + còi
                                   │  • máy trạng thái  │
   Nút xanh "Tôi ổn" ─────GPIO───► │  • web + WebSocket │ ◄─────── trình duyệt điện thoại
   Nút đỏ  "SOS"    ─────GPIO───► │  • nhật ký LittleFS│
                                   └─────────┬──────────┘
                                             │ Wi-Fi + HTTPS
                                             ▼
                              Telegram + Email (Resend) + Zalo OA → người thân
                              (Telegram còn chat hai chiều: hỏi là bot trả lời)
```

---

Hệ thống gồm **hai phần chạy độc lập nhau**:

| Phần | Ngôn ngữ | Chạy ở đâu | Vai trò |
|---|---|---|---|
| **Firmware** (thư mục gốc) | C++ | ESP32-S3 | Toàn bộ chức năng an toàn: đọc radar, loa hỏi thăm, nút bấm, gửi cảnh báo đa kênh (Telegram + Email + Zalo), chat hai chiều qua Telegram, trang web cơ bản |
| **Dashboard** ([dashboard/](dashboard/)) | TypeScript / Next.js | Laptop | Lưu lịch sử dài hạn + đo và tính số liệu thực nghiệm cho báo cáo |

Dashboard **không nằm trong đường đi của cảnh báo** — tắt laptop thì hệ thống an
toàn vẫn chạy nguyên vẹn. Xem [dashboard/README.md](dashboard/README.md).

---

## 1. Cấu trúc thư mục

| Đường dẫn | Nội dung |
|---|---|
| `platformio.ini` | Khai báo board, phiên bản thư viện, bảng phân vùng |
| `lib/DFRobot_HumanDetection/` | Thư viện radar chính chủ, đã tải sẵn vào repo (build được khi không có mạng) |
| `dashboard/` | Ứng dụng web phân tích số liệu (Next.js) |
| `include/config.h` | **Toàn bộ thông số chỉnh được**: chân cắm, thời gian chờ, độ nhạy |
| `include/secrets.h` | Wi-Fi, token Telegram, API key Resend (email), Zalo OA, tên người được giám sát (bạn tự tạo) |
| `src/main.cpp` | Điểm vào: máy trạng thái chính + setup/loop, điều phối các layer |
| **`src/core/`** | **Lõi nghiệp vụ — không phụ thuộc phần cứng cụ thể** |
| `src/core/app_types.h` | Kiểu dữ liệu dùng chung (máy trạng thái, sự kiện, snapshot) |
| `src/core/app_api.h` | Cầu nối web ↔ máy trạng thái (chỉ bật cờ, loop xử lý) |
| `src/core/fall_model.*` | Model hồi quy logistic tự huấn luyện, chạy trên ESP32 |
| **`src/hal/`** | **Lớp chạm phần cứng (Hardware Abstraction Layer)** |
| `src/hal/radar.*` | Đọc radar C1001 trong task riêng ở core 0 |
| `src/hal/radar_frame.*` | Bộ mã hóa/giải mã khung UART **không chặn** (tự viết) |
| `src/hal/audio.*` | Phát file WAV qua I2S ra MAX98357A |
| `src/hal/hmi.*` | Nút nhấn (chống dội), 3 LED, còi buzzer |
| `src/hal/rf_remote.*` | Nhận nút SOS đeo tay qua sóng 433 MHz |
| **`src/net/`** | **Mạng** |
| `src/net/notifier.*` | Gửi cảnh báo đa kênh (Telegram + Email Resend + Zalo OA) + hàng đợi chống mất tin khi rớt mạng |
| `src/net/web_ui.*` | Máy chủ web + WebSocket + các API |
| **`src/storage/`** | **Lưu trữ** |
| `src/storage/event_log.*` | Nhật ký sự kiện trong LittleFS, xuất CSV cho Excel |
| `include/model_weights.h` | Trọng số model — sinh ra từ notebook `tools/kaggle/huan_luyen_model_te_nga.ipynb` |
| `tools/kaggle/` | Notebook huấn luyện model trên Kaggle (bản `.py` y hệt để chạy trên máy) |
| `data/index.html` | Trang giám sát (nạp vào LittleFS) |
| `data/*.wav` | Câu hỏi thăm phát ra loa |
| `tools/` | Script tạo WAV mẫu, 2 mẫu bảng số liệu thực nghiệm |
| `docs/` | Sơ đồ nối dây và bảng máy trạng thái để đưa vào chương 3 báo cáo |

---

## 2. Sơ đồ nối dây

### Radar C1001 → ESP32-S3
| Chân radar | Nối tới | Ghi chú |
|---|---|---|
| VCC | **5V** | Dòng ≤ 100 mA. Gắn tụ 470–1000 µF/16V sát chân này |
| GND | GND | Phải chung GND với ESP32 |
| TX | **GPIO18** (ESP32 nhận) | Đo mức logic trước: nếu là 5V thì thêm cầu chia áp 1k8/3k3 |
| RX | **GPIO17** (ESP32 gửi) | |

### MAX98357A → ESP32-S3
| Chân | Nối tới |
|---|---|
| VIN | 5V |
| GND | GND |
| BCLK | GPIO4 |
| LRC | GPIO5 |
| DIN | GPIO6 |
| SD | để trống (chế độ trộn trái+phải) |
| Loa +/− | loa 3W 4Ω |

### Nút, LED, còi
| Thiết bị | Chân | Cách nối |
|---|---|---|
| Nút xanh “Tôi ổn” | GPIO15 | một đầu vào chân, đầu kia xuống **GND** (dùng pull-up nội) |
| Nút đỏ “SOS” | GPIO16 | như trên |
| LED xanh | GPIO10 | qua điện trở 220 Ω xuống GND |
| LED vàng | GPIO11 | qua điện trở 220 Ω |
| LED đỏ | GPIO12 | qua điện trở 220 Ω |
| Còi buzzer | GPIO13 | đặt `PIN_BUZZER = -1` trong `config.h` nếu không gắn |
| Mạch thu RF 433 MHz | GPIO14 | **RXB6 / SRX882** (siêu ngoại sai). Cấp **3,3V**, hàn dây ăng-ten 17,3 cm. Đặt `PIN_RF_433 = -1` nếu không gắn |

> **Tránh dùng**: GPIO 0, 3, 45, 46 (chân chọn chế độ khởi động) và GPIO 35–37
> (board N16R8 dùng cho PSRAM). Nếu LED của bạn nối kiểu anode chung thì đặt
> `LED_ACTIVE_LOW = true` trong `config.h`.

Sơ đồ chi tiết hơn: xem [docs/so_do_noi_day.md](docs/so_do_noi_day.md).

---

## 3. Cài đặt và nạp code

**Bước 1 — Cài công cụ.** Cài [VS Code](https://code.visualstudio.com/) rồi cài
extension **PlatformIO IDE**. Lần build đầu PlatformIO tự tải toolchain và thư
viện (khoảng 300–500 MB, cần mạng tốt, chỉ tải một lần).

**Bước 2 — Tạo file thông tin riêng:**

```bat
copy include\secrets.h.example include\secrets.h
```

Mở `include/secrets.h` và điền:
- `WIFI_SSID` / `WIFI_PASSWORD` — ESP32 chỉ bắt được **Wi-Fi 2,4 GHz**.
- `TELEGRAM_BOT_TOKEN` — chat với **@BotFather** trên Telegram → `/newbot`.
- `TELEGRAM_CHAT_ID` — chat một câu với bot vừa tạo, rồi mở
  `https://api.telegram.org/bot<TOKEN>/getUpdates` và lấy số trong `"chat":{"id":...}`.
  Muốn gửi vào nhóm gia đình: thêm bot vào nhóm, chat một câu, chat id sẽ là **số âm**.
- `PATIENT_NAME`, `DEVICE_PLACE` — hiện trong nội dung tin cảnh báo.

**Các kênh cảnh báo (bật kênh nào tùy bạn — để trống thì kênh đó tắt):**

- **Email qua Resend** (tùy chọn): đăng ký ở [resend.com](https://resend.com) (miễn phí
  3.000 email/tháng), tạo API key rồi điền `RESEND_API_KEY`, `EMAIL_TO`.
  **Lưu ý:** khi chưa xác minh tên miền riêng, Resend chỉ cho gửi **từ**
  `onboarding@resend.dev` và **tới chính email đã đăng ký tài khoản**; muốn gửi
  tới email người thân bất kỳ thì phải xác minh tên miền rồi đổi `EMAIL_FROM`.
- **Zalo** (tùy chọn, nâng cao): Zalo **không có API cho tài khoản cá nhân** —
  chỉ **Zalo Official Account (OA)** mới gửi tin hợp lệ. Gửi qua tài khoản cá nhân
  bằng công cụ không chính thức rất dễ bị **khóa tài khoản** nên firmware **không
  hỗ trợ**. Có OA + access token thì điền `ZALO_OA_TOKEN`, `ZALO_USER_ID`.

Mỗi tin cảnh báo được gửi **song song** qua mọi kênh đang bật. Mỗi tin trong hàng
đợi mang một **mặt nạ kênh** (bitmask) cho biết kênh nào còn phải gửi; gửi xong
kênh nào thì tắt bit của kênh đó. Nhờ vậy nếu một kênh tạm lỗi (ví dụ email), lần
thử lại **chỉ gửi lại kênh đó**, không gửi trùng các kênh đã thành công. Để một
kênh hỏng vĩnh viễn không làm kẹt cả hàng đợi, mỗi tin bị **bỏ sau 8 lần thử thất
bại** (ghi lại kênh còn sót vào *Kết quả gửi gần nhất*).

**Bước 3 — Tạo file âm thanh** (hoặc dùng file WAV mẫu đã có trong `data/`):

```bat
python tools\tao_file_wav_mau.py
```

Khi đã thu được giọng nói thật, chuyển đúng định dạng (WAV PCM 16-bit, 16 kHz, mono):

```bat
ffmpeg -i ghiam.m4a -ar 16000 -ac 1 -c:a pcm_s16le data\ask.wav
```

**Bước 4 — Nạp firmware và nạp dữ liệu:**

```bat
pio run -t upload      :: nạp firmware
pio run -t uploadfs    :: nạp thư mục data/ (trang web + file WAV) vào LittleFS
pio device monitor     :: xem log, Ctrl+C để thoát
```

> `uploadfs` là bước **rất hay bị quên**. Thiếu nó thì mở trang web sẽ thấy dòng
> “Chưa nạp giao diện web”, và loa chỉ phát tiếng bíp thay vì câu hỏi thăm.

**Bước 5 — Mở trang giám sát.** Cổng serial in ra địa chỉ IP. Dùng điện thoại
cùng mạng Wi-Fi, mở `http://<địa-chỉ-IP>/` hoặc `http://canhbao-tenga.local/`.

---

## 4. Chạy thử từng khối (tuần 2–3 của bản kế hoạch)

Bản kế hoạch nhấn mạnh: **đừng ghép tất cả cùng lúc**. Firmware này được viết để
chạy thử từng phần ngay cả khi radar chưa về tới:

1. Mở `include/config.h`, đặt `SIMULATE_RADAR = true`, nạp lại firmware.
2. Trang web sẽ hiện “CHẾ ĐỘ MÔ PHỎNG”. Dùng các nút trong thẻ *Công cụ thử nghiệm*:
   - **Thử loa** → kiểm tra I2S + MAX98357A + loa.
   - **Thử Telegram** / **Thử Email** / **Thử Zalo** → ba nút riêng, mỗi nút chỉ
     gửi thử qua **đúng một kênh** để dò lỗi từng kênh khi demo (kênh chưa bật
     trong `secrets.h` thì bấm cũng không gửi). Nếu lỗi, dòng *Kết quả gửi gần
     nhất* sẽ hiện mã lỗi (ví dụ Telegram `HTTP 401` = sai token, `HTTP 400` =
     sai chat id).
   - **Mô phỏng té ngã** → chạy trọn vẹn quy trình: loa hỏi thăm → đếm ngược 30 giây
     → bấm nút xanh để hủy, hoặc để hết giờ cho hệ thống gửi cảnh báo thật.
   - **Giả lập có người / không người** → kiểm tra chuyển trạng thái.
3. Bấm thử hai nút vật lý: nút xanh lúc bình thường sẽ ghi một dòng nhật ký
   `Thao tác thử nghiệm` → biết là dây nối đúng.
4. Khi radar về tới, đặt lại `SIMULATE_RADAR = false` và nạp lại.

---

## 5. Máy trạng thái

| Trạng thái | Điều kiện vào | Hành động |
|---|---|---|
| `KHONG_NGUOI` | radar báo không có người | LED xanh nháy ngắn mỗi 3 giây |
| `CO_NGUOI` | radar báo có người | LED xanh sáng liên tục |
| `NGHI_NGO_TE_NGA` | radar báo té ngã (ngoài thời gian nghỉ) | phát loa hỏi thăm, LED vàng nháy, còi bíp, đếm ngược 30 giây |
| → về `CO_NGUOI` | bấm nút xanh “Tôi ổn” | ghi log kèm **thời gian phản hồi**, nghỉ 60 giây |
| `KHAN_CAP` | hết 30 giây không phản hồi, **hoặc** bấm SOS bất kỳ lúc nào | gửi Telegram, LED đỏ nháy, còi gấp |
| → về `CO_NGUOI` | bấm nút xanh khi đang khẩn cấp | gửi tin “đã xác nhận an toàn” |

Ba tình huống đặc biệt mà bản kế hoạch yêu cầu xử lý đều đã có trong code:

- **Radar báo té ngã liên tục** → sau khi người dùng bấm “Tôi ổn”, mọi báo ngã mới
  bị bỏ qua trong `FALL_COOLDOWN_S` (mặc định 60 giây) và vẫn được ghi vào nhật ký
  kèm ghi chú *“bỏ qua, còn Ns nghỉ”* → loa không hỏi thăm lặp lại gây khó chịu.
- **Mất Wi-Fi** → tin nhắn vào hàng đợi ghi xuống flash, tự gửi lại mỗi 15 giây khi
  có mạng. Mất điện giữa lúc chưa gửi được thì bật lên tin vẫn còn.
- **Bấm SOS bất kỳ lúc nào** → được kiểm tra trước mọi trạng thái khác, gửi cảnh báo
  ngay, không cần chờ radar.

### Hỏi thăm qua Telegram (chat hai chiều)

Người nhà có thể **nhắn thẳng cho bot** để hỏi tình hình, không cần mở trang web:

> — *"dạo này ông bà thế nào?"*
> — 🤖 *"✅ Mọi thứ bình thường. Bà Nguyễn Thị A đang ở trong phòng, nghỉ ngơi yên
> tĩnh. Radar: đang hoạt động bình thường, có người trong phòng. Cập nhật lúc
> 14:32:08 ngày 20/10/2026."*

Các câu bot hiểu: **tình hình**, **số liệu**, **vị trí**, hoặc **help/lệnh** để xem
hướng dẫn. Firmware hỏi tin mới mỗi `TELEGRAM_POLL_MS` (mặc định 4 giây) qua
`getUpdates`.

**Bảo mật:** bot **chỉ trả lời đúng `TELEGRAM_CHAT_ID`** đã khai trong `secrets.h`.
Người lạ biết tên bot nhắn vào cũng bị bỏ qua, không lộ thông tin người thân.

> ⚠️ Để nhận được tin, **người nhà phải nhắn cho bot trước một lần** (Telegram
> không cho bot nhắn tới người chưa từng chat). Muốn tắt hẳn chat hai chiều: đặt
> `TELEGRAM_POLL_MS = 0` trong `config.h`.

**Vì sao chia nhiều task?** Thư viện `DFRobot_HumanDetection` làm việc kiểu hỏi–đáp
qua UART, bên trong có `delay(50)` cho mỗi byte và chờ tối đa 5 giây mỗi lệnh; riêng
`begin()` chờ 10 giây. Nếu gọi thẳng trong `loop()` thì nút bấm sẽ phản hồi chậm và
WebSocket bị đứng. Vì vậy:

| Nhân (core) | Công việc |
|---|---|
| core 0 | task đọc radar |
| core 1 | `loop()` (máy trạng thái, nút, LED), task âm thanh I2S, task gửi Telegram, task máy chủ web |

Sự kiện té ngã được **chốt bằng bộ đếm sườn** (`fallEdges`) nên dù máy trạng thái đọc
trễ cũng không bỏ sót lần nào.

---

## 6. Trang web và API

| Đường dẫn | Công dụng |
|---|---|
| `/` | Trang giám sát: trạng thái, đếm ngược, số liệu radar, nhật ký, nút điều khiển |
| `/ws` | WebSocket đẩy trạng thái mỗi giây (đứt thì trang tự chuyển sang hỏi định kỳ) |
| `/api/status` | JSON trạng thái hiện tại |
| `/api/events` | JSON các sự kiện gần nhất |
| `/api/export.csv` | **Tải toàn bộ nhật ký dạng CSV để mở bằng Excel** |
| `/api/action?name=...` | `iamok`, `sos`, `simfall`, `present_on`, `present_off`, `testvoice`, `testtg`, `clearlog` |

Muốn đặt mật khẩu cho trang web khi demo: điền `WEB_USER` / `WEB_PASS` trong `secrets.h`.

---

## 7. Lấy số liệu thực nghiệm (tuần 8–9)

Quy trình gọn nhất cho mỗi phiên đo:

1. Mở trang giám sát → **Xóa nhật ký**.
2. Làm thí nghiệm theo từng kịch bản trong `tools/bang_thuc_nghiem_tong_hop.csv`.
3. Bấm **Tải nhật ký CSV** → mở bằng Excel.

Nhật ký đã tự ghi sẵn những thứ cần cho báo cáo:

- thời điểm từng sự kiện (giờ Việt Nam, đồng bộ qua NTP);
- **thời gian phản hồi** của người dùng (`phan hoi sau 7.2s`);
- **tổng thời gian cảnh báo** từ lúc radar báo ngã tới lúc Telegram gửi xong
  (`tong 33.4s tu luc nga`) → dùng để tính trễ trung bình và lớn nhất;
- nguồn sinh ra sự kiện (`RADAR` / `BUTTON` / `WEB`) → tách được số liệu thật và
  số liệu thử nghiệm.

Hai mẫu bảng trong `tools/` khớp với bảng kịch bản ở mục 4 của bản kế hoạch:
`bang_thuc_nghiem_tong_hop.csv` (tổng hợp, có sẵn công thức TP/FP/FN) và
`bang_thuc_nghiem_tung_lan.csv` (ghi từng lần thử).

**Hoặc làm tự động bằng dashboard** (nhanh và ít sai sót hơn hẳn): mở
[dashboard/](dashboard/), tạo phiên đo, bấm “bắt đầu lần thử” trước mỗi động tác —
hệ thống tự chấm TP/FP/FN/TN, tự tính Precision / Recall / F1, tự vẽ biểu đồ và
xuất CSV. Xem [dashboard/README.md](dashboard/README.md).

---

## 8. Dò lỗi thường gặp

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Serial in `[RADAR] Khong ket noi duoc` | Nhầm TX/RX (radar TX phải vào GPIO18); radar chưa đủ 5V; thiếu chung GND |
| Trang web hiện “Chưa nạp giao diện web” | Chưa chạy `pio run -t uploadfs` |
| Loa chỉ kêu bíp, không nói | Thiếu file `data/ask.wav` hoặc WAV sai định dạng (phải PCM 16-bit) |
| Loa rè | Giảm `AUDIO_VOLUME_PERCENT`; thiếu tụ lọc nguồn cho MAX98357A |
| Telegram `HTTP 401` | Sai `TELEGRAM_BOT_TOKEN` |
| Telegram `HTTP 400` | Sai `TELEGRAM_CHAT_ID` (nhóm phải là số âm) |
| Email `HTTP 401` | Sai `RESEND_API_KEY` |
| Email `HTTP 403` | Chưa xác minh tên miền, hoặc `EMAIL_TO` khác email đã đăng ký Resend |
| Zalo `HTTP 401` | Sai/hết hạn `ZALO_OA_TOKEN` (access token OA có thời hạn, cần làm mới) |
| Nút bấm tự kích liên tục | Thiếu nối về GND, hoặc dây nút quá dài gây nhiễu → tăng `BTN_DEBOUNCE_MS` |
| Board không nạp được | Giữ nút BOOT rồi nhấn RESET; cáp USB-C phải là loại **truyền dữ liệu** |
| Radar báo ngã khi chỉ ngồi xuống sàn | Giảm `RADAR_FALL_SENSITIVITY` xuống 2, hoặc tăng `RADAR_FALL_TIME_S` |

---

## 9. Model AI của riêng bạn (chạy trên ESP32)

Mô-đun C1001 đã có thuật toán phát hiện té ngã bên trong chip, nhưng đó là của
nhà sản xuất. Để có phần AI **do bạn làm**, firmware này còn chạy song song một
bộ phân loại **hồi quy logistic** học từ chính dữ liệu bạn đo:

```
  Radar  ──►  chuỗi đặc trưng 4 mẫu/giây  ──►  dashboard thu + gán nhãn lần thử
                                                      │  Tải dữ liệu huấn luyện (JSON)
                                                      ▼
                     notebook Kaggle (+ dataset mm-ADL đã chuyển sang tín hiệu C1001)
                                                      │
                                           model_weights.h  ──►  nạp vào ESP32
                                                      │
                                      ESP32 chạy model song song với chip radar
```

**Ba bước:**

1. Đo thực nghiệm ở dashboard (để dashboard chạy suốt lúc đo — nó tự thu chuỗi đặc
   trưng từ `/api/features`), rồi *Báo cáo & biểu đồ* → **Tải dữ liệu huấn luyện (Kaggle)**.
2. Chạy notebook [`tools/kaggle/huan_luyen_model_te_nga.ipynb`](tools/kaggle/huan_luyen_model_te_nga.ipynb)
   trên Kaggle (CPU, 1–2 phút). Nơi lấy dataset và từng bước bấm: [docs/huan_luyen_model.md](docs/huan_luyen_model.md).
3. Tải `model_weights.h` ở tab *Output*, chép đè `include/model_weights.h` rồi `pio run -t upload`.

Trang giám sát sẽ hiện cả hai kết quả: của chip radar và của model bạn.

**Hai điều phải nói thẳng trong báo cáo:**

- Model **không dùng cờ té ngã của radar** làm đặc trưng. Nếu dùng thì nó chỉ sao
  chép kết quả của chip và con số chính xác trở nên vô nghĩa. Nó học từ chuỗi biên
  độ chuyển động, khoảng cách và trạng thái hiện diện trong cửa sổ 3 giây.
- Với dữ liệu cỡ một đồ án (vài trăm cửa sổ), hãy trình bày model như một **phép
  so sánh và kiểm chứng độc lập**, không phải thứ thay thế thuật toán của chip.

Cách tính đặc trưng được viết ở **hai nơi** (C++ cho ESP32, TypeScript cho phần
huấn luyện) nên bắt buộc phải khớp từng con số. Có bài kiểm tra tự động cho việc
này — chạy lại mỗi khi sửa:

```bat
python tools\kiem_tra_dac_trung.py     :: doi chieu C++ vs TypeScript
python tools	est_radar_frame.py       :: kiem tra bo giai ma khung UART
```

---

## 10. Vì sao firmware tự viết bộ đọc UART

Thư viện `DFRobot_HumanDetection` đọc theo kiểu hỏi–đáp và bên trong có
`delay(50)` cho **mỗi byte** nhận được. Một câu lệnh vì thế mất 0,5–0,7 giây; đọc
đủ 6 thông tin mất **3–4 giây**, tức là trễ phát hiện té ngã bị cộng thêm tới 4
giây — quá nhiều với một hệ thống cảnh báo, và nó làm xấu đúng con số quan trọng
nhất của báo cáo.

Nên firmware có thêm `src/hal/radar_frame.*`: bộ mã hóa/giải mã khung UART không chặn,
vẫn gửi lệnh theo đúng định dạng khung của hãng nhưng không chờ byte nào. Trạng
thái té ngã được làm mới mỗi **~300 ms**.

An toàn: nếu sau 8 giây mà không giải mã được khung hợp lệ nào, firmware **tự động
quay về dùng thư viện** (chậm nhưng chắc chắn chạy) và ghi một dòng nhật ký. Muốn
bắt buộc dùng thư viện thì đặt `RADAR_FORCE_LIBRARY = true` trong `config.h`.

---

## 11. Nút SOS đeo tay (433 MHz)

Thiết kế ban đầu có một lỗ thật: nút SOS gắn cố định trên hộp điều khiển, mà
**người đã ngã rồi thì bò tới nút bấm kiểu gì?** Nhất là trong nhà vệ sinh — nơi
hay ngã nhất và radar cũng khó quét tới.

Nút đeo tay bịt lỗ đó và cho hệ thống hai đường độc lập: radar tự phát hiện,
hoặc người dùng tự gọi. Một đường hỏng thì còn đường kia.

**Mua gì** (tổng khoảng 100–200k):

| Món | Giá | Từ khóa Shopee |
|---|---|---|
| Nút SOS không dây 433 MHz (vòng tay / móc cổ) | 50–150k | `nút gọi khẩn cấp người già không dây 433` |
| Mạch thu **RXB6** hoặc **SRX882** | 35–60k | `RXB6 433MHz`, `mạch thu RF 433 siêu ngoại sai` |
| Dây ăng-ten 17,3 cm | ~0đ | cắt từ dây có sẵn, hàn vào chân ANT |

**Đừng mua** mạch thu rẻ nhất `MX-RM-5V` / `XY-MK-5V` (loại siêu tái sinh): nhiễu
nặng, tầm vài mét, hay tự kích — với hệ thống cảnh báo thì tự kích là lỗi nặng.

**Lấy mã nút:** lần nạp đầu để `RF_REMOTE_CODE_1 = 0` trong `secrets.h`. Firmware
in mã của mọi nút bấm ra cổng serial. Bấm nút của bạn, copy con số, dán vào
`secrets.h`, nạp lại. Từ đó remote cửa cuốn của nhà bên cạnh bấm cũng không kích
được hệ thống.

Trong nhật ký, SOS từ nút đeo tay được ghi riêng (`SOS_REMOTE`, nguồn `REMOTE`)
để phân biệt với nút trên hộp — tiện lập bảng số liệu theo từng kênh.

**Cách trình bày trong báo cáo:** radar vẫn là phương tiện phát hiện **chính**,
người dùng **không cần đeo gì** thì hệ thống vẫn phát hiện té ngã. Nút đeo là
kênh dự phòng do người dùng chủ động. Nói vậy thì lý do chọn radar (không phải
đeo, bảo vệ riêng tư) vẫn giữ nguyên giá trị.

---

## 12. Chế độ giấc ngủ: nhịp tim và nhịp thở

Mô-đun C1001 có sẵn chế độ theo dõi giấc ngủ cho ra nhịp tim, nhịp thở, trạng
thái trên/ngoài giường và điểm chất lượng giấc ngủ. **Không cần mua thêm gì.**

### Ràng buộc cứng phải biết trước

Mô-đun chỉ chạy **một chế độ tại một thời điểm**. Không thể vừa phát hiện té ngã
vừa đo nhịp tim. Đổi chế độ mất **15–20 giây** và trong khoảng đó hệ thống
**không phát hiện được té ngã**.

Vì vậy tính năng này **mặc định TẮT**. Bật bằng `ENABLE_SLEEP_MODE = true` trong
`config.h` là bạn chấp nhận đánh đổi đó.

### Cách firmware xử lý

```
  Ban đêm (22h–6h) + radar thấy nằm im liên tục 5 phút
        → chuyển sang chế độ GIẤC NGỦ (đo nhịp tim, nhịp thở)

  Radar báo ra khỏi giường / hết khung giờ đêm / không còn người
        → chuyển ngay về chế độ TÉ NGÃ
```

Ra khỏi giường là lúc dễ ngã nhất (vừa ngủ dậy, choáng), nên firmware ưu tiên
quay về chế độ té ngã ngay khi thấy tín hiệu đó. Ngoài ra có thời gian tối thiểu
60 giây ở mỗi chế độ để không đổi qua đổi lại liên tục.

### Firmware tự đo thời gian "mù"

Mỗi lần đổi chế độ, firmware cộng dồn thời gian không phát hiện được té ngã vào
`blindMs` và hiện lên cả trang web lẫn dashboard. **Hãy đưa con số này vào phần
hạn chế của báo cáo** — hội đồng sẽ hỏi, và có số đo sẵn thì trả lời rất gọn:
*"mỗi đêm hệ thống mù khoảng N giây, chia làm 2 lần chuyển chế độ"*.

### Cảnh báo sinh hiệu

Ngưỡng để rất rộng (nhịp tim 40–130, nhịp thở 8–30) và phải vượt ngưỡng **liên
tục 60 giây** mới gửi Telegram, sau đó nghỉ 15 phút. Lý do: một cảnh báo giả lúc
2 giờ sáng làm người thân mất ngủ, và lần sau họ sẽ tắt thông báo — lúc đó cảnh
báo thật cũng vô nghĩa.

### AI nhận xét sinh hiệu (Groq)

Trên dashboard, trang giám sát có nút **"Nhờ AI nhận xét"**: gửi các con số nhịp
tim / nhịp thở (chỉ số liệu, không kèm tên hay thông tin đời tư) lên mô hình ngôn
ngữ Groq để diễn giải thành vài câu dễ hiểu cho người nhà. AI **chỉ nhận xét xu
hướng, không chẩn đoán bệnh, không kê đơn**, và luôn kèm câu nhắc hỏi bác sĩ. Cần
khai `GROQ_API_KEY` trong `dashboard/.env.local` (lấy miễn phí ở console.groq.com/keys).
Dashboard còn vẽ **biểu đồ nhịp tim / nhịp thở theo thời gian** khi đang ở chế độ
theo dõi giấc ngủ.

### Phải nói rõ trong báo cáo

> Nhịp tim và nhịp thở ở đây là **ước lượng bằng sóng milimet**, KHÔNG phải thiết
> bị y tế, không dùng để chẩn đoán.

Muốn có số liệu về độ chính xác thì mua thêm **máy đo SpO2 kẹp ngón tay**
(150–250k), đo song song 30–50 lần rồi lập bảng sai số. Đó là một bảng số liệu
nữa cho chương 4, và trả lời được câu hỏi về độ tin cậy bằng con số thật.

---

## 12b. TRỢ LÝ HỘI THOẠI (kiểu Xiaozhi)

Trợ lý trò chuyện với người cao tuổi bằng giọng nói, có mặt ở **cả hai nơi**:

**Trên web (dashboard, trang "Trò chuyện"):** gõ chữ HOẶC bấm "🎤 Nói". Trình
duyệt tự nhận giọng (Web Speech API) và đọc to câu trả lời. Không cần phần cứng gì.

**Trên ESP32 (nghe-nói qua loa):** cần gắn thêm **mic INMP441** (I2S). Luồng:
ESP32 ghi âm → gửi dashboard → Groq Whisper nhận giọng (STT) → Groq LLM trả lời →
`/api/tts` tạo giọng → ESP32 phát ra loa. ESP32 chỉ là client thu/phát; "bộ não"
ở dashboard (giống chính Xiaozhi).

Nối mic INMP441 (đặt `PIN_MIC_SD = -1` trong `config.h` nếu không gắn):

| INMP441 | ESP32-S3 |
|---|---|
| VDD | 3V3 |
| GND | GND |
| SCK | GPIO7 (`PIN_MIC_SCK`) |
| WS  | GPIO8 (`PIN_MIC_WS`) |
| SD  | GPIO9 (`PIN_MIC_SD`) |
| L/R | GND (chọn kênh trái) |

Bật trợ lý trên ESP32: điền `ASSISTANT_SERVER` trong `config.h` = địa chỉ
dashboard trong mạng LAN, ví dụ `"http://192.168.1.10:3000"`. Kích hoạt một lượt
nói bằng cách **giữ nút xanh** (push-to-talk) khi hệ thống đang bình thường, hoặc
bấm nút trợ lý trên trang web. Cần `GROQ_API_KEY` trong `dashboard/.env.local`.

> ⚠️ An toàn: trợ lý là tính năng PHỤ, chạy ở task riêng ưu tiên thấp, chỉ hoạt
> động khi hệ thống BÌNH THƯỜNG — không bao giờ chen vào loa hỏi thăm / cảnh báo
> té ngã, không ảnh hưởng nút "Tôi ổn" / SOS. Trợ lý KHÔNG chẩn đoán bệnh; gặp
> dấu hiệu nguy cấp thì nhắc bấm SOS / gọi người thân.

---
## 13. Hai điểm cần lưu ý từ bản kế hoạch

**Link thư viện trong bản kế hoạch đã chết.** Tài liệu ghi
`github.com/cdjq/DFRobot_HumanDetection` — repo này không còn tồn tại (404). Repo
đúng là **`github.com/DFRobot/DFRobot_HumanDetection`**, đã khai sẵn trong
`platformio.ini` nên PlatformIO tự tải. Nhớ sửa lại ở mục *Nguồn tham khảo* của báo cáo.

**“AI nằm ở đâu?”** Như bản kế hoạch đã cảnh báo, hội đồng rất có thể hỏi câu này.
Phần nhận dạng tư thế từ đám mây điểm (point cloud) chạy **bên trong chip radar**;
ESP32 nhận kết quả rồi chạy quy trình cảnh báo. Phần do bạn tự làm nằm ở:
model hồi quy logistic **tự huấn luyện** (chạy song song, so sánh với thuật toán
của chip), máy trạng thái có xử lý thời gian nghỉ và hàng đợi chống mất tin, quy
trình xác nhận hai bước để giảm báo động giả, hệ thống ghi nhật ký phục vụ đánh
giá định lượng. Nếu GVHD muốn phần AI do chính bạn viết, hãy trao đổi **trước khi
chốt đề cương**.

**Huấn luyện model + nguồn dataset:** xem [docs/huan_luyen_model.md](docs/huan_luyen_model.md)
và notebook `tools/kaggle/huan_luyen_model_te_nga.ipynb`. Dữ liệu sát nhất là dữ
liệu tự đo bằng chính C1001; dataset radar 60 GHz công khai mm-ADL / mm-ADL-Home
(Zenodo, CC BY 4.0) được notebook chuyển sang tín hiệu kiểu C1001 để bổ sung. Phép
chuyển là xấp xỉ, nên số liệu báo cáo vẫn lấy trên dữ liệu tự đo.

---

## 14. Nguồn tham khảo

- Trang sản phẩm C1001: https://www.dfrobot.com/product-2861.html
- Wiki C1001 (sơ đồ chân, hướng dẫn lắp, code mẫu): https://wiki.dfrobot.com/sen0623/
- Thư viện Arduino (repo đúng): https://github.com/DFRobot/DFRobot_HumanDetection
- Telegram Bot API: https://core.telegram.org/bots/api#sendmessage
