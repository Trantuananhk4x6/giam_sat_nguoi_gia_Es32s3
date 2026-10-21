# Dashboard — Trung tâm giám sát & phân tích số liệu

Ứng dụng web (Next.js 16 + TypeScript) chạy trên laptop, làm hai việc mà bản thân
ESP32 không làm tốt:

1. **Lưu lịch sử dài hạn** — bộ nhớ flash của ESP32 chỉ giữ vài chục dòng nhật ký,
   dashboard lưu không giới hạn vào file trên máy tính.
2. **Đo và tính số liệu thực nghiệm** — tự chấm TP/FP/FN/TN, tính Precision /
   Recall / F1 / Accuracy, đo trễ cảnh báo, vẽ biểu đồ, xuất CSV cho báo cáo.

> **Quan trọng khi bảo vệ:** dashboard **không nằm trong đường đi của cảnh báo**.
> Khi phát hiện té ngã, chính ESP32 phát loa và gửi Telegram. Tắt laptop thì hệ
> thống an toàn vẫn chạy nguyên vẹn.

---

## 1. Chạy lên trong 3 bước

```bat
cd dashboard
npm install
npm run dev
```

Mở http://localhost:3000 → vào trang **Cài đặt** → nhập địa chỉ IP của ESP32
(xem ở cổng serial lúc khởi động) → **Lưu và thử kết nối**.

### Chưa có phần cứng? Dùng bộ giả lập

```bat
node tools/gia-lap-esp32.mjs
```

Rồi vào trang Cài đặt nhập `localhost:8080`. Bộ giả lập dựng lại **đúng** máy
trạng thái của firmware (nghi ngờ → đếm ngược 30 giây → khẩn cấp, thời gian nghỉ
60 giây, trễ gửi Telegram 1–2 giây) nên có thể tập đo, thử giao diện và demo cho
GVHD xem trước khi radar về tới.

---

## 2. Các trang

Menu chia hai phần: phần cho **người nhà** đứng trước, phần **kỹ thuật** gom vào
sub-menu "Kỹ thuật".

| Trang | Dùng để làm gì |
|---|---|
| **Tổng quan** (`/`) | Tình hình bằng lời thường, mức độ (bình thường / cần chú ý / khẩn cấp), AI nhận xét trong ngày, diễn biến hôm nay, lời nhắn gần đây |
| **Hỏi thăm › Trò chuyện với trợ lý** | Hỏi "Hôm nay bà thế nào?", AI trả lời dựa trên dữ liệu radar; gõ `/hoitham <lời nhắn>` để loa đọc |
| **Hỏi thăm › Gửi lời nhắn qua loa** | Soạn lời nhắn, xem trước câu loa sẽ đọc, gửi xuống ESP32; nhật ký mọi lượt hỏi thăm (Telegram + web) |
| **Nhật ký** | Diễn biến nhiều ngày bằng lời thường, tải CSV |
| **Kỹ thuật › Giám sát thiết bị** | Số liệu thô radar, mạng, sinh hiệu, công cụ thử (trang chủ cũ) |
| **Kỹ thuật › Đo thực nghiệm** | Tạo phiên đo, chạy từng lần thử, hệ thống tự chấm kết quả |
| **Kỹ thuật › Báo cáo & biểu đồ** | Chỉ số, ma trận nhầm lẫn, so sánh cấu hình, xuất CSV, nhận xét bằng AI |
| **Cài đặt** | Địa chỉ ESP32, cách xưng hô, giọng đọc, bật/tắt bot Telegram hai chiều |

### Telegram hai chiều và lời nhắn qua loa

