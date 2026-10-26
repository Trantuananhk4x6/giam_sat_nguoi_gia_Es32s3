# Hướng dẫn Huấn luyện Đa Bộ Dữ liệu, Chưng cất Tri thức & Kiểm toán Bias/Confusion Matrix (Local)

Script huấn luyện chính: [`tools/huan_luyen_local.py`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/tools/huan_luyen_local.py)
Notebook tương tác đầy đủ kết quả: [`tools/huan_luyen_local.ipynb`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/tools/huan_luyen_local.ipynb)
Script đồng bộ `.py -> .ipynb`: [`tools/build_local_notebook.py`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/tools/build_local_notebook.py)
Script thực thi & kiểm thử notebook: [`tools/test_notebook_exec.py`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/tools/test_notebook_exec.py)

---

## 1. Kiến trúc Huấn luyện Đa Bộ Dữ liệu & Chưng cất Tri thức (Knowledge Distillation)

Hệ thống huấn luyện của dự án **OALPHA (ESP32-S3 + Radar 60 GHz DFRobot C1001)** tích hợp **4 nguồn dữ liệu công khai & chuẩn hóa vật lý** (tổng cộng **151 bản ghi**, **14,62 giờ**, **813 sự kiện té ngã**, **150.342 cửa sổ trượt 3 giây có nhãn**):

| Bộ dữ liệu | Số bản ghi | Số người / hoạt động | Cửa sổ có nhãn | Sự kiện ngã | Vai trò trong huấn luyện |
|---|---:|---:|---:|---:|---|
| **`mm-adl`** (Zenodo `mm-adl-v1.0.zip`) | 55 | 11 người (`sub-01..11`) | 101.615 | 649 | Dữ liệu đám mây điểm 3D mmWave phòng thí nghiệm (10 hoạt động) |
| **`mm-adl-home`** (Zenodo `mm-ADL-Home-v1.0.zip`) | 14 | 4 người (`home-01..04`) | 42.799 | 146 | Dữ liệu căn hộ thực tế có đồ đạc, dùng cho cả huấn luyện & kiểm tra chuyển miền CORAL |
| **`radhar`** (GitHub `nesl/RadHAR`) | 40 | 5 hoạt động mạnh (`boxing`, `jack`, `jump`, `squats`, `walk`) | 2.778 | 0 | Làm dày lớp âm khó (vận động mạnh nhưng không ngã) để ép tỷ lệ báo nhầm về 0 |
| **`c1001-ext`** (Chuẩn hóa Vật lý C1001) | 42 | 6 người (`ext-sub-01..06`) | 3.150 | 18 | Bổ sung kịch bản phòng trống (`khong_nguoi`), nằm bất động trên sàn kéo dài `> 200s` (kích hoạt `RESIDENCE_S = 200`s và đặc trưng `f9`), cùng các ca ngồi/nằm nhanh |

### Chuẩn hóa Vật lý Radar Trần C1001 & Khắc phục Liệt Đặc trưng `f9`
- **Khử suy biến khoảng cách xuyên hướng (Slant-Range Degeneracy)**: Áp dụng hiệu chỉnh cosin góc tới $\cos\theta = \Delta z / d_{3\text{D}}$ trong [`render_c1001()`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/tools/huan_luyen_local.py) để quy đổi đám mây điểm 3D về khoảng cách tương đương trục đứng từ trần `2,70 m`, giúp tách biệt hoàn toàn cao độ **Nằm sàn (`~235 cm`)** khỏi **Nằm giường (`~195 cm`)** và **Ngồi ghế (`~167 cm`)** dù người ở lệch tâm nón quét.
- **Kích hoạt đặc trưng `f9` (`staticStay`)**: Mô phỏng chính xác cơ chế tích lũy thời gian bất động trên sàn của C1001 và bổ sung các ca nằm sàn kéo dài `> 200s` trong `c1001-ext`, nâng trọng số `f9` từ `0.0000` (tê liệt hoàn toàn) lên **`+2.3352`**.

### Chưng cất Tri thức (Teacher Ensemble $\to$ Student ESP32)
Giữ nguyên 100% hợp đồng đặc trưng **`FEATURE_SPEC_VERSION = 1`** (10 đặc trưng cửa sổ 3 giây) và cấu trúc bộ nhớ C++ trên ESP32-S3:
1. **Teacher Ensemble**: Tổ hợp `HistGradientBoostingClassifier` + `RandomForestClassifier` + `MLPClassifier(128-64-32)` đạt **OOF AUC = 0.9923**, **AP = 0.9600**.
2. **Student MLP (`10-64-32-16-1`, 3.329 tham số float32)**: Học biểu diễn ẩn kết hợp tinh chỉnh lớp đầu ra theo logit mềm của Teacher ở nhiệt độ $T = 2.0, \alpha = 0.60$, đạt **OOF AUC = 0.9902**, bắt trúng **91,4% (743/813) cú ngã** tại trần báo nhầm $\le 6,0$ lần/giờ (Chấm lồng nhau Nested CV: **91,4% = 743/813** tại `5,7` báo nhầm/giờ).
3. **Student Logistic Regression (`10 đặc trưng`)**: Học từ xác suất mềm của Teacher kèm **Ràng buộc Dấu Vật Lý (Physical Sign Regularization)** ($w_0 \dots w_9 > 0$), triệt tiêu hoàn toàn hiện tượng đảo dấu đa cộng tuyến (`f0 = -2.36` $\to$ **`+3.44`**) và nổ trọng số khoảng cách (`f4 = +15.34` $\to$ **`+1.99`**), nâng tỷ lệ bắt cú ngã ở trần $\le 6$ FA/h lên **88,7% (721/813)** (Nested CV: **89,5% = 728/813**).
4. **Student 5-Class Posture MLP (`10-32-16-5`, 965 tham số float32)**: Chưng cất từ Teacher Tư thế, nâng độ chính xác ngoài-tập từ `67,9%` lên **89,3%** (Macro F1 = **0.865**, F1 lớp `nam_san` = **0.947** với Recall **96,1%**).

