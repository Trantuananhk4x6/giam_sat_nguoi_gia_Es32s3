# Hướng dẫn huấn luyện model phát hiện té ngã

Đồ án huấn luyện **ba model**, tất cả đều chạy **ngay trên ESP32-S3** (không cần laptop),
tất cả dùng **đúng một bộ 10 đặc trưng** nên không có hợp đồng đặc trưng thứ hai để lệch nhau.

Huấn luyện bằng notebook **`tools/kaggle/huan_luyen_model_te_nga.ipynb`** (chạy trên Kaggle,
CPU là đủ, khoảng 5–8 phút). File `.py` cùng thư mục có nội dung y hệt ở dạng dễ xem diff trên
git; sửa `.py` rồi chạy `python tools/kaggle/py_sang_ipynb.py` để đồng bộ lại `.ipynb`.

---

## 0. Ba model dùng ở đâu, cấu hình thế nào

| # | Model | File trọng số | Code chạy | Vai trò trong hệ thống |
|---|---|---|---|---|
| 1 | **Hồi quy logistic** 10 đặc trưng | `include/model_weights.h` | `src/core/fall_model.cpp` | Bản **giải thích được**: mỗi trọng số cho biết đặc trưng nào đẩy quyết định theo hướng nào. Dùng làm mốc so sánh trong báo cáo. |
| 2 | **MLP té ngã** `10-64-32-16-1` | `include/nn_weights.h` | `src/core/nn_model.cpp` | Bộ phát hiện té ngã **mạnh** của đồ án. Cùng 10 đặc trưng, cùng con chip, nhưng bắt được nhiều hơn model 1 khoảng **7 lần** ở cùng mức báo nhầm (5,3% → 38,7%). |
| 3 | **MLP tư thế** `10-32-16-5` | `include/nn_weights.h` (cùng file) | `src/core/nn_model.cpp` | Trả lời câu hỏi gây báo nhầm nhiều nhất: người đang **nằm trên sàn** hay **nằm trên giường**. Hiện lên trang web để người nhà hiểu vì sao máy báo. |

Model 2 và 3 nằm **chung một file** `nn_weights.h` nên chỉ phải tải về một file.

### Cấu hình từng model

Mọi thứ chỉnh được đều nằm trong **ô 1 của notebook** (lúc huấn luyện) hoặc ngay trong file `.h`
sinh ra (chỉnh sau, không cần train lại):

