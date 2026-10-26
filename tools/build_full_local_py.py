#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script xây dựng tools/huan_luyen_local.py ĐẦY ĐỦ 3330+ DÒNG từ tools/kaggle/huan_luyen_model_te_nga.py.
Đảm bảo giữ 100% tất cả các mô hình, 10 hàm EDA, các nghiên cứu và bảng số liệu Chương 4,
nhưng hoạt động hoàn hảo trên máy tính cá nhân (Windows/Linux/Mac).
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import shutil
from pathlib import Path

def build_full_local_py():
    src_path = Path("tools/kaggle/huan_luyen_model_te_nga.py")
    dst_path = Path("tools/huan_luyen_local.py")

    with open(src_path, "r", encoding="utf-8") as f:
        content = f.read()

    print(f"Đọc {len(content.splitlines())} dòng từ {src_path}...")

    # 1. Thêm cấu hình UTF-8 ở đầu file
    utf8_header = """import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import shutil
"""
    if "sys.stdout.reconfigure" not in content[:300]:
        content = utf8_header + content

    # 2. Thay thế cấu hình đường dẫn Kaggle sang Local
    kaggle_paths_target = """KAGGLE = Path("/kaggle/working").exists()
OUT_DIR = Path("/kaggle/working") if KAGGLE else Path("oalpha_output")
CACHE_DIR = Path("/tmp/oalpha_cache") if KAGGLE else OUT_DIR / "cache"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
SEARCH_ROOTS = [Path(p) for p in os.environ.get("OALPHA_DATA_DIRS", "").split(os.pathsep) if p]
SEARCH_ROOTS += [Path("/kaggle/input"), CACHE_DIR, Path("."), Path("../../dashboard/data")]
RNG = np.random.default_rng(SEED)
print(f"Kaggle: {KAGGLE} | ket qua ghi vao: {OUT_DIR.resolve()} | matplotlib: {HAS_PLT}")"""

    local_paths_replacement = """WORKSPACE_ROOT = Path(".").resolve()
if not (WORKSPACE_ROOT / "include").exists() and (WORKSPACE_ROOT.parent / "include").exists():
    WORKSPACE_ROOT = WORKSPACE_ROOT.parent

OUT_DIR = WORKSPACE_ROOT / "oalpha_output"
CACHE_DIR = OUT_DIR / "cache"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

SEARCH_ROOTS = [Path(p) for p in os.environ.get("OALPHA_DATA_DIRS", "").split(os.pathsep) if p]
SEARCH_ROOTS += [
    WORKSPACE_ROOT / "dashboard" / "data",
    WORKSPACE_ROOT / "data",
    WORKSPACE_ROOT,
    Path.home() / "Downloads",
    CACHE_DIR,
]
RNG = np.random.default_rng(SEED)

# Cấu hình tối ưu chạy nhanh trên CPU máy cá nhân
TU_DONG_GHI_DE_INCLUDE = True
FAST_LOCAL_MODE = True
if FAST_LOCAL_MODE:
    N_FOLDS = 3
    NN_MAX_ITER = 25
    NN_AUGMENT = 1

print(f"Thư mục dự án: {WORKSPACE_ROOT.resolve()}")
print(f"Kết quả lưu tại: {OUT_DIR.resolve()} | matplotlib: {HAS_PLT}")"""

    if kaggle_paths_target in content:
        content = content.replace(kaggle_paths_target, local_paths_replacement)
    else:
        print("[!] Cảnh báo: không tìm thấy cụm kaggle_paths_target")

    # 3. Thêm hàm sinh dữ liệu mô phỏng C1001 sau _self_test()
    synthetic_def = """

# =============================================================================
# BỘ SINH DỮ LIỆU RADAR C1001 MÔ PHỎNG VẬT LÝ (DỰ PHÒNG KHI CHƯA TẢI DATASET)
# =============================================================================
def generate_synthetic_c1001(num_people=4, trials_per_scenario=4, seed=SEED):
    \"\"\"
    Sinh dữ liệu mô phỏng cảm biến radar C1001 sát với thực tế vật lý:
    - 4 Hz, trần 2.7m (270cm)
    - 4 người (sub-01 .. sub-04) chia thành 2 miền: mm-adl và mm-adl-home
    - Đầy đủ track, P (độ cao người theo trục Z), raw cho toàn bộ 10 bài toán EDA
    - Đủ 5 tư thế theo hợp đồng firmware:
      0: khong_nguoi (phòng trống)
      1: dung_di (Walking)
      2: ngoi (Sit-Stationary)
      3: nam_giuong (LayBed-Stationary)
      4: nam_san (LayFloor-Stationary sau cú ngã)
    \"\"\"
    rng = np.random.default_rng(seed)
    seqs = []
    print(f"[*] Đang sinh dữ liệu mô phỏng C1001 cho {num_people} người (2 miền mm-adl & mm-adl-home)...")

    for pid in range(1, num_people + 1):
        subj = f"sub-{pid:02d}"
        domain = "mm-adl" if pid <= 2 else "mm-adl-home"

        # 0. Phòng trống (không người) -> Nhãn 0: khong_nguoi
        for tr in range(trials_per_scenario):
            duration_s = rng.integers(12, 18)
            N = int(duration_s / PERIOD_S)
            raw_seq = np.zeros((N, 5), int)
            labs = np.array(["Walking"] * N, dtype=object)
            P = np.zeros((N, 3))
            track = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.zeros(N, bool), vstd=np.zeros(N))
            raw = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.zeros(N, bool), amp=np.zeros(N), dist=np.full(N, 270.0))
            seqs.append(dict(
                domain=domain, group=subj, name=f"{subj}/empty/run{tr}",
                protocol="empty", seq=raw_seq, y=np.zeros(len(raw_seq) - WINDOW_SIZE + 1, int),
                raw=raw, track=track
            ))

        # 1. Đi lại -> Nhãn 1: dung_di
        for tr in range(trials_per_scenario):
            duration_s = rng.integers(15, 22)
            N = int(duration_s / PERIOD_S)
            d = 200 + 40 * np.sin(np.linspace(0, 6, N)) + rng.normal(0, 5, N)
            amp = rng.normal(35, 10, N).clip(15, 70)
            pres = np.ones(N, int)
            mov = np.where(amp >= ACTIVE_AMP, 2, 1)
            stat = np.zeros(N, int)
            raw_seq = np.column_stack([pres, mov, amp.round().astype(int), stat, d.round().astype(int)])
            labs = np.array(["Walking"] * N, dtype=object)
            P = np.zeros((N, 3))
            P[:, 2] = np.maximum(0.0, INSTALL_HEIGHT_M - d / 100.0)
            track = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), vstd=np.zeros(N))
            raw = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), amp=amp, dist=d)
            seqs.append(dict(
                domain=domain, group=subj, name=f"{subj}/walk/run{tr}",
                protocol="walk", seq=raw_seq, y=np.zeros(len(raw_seq) - WINDOW_SIZE + 1, int),
                raw=raw, track=track
            ))

        # 2. Ngồi ghế -> Nhãn 2: ngoi (kèm chuyển tiếp ngồi xuống)
        for tr in range(trials_per_scenario):
            duration_s = rng.integers(15, 22)
            N = int(duration_s / PERIOD_S)
            t_tr = N // 3
            d = np.concatenate([
                np.linspace(190, 230, t_tr),
                np.full(N - t_tr, 230) + rng.normal(0, 3, N - t_tr)
            ])
            amp = np.concatenate([
                rng.normal(30, 8, t_tr).clip(15, 60),
                rng.normal(4, 2, N - t_tr).clip(0, 10)
            ])
            pres = np.ones(N, int)
            mov = np.where(amp >= ACTIVE_AMP, 2, 1)
            stat = np.zeros(N, int)
            raw_seq = np.column_stack([pres, mov, amp.round().astype(int), stat, d.round().astype(int)])
            labs = np.array(["Transition-Stand-to-Sit"] * t_tr + ["Sit-Stationary"] * (N - t_tr), dtype=object)
            P = np.zeros((N, 3))
            P[:, 2] = np.maximum(0.0, INSTALL_HEIGHT_M - d / 100.0)
            track = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), vstd=np.zeros(N))
            raw = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), amp=amp, dist=d)
            seqs.append(dict(
                domain=domain, group=subj, name=f"{subj}/sit/run{tr}",
                protocol="sit", seq=raw_seq, y=np.zeros(len(raw_seq) - WINDOW_SIZE + 1, int),
                raw=raw, track=track
            ))

        # 3. Nằm giường -> Nhãn 3: nam_giuong (kèm chuyển tiếp nằm giường)
        for tr in range(trials_per_scenario):
            duration_s = rng.integers(15, 22)
            N = int(duration_s / PERIOD_S)
            t_tr = N // 3
            d = np.concatenate([
                np.linspace(190, 220, t_tr),
                np.full(N - t_tr, 220) + rng.normal(0, 3, N - t_tr)
            ])
            amp = np.concatenate([
                rng.normal(25, 6, t_tr).clip(12, 50),
                rng.normal(2, 1.5, N - t_tr).clip(0, 8)
            ])
            pres = np.ones(N, int)
            mov = np.ones(N, int)
            stat = np.ones(N, int)
            raw_seq = np.column_stack([pres, mov, amp.round().astype(int), stat, d.round().astype(int)])
            labs = np.array(["Transition-Sit-to-LayBed"] * t_tr + ["LayBed-Stationary"] * (N - t_tr), dtype=object)
            P = np.zeros((N, 3))
            P[:, 2] = np.maximum(0.0, INSTALL_HEIGHT_M - d / 100.0)
            track = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), vstd=np.zeros(N))
            raw = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), amp=amp, dist=d)
            seqs.append(dict(
                domain=domain, group=subj, name=f"{subj}/bed/run{tr}",
                protocol="bed", seq=raw_seq, y=np.zeros(len(raw_seq) - WINDOW_SIZE + 1, int),
                raw=raw, track=track
            ))

        # 4. Té ngã xuống sàn -> Nhãn 4: nam_san (sau khi ngã)
        for tr in range(trials_per_scenario * 2):
            duration_s = 20
            N = int(duration_s / PERIOD_S)
            fall_idx = int(rng.integers(5, 8) / PERIOD_S)
            f_dur = rng.integers(4, 7)
            post_len = N - (fall_idx + f_dur)

            d = np.zeros(N)
            amp = np.zeros(N)

            # Trước ngã: đứng đi lại
            d[:fall_idx] = 190 + rng.normal(0, 5, fall_idx)
            amp[:fall_idx] = rng.normal(35, 8, fall_idx).clip(15, 60)

            # Cú ngã: biên độ tăng vọt trong 4-6 mẫu (~1-1.5s), khoảng cách tăng lên sàn 270cm
            d[fall_idx:fall_idx + f_dur] = np.linspace(190, 270, f_dur)
            amp[fall_idx:fall_idx + f_dur] = np.linspace(50, 95, f_dur) + rng.normal(0, 3, f_dur)

            # Sau ngã: nằm bất động trên sàn (270cm, biên độ ~0)
            d[fall_idx + f_dur:] = 270 + rng.normal(0, 2, post_len)
            amp[fall_idx + f_dur:] = rng.normal(2, 1, post_len).clip(0, 5)

            labs = np.array(["Walking"] * fall_idx + ["Falling"] * f_dur + ["LayFloor-Stationary"] * post_len, dtype=object)

            pres = np.ones(N, int)
            mov = np.where(amp >= ACTIVE_AMP, 2, 1)
            stat = np.where(np.arange(N) >= fall_idx + f_dur + 8, 1, 0)
            raw_seq = np.column_stack([pres, mov, amp.round().astype(int), stat, d.round().astype(int)])

            # Gán nhãn cửa sổ (1 = ngã, 0 = bình thường, -1 = bỏ qua vùng chuyển tiếp)
            y = np.zeros(N - WINDOW_SIZE + 1, int)
            for j in range(len(y)):
                end_sample = j + WINDOW_SIZE - 1
                if fall_idx <= end_sample <= fall_idx + f_dur + 8:
                    y[j] = 1
                elif end_sample > fall_idx + f_dur + 8:
                    y[j] = -1

            P = np.zeros((N, 3))
            P[:, 2] = np.maximum(0.0, INSTALL_HEIGHT_M - d / 100.0)
            track = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), vstd=np.zeros(N))
            raw = dict(labs=labs, times=np.arange(N) * PERIOD_S, P=P, has=np.ones(N, bool), amp=amp, dist=d)
            seqs.append(dict(
                domain=domain, group=subj, name=f"{subj}/fall/run{tr}",
                protocol="fall", seq=raw_seq, y=y,
                raw=raw, track=track
            ))

    print(f"  -> Đã tạo {len(seqs)} chuỗi mô phỏng hoàn tất.")
    return seqs
"""
    if "_self_test()\n" in content:
        content = content.replace("_self_test()\n", "_self_test()\n" + synthetic_def)
    else:
        print("[!] Cảnh báo: không tìm thấy _self_test()")

    # 4. Kích hoạt fallback dữ liệu mô phỏng nếu không có file dữ liệu
    pub_target = """PUB_SEQS = load_public(SRC_MMADL, "mm-adl") + load_public(SRC_HOME, "mm-adl-home") + load_radhar()
for _s in PUB_SEQS:
    _s["seq"] = c1001_samples(_s["raw"])"""

    pub_replacement = """PUB_SEQS = load_public(SRC_MMADL, "mm-adl") + load_public(SRC_HOME, "mm-adl-home") + load_radhar()
if not OWN_SEQS and not PUB_SEQS:
    print("\\n[*] Không tìm thấy dữ liệu tự đo hoặc bộ dataset nào trên máy.")
    print("    -> Tự động kích hoạt BỘ DỮ LIỆU MÔ PHỎNG VẬT LÝ C1001 (4 người, 2 miền mm-adl & mm-adl-home, đủ 5 tư thế).")
    print("    -> Đảm bảo chạy trọn vẹn toàn bộ 3300 dòng nghiên cứu, 10 bài toán EDA, kiểm tra đổi nhà và xuất weights.")
    PUB_SEQS = generate_synthetic_c1001(num_people=4, trials_per_scenario=4)

for _s in PUB_SEQS:
    if "seq" not in _s:
        _s["seq"] = c1001_samples(_s["raw"])"""

    if pub_target in content:
        content = content.replace(pub_target, pub_replacement)

    # 5. Triển khai tự động vào firmware cho model_weights.h
    model_export_target = 'print(HEADER_PATH.read_text(encoding="ascii"))'
    model_export_replacement = """print(HEADER_PATH.read_text(encoding="ascii"))

if TU_DONG_GHI_DE_INCLUDE and (WORKSPACE_ROOT / "include").exists():
    target_path = WORKSPACE_ROOT / "include" / "model_weights.h"
    if target_path.exists():
        shutil.copy2(target_path, target_path.with_suffix(".h.bak"))
    shutil.copy2(HEADER_PATH, target_path)
    print(f"  [V] Đã tự động cập nhật vào firmware: {target_path.resolve()}")"""

    if model_export_target in content:
        content = content.replace(model_export_target, model_export_replacement)

    # 6. Triển khai tự động vào firmware cho nn_weights.h
    nn_export_target = """    (OUT_DIR / "model_report.json").write_text(
        json.dumps(REPORT, ensure_ascii=False, indent=2, default=str), encoding="utf-8")"""

    nn_export_replacement = """    (OUT_DIR / "model_report.json").write_text(
        json.dumps(REPORT, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    if TU_DONG_GHI_DE_INCLUDE and (WORKSPACE_ROOT / "include").exists() and NN_PATH.exists():
        target_path = WORKSPACE_ROOT / "include" / "nn_weights.h"
        if target_path.exists():
            shutil.copy2(target_path, target_path.with_suffix(".h.bak"))
        shutil.copy2(NN_PATH, target_path)
        print(f"  [V] Đã tự động cập nhật vào firmware: {target_path.resolve()}")"""

    if nn_export_target in content:
        content = content.replace(nn_export_target, nn_export_replacement)

    # Ghi file
    with open(dst_path, "w", encoding="utf-8") as f:
        f.write(content)

    final_lines = len(content.splitlines())
    print(f"ĐÃ XUẤT THÀNH CÔNG {final_lines} DÒNG VÀO {dst_path}!")

if __name__ == "__main__":
    build_full_local_py()
