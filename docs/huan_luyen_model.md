# Hướng dẫn huấn luyện model phát hiện té ngã

Model là bộ phân loại **hồi quy logistic 10 đặc trưng** chạy ngay trên ESP32
(`src/core/fall_model.*`). Huấn luyện bằng notebook
**`tools/kaggle/huan_luyen_model_te_nga.ipynb`** (chạy trên Kaggle, CPU là đủ),
kết quả là file `include/model_weights.h` để nạp vào firmware. File `.py` cùng thư
mục có nội dung y hệt, chạy trên máy bằng `python huan_luyen_model_te_nga.py`.

---

## 1. Lấy dữ liệu ở đâu (xếp theo độ sát với dự án)

| # | Nguồn | Vì sao | Lấy ở đâu |
|---|---|---|---|
| 1 | **Tự đo bằng chính C1001** | Cùng cảm biến, cùng lắp trần 2,7 m, cùng 10 đặc trưng. **Bắt buộc**, số liệu báo cáo lấy ở đây | Dashboard → *Kỹ thuật › Báo cáo & biểu đồ* → **Tải dữ liệu huấn luyện (Kaggle)** → file `oalpha_du_lieu_huan_luyen.json` |
| 2 | **mm-ADL** (214 MB, CC BY 4.0) | Radar 60 GHz TI IWR6843 cùng dải tần C1001; 11 người, ~50 cú ngã mỗi người, kèm ngồi ghế, nằm giường (ca dễ nhầm) | [doi.org/10.5281/zenodo.22405011](https://doi.org/10.5281/zenodo.22405011) · [GitHub](https://github.com/OwenHan10/mm-ADL) |
| 3 | **mm-ADL-Home** (134 MB, CC BY 4.0) | Cùng radar, quay trong căn hộ có đồ đạc, ghi liên tục: dùng làm dữ liệu gần thực tế | [doi.org/10.5281/zenodo.23456178](https://doi.org/10.5281/zenodo.23456178) · [GitHub](https://github.com/OwenHan10/mm-ADL-Home) |

**Vì sao dataset công khai không nạp thẳng được:** C1001 không xuất point cloud,
chỉ xuất giá trị mức cao (có người, kiểu chuyển động, biên độ 0–100, khoảng cách).
Notebook **chuyển** point cloud của mm-ADL sang các giá trị đó bằng một "radar ảo
gắn trần 2,7 m, nón quét 100°" (mục 5 trong notebook). Đây là phép **xấp xỉ**:
biên độ chuyển động của C1001 là thuật toán đóng của hãng. Vì vậy:

- dữ liệu tự đo có trọng số gấp 3 (`W_OWN`) và được dùng để chọn ngưỡng;
- khi có ≥ 400 mẫu sinh hoạt tự đo, notebook tự khớp thang biên độ mm-ADL về đúng
  phân bố của C1001 (quantile mapping);
- **chỉ số đưa vào báo cáo là chỉ số trên dữ liệu tự đo**, mm-ADL chỉ dùng để nói
  "model đã được kiểm tra trên 11 người lạ".

Dataset khác (SisFall, UR Fall, mmFall…) dùng gia tốc kế, camera hoặc radar 77 GHz
gắn tường: chỉ nên trích ở chương tổng quan, không dùng để train.

---

## 2. Tự đo dữ liệu bằng thiết bị

1. Nạp firmware (`pio run -t upload`, `pio run -t uploadfs`), chạy dashboard
   (`cd dashboard && npm run dev`), nhập IP của ESP32 ở trang **Cài đặt**.
2. Trang **Kỹ thuật › Đo thực nghiệm**: tạo phiên đo, mỗi lần thử bấm *Bắt đầu*,
   làm động tác (ngã lên **thảm dày**), bấm *Kết thúc*. Kịch bản có sẵn theo bản kế
   hoạch: không người, đi lại, 3 kiểu ngã (30 lần mỗi kiểu), 3 ca dễ nhầm, ngã rồi
   bấm "Tôi ổn", bấm SOS, ngã không phản hồi.
3. **Để dashboard chạy suốt lúc đo**: nó thu chuỗi đặc trưng 4 mẫu/giây từ
   `/api/features`. Lần thử thiếu 3 giây dữ liệu sẽ bị bỏ.

Mẹo cho dữ liệu sạch: ngã nhiều hướng, nhiều vị trí dưới radar; đo kỹ các ca dễ
nhầm (đây là nguồn báo nhầm); đo ở 2 độ cao lắp hoặc 2 độ nhạy để có bảng so sánh.

---

## 3. Huấn luyện trên Kaggle

1. Dashboard → **Tải dữ liệu huấn luyện (Kaggle)**.
2. Kaggle → *Create → New Dataset* → upload file JSON vừa tải (để *Private*).
   Thêm mm-ADL: *New Dataset* → tab *Link* → dán
   `https://zenodo.org/records/22405011/files/mm-adl-v1.0.zip?download=1`
   (làm tương tự với mm-ADL-Home). Hoặc bỏ qua bước này và bật
   *Settings → Internet: On*: notebook tự tải từ Zenodo, có kiểm tra MD5.
3. Kaggle → *Create → New Notebook* → *File → Import Notebook* → chọn
   `tools/kaggle/huan_luyen_model_te_nga.ipynb` → *Add Data* các dataset ở bước 2
   → **Run All** (khoảng 1–2 phút trên CPU).
4. Tab *Output*: tải `model_weights.h` (kèm `model_report.json` và 2 ảnh `.png`
   cho báo cáo) → chép đè `include/model_weights.h` → `pio run -t upload`.
   Serial phải in `[MODEL] Da nap model: kaggle ...`.

Notebook làm gì, theo thứ tự: tự kiểm tra hợp đồng đặc trưng khớp bản C++ → gán
nhãn cửa sổ 3 giây (giống `buildDataset()` của dashboard) → chuyển mm-ADL → đánh
giá chéo **theo người / theo lần thử** (không rò rỉ dữ liệu) → chọn `C` và ngưỡng
→ mô phỏng đúng luật "2 cửa sổ liên tiếp" của firmware → bảng **model vs chip** →
xuất `model_weights.h` rồi đọc lại, tính bằng float32 như ESP32 để đối chiếu.

---

## 4. Đọc kết quả cho đúng

- **Bảng "Model vs chip" (mục 8)** là bảng chính cho chương 4: TP/FP/FN/TN từng lần
  thử của model và của thuật toán có sẵn trong chip, trên cùng dữ liệu.
- **Bảng điểm vận hành**: mỗi ngưỡng cho bao nhiêu % cú ngã bắt được và bao nhiêu
  lần báo nhầm mỗi giờ. Muốn ít báo nhầm hơn thì đặt `THRESHOLD_OVERRIDE` ở mục 1.
- Chạy thử chỉ với mm-ADL (chưa có dữ liệu tự đo): bắt được khoảng 75% cú ngã nhưng
  báo nhầm hơn 100 lần/giờ. Lý do là 10 đặc trưng tổng hợp này còn thô so với point
  cloud mà chip dùng bên trong. Đây là một kết luận nên nêu thẳng trong báo cáo.

---

## 5. Model dùng để làm gì trong hệ thống

Kết quả model (`modelFall`, `modelProb`) được **tính và hiển thị song song** với
thuật toán của chip, nhưng **không** kích hoạt cảnh báo (máy trạng thái vẫn dựa vào
cờ ngã của chip, xem `stateMachineTick()` trong `src/main.cpp`). Lựa chọn có chủ
đích: so sánh "model của em" với "thuật toán có sẵn trong chip" trên cùng dữ liệu,
và hồi quy logistic giải thích được (mỗi trọng số cho biết đặc trưng nào đẩy quyết
định theo hướng nào; notebook vẽ sẵn biểu đồ trọng số).

Nếu GVHD muốn model tham gia quyết định (ví dụ chỉ báo khi chip **và** model cùng
đồng ý, để giảm báo nhầm), đó là thay đổi nhỏ trong `stateMachineTick()`, nên trao
đổi trước khi chốt.

---

## 6. Trả lời câu hỏi "AI nằm ở đâu?" khi bảo vệ

1. Nhận dạng tư thế từ point cloud chạy **trong chip radar** (thuật toán của
   DFRobot): "AI có sẵn".
2. **AI do em tự làm**: hồi quy logistic huấn luyện trên dữ liệu em tự đo (bổ sung
   dữ liệu công khai mm-ADL đã chuyển đổi), chạy ngay trên ESP32, so sánh định lượng
   với chip.
3. **Cố ý không** đưa cờ ngã của chip vào đặc trưng: đưa vào thì model chỉ chép lại
   kết quả của chip, con số đẹp sẽ vô nghĩa.