Khai `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (giống `secrets.h`) và `GROQ_API_KEY`
trong `.env.local`. Khi dashboard chạy, nó "thuê" quyền đọc tin của bot từ ESP32
(`GET /api/status?tg=<giây>`), nên mỗi tin chỉ một bên trả lời:

- `Hôm nay mẹ thế nào?` → AI trả lời bằng dữ liệu radar trong ngày.
- `/hoitham mẹ ơi, 10h con gọi về nha` → AI biên tập thành "Mẹ ơi, con Tuấn nhắn: 10 giờ
  con Tuấn sẽ gọi điện về cho mẹ nhé." → đọc giọng (WAV 16 kHz) → `POST /api/say` xuống
  ESP32 → loa phát "ting tong" rồi đọc. Câu AI làm rơi giờ giấc / phủ định thì tự quay
  về câu mẫu giữ nguyên lời nhắn.
- `/tinhhinh`, `/homnay`, `/hoi <câu hỏi>` (trong nhóm), `/help`.

Chỉ các chat trong `TELEGRAM_CHAT_ID` / `TELEGRAM_ALLOWED_CHAT_IDS` được trả lời; người
lạ bị từ chối. Đang nghi ngã / khẩn cấp thì loa không đọc lời nhắn. Tắt laptop thì
ESP32 tự trả lời như cũ, `/hoitham` phát lời hỏi thăm thu sẵn (`data/hoitham.wav`).
Mọi lượt lưu ở `data/messages.jsonl`. Bộ giả lập cũng hiểu `?tg=` và `/api/say`
(file WAV nhận được lưu ra thư mục tạm để nghe lại).

---

## 3. Cách đo một lần thử

1. Trang **Đo thực nghiệm** → tạo phiên đo, điền **chiều cao lắp** và **độ nhạy**
   đúng như đang nạp trong firmware.
2. Chọn kịch bản (danh sách lấy đúng theo bảng ở mục 4 bản kế hoạch) → bấm
   **BẮT ĐẦU LẦN THỬ**.
3. Làm động tác. Thẻ đang đo sẽ sáng dần các mốc: *radar báo ngã → phát cảnh báo →
   Telegram gửi xong*, kèm số giây.
4. Bấm **KẾT THÚC & LƯU**. Hệ thống tự chấm:

   | Kịch bản | Hệ thống có báo | Kết quả |
   |---|---|---|
   | Là té ngã thật | có | **TP** |
   | Là té ngã thật | không | **FN** |
   | Không phải té ngã | có | **FP** |
   | Không phải té ngã | không | **TN** |

   Chấm sai thì sửa lại ngay trong bảng — cột kết quả là ô chọn.

### Hai chi tiết giúp số liệu sạch

- **Trễ cảnh báo lấy từ chính firmware.** Firmware tự đo bằng đồng hồ của nó rồi
  ghi vào nhật ký (`tong 32.1s tu luc nga`); dashboard đọc lại con số đó thay vì
  lấy hiệu hai mốc nhận được qua mạng. Nhờ vậy sai số chỉ còn vài chục ms thay vì
  vài giây.
- **Cảnh báo “rơi vào thời gian nghỉ”.** Sau khi bấm “Tôi ổn”, firmware bỏ qua mọi
  báo ngã mới trong 60 giây. Nếu đo trúng khoảng đó, lần thử sẽ bị tính FN oan —
  dashboard phát hiện và hiện cảnh báo vàng để bạn **xóa và đo lại**.

---

## 4. Cấu trúc mã nguồn

Mỗi file một việc, muốn sửa gì chỉ phải mở một chỗ:

```
src/
  lib/
    types.ts       Toàn bộ kiểu dữ liệu (sửa cấu trúc dữ liệu thì bắt đầu từ đây)
    scenarios.ts   DANH MỤC KỊCH BẢN — thêm/bớt kịch bản thí nghiệm ở đúng file này
    metrics.ts     Công thức chấm điểm và tính TP/FP/FN/TN, Precision/Recall/F1
    store.ts       Đọc ghi dữ liệu (file JSON/JSONL trong dashboard/data/)
    esp32.ts       Gọi sang firmware + dịch lỗi mạng thành câu tiếng Việt dễ hiểu
    poller.ts      Vòng thu thập dữ liệu chạy ở máy chủ
    trials.ts      Nghiệp vụ một lần thử: bắt đầu / chốt mốc / chấm điểm
    features.ts    HỢP ĐỒNG ĐẶC TRƯNG — phải khớp từng số với src/fall_model.cpp
    train.ts       Huấn luyện hồi quy logistic + sinh file model_weights.h
    format.ts      Hàm định dạng cho giao diện
  app/
    page.tsx            Giám sát trực tiếp
    thuc-nghiem/        Đo thực nghiệm
    bao-cao/            Báo cáo & biểu đồ
    cai-dat/            Cài đặt
    api/                Các endpoint (live, action, sessions, trials, report, export, settings)
    globals.css         Toàn bộ CSS, dùng biến màu ở đầu file
  components/
    Nav.tsx, EventTable.tsx, useLive.ts
tools/
  gia-lap-esp32.mjs     Bộ giả lập firmware để phát triển không cần phần cứng