---

## 2. Cách Chạy Huấn luyện & Đồng bộ Notebook

### Chạy trực tiếp script Python (tự động cập nhật `include/` và `oalpha_output/`):
```powershell
python tools/huan_luyen_local.py
```

### Đồng bộ sang Jupyter Notebook và thực thi toàn bộ các ô:
```powershell
python tools/build_local_notebook.py
python tools/test_notebook_exec.py
```

Sau khi chạy xong, toàn bộ trọng số C++ được kiểm tra sai số số học `float32` so với `scikit-learn` (`< 2e-6`, khớp quyết định `100.000%`) và tự động ghi vào:
- [`include/model_weights.h`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/include/model_weights.h) (và [`oalpha_output/model_weights.h`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/oalpha_output/model_weights.h))
- [`include/nn_weights.h`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/include/nn_weights.h) (và [`oalpha_output/nn_weights.h`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/oalpha_output/nn_weights.h))

---

## 3. Bộ Biểu đồ EDA, Ma trận Nhầm lẫn & Kiểm toán Độ chệch trong `oalpha_output/`

### A. Biểu đồ Kiểm toán Ma trận Nhầm lẫn & Độ chệch (DPI 160)
1. **[`oalpha_output/cm_01_ma_tran_nham_lan_tong_hop.png`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/oalpha_output/cm_01_ma_tran_nham_lan_tong_hop.png)**:
   - **Panel 1**: Ma trận nhầm lẫn cấp Cửa sổ 3 giây (`TN=141.902`, `FP=329`, `FN=1.823`, `TP=6.288`).
   - **Panel 2**: Ma trận nhầm lẫn cấp Sự kiện theo đúng luật 2 cửa sổ liên tiếp của firmware (`TP=743/813 = 91,4%`, `FP=56` trên `14,62 giờ = 5,7 FA/h`).
   - **Panel 3**: Ma trận nhầm lẫn Tư thế 5 lớp (`khong_nguoi`, `dung_di`, `ngoi`, `nam_giuong`, `nam_san`) đạt độ chính xác **89,3%**.
   - **Panel 4**: Ma trận nhầm lẫn Chuyển miền (`Học trên mm-ADL -> Thử trên mm-ADL-Home` với CORAL + Tăng cường radar trần), bắt trúng **82,2% (120/146)** cú ngã ở nhà mới với ngưỡng chuyển mù.
2. **[`oalpha_output/bias_01_kiem_toan_do_chech.png`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/oalpha_output/bias_01_kiem_toan_do_chech.png)**:
   - **Panel 1**: So sánh trực quan 10 trọng số `f0..f9` và độ chệch `w0` Trước vs Sau Chưng cất Tri thức (khắc phục hoàn toàn đảo dấu `f0`, nổ `f4`, liệt `f9`).
   - **Panel 2**: Đường cong Hiệu chuẩn Xác suất (Reliability Diagram) kèm chỉ số **Brier Score** (`0.0324 -> 0.0185`) và **ECE** (`0.0732 -> 0.0439`).
   - **Panel 3**: Kiểm toán Độ công bằng theo từng người/nhóm (`Per-Subject Recall Fairness Audit` trên 21 người và `RadHAR = 0.0 FA/h`).
   - **Panel 4**: Biểu đồ cột so sánh 6 mô hình ở cùng trần $\le 6$ báo nhầm/giờ (cả điểm toàn cục và điểm lồng nhau Nested CV).
3. **[`oalpha_output/bao_cao_kiem_tra_bias.md`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/oalpha_output/bao_cao_kiem_tra_bias.md)** & **[`oalpha_output/model_report.json`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/oalpha_output/model_report.json)**: Báo cáo kiểm toán chi tiết dạng bảng Markdown và JSON đầy đủ các khóa `datasets_summary`, `distillation`, `confusion_matrices`, `bias_audit`.

### B. Bộ 10 Biểu đồ Trực quan hóa Dữ liệu (EDA)
- `eda_01_tong_quan.png`: Tổng quan số lượng bản ghi, thời lượng và tỷ lệ lệch lớp của 4 nguồn dữ liệu.
- `eda_02_thoi_luong_hoat_dong.png`: Phân bố thời lượng 10 hoạt động của `mm-ADL`/`mm-ADL-Home` và 5 hoạt động mạnh của `RadHAR`.
- `vi_du_cu_nga.png`: Dạng sóng C1001 (Biên độ, Khoảng cách, Cờ có người) của một cú ngã điển hình.
- `eda_03_nga_va_ca_de_nham.png`: So sánh trực tiếp dạng sóng Ngã vs Ngồi xuống ghế vs Nằm xuống giường.
- `eda_04_chu_ky_su_kien.png`: Chữ ký trung bình + dải phân vị 25–75% căn theo thời điểm chạm sàn.
- `eda_05_phan_bo_dac_trung.png` & `eda_06_tuong_quan_dac_trung.png`: Phân bố 10 đặc trưng và ma trận tương quan Spearman.
- `eda_07_lech_mien.png`: Độ lệch phân bố giữa các miền dữ liệu.
- `eda_08_ban_do_2d.png`: Phép chiếu PCA & t-SNE toàn bộ cửa sổ 10 đặc trưng.
- `eda_09_tu_the.png`: Phân bố khoảng cách và phân tách 5 tư thế sau chuẩn hóa góc tới AoA.
- `trong_so_va_pr.png`: Trọng số Student LR và đường cong Precision-Recall theo từng miền.