| Tham số | Ở đâu | Ý nghĩa | Mặc định |
|---|---|---|---|
| `FA_BUDGET_PER_HOUR` | ô 1 notebook | **Trần báo nhầm** dùng để chọn ngưỡng cho MLP té ngã (lần/giờ sinh hoạt). Đây là núm điều chỉnh quan trọng nhất | `6.0` |
| `NN_FALL_HIDDEN` | ô 1 notebook | Các lớp ẩn của MLP té ngã | `(64, 32, 16)` |
| `NN_POSTURE_HIDDEN` | ô 1 notebook | Các lớp ẩn của MLP tư thế | `(32, 16)` |
| `THRESHOLD_NN_OVERRIDE` | ô 1 notebook | Tự đặt ngưỡng MLP, bỏ qua trần báo nhầm | `None` |
| `TRY_BIG_FEATURES` | ô 1 notebook | Chạy thêm phần so sánh bộ 43 đặc trưng (mục 14) | `False` |
| `USE_AUGMENT`, `NN_AUGMENT` | ô 1 notebook | Tăng cường dữ liệu (nhân bản có ý nghĩa vật lý) — xem mục 11a | `True`, `2` |
| `USE_CORAL` | ô 1 notebook | Khớp đặc trưng công khai → dữ liệu tự đo. **Chỉ chạy khi đã có dữ liệu tự đo** | `True` |
| `USE_HARD_NEGATIVE` | ô 1 notebook | Đào mẫu khó. **Đã đo: không giúp gì**, để `False` | `False` |
| `CROSS_DOMAIN_CHECK` | ô 1 notebook | Chạy bảng "đổi nhà" ở mục 11c (tốn ~6 phút, nhưng là bảng chính của chương 4) | `True` |
| `RUN_EDA` | ô 1 notebook | Vẽ các biểu đồ khám phá dữ liệu ở mục 6, trước khi huấn luyện (xem mục 3 dưới đây) | `True` |
| `CHI_XEM_DU_LIEU` | ô 1 notebook | Chỉ chuẩn bị dữ liệu và vẽ mục 6 rồi **dừng**, chưa huấn luyện. Chạy trên máy: biến môi trường `OALPHA_CHI_XEM=1` | `False` |
| `EDA_TSNE`, `EDA_MAX_POINTS` | ô 1 notebook | Bản đồ t-SNE ở mục 6h (phần chậm nhất của mục 6) và số cửa sổ tối đa đưa lên bản đồ 2D | `True`, `4000` |
| `W_OWN` | ô 1 notebook | Một cửa sổ tự đo nặng bằng mấy cửa sổ công khai | `3.0` |
| `NN_BALANCE_FALL` | ô 1 notebook | Cân lớp cho mạng **té ngã**. **Đo được là KHÔNG nên bật** (31,1% khi bật so với 38,0% khi tắt): ngưỡng đã chọn theo trần báo nhầm nên cái quyết định là thứ tự xếp hạng, cân lớp chỉ dịch hiệu chuẩn | `False` |
| `NN_BALANCE_POSTURE` | ô 1 notebook | Cân lớp cho mạng **tư thế**. **Phải bật**: nó quyết định bằng argmax, không có ngưỡng chỉnh sau, không cân thì lớp `nam_san` gần như không bao giờ được chọn | `True` |
| `NN_EARLY_STOPPING` | ô 1 notebook | Dừng sớm của scikit-learn. **Để `False`**: nó cắt ngẫu nhiên 10% *hàng* làm tập kiểm tra, mà hàng của ta là cửa sổ trượt chồng nhau + bản tăng cường của chính nó → tín hiệu dừng bị rò rỉ (đo được: dừng ở vòng 43 khi chưa hội tụ) | `False` |
| `NN_MAX_ITER`, `NN_BATCH` | ô 1 notebook | Cái quyết định là **tổng số bước** ≈ số vòng × số dòng / `NN_BATCH`. Đo được: ~27k bước → 36,2%, **~54k → 38,0%**, ~107k → 35,7%, ~215k → 34,0%. Nâng `NN_BATCH` "cho nhanh" sẽ âm thầm cắt số bước | `40`, `256` |
| `NN_ALPHA` | ô 1 notebook | Điều chuẩn L2 của MLP (thay cho dừng sớm) | `1e-3` |
| `AUG_RADAR_SHIFT_M` | ô 1 notebook | Dời vị trí **radar ảo trên trần** khi tăng cường dữ liệu công khai — mô phỏng "người ngã ở chỗ khác trong phòng". Xem mục 5a | `1.2` |
| `RADAR_PLACE_BY_LABEL` | ô 1 notebook | Đặt radar ảo theo **nhãn** như bản trước (rò rỉ nhãn). Chỉ bật để tái lập con số cũ khi làm bảng so sánh | `False` |
| `EXPORT_AT_FA_BUDGET` | ô 1 notebook | Ngưỡng xuất cho **hồi quy logistic** chọn theo trần báo nhầm thay vì theo F1 (ngưỡng F1 cho tới ~127 báo nhầm/giờ) | `True` |
| `FALL_MODEL_CONFIRM_WINDOWS` | `include/model_weights.h` | Số cửa sổ liên tiếp cho hồi quy logistic — notebook xuất kèm bộ trọng số để firmware và phần mô phỏng không lệch nhau | `2` |
| `NN_FALL_THRESHOLD` | `include/nn_weights.h` | Ngưỡng xác suất của MLP. **Cao hơn = ít báo nhầm hơn, bỏ sót nhiều hơn** | do notebook chọn |
| `NN_CONFIRM_WINDOWS` | `include/nn_weights.h` | Số cửa sổ liên tiếp phải vượt ngưỡng mới báo (2 cửa sổ ≈ 0,5 s) | `2` |
| `FALL_MODEL_THRESHOLD` | `include/model_weights.h` | Ngưỡng của hồi quy logistic | do notebook chọn |
| `FEATURE_PERIOD_MS`, `FEATURE_RING_SIZE` | `include/config.h` | Chu kỳ lấy mẫu đặc trưng (250 ms) và số mẫu giữ trong RAM | `250`, `400` |

**Muốn ít báo nhầm hơn mà không train lại:** mở `include/nn_weights.h`, tăng `NN_FALL_THRESHOLD`
(ví dụ `0.98` → `0.995`), nạp lại firmware. Bảng *điểm vận hành* ở mục 11 của notebook cho biết
mỗi ngưỡng tương ứng bao nhiêu % cú ngã bắt được và bao nhiêu lần báo nhầm mỗi giờ.

### Ba model KHÔNG tự kích hoạt cảnh báo

Máy trạng thái cảnh báo (`stateMachineTick()` trong `src/main.cpp`) vẫn dựa vào **cờ ngã của
chip C1001**. Kết quả của cả ba model được tính và **hiển thị song song** (xem `/api/status`,
khối `model` và `nn`), nhưng không tự gọi người nhà. Đây là lựa chọn có chủ đích:

- để so sánh công bằng "model của em" với "thuật toán có sẵn trong chip" trên cùng dữ liệu;
- và vì số liệu hiện tại vẫn đo trên dữ liệu công khai **đã chuyển đổi**, chưa phải dữ liệu đo
  bằng chính con C1001 của đồ án.

Nếu GVHD muốn model tham gia quyết định (ví dụ chỉ báo khi chip **và** MLP cùng đồng ý, để giảm
báo nhầm; hoặc báo khi MLP đồng ý **và** tư thế là `nằm trên sàn`), đó là thay đổi vài dòng trong
`stateMachineTick()` — nên trao đổi trước khi chốt.

---

## 1. Lấy dữ liệu ở đâu

