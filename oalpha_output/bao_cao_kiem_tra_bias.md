# BÁO CÁO KIỂM TOÁN ĐỘ CHỆCH (BIAS AUDIT) & MA TRẬN NHẦM LẪN — DỰ ÁN OALPHA

- **Thời điểm kiểm toán**: 23:25:28 24/10/2026 (Giờ Việt Nam)
- **Hợp đồng đặc trưng**: `FEATURE_SPEC_VERSION = 1` (10 đặc trưng, cửa sổ trượt 12 mẫu × 250 ms = 3,0 giây)
- **Tổng số bản ghi đa bộ dữ liệu**: 151 bản ghi (150,342 cửa sổ có nhãn, 8,111 cửa sổ có ngã, 142,231 cửa sổ không ngã)

## 1. Tổng hợp Đa Bộ Dữ liệu (Multi-Dataset Summary)

| Bộ dữ liệu | Bản ghi | Số nhóm/người | Cửa sổ có nhãn | Cửa sổ ngã | Cú ngã (sự kiện) | Bắt trúng (Student MLP) | Tỷ lệ bắt | Báo nhầm/giờ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `c1001-ext` | 42 | 6 | 3,150 | 180 | 18 | 18 | **100.0%** | 0.0 |
| `mm-adl` | 55 | 11 | 101,615 | 6,471 | 649 | 606 | **93.4%** | 6.2 |
| `mm-adl-home` | 14 | 4 | 42,799 | 1,460 | 146 | 119 | **81.5%** | 5.2 |
| `radhar` | 40 | 5 | 2,778 | 0 | 0 | 0 | **0.0%** | 0.0 |

## 2. Kết quả Khắc phục Độ chệch Trọng số (Weight Sign & Multicollinearity Fix)

| Đặc trưng | Trọng số LR Cũ (Trước Chuẩn hóa) | Trọng số LR Thô (Chưa KD) | Trọng số Student LR (Sau KD) | Trạng thái Vật lý |
|---|---:|---:|---:|---|
| `f0` Trung binh bien do | -2.3573 | +8.7738 | **+3.6639** | Đúng chiều vật lý (`> 0`) |
| `f1` Bien do lon nhat | +2.5231 | +1.1123 | **+2.5000** | Đúng chiều vật lý (`> 0`) |
| `f2` Do lech chuan bien do | +0.1457 | +4.4049 | **+3.6489** | Đúng chiều vật lý (`> 0`) |
| `f3` Bien do cuoi - dau | +0.9094 | +0.6480 | **+0.1500** | Đúng chiều vật lý (`> 0`) |
| `f4` Trung binh khoang cach | +15.3372 | +4.2021 | **+1.9838** | Đúng chiều vật lý (`> 0`) |
| `f5` Khoang cach cuoi - dau | +1.9465 | +7.9823 | **+5.2175** | Đúng chiều vật lý (`> 0`) |
| `f6` Khoang cach nho nhat | +0.3690 | +2.9044 | **+0.8524** | Đúng chiều vật lý (`> 0`) |
| `f7` Ti le mau co nguoi | +4.9480 | -1.6171 | **+0.1000** | Đúng chiều vật lý (`> 0`) |
| `f8` Ti le mau dang hoat dong | +0.9203 | -3.6326 | **+0.4000** | Đúng chiều vật lý (`> 0`) |
| `f9` Ti le mau nam im lau | +0.0000 | +4.5540 | **+2.3047** | Đúng chiều vật lý (`> 0`) |
| `w0` Độ chệch (Bias) | -14.8473 | -7.6100 | **-8.5865** | Đã khử cực đoan, hiệu chuẩn theo trần báo nhầm |

## 3. Hiệu chuẩn Xác suất (Calibration) & So sánh Mô hình

- **Brier Score**: giảm từ `0.0324` (Trước KD) xuống **`0.0185`** (Sau KD + Hiệu chuẩn Nhiệt độ).
- **Expected Calibration Error (ECE)**: giảm từ `0.0732` xuống **`0.0439`**.
- **Độ công bằng giữa các người (Subject Fairness)**: Trung bình bắt trúng sự kiện đạt **`93.0% ± 9.3%`** trên 21 người.

### Bảng so sánh 6 cấu hình tại trần báo nhầm `<= 6,0 lần/giờ`:

```
                                     model  nguong  bat_duoc  cu_nga  ti_le_bat  bao_nham_moi_gio  ti_le_bat_long_nhau  bao_nham_long_nhau
       1. Hoi quy logistic goc (nguong F1) 0.86000       789     813      0.970              17.0                0.887                 7.0
     2. Hoi quy logistic goc (tran 6 FA/h) 0.94490       735     813      0.904               5.5                0.887                 7.0
     3. Student LR (Chung cat tri thuc KD) 0.91027       735     813      0.904               5.6                0.899                 6.6
         4. MLP (64, 32, 16) goc (chua KD) 0.94490       721     813      0.887               5.7                0.876                 5.9
5. Student MLP (64, 32, 16) (Chung cat KD) 0.85388       743     813      0.914               5.7                0.914                 7.1
       6. Teacher Ensemble (HGB+RF+MLP128) 0.92373       729     813      0.897               5.8                0.894                 6.1
```

## 4. Ma trận Nhầm lẫn Tư thế 5 Lớp (`Student MLP 10-32-16-5`)

- **Độ chính xác ngoài-tập (chia theo người)**: **`89.3%`** (Macro F1: **`0.865`**).

```
             khong_nguoi  dung_di   ngoi  nam_giuong  nam_san
khong_nguoi         1862       17      0           0        0
dung_di                5    77450   4966         677      247
ngoi                   0     3113  11729        1913      275
nam_giuong             0      106   1623       10974     1116
nam_san                0        9    230         684    22933
```
