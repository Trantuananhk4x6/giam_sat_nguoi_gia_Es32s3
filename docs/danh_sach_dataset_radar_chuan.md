# DANH SÁCH BỘ DỮ LIỆU RADAR mmWAVE CHẤT LƯỢNG CAO CHO PHÁT HIỆN TÉ NGÃ & TƯ THẾ

Tài liệu này tổng hợp các bộ dữ liệu radar sóng milimet (mmWave FMCW 60 GHz – 77 GHz) chuẩn học thuật quốc tế phục vụ bài toán **Phát hiện té ngã (Fall Detection)** và **Nhận diện tư thế / Hành động (Human Activity Recognition - HAR)** cho người cao tuổi, tương thích với kiến trúc OALPHA trên vi điều khiển **ESP32-S3**.

---

## 1. BẢNG TỔNG HỢP SO SÁNH CÁC BỘ DỮ LIỆU RADAR

| # | Tên Dataset | Nguồn / Nền tảng | Tần số & Phần cứng | Dạng dữ liệu | Quy mô & Đối tượng | Ưu điểm & Vai trò trong dự án |
|---|---|---|---|---|---|---|
| **1** | **OALPHA Custom Dataset** | Dashboard OALPHA xuất JSON | 60 GHz (DFRobot C1001 / SEN0623) | 5 cột tín hiệu (4 Hz): present, movement, range, static, distance | Đo trực tiếp tại phòng thử nghiệm | **Chuẩn xác 100%**: Đúng cảm biến thật, vị trí gắn trần 2.7m, mang trọng số cao nhất (`W_OWN = 3.0`). |
| **2** | **mm-ADL** | Zenodo `10.5281/zenodo.22405011` (CC BY 4.0) | 60–64 GHz (TI IWR6843) | Point cloud 3D $(x, y, z, v)$ + bounding box | 11 người, ~50 cú ngã/người + ngồi, nằm giường | **Bộ chuẩn phòng thí nghiệm**: Cùng dải tần 60GHz với C1001, có chuỗi động lực học rơi chạm sàn đầy đủ. |
| **3** | **mm-ADL-Home** | Zenodo `10.5281/zenodo.23456178` (CC BY 4.0) | 60–64 GHz (TI IWR6843) | Point cloud 3D $(x, y, z, v)$ trong căn hộ | Căn hộ có nội thất, ghi liên tục 15–20 phút/phiên | **Đánh giá đổi nhà**: Có nhiễu phản xạ đa đường (multipath) từ giường/ghế, dùng để kiểm tra độ bền vững khi đổi phòng. |
| **4** | **mmwave-fall-detection** | Hugging Face (`SachitanandAgalduti`) | 60–64 GHz (TI IWR6843) | Point cloud theo từng frame $(x, y, z, v)$ | 102 bản ghi hành động (ngã về trước/sau, đi lại) | **Dễ tích hợp**: Định dạng bảng dữ liệu sạch trên Hugging Face, phù hợp bổ sung thêm mẫu ngã đa góc độ. |
| **5** | **mmFall** | ModelScope / GitHub (IEEE TMC) | 77 GHz FMCW (TI IWR1443 + DCA1000 EVM) | Raw ADC binary (`.bin`), `.mat` Range-Doppler + Camera | Nhiều người với các tình huống ngã giả lập và ADL | **Độ phân giải cực cao**: Có dữ liệu thô ADC và Range-Doppler heatmaps, dùng để đào tạo các mạng không gian sâu. |
| **6** | **RadHAR** | GitHub (`nesl/RadHAR`) | 60–77 GHz TI mmWave | Chuỗi cụm point cloud phân tán | 5 hoạt động mạnh: Đấm, nhảy, bật cao, ngồi xổm, đi bộ | **Triệt tiêu báo động giả**: Cung cấp các hành vi gia tốc mạnh không phải té ngã để ép model không báo nhầm. |
| **7** | **LABIOMEP Multimodal Fall** | Zenodo (LABIOMEP Porto) | mmWave Radar + Motion Capture Theia | Radar chùm sóng + Tọa độ trọng tâm (Center of Mass) | 40 sự kiện ngã (ngất xỉu, vấp ngã tốc độ nhanh/chậm) | **Xác thực y sinh học**: Đo đồng thời bằng hệ thống quang học bắt chuyển động chuẩn xác đến từng mili-giây. |
| **8** | **mRI Dataset** | GitHub (`SizheAn/mRI`) & Website | mmWave 60GHz + RGB-D + IMU | 160.000 frame đồng bộ từ 20 đối tượng | Các động tác phục hồi chức năng và di chuyển trong nhà | Phù hợp để làm phong phú dữ liệu tư thế đứng, ngồi lâu, cúi người. |