```

**Muốn thêm một kịch bản thí nghiệm?** Thêm một dòng vào `src/lib/scenarios.ts`.
Giao diện, bảng số liệu và CSV tự cập nhật theo.

**Muốn đổi màu?** Sửa các biến ở đầu `src/app/globals.css`.

**Muốn thêm một chỉ số mới?** Thêm vào `computeMetrics()` trong `src/lib/metrics.ts`
rồi hiện ra ở `app/bao-cao/page.tsx`.

### Vài quyết định kỹ thuật và lý do

| Quyết định | Lý do |
|---|---|
| Trình duyệt gọi qua máy chủ Next.js, không gọi thẳng ESP32 | Firmware không gửi header CORS nên trình duyệt sẽ bị chặn; đi qua máy chủ cũng giúp thu dữ liệu khi không mở trang |
| Lưu bằng file JSON/JSONL, không dùng database | Không phải cài gì thêm, không có thư viện biên dịch sẵn dễ lỗi trên Windows; mở được bằng Notepad để kiểm tra |
| Hỏi lại định kỳ (polling) thay vì WebSocket | 1,5 giây là đủ cho quy trình 30 giây, ít phần phức tạp hơn, không vướng khi Next.js nạp lại code |
| Phiên bản thư viện ghim cố định | Vài tháng sau build lại vẫn ra đúng kết quả như hôm nay |

---

## 5. Huấn luyện model (bộ train trong `src/lib/train.ts`)

> **Cách train hiện tại:** trang *Báo cáo & biểu đồ* → **Tải dữ liệu huấn luyện
> (Kaggle)** (`GET /api/export?kind=train`) rồi chạy notebook
> `tools/kaggle/huan_luyen_model_te_nga.ipynb`. Notebook dùng đúng cách gán nhãn mô
> tả dưới đây, thêm dữ liệu công khai mm-ADL và xuất `model_weights.h`. Xem
> `docs/huan_luyen_model.md`.

Bộ huấn luyện (`src/lib/train.ts`) dựng bộ phân loại **hồi quy logistic** từ dữ
liệu bạn đo rồi xuất trọng số thành file C (`include/model_weights.h`) để nạp vào
ESP32. (Trang bấm nút "Huấn luyện model" trước đây đã được gỡ cho gọn; logic train
vẫn còn nguyên trong `src/lib/train.ts`.)

### Cách gán nhãn — chi tiết quan trọng nhất

Radar chỉ báo té ngã **sau khi xác nhận liên tục 5 giây** (`RADAR_FALL_TIME_S`).
Nghĩa là mốc "radar báo ngã" muộn hơn cú ngã thật khoảng 5 giây. Nếu lấy cửa sổ 3
giây quanh mốc báo thì nó rơi vào đoạn người đã nằm im và **bỏ mất chính cú va
đập** — model sẽ không học được gì (lần chạy thử đầu tiên của tôi ra F1 chỉ 45% vì
đúng lỗi này).

Nên khoảng được gán nhãn "có ngã" trải từ `thời điểm báo − 5 giây` tới `thời điểm
báo`, tức là phủ cả cú va đập lẫn đoạn nằm im sau đó. Độ trễ 5 giây này **firmware
tự báo lên** trong `/api/status` nên dashboard luôn dùng đúng con số đang nạp, kể cả
khi bạn đổi `RADAR_FALL_TIME_S`.

Các cửa sổ còn lại trong một lần thử ngã **bị bỏ qua**, không gán nhãn 0 — vì chúng
nằm lẫn giữa trước và sau lúc ngã, gán 0 sẽ làm nhiễu dữ liệu.

### Hai điểm về phương pháp (nên viết vào báo cáo)

- **Chia train/test theo lần thử, không theo cửa sổ.** Các cửa sổ trong cùng một
  lần thử gần như giống nhau; chia theo cửa sổ thì "cửa sổ anh em" rơi vào cả hai
  tập và điểm số bị thổi phồng (rò rỉ dữ liệu).
- **Cân trọng số theo lớp.** Cửa sổ "không ngã" luôn nhiều hơn hẳn; không cân thì
  model chỉ cần đoán "không ngã" mọi lúc là đã có độ chính xác cao mà vô dụng.

### Nói thật về chất lượng model

Với vài trăm cửa sổ dữ liệu và đặc trưng khá thô (biên độ chuyển động, khoảng cách,
trạng thái hiện diện ở 4 mẫu/giây), **đừng kỳ vọng model vượt được thuật toán trong
chip radar**. Giá trị của nó với đồ án là: (1) chứng minh bạn hiểu và tự làm được
một pipeline học máy đầy đủ, (2) cho một phép so sánh định lượng độc lập, (3) trả
lời được câu "AI nằm ở đâu". Hãy báo cáo đúng con số đo được, kể cả khi nó thấp —
hội đồng đánh giá cao sự trung thực hơn là một con số đẹp không giải thích được.

---

## 6. Dữ liệu lưu ở đâu

```
dashboard/data/
  events.jsonl     nhật ký sự kiện thu từ ESP32 (mỗi dòng một JSON)
  sessions.json    các phiên đo
  trials.json      từng lần thử và kết quả chấm
  settings.json    địa chỉ ESP32, chu kỳ hỏi
```

Sao lưu trước khi viết báo cáo: copy cả thư mục `dashboard/data/`.
Thư mục này đã được `.gitignore` bỏ qua nên không bị đẩy lên GitHub.