| # | Nguồn | Vì sao phù hợp | Lấy ở đâu |
|---|---|---|---|
| 1 | **Tự đo bằng chính C1001** | Cùng cảm biến, cùng lắp trần 2,7 m, cùng 10 đặc trưng. **Bắt buộc** — số liệu chính của báo cáo lấy ở đây | Dashboard → *Kỹ thuật › Báo cáo & biểu đồ* → **Tải dữ liệu huấn luyện (Kaggle)** |
| 2 | **mm-ADL** (214 MB, CC BY 4.0) | Radar **TI IWR6843ISK-ODS, 60 GHz** — đúng dải tần của C1001. 11 người, ~50 cú ngã mỗi người, **kèm ngồi ghế và nằm giường** (chính là các ca dễ nhầm) | [doi.org/10.5281/zenodo.22405011](https://doi.org/10.5281/zenodo.22405011) · [GitHub](https://github.com/OwenHan10/mm-ADL) |
| 3 | **mm-ADL-Home** (134 MB, CC BY 4.0) | Cùng radar, cùng bảng 10 nhãn, nhưng quay **liên tục 15–20 phút** trong 4 căn hộ có đồ đạc. Dùng làm tập "gần thực tế" | [doi.org/10.5281/zenodo.23456178](https://doi.org/10.5281/zenodo.23456178) · [GitHub](https://github.com/OwenHan10/mm-ADL-Home) |
| 4 | **RadHAR** (tùy chọn) | Point cloud TI mmWave, 5 hoạt động **thường** (đấm, nhảy, bật, ngồi xổm, đi) — không có ngã. Làm dày lớp "không ngã" để giảm báo nhầm | tự tải từ GitHub `nesl/RadHAR` khi bật Internet |

Vì sao chọn mm-ADL mà không phải bộ khác: các bộ phổ biến hơn (SisFall, UR Fall) dùng gia tốc kế
hoặc camera; mmFall dùng radar **77 GHz** gắn tường; các bộ 24 GHz có độ phân giải khác hẳn. Chỉ
mm-ADL vừa **60 GHz**, vừa có **point cloud theo thời gian**, vừa có **nhãn từng khung** cho cả
cú ngã lẫn các ca dễ nhầm. Những bộ kia chỉ nên trích ở chương tổng quan.

**Vì sao dataset công khai không nạp thẳng được:** C1001 không xuất point cloud, chỉ xuất giá trị
mức cao (có người, kiểu chuyển động, biên độ 0–100, khoảng cách). Notebook **chuyển** point cloud
của mm-ADL sang các giá trị đó bằng một "radar ảo gắn trần 2,7 m, nón quét 100°" (mục 5). Đây là
phép **xấp xỉ** — biên độ chuyển động của C1001 là thuật toán đóng của hãng. Vì vậy:

- dữ liệu tự đo có trọng số gấp 3 (`W_OWN`);
- khi có ≥ 400 mẫu sinh hoạt tự đo, notebook tự khớp thang biên độ mm-ADL về đúng phân bố của
  C1001 (ánh xạ phân vị);
- **số liệu đưa vào báo cáo là số liệu trên dữ liệu tự đo**; mm-ADL chỉ dùng để nói "model đã
  được kiểm tra trên 15 người lạ".

---

## 2. Tự đo dữ liệu bằng thiết bị

1. Nạp firmware (`pio run -t upload`, `pio run -t uploadfs`), chạy dashboard
   (`cd dashboard && npm run dev`), nhập IP của ESP32 ở trang **Cài đặt**.
2. Trang **Kỹ thuật › Đo thực nghiệm**: tạo phiên đo, mỗi lần thử bấm *Bắt đầu*, làm động tác
   (ngã lên **thảm dày**), bấm *Kết thúc*. Kịch bản có sẵn theo bản kế hoạch: không người, đi lại,
   3 kiểu ngã (30 lần mỗi kiểu), 3 ca dễ nhầm, ngã rồi bấm "Tôi ổn", bấm SOS, ngã không phản hồi.
3. **Để dashboard chạy suốt lúc đo**: nó thu chuỗi đặc trưng 4 mẫu/giây từ `/api/features`.
   Lần thử thiếu 3 giây dữ liệu sẽ bị bỏ.

Mẹo cho dữ liệu sạch: ngã nhiều hướng, nhiều vị trí dưới radar; **đo kỹ các ca dễ nhầm** (đây là
nguồn báo nhầm); đo ở 2 độ cao lắp hoặc 2 độ nhạy để có bảng so sánh.

> Dữ liệu tự đo **không có nhãn tư thế**, nên model 3 (tư thế) học hoàn toàn trên dữ liệu công
> khai. Phải ghi rõ điểm này trong báo cáo.

### Mẹo rẻ nhất mà hiệu quả nhất: để máy ghi "sinh hoạt thường" không cần nhãn

Ngoài các lần thử có kịch bản ở trên, hãy **cắm thiết bị trong chính phòng sẽ lắp và để dashboard
chạy vài tiếng** lúc sinh hoạt bình thường — không cần ngã lần nào, không cần bấm gì, không cần
gán nhãn. Chuỗi đặc trưng đó đủ để **CORAL** (mục 11a) kéo toàn bộ dữ liệu công khai về đúng
"chất" tín hiệu của phòng bạn.

Đo trên mm-ADL → mm-ADL-Home (bảng mục 11c), riêng bước này làm tỉ lệ bắt được tăng từ **13,0%
lên 22,6%** ở mức ≤ 6 báo nhầm/giờ, và quan trọng hơn: khi mang ngưỡng dò ở phòng nguồn sang
phòng mới thì số lần hú thực tế giảm từ **56,1 xuống 11–18 lần/giờ**. Nhiều hơn mọi thứ khác cộng
lại, mà công sức bỏ ra gần như bằng không. Càng nhiều giờ càng tốt; từ khoảng 1 giờ (≈ 14 000
mẫu) trở lên là đã có tác dụng.

---

## 3. Huấn luyện trên Kaggle

1. Dashboard → **Tải dữ liệu huấn luyện (Kaggle)** (bỏ qua nếu chưa đo được gì — notebook vẫn
   chạy bằng dữ liệu công khai, nhưng số liệu khi đó **chỉ để thử**).
2. Kaggle → *Create → New Dataset* → upload file JSON vừa tải (để *Private*).
3. Kaggle → *Create → New Notebook* → *File → Import Notebook* → chọn
   `tools/kaggle/huan_luyen_model_te_nga.ipynb`.
4. Bật **Settings → Internet: On** (notebook tự tải mm-ADL từ Zenodo, có kiểm tra MD5). Hoặc thêm
   dataset bằng tay: *New Dataset → tab Link* → dán
   `https://zenodo.org/records/22405011/files/mm-adl-v1.0.zip?download=1` (làm tương tự với
   mm-ADL-Home) rồi *Add Data*.
5. **Run All**, rồi vào tab *Output* tải về:

| File | Chép vào |
|---|---|
| `model_weights.h` | `include/model_weights.h` |
| `nn_weights.h` | `include/nn_weights.h` |
| `model_report.json`, `*.png`, `eda_*.csv` | giữ cho báo cáo |

   Muốn **xem dữ liệu trước khi huấn luyện**: đặt `CHI_XEM_DU_LIEU = True` ở ô 1 rồi Run All. Notebook
   chuẩn bị dữ liệu, vẽ mục 6 rồi dừng, không chạy phần huấn luyện. Xem xong thì đặt lại `False` và Run
   All lần nữa. Đừng để `True` khi bấm *Save Version*: notebook dừng giữa chừng nên Kaggle ghi bản chạy
   đó là lỗi.

6. `pio run -t upload`. Serial phải in **cả hai** dòng:

```
[MODEL] Da nap model: kaggle ...
[NN] Da nap mang no-ron: kaggle ... | MLP 10-64-32-16-1 | bat ...% cu nga @ 6 bao nham/gio
```

Notebook làm gì, theo thứ tự: tự kiểm tra hợp đồng đặc trưng khớp bản C++ → gán nhãn cửa sổ 3 giây
→ chuyển point cloud mm-ADL sang tín hiệu kiểu C1001 → **trực quan hóa dữ liệu** (mục 6, xem bảng dưới)
→ đánh giá chéo **theo người / theo lần thử**
(không rò rỉ dữ liệu) → huấn luyện hồi quy logistic → huấn luyện MLP té ngã và chọn ngưỡng theo
**trần báo nhầm** → huấn luyện MLP tư thế 5 lớp → xuất hai file `.h` rồi **đọc lại chính file vừa
ghi, tính bằng số thực 32 bit như ESP32** để đối chiếu với scikit-learn (lệch phải < 1e-5).

### Mục 6: trực quan hóa dữ liệu trước khi huấn luyện

Mục 6 chỉ đọc dữ liệu đã chuẩn bị ở mục 4–5, không đổi gì, nên bật hay tắt thì kết quả huấn luyện vẫn
y hệt. Mỗi hình kèm một bảng số in ngay dưới ô; hình và bảng đều nằm ở tab *Output*:

| Mục | Hình | Xem gì |
|---|---|---|
| 6a | `eda_01_tong_quan.png` (+ `eda_tong_quan.csv`) | Số giờ, số cú ngã, số cửa sổ mỗi nhãn của từng nguồn; số cú ngã của từng người |
| 6b | `eda_02_thoi_luong_hoat_dong.png` | Mỗi hoạt động (ngã, ngồi, nằm giường…) chiếm bao nhiêu phút |
| 6c | `vi_du_cu_nga.png` | Một cú ngã sau khi chuyển sang tín hiệu C1001 |
| 6d | `eda_03_nga_va_ca_de_nham.png` | Ngã, ngồi xuống, nằm xuống giường đặt cạnh nhau: độ cao, biên độ, khoảng cách, trạng thái |
| 6e | `eda_04_chu_ky_su_kien.png` (+ `eda_chu_ky_su_kien.csv`) | Trung vị của mọi lần mỗi động tác quanh lúc kết thúc, so với cửa sổ 3 giây và mốc chip xác nhận ngã |
| 6f | `eda_05_phan_bo_dac_trung.png`, `eda_06_tuong_quan_dac_trung.png` (+ `eda_do_tach_dac_trung.csv`) | Phân bố và AUC của từng đặc trưng; cặp đặc trưng trùng thông tin |
| 6g | `eda_07_lech_mien.png` | Biên độ, khoảng cách, thời gian ở từng trạng thái của từng nguồn (lệch miền) |
| 6h | `eda_08_ban_do_2d.png` | Bản đồ PCA và t-SNE của các cửa sổ, tô theo nhãn / hoạt động / nguồn |
| 6i | `eda_09_tu_the.png` | Khoảng cách, biên độ, độ cao của 4 tư thế tĩnh: kiểm tra giả thuyết "nằm sàn xa radar hơn nằm giường" |
| 6j | `eda_10_du_lieu_tu_do.png` | Chỉ khi có dữ liệu tự đo: số lần thử mỗi kịch bản, nhịp lấy mẫu, một lần thử ngã mẫu |

Một hình bị lỗi chỉ in một dòng `[EDA] Bo qua ...` rồi chạy tiếp. Thiếu matplotlib thì vẫn in bảng.

---

## 4. Đọc kết quả cho đúng

- **Mục 11b — bảng so sánh ba bộ phát hiện** là bảng chính cho chương 4. Hồi quy logistic được
  chấm ở **hai** ngưỡng: ngưỡng F1 của chính nó, và ngưỡng cho **cùng trần báo nhầm** với MLP.
  So ở cùng trần báo nhầm mới là so công bằng.
- **Mục 12 — ma trận nhầm lẫn tư thế**: xem riêng hai dòng `nam_giuong` và `nam_san`. Đây là
  phần trả lời "làm sao phân biệt nằm giường với nằm sàn".
- **Bảng điểm vận hành (mục 11)**: mỗi ngưỡng cho bao nhiêu % cú ngã bắt được và bao nhiêu lần
  báo nhầm mỗi giờ. Đây là bảng để chọn `FA_BUDGET_PER_HOUR`.
- **Đừng dùng độ chính xác (accuracy) làm số liệu chính.** Cửa sổ "không ngã" nhiều gấp hàng chục
  lần cửa sổ "ngã", nên chỉ cần đoán "không ngã" mọi lúc là đã đạt ~95% mà hoàn toàn vô dụng.
  Riêng với model tư thế, accuracy còn bị lớp `khong_nguoi` kéo lên: cửa sổ không có người là
  cửa sổ toàn số 0 nên tách ra quá dễ (F1 = 1,00), đưa vào accuracy là tự thưởng cho mình.
- **Lấy cột "lồng nhau" (nested), đừng lấy cột dò trên chính dữ liệu.** Bảng điểm vận hành dò
  ngưỡng trên chính tập đang chấm rồi báo điểm trên đó — đó là **giới hạn trên**, vì ngoài đời
  bạn không có nhãn của căn phòng sẽ lắp. Notebook có `nested_events()`: với mỗi fold, ngưỡng
  được chọn trên các fold **khác** rồi mới áp cho fold đang chấm, sau đó gộp sự kiện của 5 fold.
  Mục 11, 11b và 14 đều in thêm cột này. **Số viết vào báo cáo là số lồng nhau.**

### Một chỗ từng làm số liệu đẹp giả — nên nêu thẳng trong báo cáo

mm-ADL quay bằng radar để trên chân máy cao 1,53 m nhìn ngang; đồ án lắp C1001 trên trần 2,7 m
nhìn xuống. Muốn dùng được dữ liệu đó phải chọn một điểm trên trần làm chỗ đặt "radar ảo".

Bản trước chọn điểm đó **bằng nhãn**: bản ghi nào có cú ngã thì đặt radar ngay trên chỗ người
ngã, bản ghi không ngã thì đặt trên chỗ ngồi/nằm. Đó là **rò rỉ nhãn** — nhãn được lấy ra để
dựng đặc trưng, và bài toán bị đổi thành *"người luôn ngã ngay bên dưới radar"*, điều không bao
giờ đúng trong nhà thật.

Bây giờ radar ảo đặt ở tâm vùng người hoạt động, **không xem nhãn** (`radar_xy()` ở mục 5a), và
mỗi bản tăng cường còn **quay lại cùng cú ngã đó từ một vị trí radar lệch đi tới
`AUG_RADAR_SHIFT_M` mét** — nhờ tách `person_track()` (đường đi của người) khỏi `render_c1001()`
(quay lại từ một vị trí radar). Cờ `RADAR_PLACE_BY_LABEL` giữ lại cách cũ để tái lập con số cũ
khi làm bảng so sánh; đừng lấy số đó viết vào phần kết quả.

### Số liệu đo được trên dữ liệu công khai (chưa có dữ liệu tự đo)

Chia theo **người** (người trong tập kiểm tra chưa từng xuất hiện khi học), 144 760 cửa sổ có nhãn,
**15 người** (mm-ADL 11 + mm-ADL-Home 4) cộng 5 hoạt động thường của RadHAR, **795 cú ngã**, mô
phỏng đúng luật "2 cửa sổ liên tiếp" của firmware. Trần báo nhầm nhắm tới: **6 lần/giờ sinh hoạt**.

| Model | Ngưỡng | Bắt được cú ngã | Báo nhầm/giờ |
|---|---|---|---|
| Hồi quy logistic, ngưỡng theo **F1 cửa sổ** | 0,75 | 77,6% | **121,2** ← không ai dùng được |
| Hồi quy logistic, cùng trần báo nhầm | 0,9915 | 5,3% (42/795) | 6,4 |
| **MLP `10-64-32-16-1` (đang nạp)** | 0,73 | **38,7%** (308/795) | 6,6 |

Hai dòng dưới chấm **lồng nhau** (ngưỡng chọn trên fold khác rồi mới áp cho fold đang chấm) nên
là con số đưa vào báo cáo. Dòng đầu là minh chứng cho việc **F1 là tiêu chí sai** cho bài toán
này: nó cho tỉ lệ bắt được rất đẹp kèm 121 lần hú mỗi giờ — thiết bị sẽ bị rút điện trong ngày
đầu. Vì vậy ngưỡng xuất xuống firmware chọn theo trần báo nhầm (`EXPORT_AT_FA_BUDGET`).

Toàn bộ đường cong, cũng chấm lồng nhau (bảng này đo trên mm-ADL + mm-ADL-Home, **không** gồm
RadHAR, nên hơi thấp hơn con số ở trên):

| Tỉ lệ bắt được cú ngã | ≤ 1 báo nhầm/giờ | ≤ 3 | ≤ 6 | ≤ 12 | ≤ 24 |
|---|---|---|---|---|---|
| Hồi quy logistic (model 1) | 1,0% | 2,8% | 5,3% | 12,5% | 22,5% |
| **MLP `10-64-32-16-1` (model 2)** | **11,6%** | **22,8%** | **34,2%** | **46,8%** | **62,3%** |

Bật thêm RadHAR (mặc định) làm dày lớp "không ngã" bằng 5 hoạt động mạnh mà **không** ngã (đấm,
nhảy, bật, ngồi xổm, đi) và đưa mức ≤ 6 lên **38,7%**.

> Số liệu **xê dịch vài điểm phần trăm** giữa các lần chạy (khởi tạo ngẫu nhiên của MLP). Hãy lấy
> số của **chính lần chạy của bạn** để viết báo cáo.

Model tư thế (`10-32-16-5`): độ chính xác ngoài-tập **69,8%**, macro F1 **0,652**. F1 từng lớp —
`khong_nguoi` 1,00 · `dung_di` 0,78 · `nam_san` 0,56 · `nam_giuong` 0,51 · `ngoi` 0,41. Lớp quan
trọng nhất của đồ án là `nam_san`: **recall 0,80** (precision 0,43) — nhờ cân lớp
(`NN_BALANCE_POSTURE`), model thà báo thừa chứ ít bỏ sót người nằm trên sàn. Đổi lại độ chính xác tổng tụt so với bản không cân lớp;
đó là đánh đổi có chủ đích, và `khong_nguoi` đạt F1 = 1,00 chỉ vì cửa sổ không có người là cửa
sổ toàn số 0 nên tách ra quá dễ — **đừng lấy accuracy làm số liệu chính**.

**Kết luận nên nêu thẳng trong báo cáo:** với đúng 10 đặc trưng mức cao mà C1001 cung cấp, **giới
hạn không nằm ở dữ liệu mà ở dạng model**. Hồi quy logistic gần như vô dụng ở mức báo nhầm chấp
nhận được, vì ranh giới giữa "ngã xuống sàn" và "ngồi xuống ghế / nằm xuống giường" không phải
đường thẳng. Đổi sang một MLP nhỏ — vẫn chạy trên **chính con ESP32 đó**, vẫn **đúng 10 đặc trưng
đó** — làm tỉ lệ bắt được tăng khoảng **7 lần** (5,3% → 38,7%) ở cùng mức báo nhầm.

### Từng thay đổi đóng góp bao nhiêu (mục 11d)

Ablation trên **cùng dữ liệu, cùng cách chia fold, cùng hạt ngẫu nhiên** (mm-ADL + mm-ADL-Home,
**không** gồm RadHAR, chấm lồng nhau, trần 6 báo nhầm/giờ):

| Cấu hình | Bắt được cú ngã |
|---|---|
| Bản ĐẦU TIÊN (đặt radar ảo theo nhãn · dừng sớm bị rò rỉ · không cân lớp) | 40,0% |
| Bản sau khi sửa lỗi, nhưng `NN_BATCH = 1024`, `NN_MAX_ITER = 30`, bật cân lớp | 31,1% |
| ↳ chỉ bỏ cân lớp | 32,3% |
| ↳ chỉ bỏ phép dời vị trí radar ảo | 35,7% |
| ↳ chỉ đặt lại radar ảo **theo nhãn** | 23,1% |
| ↳ chỉ bật lại dừng sớm của scikit-learn | 25,5% |
| **Bản CHỐT (bỏ cân lớp · `NN_BATCH = 256` · `NN_MAX_ITER = 40`)** | **34,2%** |

**Bài học đáng viết vào báo cáo:** ba lỗi phương pháp của bản đầu (lấy *nhãn* ra đặt radar ảo,
dùng tín hiệu dừng sớm bị *rò rỉ*, dò ngưỡng trên chính dữ liệu đem báo điểm) **sửa được mà gần
như không mất điểm** — 34,2% so với 40,0% trên cùng dữ liệu, và lên 38,7% khi bật RadHAR. Nhưng
trong lúc sửa, việc nâng `NN_BATCH` 200 → 1024 và hạ `NN_MAX_ITER` 600 → 30 "cho chạy nhanh" đã
âm thầm cắt tổng số **bước cập nhật** từ ~72 000 xuống ~20 000, và **đó** mới là chỗ làm mất 7
điểm phần trăm. Đo `n_iter_` của bản cũ mới thấy nó dừng ở **vòng 43**, không phải 600 như
`max_iter` ghi. Một "tối ưu cho nhanh" có thể là một thay đổi siêu tham số lớn mà không ai nhận
ra — và chỉ ablation mới lộ ra.

Hai thứ tôi tưởng là cải tiến thì **đo được là không**: cân lớp cho mạng té ngã (đã tắt mặc
định), và — ở riêng benchmark trộn này — phép dời vị trí radar ảo. Phép dời radar vẫn **giữ**, vì
nó sửa một chỗ *không thật* của phép mô phỏng (người luôn ngã ngay dưới radar) mà benchmark trộn
không đo được: benchmark chỉ chia theo NGƯỜI, các fold vẫn dùng chung phòng.

### Bài kiểm tra "đổi nhà" — số liệu quan trọng nhất (mục 11c)

Mọi con số ở bảng trên đều **trộn chung** dữ liệu rồi mới chia fold, nên che mất câu hỏi thật:
*model học ở phòng này, đem sang phòng khác có còn chạy không?* Mục 11c đo thẳng vào đó — học
**chỉ** trên mm-ADL (11 người, phòng trống có kiểm soát), rồi thả vào mm-ADL-Home (**4 người lạ**,
4 căn hộ có giường/sofa/tủ che khuất):

| Cách làm | ≤ 1 | ≤ 3 | ≤ 6 | ≤ 12 | **ngưỡng dò ở NGUỒN** | **báo nhầm/giờ THỰC TẾ** |
|---|---|---|---|---|---|---|
| 1. Gốc | 0,7% | 7,5% | 13,0% | 19,9% | 57,5% | **56,1** |
| 2. CORAL một mình | 4,1% | 12,3% | 19,2% | **34,2%** | 34,2% | **11,1** |
| 3. Tăng cường một mình | 0,7% | 6,2% | 15,8% | 21,2% | 53,4% | **41,5** |
| **4. Cả hai (mặc định)** | **5,5%** | **17,1%** | **22,6%** | 32,2% | 40,4% | 18,1 |

**1. Lệch miền mới là vấn đề lớn nhất, không phải thuật toán.** Cùng model đó, trộn chung dữ
liệu rồi chia fold thì được ~39% ở mức 6 báo nhầm/giờ; học riêng mm-ADL rồi thả vào căn hộ chưa
từng thấy thì còn **22,6%**, và nếu bỏ CORAL thì còn **13–16%**. Nói cách khác, **mọi con số đo
trên dữ liệu trộn đều lạc quan** — và đây chính là lý do bạn bắt buộc phải đo dữ liệu trong chính
phòng sẽ lắp thiết bị.

**2. Giá trị thật của CORAL là làm NGƯỠNG CHUYỂN ĐƯỢC** — đây là kết luận chắc nhất của cả bảng,
nhìn hai cột cuối. Bạn dò ngưỡng ở phòng nguồn để nhắm 6 báo nhầm/giờ; đem sang phòng lạ thì thực
tế nó kêu **42–56 lần/giờ** (hơn một phút lại hú một lần). Con số "bắt được 53–58%" ở cột kế bên
vì vậy **vô nghĩa** — nó đi kèm mức báo nhầm không ai chịu nổi. Có CORAL: **11–18 lần/giờ**,
cùng cỡ với mức nhắm, mà vẫn bắt được 34–40%. Lý do: phân bố đặc trưng ở phòng mới lệch đi nên
cùng một con số ngưỡng lại rơi vào chỗ khác hẳn trên đường cong; CORAL kéo hai phân bố về khớp
nhau nên **ngưỡng giữ nguyên ý nghĩa**.

**3. Hai kỹ thuật bù nhau, nhưng KHÔNG phải ở mọi mức — phát biểu "cộng hưởng, phải bật cả hai"
của bản trước là quá mạnh.** Ở các trần **ngặt**, đúng là vùng đồ án dùng, gộp cả hai hơn rõ:
≤ 1 là 5,5% so với 4,1%, ≤ 3 là 17,1% so với 12,3%, ≤ 6 là 22,6% so với 19,2%. Nhưng ở ≤ 12 thì
CORAL một mình lại hơn (34,2% so với 32,2%), và cột báo nhầm thực tế của nó cũng thấp hơn (11,1
so với 18,1). Còn tăng cường **một mình** thì gần như vô dụng: 15,8% so với 13,0% của bản gốc, mà
vẫn kêu 41,5 lần/giờ. Kết luận trung thực: **CORAL là thứ bắt buộc; tăng cường chỉ đáng khi nhắm
trần ngặt** — mà đó đúng là trường hợp của đồ án (`FA_BUDGET_PER_HOUR = 6`), nên cả hai đều mặc
định `True`.

**4. Cái giá phải trả của tăng cường.** Nó làm bảng mẫu to gấp 3 nên notebook chạy chậm gấp 3, và
như nói ở trên thì không phải lúc nào cũng có lợi. Đây là một núm cần đo, không phải một chân lý.

**5. Chi phí trên ESP32 bằng không.** CORAL chỉ biến đổi **dữ liệu lúc huấn luyện**; model nạp
xuống vẫn nhận thẳng 10 đặc trưng thật. Firmware không thêm một phép tính hay một byte nào. Đây là
lý do chọn CORAL thay vì DANN (huấn luyện đối kháng, khó hội tụ với lượng dữ liệu này, mà cũng
không cho lợi thế triển khai nào hơn).

**6. Đào mẫu khó KHÔNG giúp gì** (đo trên quy trình cũ: 10,3% → 9,6%). Mặc định
`USE_HARD_NEGATIVE = False`; bật lên để chạy lại dòng 5 của bảng. Một kết quả âm **có đo đạc** —
rất đáng viết vào báo cáo.

**7. CORAL chỉ chạy khi có dữ liệu tự đo** (ở mục 11/11b nó khớp *công khai → tự đo*). Bảng trên
là mục 11c, nơi nó khớp *mm-ADL → mm-ADL-Home*. Khi bạn chưa đo dữ liệu của mình, các con số ở
mục 11/11b **không có** CORAL — thêm một lý do nữa để đo dữ liệu trong phòng thật.

> Bốn cột đầu dò ngưỡng trên chính miền đích nên là **giới hạn trên**; ngoài đời bạn không có nhãn
> của phòng mới. Cả 4 cách đều được ưu ái như nhau nên so sánh giữa chúng là công bằng. **Hai cột
> cuối mới là kịch bản triển khai thật — lấy hai cột đó khi viết phần kết quả.**

Hai thí nghiệm khác đã làm nhưng **không** đưa vào firmware, nên ghi ở mục "hướng phát triển":

- **Bộ 43 đặc trưng / cửa sổ 6 giây** (mục 14): bản trước đo được hơn khoảng 4–5 điểm phần trăm,
  nhưng phép so đó **không công bằng** (bộ 43 đặc trưng chạy không tăng cường, không CORAL, không
  cân lớp, trong khi bộ 10 có cả ba). Notebook đã sửa để so ở cùng điều kiện; **chưa đo lại** —
  bật `TRY_BIG_FEATURES = True` nếu cần con số cho báo cáo. Dù hơn thì vẫn không nạp xuống
  firmware: phải cài trùng khớp 43 công thức ở cả C++ lẫn TypeScript là nguồn lỗi âm thầm lớn.
- **Dùng tư thế để "chốt" cảnh báo** (chỉ báo khi MLP đồng ý *và* tư thế là `nằm trên sàn`): đo
  trên quy trình **cũ** thì lợi ích **không đáng kể** ở phần lớn các mức báo nhầm (chỉ khá hơn ở
  mức rất ngặt ≤ 1 lần/giờ: 16,4% → 19,5%). Chưa đo lại sau khi sửa. Vì vậy model tư thế hiện dùng
  để **giải thích cho người nhà**, không dùng để chốt. Một kết quả âm nhưng có đo — rất đáng viết.

---

## 5. Trả lời câu hỏi "AI nằm ở đâu?" khi bảo vệ

1. Nhận dạng tư thế từ point cloud chạy **trong chip radar** (thuật toán của DFRobot): "AI có sẵn",
   không phải của em.
2. **AI do em tự làm**: ba model ở mục 0 — huấn luyện trên dữ liệu em tự đo cộng dữ liệu công khai
   mm-ADL đã chuyển đổi, **chạy ngay trên ESP32**, so sánh định lượng với thuật toán của chip.
3. **Cố ý không** đưa cờ ngã của chip vào đặc trưng: đưa vào thì model chỉ chép lại kết quả của
   chip, con số đẹp sẽ vô nghĩa. Đây là điểm dễ bị hội đồng bắt lỗi nhất.
4. Em **so sánh ba dạng model** trên cùng dữ liệu và chỉ ra giới hạn nằm ở dạng model, không phải
   ở dữ liệu — kèm cả một kết quả âm (chốt bằng tư thế không giúp được bao nhiêu).
5. Em xử lý **lệch miền (domain shift)**: đo được rằng khi đổi sang căn hộ lạ, nếu mang nguyên
   ngưỡng dò ở phòng nguồn sang thì thiết bị hú **42–56 lần mỗi giờ** (bảng mục 11c), rồi dùng
   **CORAL** kéo xuống **11–18 lần/giờ** mà vẫn bắt được 34–40% — **không cần nhãn** của phòng
   mới và **không tốn thêm phép tính nào trên ESP32**. Em cũng nêu một kết quả **trái với kỳ vọng
   ban đầu**: tăng cường dữ liệu không "cộng hưởng" với CORAL như em từng kết luận, mà lợi/hại
   tuỳ mức báo nhầm nhắm tới.

### Nếu hội đồng hỏi "sao không dùng PointNet / CNN 3D / phổ micro-Doppler như trong paper?"

Trả lời thẳng: **lúc chạy thật, C1001 không xuất point cloud.** Nó chỉ cho 5 con số ở 4 Hz
(`present`, `movement`, `range` 0–100, `staticStay`, `distanceCm`). Point cloud chỉ tồn tại trong
mm-ADL (dùng để *sinh* ra dữ liệu huấn luyện ở mục 5). Train PointNet trên đó thì lúc nạp vào
thiết bị **không có gì để đưa vào mạng**. Đây là ràng buộc phần cứng, không phải lựa chọn tùy
tiện — và chính nó quyết định toàn bộ thiết kế: 10 đặc trưng mức cao + model đủ nhỏ để chạy
on-device.

---

## 6. Hợp đồng đặc trưng — chỗ dễ sai nhất

Cả ba model dùng đúng 10 đặc trưng của cửa sổ 12 mẫu × 250 ms = 3 giây. Công thức được cài ở
**ba** nơi và phải khớp từng con số:

| Nơi | Hàm |
|---|---|
| C++ (firmware) | `src/core/fall_model.cpp` → `extractFeatures()` |
| TypeScript (dashboard) | `dashboard/src/lib/features.ts` → `extractFeatures()` |
| Python (notebook) | mục 3 → `cpp_extract()` / `window_features()` |

Sửa một nơi thì **phải** sửa hai nơi kia và tăng `FEATURE_SPEC_VERSION` ở cả ba. Firmware kiểm tra
số phiên bản trong `model_weights.h` và `nn_weights.h`; lệch thì nó **bỏ qua model** và in cảnh báo
ra Serial thay vì chạy sai âm thầm. Notebook cũng tự đối chiếu bản Python với bản C++ trên 62 ca
thử ngay ở mục 3 và dừng nếu lệch.