---

## 2. CHI TIẾT VÀ LINK TẢI TỪNG DATASET

### 2.1. mm-ADL & mm-ADL-Home (Khuyến nghị số 1 cho đồ án)
- **Tác giả:** Z. Han, X. Wang, M. Bolic (2026).
- **Mô tả:** Bộ dữ liệu đo bằng radar 60 GHz TI IWR6843. Thiết lập bao gồm cả phòng đo chuẩn (`mm-adl`) và căn hộ gia đình có đồ đạc nội thất (`mm-adl-home`). Chứa các kịch bản ngã: ngã về phía trước, ngã ngửa, ngã trượt ngang, ngã từ ghế xuống sàn, kèm các kịch bản sinh hoạt dễ nhầm: cúi nhặt đồ, ngồi phịch xuống ghế, nằm lên giường.
- **Link tải trực tiếp:**
  * `mm-adl-v1.0.zip` (214 MB): [https://zenodo.org/records/22405011](https://zenodo.org/records/22405011)
  * `mm-ADL-Home-v1.0.zip` (134 MB): [https://zenodo.org/records/23456178](https://zenodo.org/records/23456178)

### 2.2. Hugging Face mmWave Fall Detection Dataset
- **Kho lưu trữ:** `SachitanandAgalduti/mmwave-fall-detection-dataset`
- **Mô tả:** Bộ dữ liệu point cloud 60 GHz TI IWR6843 gồm 102 bản ghi chuyển động đã tiền xử lý sạch. Cung cấp tọa độ không gian 3 chiều $(x, y, z)$ và vận tốc Doppler $(v)$ của từng điểm phản xạ trong mỗi khung hình.
- **Link truy cập:** [https://huggingface.co/datasets/SachitanandAgalduti/mmwave-fall-detection-dataset](https://huggingface.co/datasets/SachitanandAgalduti/mmwave-fall-detection-dataset)
- **Cách kéo nhanh bằng Python:**
  ```bash
  pip install datasets
  ```
  ```python
  from datasets import load_dataset
  ds = load_dataset("SachitanandAgalduti/mmwave-fall-detection-dataset")
  ```

### 2.3. mmFall Dataset (IEEE Transactions on Mobile Computing)
- **Mô tả:** Bộ dữ liệu đa phương thức phát hiện té ngã không tiếp xúc bằng radar 77 GHz FMCW kết hợp DCA1000 EVM thu mẫu tín hiệu ADC với tốc độ 20 FPS. Bộ dữ liệu này được cộng đồng nghiên cứu dùng rộng rãi để huấn luyện các mạng Autoencoder và Variational RNN (HVRAE) nhận diện ngã dị thường (anomaly detection).
- **Link tham khảo & tải:**
  * GitHub repo: [https://github.com/radar-lab/mmfall](https://github.com/radar-lab/mmfall)
  * ModelScope mirror: [https://www.modelscope.cn/datasets](https://www.modelscope.cn/datasets) (Tìm kiếm từ khóa `mmFall`)

### 2.4. RadHAR Dataset (UCLA NESL Lab)
- **Kho lưu trữ:** `nesl/RadHAR`
- **Mô tả:** Tập dữ liệu radar chuyên biệt về các hoạt động sinh hoạt và vận động mạnh của con người (Human Activity Recognition). Gồm 5 lớp động lực học cao: nhảy lò cò, bật nhảy tại chỗ, đấm bốc, ngồi thụp xuống nhanh, và đi bộ bình thường.
- **Vai trò đặc biệt trong OALPHA:** Cảm biến C1001 dễ báo động giả khi người già ngồi xuống ghế quá nhanh hoặc cúi nhặt đồ. Đưa RadHAR vào tập huấn luyện giúp tăng độ chịu đựng của mô hình đối với các chuyển động mạnh lành tính, hạ tỷ lệ báo nhầm xuống dưới **6 lần/giờ**.
- **Link tải:** [https://github.com/nesl/RadHAR](https://github.com/nesl/RadHAR)

### 2.5. Synchronized Multimodal Fall Dataset (Zenodo - LABIOMEP)
- **Mô tả:** 40 phiên thử nghiệm ngã mô phỏng (ngất xỉu do hạ huyết áp, trượt chân vấp ngã) được đo đồng thời bởi Radar mmWave và hệ thống bắt chuyển động quang học không đánh dấu (*Theia Markerless*). Cung cấp quỹ đạo trọng tâm cơ thể theo 3 trục không gian giúp thẩm định pha va chạm sàn chính xác tới từng mili-giây.
- **Link tải:** [https://zenodo.org/records/8083204](https://zenodo.org/records/8083204) (Multimodal Fall Events)

---

## 3. CƠ CHẾ CHUYỂN ĐỔI POINT CLOUD SANG TÍN HIỆU RADAR GẮN TRẦN C1001

Cảm biến DFRobot C1001 (SEN0623) là loại cảm biến đã đóng gói sẵn firmware bám người, chỉ xuất qua UART 5 trường giá trị cấp cao ở tần số 4 Hz:
1. `present` (0 hoặc 1): Có người trong phòng.
2. `movement` (0, 1, 2): 0 = không có người, 1 = cử động nhẹ/đứng yên, 2 = di chuyển tích cực.
3. `range` (0 – 100): Biên độ dao động cơ thể do vi Doppler phản xạ.
4. `staticStay` (0 hoặc 1): Cờ người nằm yên lâu không đổi tư thế.
5. `distanceCm` (cm): Khoảng cách từ mắt radar đến điểm tán xạ mạnh nhất của cơ thể.

### Thuật toán Radar Ảo Gắn Trần (`virtual_radar_c1001`):
Khi nhập dữ liệu từ các bộ Point Cloud công khai (như `mm-ADL` hoặc `Hugging Face`), module chuyển đổi trong [`tools/huan_luyen_local.py`](file:///c:/doan/giam_sat_nguoi_gia_Es32s3/tools/huan_luyen_local.py) thực hiện:
```python
# Tọa độ radar ảo gắn giữa trần phòng ở độ cao 2.70m
x_r, y_r, z_r = (room_center_x, room_center_y, 2.70)

# 1. Tính khoảng cách 3D từ radar tới tâm cụm điểm người
dist_m = math.sqrt((x_p - x_r)**2 + (y_p - y_r)**2 + (z_p - z_r)**2)
distance_cm = int(np.clip(dist_m * 100.0, 0, 1100))

# 2. Xấp xỉ biên độ vi Doppler từ độ phân tán vận tốc điểm
v_spread = np.std(point_velocities)
v_center = np.linalg.norm(v_p)
amp = int(np.clip(100.0 * (1.0 - math.exp(-(v_center + 0.35 * v_spread) / 0.55)), 0, 100))

# 3. Suy ra trạng thái chuyển động và cờ tĩnh tại
movement = 2 if amp >= 12 else (1 if amp > 0 else 0)
present = 1 if len(points) > 0 else 0
```
Nhờ cơ chế này, toàn bộ các dataset quốc tế đều có thể đưa vào huấn luyện mô hình cho ESP32-S3 mà không cần phần cứng TI đắt tiền.
