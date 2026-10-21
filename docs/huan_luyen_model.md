# Hướng dẫn huấn luyện model phát hiện té ngã

Tài liệu này trả lời hai câu: **lấy dataset ở đâu** và **các bước train thế nào**.

---

## 1. Điều quan trọng nhất phải hiểu trước

Model trong đồ án này **huấn luyện trên dữ liệu do CHÍNH thiết bị của bạn thu**,
không phải trên dataset tải từ mạng. Lý do:

- Model học từ **10 đặc trưng** rút ra từ tín hiệu UART của radar DFRobot C1001:
  biên độ chuyển động (`range`), kiểu chuyển động (`movement`), khoảng cách
  (`distanceCm`), cờ nằm im (`staticStay`)… (xem `src/core/fall_model.h` và
  `dashboard/src/lib/features.ts`).
- Các dataset té ngã công khai trên mạng dùng **cảm biến khác** (đồng hồ đeo tay,
  camera, hoặc radar point-cloud thô). Định dạng và ý nghĩa số liệu **khác hoàn
  toàn** với 10 đặc trưng ở trên, nên **không nạp thẳng vào pipeline này được**.

👉 **Kết luận:** để có model chạy trên ESP32, bạn **phải tự đo dữ liệu bằng radar
C1001 + dashboard**. Đây cũng chính là điểm mạnh khi bảo vệ: "model do em tự huấn
luyện trên dữ liệu em tự đo", chứ không phải lấy sẵn của người khác.

Vậy dataset ngoài dùng để làm gì? → Mục 2.

---

## 2. Dataset công khai — dùng để THAM KHẢO trong báo cáo

Không nạp vào firmware được, nhưng **rất đáng trích trong chương cơ sở lý thuyết
và phần so sánh** của báo cáo (cho thấy bạn có khảo sát tài liệu). Nguồn uy tín:

| Dataset | Cảm biến | Dùng để làm gì trong báo cáo | Link |
|---|---|---|---|
| **mm-ADL** | Radar mmWave (point cloud) | Gần đề tài nhất — dataset radar sóng mm cho sinh hoạt thường ngày + té ngã. Trích để nói "đã có dataset radar mmWave công khai" | [github.com/OwenHan10/mm-ADL](https://github.com/OwenHan10/mm-ADL) |
| **SisFall** | Gia tốc kế đeo người | Dataset té ngã kinh điển, 23 người trẻ + 15 người trên 60 tuổi, 15 kiểu ngã + 19 sinh hoạt. Trích để mô tả các **kiểu ngã** cần thử | [sistemic.udea.edu.co](http://sistemic.udea.edu.co/en/investigacion/proyectos/english-falls/) |
| **UR Fall Detection (URFD)** | Camera + gia tốc kế | Hay dùng để đối chiếu, có nhãn ngã/không ngã rõ ràng | Tìm "UR Fall Detection Dataset" (ĐH Rzeszów) |
| **mmFall (bài báo)** | Radar mmWave 4D | Bài báo nền tảng về phát hiện ngã bằng radar + autoencoder, trích cho phần phương pháp | [arxiv.org/abs/2003.02386](https://arxiv.org/abs/2003.02386) |

Nội dung bảng được tóm tắt lại từ mô tả gốc của các dataset (đã diễn giải để tuân
thủ bản quyền). Khi trích vào báo cáo, dẫn lại đúng link gốc ở trên.

> **Cách dùng trong báo cáo (gợi ý câu chữ):**
> "Qua khảo sát, các dataset té ngã công khai chủ yếu dựa trên cảm biến đeo
> (SisFall) hoặc camera (URFD); dataset radar sóng milimet (mm-ADL, mmFall) tuy
> gần với đề tài nhưng dùng dữ liệu point-cloud thô, khác với dữ liệu đặc trưng
> mức cao mà mô-đun C1001 cung cấp qua UART. Do đó đề tài **tự xây dựng tập dữ
> liệu** bằng chính thiết bị, gồm N lần thử trên M kịch bản (bảng 4.x)."

---

## 3. Tự đo dataset bằng thiết bị — các bước

### 3.1. Chuẩn bị
1. Nạp firmware và nạp giao diện web:
   ```bat
   pio run -t upload
   pio run -t uploadfs
   ```
2. Chạy dashboard trên laptop (cùng mạng Wi-Fi với ESP32):
   ```bat
   cd dashboard
   npm install
   npm run dev
   ```
3. Mở dashboard (mặc định `http://localhost:3000`), vào phần **Cài đặt**, điền
   địa chỉ IP của ESP32 (xem trên trang giám sát của thiết bị). Dashboard sẽ tự
   kéo chuỗi đặc trưng từ `GET /api/features` của firmware.

### 3.2. Đo theo kịch bản
Vào trang **Thực nghiệm** của dashboard. Các kịch bản đã cài sẵn đúng theo bản
kế hoạch (`dashboard/src/lib/scenarios.ts`):

| Nhóm | Kịch bản | Số lần nên đo |
|---|---|---|
| Không ngã | Không có người; đi lại/ngồi ghế | 20 mỗi loại |
| **Ngã thật** | Ngã về trước; ngã ngang; ngã ngồi bệt | **30 mỗi loại** |
| Dễ nhầm | Cúi nhặt đồ; ngồi xuống sàn nhanh; nằm xuống thảm | 20 mỗi loại |
| Quy trình | Ngã rồi bấm "Tôi ổn"; bấm SOS; ngã không phản hồi | 20 mỗi loại |

Với mỗi lần thử:
1. Bấm **Bắt đầu lần thử**, chọn đúng kịch bản.
2. Thực hiện động tác (ngã lên **thảm tập dày** cho an toàn — cần làm hàng trăm lần).
3. Bấm **Kết thúc lần thử**.

Dashboard tự gắn mốc thời gian lần thử với chuỗi đặc trưng, và tự suy ra "lúc ngã
thật" bằng cách lùi lại `RADAR_FALL_TIME_S` giây so với lúc radar báo (logic này
nằm ở `buildDataset()` trong `dashboard/src/lib/train.ts`).

> ⚠️ **Để dashboard luôn chạy trong suốt lúc đo** — nó phải thu đặc trưng liên
> tục. Mỗi lần thử cần tối thiểu ~3 giây dữ liệu (12 mẫu × 250 ms) nếu không sẽ
> bị bỏ.

### 3.3. Mẹo để dataset "sạch" và model đáng tin
- **Đủ số lần ngã:** cần ≥ 20–30 cửa sổ "có ngã", ít hơn thì model không đáng tin
  (dashboard sẽ cảnh báo).
- **Đổi tư thế/hướng:** ngã nhiều hướng, nhiều vị trí trong phòng để model không
  học vẹt một kiểu.
- **Đo cả ca "dễ nhầm":** cúi nhặt đồ, ngồi bệt… — đây là thứ tạo ra FP, đo nhiều
  thì model học cách phân biệt.
- Đo ở **2 độ cao lắp** hoặc **2 mức độ nhạy** để báo cáo có số liệu so sánh.

---

## 4. Huấn luyện — các bước bấm nút

Chạy bộ huấn luyện (hồi quy logistic) trong `dashboard/src/lib/train.ts` trên dữ liệu đã đo. Bộ train sẽ:

1. **Bấm "Huấn luyện".** Dashboard sẽ:
   - Cắt chuỗi đặc trưng thành các **cửa sổ trượt** 3 giây.
   - Gán nhãn (1 = có ngã, 0 = không ngã) theo kịch bản của từng lần thử.
   - **Chia train/test theo LẦN THỬ** (không theo cửa sổ) để tránh rò rỉ dữ liệu.
   - Chạy **hồi quy logistic** có cân trọng số theo lớp + chuẩn hóa L2.
   - Tự dò **ngưỡng** cho F1 cao nhất.
   (Toàn bộ logic ở `dashboard/src/lib/train.ts`.)

2. **Đọc số liệu kết quả.** Chỉ quan tâm số liệu trên **tập TEST** (train luôn đẹp
   hơn, không dùng để báo cáo):
   - **Precision** (độ chính xác) = TP/(TP+FP) — báo nhầm ít hay nhiều.
   - **Recall / Độ nhạy** = TP/(TP+FN) — bỏ sót ngã ít hay nhiều. **Quan trọng
     nhất** với hệ thống an toàn.
   - **F1** = trung bình điều hòa của hai cái trên.

3. **Bấm "Tải model_weights.h".** File tải về chứa trọng số + ngưỡng + `FALL_MODEL_TRAINED 1`.

4. **Ghi đè** `include/model_weights.h` bằng file vừa tải.

5. **Nạp lại firmware:**
   ```bat
   pio run -t upload
   ```
   Lúc khởi động, firmware in ra serial: `[MODEL] Da nap model: ...`. Trên trang
   giám sát, mục model sẽ hiện trạng thái đã huấn luyện.

---

## 5. Model dùng để làm gì trong hệ thống

Hiện tại kết quả model (`modelFall`, `modelProb`) được **tính và hiển thị song
song** với thuật toán có sẵn trong chip radar, nhưng **không** trực tiếp kích hoạt
cảnh báo (máy trạng thái vẫn dựa vào cờ ngã của chip — xem `stateMachineTick()`
trong `src/main.cpp`).

Đây là **lựa chọn có chủ đích** và là nội dung hay cho báo cáo:
- Chương so sánh: "**model của em** vs **thuật toán có sẵn trong chip**" — chạy
  cùng lúc trên cùng dữ liệu, so Precision/Recall/F1.
- Giải thích được: mỗi trọng số cho biết đặc trưng nào quan trọng tới đâu (hồi
  quy logistic minh bạch, không phải hộp đen).

Nếu GVHD muốn model **trực tiếp tham gia quyết định cảnh báo** (ví dụ: chỉ báo
khi **cả** chip radar **và** model cùng đồng ý, để giảm báo nhầm), thì đó là một
thay đổi nhỏ trong `stateMachineTick()` — trao đổi với GVHD trước khi chốt, rồi
mình bổ sung sau.

---

## 6. Trả lời câu hỏi "AI nằm ở đâu?" khi bảo vệ

Hội đồng rất có thể hỏi. Chuẩn bị sẵn:

1. Phần nhận dạng tư thế từ đám mây điểm (point cloud) chạy **trong chip radar**
   (thuật toán của DFRobot) — đây là "AI có sẵn".
2. Phần **AI do em tự làm**: bộ phân loại **hồi quy logistic** huấn luyện trên
   tập dữ liệu em tự đo bằng chính thiết bị, chạy ngay trên ESP32, và em **so
   sánh định lượng** nó với thuật toán của chip (bảng Precision/Recall/F1).
3. Nói rõ: **cố ý không** đưa cờ ngã của chip vào đặc trưng của model — nếu đưa
   vào thì model chỉ sao chép kết quả của chip, con số đẹp sẽ vô nghĩa. (Đây là
   điểm thể hiện mình hiểu rõ phương pháp, dễ ghi điểm.)
