# %% [markdown]
# # Huấn luyện model phát hiện té ngã — OALPHA (ESP32-S3 + radar C1001)
#
# Notebook này huấn luyện **bộ phân loại hồi quy logistic 10 đặc trưng** chạy ngay trên ESP32
# (`src/core/fall_model.cpp`) rồi xuất file **`model_weights.h`** để nạp vào firmware.
# Bản `.py` cùng thư mục có nội dung y hệt, chạy được trên máy: `python huan_luyen_model_te_nga.py`.
#
# **Chạy trên Kaggle (CPU là đủ, khoảng 5–10 phút):**
# 1. *Add Data* → thêm dữ liệu theo bảng dưới (không có dữ liệu tự đo vẫn chạy được, nhưng chỉ để thử).
# 2. *Run All*.
# 3. Tab *Output* → tải `model_weights.h` → chép đè `include/model_weights.h` → `pio run -t upload`.
#
# ## Lấy dữ liệu ở đâu (xếp theo độ sát với dự án)
#
# | # | Nguồn | Vì sao dùng | Đưa lên Kaggle |
# |---|---|---|---|
# | 1 | **Tự đo bằng chính C1001** — dashboard → *Báo cáo & biểu đồ* → **Tải dữ liệu huấn luyện (Kaggle)** | Cùng cảm biến, cùng vị trí lắp trần 2,7 m, cùng 10 đặc trưng. **Sát nhất, số liệu báo cáo lấy ở đây** | *Create → New Dataset* → upload `oalpha_du_lieu_huan_luyen.json` |
# | 2 | **mm-ADL** · Zenodo `10.5281/zenodo.22405011` · 214 MB · CC BY 4.0 | Radar 60 GHz (TI IWR6843) cùng dải tần với C1001; 11 người, khoảng 50 cú ngã mỗi người, kèm ngồi ghế, nằm giường (ca dễ nhầm) | *New Dataset* → tab *Link* → dán `https://zenodo.org/records/22405011/files/mm-adl-v1.0.zip?download=1` |
# | 3 | **mm-ADL-Home** · Zenodo `10.5281/zenodo.23456178` · 134 MB · CC BY 4.0 | Cùng radar, quay trong căn hộ có đồ đạc, ghi liên tục 15–20 phút: dùng làm **dữ liệu gần thực tế** | như trên với `https://zenodo.org/records/23456178/files/mm-ADL-Home-v1.0.zip?download=1` |
# | 4 | **RadHAR** · GitHub `nesl/RadHAR` · point cloud TI mmWave | 5 hoạt động THƯỜNG (đấm, nhảy, bật, ngồi xổm, đi) — KHÔNG có ngã. Dùng làm **lớp "không ngã" phong phú** để GIẢM BÁO NHẦM | tự tải từ GitHub khi bật Internet, hoặc *Add Data* dataset RadHAR (giữ cấu trúc `Data/Train/<hoạt động>/*.txt`) |
#
# Không muốn tạo dataset thì bật *Settings → Internet: On*, notebook tự tải nguồn 2 và 3 từ Zenodo.
#
# > **Ghi vào báo cáo cho đúng:** C1001 không xuất point cloud mà chỉ xuất giá trị mức cao (có người,
# > kiểu chuyển động, biên độ 0–100, khoảng cách). Notebook **chuyển** point cloud của mm-ADL sang các
# > giá trị tương tự bằng một "radar ảo gắn trần" (mục 5). Phép chuyển là **xấp xỉ** vì biên độ chuyển
# > động của C1001 là thuật toán đóng của hãng. Vì vậy dữ liệu tự đo luôn được ưu tiên (trọng số `W_OWN`)
# > và **chỉ số đưa vào báo cáo là chỉ số trên dữ liệu tự đo**.
#
# Trích dẫn khi dùng mm-ADL: Han, Z., Wang, X., & Bolic, M. (2026). *mm-ADL: A Millimeter-Wave Radar
# Point-Cloud Dataset for Activities of Daily Living and Fall-Related Movements*. Zenodo.
# https://doi.org/10.5281/zenodo.22405011

# %% [markdown]
# ## 1. Cấu hình
# Các hằng số "hợp đồng đặc trưng" phải khớp firmware (`src/core/fall_model.h`, `include/config.h`).
# Chỉ đổi phần *Huấn luyện* nếu cần.

# %%
import hashlib, json, math, os, re, time, urllib.request, zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_fscore_support, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

try:
    import matplotlib.pyplot as plt
    HAS_PLT = True
except ImportError:  # máy không có matplotlib vẫn ra model, chỉ thiếu biểu đồ
    HAS_PLT = False

# ---- Hợp đồng đặc trưng: PHẢI khớp src/core/fall_model.h ----
FEATURE_SPEC_VERSION = 1
WINDOW_SIZE = 12            # 12 mẫu x 250 ms = 3 giây
PERIOD_S = 0.25             # FEATURE_PERIOD_MS = 250
CONFIRM_WINDOWS = 2         # firmware chỉ báo khi 2 cửa sổ LIÊN TIẾP vượt ngưỡng
FEATURE_NAMES = ["Trung binh bien do", "Bien do lon nhat", "Do lech chuan bien do",
                 "Bien do cuoi - dau", "Trung binh khoang cach", "Khoang cach cuoi - dau",
                 "Khoang cach nho nhat", "Ti le mau co nguoi", "Ti le mau dang hoat dong",
                 "Ti le mau nam im lau"]

# ---- Thiết bị thật (include/config.h) ----
INSTALL_HEIGHT_M = 2.70     # RADAR_INSTALL_HEIGHT_CM
FALL_CONFIRM_S = 5          # RADAR_FALL_TIME_S: chip chỉ báo ngã sau 5 s xác nhận
UNMANNED_HOLD_S = 3         # RADAR_UNMANNED_TIME_S
RESIDENCE_S = 200           # RADAR_RESIDENCE_TIME_S (cờ "nằm im lâu")

# ---- Chuyển point cloud mm-ADL sang tín hiệu kiểu C1001 (mục 5) ----
MMADL_SENSOR_H = 1.53       # độ cao radar trong mm-ADL (sensorPosition trong file .cfg)
FOV_HALF_DEG = 50.0         # C1001 quét hình nón 100° x 100° (wiki DFRobot SEN0623) -> nửa góc 50°
AMP_V0 = 0.55               # m/s: biên độ = 100*(1-exp(-v/AMP_V0))
AMP_DEADBAND = 0.06         # m/s: rung nhiễu của bộ bám người khi đứng yên
MICRO_GAIN = 0.35           # phần chuyển động tay chân (độ tản vận tốc các điểm)
ACTIVE_AMP = 12             # biên độ >= ngưỡng này thì movement = 2 (đang hoạt động)
STATIC_HOLD_S = 120         # người ngồi/nằm yên (radar mất điểm) vẫn tính là có người
DIST_WHEN_ABSENT = "hold"   # radar.cpp giữ khoảng cách cũ khi không có số mới

# ---- Gán nhãn ----
POS_BEFORE_S, POS_AFTER_S = 1.5, 1.5   # dữ liệu tự đo: giống dashboard/src/lib/train.ts
FALLBACK_POS = (1.0, 6.0)   # chip bỏ sót: coi cú ngã nằm trong 1-6 s đầu lần thử
LANDING_WIN = (-0.25, 2.0)  # mm-ADL: cửa sổ KẾT THÚC từ 0,25 s trước tới 2 s sau lúc chạm sàn là có ngã

# ---- Huấn luyện ----
USE_OWN, USE_MMADL, USE_MMADL_HOME = True, True, True
USE_RADHAR = True           # RadHAR: point cloud TI mmWave, 5 hoat dong THUONG (khong nga) -> lam day lop 'khong nga', giam bao nham
W_OWN = 3.0                 # mỗi cửa sổ tự đo nặng gấp 3 cửa sổ dữ liệu công khai
CALIBRATE_AMPLITUDE = True  # khớp thang biên độ mm-ADL với C1001 khi đủ dữ liệu tự đo
C_GRID = [0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
THRESHOLD_OVERRIDE = None   # vd 0.9: tự đặt ngưỡng xuất ra firmware sau khi xem bảng "điểm vận hành" (mục 8)
N_FOLDS = 5
ALLOW_DOWNLOAD = os.environ.get("OALPHA_DOWNLOAD", "1") == "1"   # Kaggle: bật Internet thì tự tải
SEED = 20261019

KAGGLE = Path("/kaggle/working").exists()
OUT_DIR = Path("/kaggle/working") if KAGGLE else Path("oalpha_output")
CACHE_DIR = Path("/tmp/oalpha_cache") if KAGGLE else OUT_DIR / "cache"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
SEARCH_ROOTS = [Path(p) for p in os.environ.get("OALPHA_DATA_DIRS", "").split(os.pathsep) if p]
SEARCH_ROOTS += [Path("/kaggle/input"), CACHE_DIR, Path("."), Path("../../dashboard/data")]
RNG = np.random.default_rng(SEED)
print(f"Kaggle: {KAGGLE} | ket qua ghi vao: {OUT_DIR.resolve()} | matplotlib: {HAS_PLT}")

# %% [markdown]
# ## 2. Tìm dữ liệu
# Notebook tự tìm trong `/kaggle/input` (và thư mục tạm): file JSON xuất từ dashboard, hoặc cặp
# `features.jsonl` + `trials.json` trong `dashboard/data`; mm-ADL dạng đã giải nén hoặc còn nguyên zip
# (đọc thẳng trong zip, khỏi giải nén). Không thấy mm-ADL mà đang có Internet thì tải từ Zenodo, có
# kiểm tra MD5.

# %%
ZENODO = {
    "mm-adl": ("https://zenodo.org/records/22405011/files/mm-adl-v1.0.zip?download=1",
               "mm-adl-v1.0.zip", "d5e07663f4bb7fb79b6cc5f57f170510"),
    "mm-adl-home": ("https://zenodo.org/records/23456178/files/mm-ADL-Home-v1.0.zip?download=1",
                    "mm-ADL-Home-v1.0.zip", "d65c6fa47798b5c7d52ee311a2848013"),
}
POINT_FILE = {"mm-adl": "radar_data.csv", "mm-adl-home": "point_cloud.csv"}


def walk(patterns):
    """Duyệt mọi thư mục tìm kiếm, trả các file khớp mẫu (không trùng)."""
    seen = set()
    for root in SEARCH_ROOTS:
        if not root.exists():
            continue
        for pat in patterns:
            for p in root.glob(pat):
                rp = p.resolve()
                if rp not in seen and "__MACOSX" not in str(rp):
                    seen.add(rp)
                    yield rp


class Source:
    """Một bộ dữ liệu nằm trong thư mục hoặc nguyên file zip (đọc thẳng trong zip)."""

    def __init__(self, path):
        self.path = Path(path)
        self.zip = zipfile.ZipFile(self.path) if self.path.suffix.lower() == ".zip" else None
        if self.zip:
            self.names = [n for n in self.zip.namelist() if "__MACOSX" not in n]
        else:
            self.names = [p.relative_to(self.path).as_posix() for p in self.path.rglob("*.csv")]

    def read_csv(self, name):
        # Vài file của mm-ADL có dòng hỏng (thừa cột): bỏ dòng đó thay vì bỏ cả bản ghi
        if self.zip:
            with self.zip.open(name) as f:
                return pd.read_csv(f, on_bad_lines="skip", low_memory=False)
        return pd.read_csv(self.path / name, on_bad_lines="skip", low_memory=False)

    def has(self, name):
        return name in set(self.names)

    def __repr__(self):
        return f"Source({self.path.name}, {len(self.names)} file)"


def md5sum(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_public(kind):
    """mm-ADL / mm-ADL-Home: thư mục đã giải nén -> file zip -> tải từ Zenodo."""
    fname = POINT_FILE[kind]
    depth = "*/*/*" if kind == "mm-adl" else "*/*"
    for p in walk([f"**/recordings/{depth}/{fname}"]):
        root = p
        while root.name != "recordings":
            root = root.parent
        return Source(root.parent)
    url, zipname, md5 = ZENODO[kind]
    for p in walk([f"**/{zipname}"]):
        try:
            return Source(p)
        except zipfile.BadZipFile:
            print(f"Bo qua {p}: file zip hong hoac tai chua xong")
    if not ALLOW_DOWNLOAD:
        return None
    dst = CACHE_DIR / zipname
    try:
        if not dst.exists() or md5sum(dst) != md5:
            print(f"Dang tai {zipname} tu Zenodo...")
            tmp = dst.with_suffix(".part")
            urllib.request.urlretrieve(url, tmp)
            if md5sum(tmp) != md5:
                raise IOError("sai MD5 (file tai ve bi hong)")
            tmp.replace(dst)
        return Source(dst)
    except Exception as err:  # Kaggle chưa bật Internet thì rơi vào đây
        print(f"Khong tai duoc {zipname}: {err}. Bat Internet hoac them dataset bang tay.")
        return None


def find_own():
    """Dữ liệu tự đo: file JSON xuất từ dashboard, hoặc features.jsonl + trials.json."""
    for p in walk(["**/oalpha_du_lieu_huan_luyen*.json", "**/oalpha_train*.json"]):
        return {"bundle": p}
    feats = next(walk(["**/features.jsonl"]), None)
    trials = next(walk(["**/trials.json"]), None)
    if feats and trials:
        return {"features": feats, "trials": trials}
    return None


OWN_FILES = find_own() if USE_OWN else None
SRC_MMADL = find_public("mm-adl") if USE_MMADL else None
SRC_HOME = find_public("mm-adl-home") if USE_MMADL_HOME else None
print("Du lieu tu do :", OWN_FILES or "CHUA CO -> model chi de thu, chua dua vao bao cao duoc")
print("mm-ADL        :", SRC_MMADL)
print("mm-ADL-Home   :", SRC_HOME)
print("RadHAR        :", "BAT (doc o muc 5c)" if USE_RADHAR else "tat")
if not (OWN_FILES or SRC_MMADL or SRC_HOME or USE_RADHAR):
    raise SystemExit("Khong co du lieu nao. Xem bang 'Lay du lieu o dau' o dau notebook.")

# %% [markdown]
# ## 3. Hợp đồng đặc trưng — tính y hệt ESP32
# `cpp_extract()` chép từng dòng của `FallModel::extractFeatures()` trong `src/core/fall_model.cpp`
# (giống `tools/kiem_tra_dac_trung.py`). `window_features()` là bản tính nhanh cho hàng vạn cửa sổ;
# ô này tự so hai bản với nhau trên 62 cửa sổ ngẫu nhiên, lệch là dừng ngay.
#
# Mỗi mẫu (4 mẫu/giây) có 5 cột theo đúng thứ tự: `present, movement, range, staticStay, distanceCm`.
# **Không chuẩn hóa thêm** (không StandardScaler): firmware nhân trọng số thẳng vào đặc trưng thô,
# các số chia 100/50/400/200 đã nằm sẵn trong công thức.

# %%
COLS = ["present", "movement", "range", "staticStay", "distanceCm"]


def cpp_extract(win):
    """win: mảng (12, 5) theo COLS, cũ trước mới sau. Port từng dòng của fall_model.cpp."""
    n = float(WINDOW_SIZE)
    r = win[:, 2].astype(float)
    d = win[:, 4].astype(float)
    sum_r, max_r, sum_d, min_d = 0.0, 0.0, 0.0, 1e9
    n_present = n_active = n_static = 0
    for i in range(WINDOW_SIZE):
        sum_r += r[i]
        max_r = max(max_r, r[i])
        sum_d += d[i]
        min_d = min(min_d, d[i])
        n_present += 1 if win[i, 0] else 0
        n_active += 1 if win[i, 1] == 2 else 0
        n_static += 1 if win[i, 3] else 0
    mean_r = sum_r / n
    std_r = math.sqrt(sum((r[i] - mean_r) ** 2 for i in range(WINDOW_SIZE)) / n)
    return [mean_r / 100.0, max_r / 100.0, std_r / 50.0, (r[-1] - r[0]) / 100.0,
            (sum_d / n) / 400.0, (d[-1] - d[0]) / 200.0, min_d / 400.0,
            n_present / n, n_active / n, n_static / n]


def window_features(seq):
    """seq: (N, 5) -> (N-11, 10) đặc trưng cho mọi cửa sổ trượt bước 1 (cửa sổ i kết thúc ở mẫu i+11)."""
    seq = np.asarray(seq)
    if len(seq) < WINDOW_SIZE:
        return np.zeros((0, 10))
    w = np.lib.stride_tricks.sliding_window_view(seq, WINDOW_SIZE, axis=0)  # (M, 5, 12)
    r = w[:, 2, :].astype(float)
    d = w[:, 4, :].astype(float)
    mean_r = r.mean(axis=1)
    std_r = np.sqrt(((r - mean_r[:, None]) ** 2).mean(axis=1))
    return np.column_stack([
        mean_r / 100.0, r.max(axis=1) / 100.0, std_r / 50.0, (r[:, -1] - r[:, 0]) / 100.0,
        d.mean(axis=1) / 400.0, (d[:, -1] - d[:, 0]) / 200.0, d.min(axis=1) / 400.0,
        (w[:, 0, :] != 0).mean(axis=1), (w[:, 1, :] == 2).mean(axis=1), (w[:, 3, :] != 0).mean(axis=1),
    ])


def _self_test():
    rs = np.random.default_rng(SEED)
    cases = [np.column_stack([rs.integers(0, 2, 12), rs.integers(0, 3, 12), rs.integers(0, 101, 12),
                              rs.integers(0, 2, 12), rs.integers(0, 601, 12)]) for _ in range(60)]
    cases += [np.zeros((12, 5), int), np.tile([1, 2, 100, 1, 1100], (12, 1))]
    worst = max(float(np.max(np.abs(window_features(c)[0] - np.array(cpp_extract(c))))) for c in cases)
    assert worst < 1e-9, f"Ban tinh nhanh lech ban C++: {worst}"
    print(f"Hop dong dac trung v{FEATURE_SPEC_VERSION}: khop ban C++ tren {len(cases)} ca (lech lon nhat {worst:.1e})")


_self_test()

# %% [markdown]
# ## 4. Dữ liệu tự đo (C1001 + dashboard)
# Gán nhãn **giống hệt** `buildDataset()` trong `dashboard/src/lib/train.ts`:
# - lần thử không ngã: mọi cửa sổ là 0;
# - lần thử có ngã: chip báo ngã muộn hơn cú va chạm đúng `FALL_CONFIRM_S` giây, nên lùi lại để lấy
#   cửa sổ CHỨA cú ngã (±1,5 s); chip bỏ sót thì coi cú ngã ở giây 1–6 của lần thử; cửa sổ còn lại bỏ qua.
#
# Cải tiến so với bản TypeScript: dashboard nhận mẫu theo lô (cả lô chung một `recvAt`), nên notebook
# dựng lại thời điểm từng mẫu từ đồng hồ `t` của ESP32 (chính xác tới 250 ms thay vì ±1,5 s).

# %%
def load_own(files):
    """-> (bảng mẫu có cột 'wall' ms, danh sách lần thử đã xong, thời gian xác nhận ngã của chip)."""
    fall_s = FALL_CONFIRM_S
    if "bundle" in files:
        with open(files["bundle"], encoding="utf-8") as f:
            b = json.load(f)
        if b.get("featureSpec", FEATURE_SPEC_VERSION) != FEATURE_SPEC_VERSION:
            raise SystemExit(f"File du lieu dung hop dong dac trung v{b.get('featureSpec')}, notebook la v{FEATURE_SPEC_VERSION}")
        samples = pd.DataFrame(b["samples"], columns=b["columns"])
        trials = b["trials"]
        fall_s = (b.get("device") or {}).get("fallTimeS") or fall_s
    else:
        samples = pd.read_json(files["features"], lines=True)
        with open(files["trials"], encoding="utf-8") as f:
            trials = json.load(f)
    samples = samples.sort_values(["recvAt", "t"], kind="stable").reset_index(drop=True)
    # Cả lô cùng recvAt: mẫu cuối lô lấy lúc ~recvAt, mẫu trước đó lùi theo đồng hồ millis() t
    samples["wall"] = samples["recvAt"] - (samples.groupby("recvAt")["t"].transform("max") - samples["t"])
    samples = samples.sort_values("wall", kind="stable").drop_duplicates(["recvAt", "t"])
    trials = [t for t in trials if t.get("endedAt")]
    return samples, sorted(trials, key=lambda t: t["startedAt"]), float(fall_s)


def own_sequences(samples, trials, fall_s):
    """Mỗi lần thử -> 1 chuỗi mẫu + nhãn từng cửa sổ (1 có ngã, 0 không ngã, -1 bỏ qua)."""
    seqs, skipped = [], 0
    wall = samples["wall"].to_numpy()
    arr = samples[COLS].to_numpy()
    for t in trials:
        lo, hi = np.searchsorted(wall, [t["startedAt"], t["endedAt"] + 2000])
        seq, ts = arr[lo:hi], wall[lo:hi]
        if len(seq) < WINDOW_SIZE:
            skipped += 1
            continue
        end_t = ts[WINDOW_SIZE - 1:]
        if not t["expectFall"]:
            y = np.zeros(len(end_t), int)
        elif t.get("detectedAt"):
            impact = t["detectedAt"] - fall_s * 1000
            y = np.where((end_t >= impact - POS_BEFORE_S * 1000) &
                         (end_t <= t["detectedAt"] + POS_AFTER_S * 1000), 1, -1)
        else:
            rel = end_t - t["startedAt"]
            y = np.where((rel >= FALLBACK_POS[0] * 1000) & (rel <= FALLBACK_POS[1] * 1000), 1, -1)
        seqs.append(dict(domain="own", group=f"own-{t['id']}", name=t.get("scenarioName", ""),
                         seq=seq, y=y, trial=t))
    return seqs, skipped


OWN_SEQS, OWN_FALL_S = [], FALL_CONFIRM_S
if OWN_FILES:
    _own_samples, _own_trials, OWN_FALL_S = load_own(OWN_FILES)
    OWN_SEQS, _skip = own_sequences(_own_samples, _own_trials, OWN_FALL_S)
    _pos = sum(int((s["y"] == 1).sum()) for s in OWN_SEQS)
    _neg = sum(int((s["y"] == 0).sum()) for s in OWN_SEQS)
    print(f"Tu do: {len(_own_samples)} mau, {len(_own_trials)} lan thu xong, dung duoc {len(OWN_SEQS)} "
          f"(bo {_skip} vi thieu mau) -> {_pos} cua so co nga, {_neg} cua so khong nga")
    if _skip:
        print("  Lan thu bi bo thuong do dashboard khong chay luc do, hoac ESP32 vua khoi dong lai.")
    if _pos < 20:
        print("  CANH BAO: qua it cua so co nga, nen do them cac kich ban nga (moi kich ban 20-30 lan).")

# %% [markdown]
# ## 5. Dữ liệu công khai mm-ADL → tín hiệu kiểu C1001 ("radar ảo gắn trần")
# mm-ADL đặt radar trên chân máy cao 1,53 m, nhìn ngang. C1001 của đồ án gắn **trần 2,7 m, nhìn xuống**.
# Mỗi 250 ms notebook lấy đám điểm của người (điểm có `target_id` của bộ bám người), rồi tính:
#
# | Tín hiệu C1001 | Cách dựng từ point cloud |
# |---|---|
# | `distanceCm` | khoảng cách 3D từ **radar ảo trên trần** (đặt ngay trên vùng người ngã / ngồi / nằm) tới tâm đám điểm |
# | `range` (biên độ 0–100) | vận tốc tâm người **chiếu lên hướng nhìn của radar trần** + phần rung tay chân, qua hàm bão hòa `100·(1−e^(−v/0,55))` |
# | `present` | có điểm của người trong hình nón quét 100°×100° của C1001; mất điểm vì ngồi/nằm yên thì vẫn tính là có người (radar sóng mm lọc bỏ vật đứng yên) |
# | `movement` | 0 không người · 1 yên · 2 hoạt động (biên độ ≥ 12) |
# | `staticStay` | nằm/ngồi yên liên tục ≥ 200 s (như `RADAR_RESIDENCE_TIME_S`) |
#
# Nhãn cửa sổ: **1** nếu chứa ≥ 1 s nhãn `Falling`; **0** nếu toàn sinh hoạt thường (đi lại, ngồi ghế,
# nằm giường và các chuyển tư thế đó: đây chính là các ca *dễ nhầm*); còn lại (đang nằm trên sàn sau khi
# ngã, đang đứng dậy) thì **bỏ qua**, giống cách dashboard bỏ phần cuối lần thử ngã.

# %%
TRACK_MAX = {"mm-adl": 252, "mm-adl-home": 249}
NEG_LABELS = {"Walking", "Transition-Stand-to-Sit", "Transition-Sit-to-LayBed",
              "Transition-LayBed-to-Sit", "Transition-Sit-to-Stand", "Sit-Stationary",
              "LayBed-Stationary"}
FLOOR_LABELS = {"Falling", "LayFloor-Stationary", "Transition-LayFloor-to-Stand"}
REST_LABELS = {"Sit-Stationary", "LayBed-Stationary", "Transition-Stand-to-Sit", "Transition-Sit-to-LayBed"}
# Dữ liệu thật có nhãn viết khác bảng phân loại (vd "Transition-Sit-to-Laybed", "LayFloor").
# Các nhãn quỳ gối (Kneeling-*) xảy ra quanh cú ngã nên để ngoài, cửa sổ chứa chúng bị bỏ qua.
_CANON = {l.lower(): l for l in NEG_LABELS | FLOOR_LABELS}
_CANON["layfloor"] = "LayFloor-Stationary"


def canon_label(lab):
    lab = str(lab).strip()
    return _CANON.get(lab.lower(), lab)


def list_recordings(src, kind):
    """Liệt kê các bản ghi trong một Source (thư mục hay zip đều được)."""
    fname = POINT_FILE[kind]
    recs = []
    for n in src.names:
        if not n.endswith("/" + fname):
            continue
        base = n[: -len(fname)]
        parts = base.strip("/").split("/")
        if "recordings" not in parts:
            continue
        rel = parts[parts.index("recordings") + 1:]
        if kind == "mm-adl" and len(rel) >= 3:   # sub-XX/protocol-YY/run-ZZ
            subject, protocol, run = rel[0], rel[1].replace("protocol-", ""), rel[2]
        elif kind == "mm-adl-home" and len(rel) >= 2:  # room-XX/sub-X
            subject, protocol, run = rel[1], "home", rel[0]
        else:
            continue
        if src.has(base + "frame_labels.csv") and src.has(base + "timestamps.csv"):
            recs.append(dict(kind=kind, base=base, points=n, subject=subject, protocol=protocol, run=run,
                             group=f"{kind}-{subject}"))
    return sorted(recs, key=lambda r: r["points"])


def numeric(df, cols):
    """Ép kiểu số, bỏ dòng hỏng (vài file có dòng tiêu đề lặp lại hoặc hai số dính nhau)."""
    df = df.rename(columns=str.strip).copy()
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.dropna(subset=cols)


def label_intervals(labels, stamps):
    """Port quy tắc của scripts/align_camera_labels_to_radar.py: [mốc i, mốc i+1), dừng ở END."""
    labels = numeric(labels, ["Frame"]).astype({"Frame": np.int64})
    stamps = numeric(stamps, ["Frame", "Timestamp"]).astype({"Frame": np.int64})
    tmap = dict(zip(stamps["Frame"].to_numpy(), stamps["Timestamp"].to_numpy(dtype=float)))
    rows = list(zip(labels["Frame"].to_numpy(), labels["Label"].astype(str).str.strip()))
    out = []
    for i, (frame, lab) in enumerate(rows):
        if lab == "END":
            break
        if frame not in tmap:
            continue
        t0 = tmap[frame]
        t1 = tmap.get(rows[i + 1][0], np.nan) if i + 1 < len(rows) else np.inf
        if np.isfinite(t0) and t1 > t0:   # mốc kế tiếp thiếu giờ -> t1 = nan -> bỏ đoạn
            out.append((t0, t1, None if lab == "DELETE" else canon_label(lab)))
    return out


def labels_at(times, intervals):
    """Nhãn tại từng thời điểm (None nếu không có nhãn)."""
    starts = np.array([a for a, _, _ in intervals])
    idx = np.searchsorted(starts, times, side="right") - 1
    out = np.full(len(times), None, dtype=object)
    for k, (i, t) in enumerate(zip(idx, times)):
        if i >= 0 and t < intervals[i][1]:
            out[k] = intervals[i][2]
    return out


def to_c1001(pts, kind, intervals):
    """Point cloud 1 bản ghi -> chuỗi mẫu 4 Hz kiểu C1001 (N, 5) + nhãn từng mẫu + thời điểm."""
    pts = numeric(pts, ["X", "Y", "Z", "velocity", "timestamp", "target_id"])
    pts = pts[(pts["target_id"] >= 0) & (pts["target_id"] <= TRACK_MAX[kind])]
    if pts.empty:
        return None
    # Dòng hỏng có thể ra mốc giờ vô lý (lệch hàng năm) -> chỉ giữ điểm nằm trong khoảng có nhãn
    lo = min(a for a, _, _ in intervals) - 60
    hi = max(b if np.isfinite(b) else a for a, b, _ in intervals) + 600
    pts = pts[(pts["timestamp"] >= lo) & (pts["timestamp"] <= hi)]
    if len(pts) < 50:
        return None
    t = pts["timestamp"].to_numpy(float)
    t0 = t.min()
    b = np.floor((t - t0) / PERIOD_S).astype(np.int64)
    z = pts["Z"].to_numpy(float)
    h = z + MMADL_SENSOR_H if np.median(z) < 0.5 else z      # Z tính từ radar hay từ sàn
    df = pd.DataFrame({"b": b, "tid": pts["target_id"].to_numpy(), "x": pts["X"].to_numpy(float),
                       "y": pts["Y"].to_numpy(float), "h": h, "v": pts["velocity"].to_numpy(float)})
    # Mỗi 250 ms chỉ lấy người chính (target có nhiều điểm nhất)
    cnt = df.groupby(["b", "tid"]).size().rename("n").reset_index()
    main = cnt.sort_values(["b", "n"], ascending=[True, False]).drop_duplicates("b")[["b", "tid"]]
    df = df.merge(main, on=["b", "tid"])
    g = df.groupby("b")
    agg = pd.DataFrame({"x": g["x"].median(), "y": g["y"].median(), "h": g["h"].median(),
                        "vstd": g["v"].std().fillna(0.0)})
    B = int(b.max()) + 1
    has = np.zeros(B, bool)
    has[agg.index.to_numpy()] = True
    P = np.full((B, 3), np.nan)
    P[agg.index.to_numpy()] = agg[["x", "y", "h"]].to_numpy()
    vstd = np.zeros(B)
    vstd[agg.index.to_numpy()] = agg["vstd"].to_numpy()

    times = t0 + (np.arange(B) + 0.5) * PERIOD_S
    labs = labels_at(times, intervals)

    # Radar ảo trên trần: ngay trên chỗ ngã (bản ghi có ngã) / chỗ ngồi-nằm / tâm vùng hoạt động
    x0, y0 = np.nanmedian(P[has, 0]), np.nanmedian(P[has, 1])
    for pick in (FLOOR_LABELS, REST_LABELS):
        sel = has & np.array([l in pick for l in labs])
        if sel.sum() >= 8:
            x0, y0 = np.nanmedian(P[sel, 0]), np.nanmedian(P[sel, 1])
            break
    radar = np.array([x0, y0, INSTALL_HEIGHT_M])

    # Làm mượt vị trí (trung vị 3 mẫu) rồi lấy vận tốc chiếu lên hướng nhìn của radar trần
    Ps = pd.DataFrame(P).rolling(3, center=True, min_periods=1).median().to_numpy()
    los = Ps - radar
    dist = np.linalg.norm(los, axis=1)
    rh = np.linalg.norm(los[:, :2], axis=1)
    # Góc lệch so với phương thẳng đứng: ngoài nửa góc quét thì radar trần không thấy người
    ang = np.degrees(np.arctan2(rh, np.maximum(INSTALL_HEIGHT_M - Ps[:, 2], 0.05)))
    vel = np.gradient(Ps, PERIOD_S, axis=0)
    v_los = np.abs(np.nansum(vel * los, axis=1) / np.maximum(dist, 1e-6))
    v_los[~np.isfinite(v_los) | ~has] = 0.0
    motion = np.maximum(np.maximum(v_los, MICRO_GAIN * vstd) - AMP_DEADBAND, 0.0)
    amp = np.clip(np.round(100 * (1 - np.exp(-motion / AMP_V0))), 0, 100)
    return dict(has=has, amp=amp, dist=dist, ang=ang, labs=labs, times=times)


def c1001_samples(r, amp=None):
    """Áp các luật giữ trạng thái của C1001 -> mảng (N, 5) đúng thứ tự COLS."""
    has, dist, ang = r["has"], r["dist"], r["ang"]
    amp = r["amp"] if amp is None else amp
    B = len(has)
    out = np.zeros((B, 5), np.int64)
    last_seen, last_ang, last_d, still_run = -1e9, 90.0, 0.0, 0
    hold_n, static_n = UNMANNED_HOLD_S / PERIOD_S, STATIC_HOLD_S / PERIOD_S
    for i in range(B):
        seen = bool(has[i]) and np.isfinite(ang[i])
        if seen:
            last_ang = ang[i]
        if seen and ang[i] <= FOV_HALF_DEG:
            present, last_seen, last_d = 1, i, dist[i]
            a = amp[i]
        else:
            gap = i - last_seen
            # radar sóng mm lọc mất người ngồi/nằm yên: vẫn có người nếu lần cuối thấy ở trong vùng quét
            present = int(gap <= hold_n or (last_ang <= FOV_HALF_DEG - 5 and gap <= static_n))
            a = 0.0
        if present:
            a = min(100.0, max(0.0, a + RNG.normal(0, 1.0)))   # chip luôn báo rung nhẹ khi có người
            move = 2 if a >= ACTIVE_AMP else 1
        else:
            a, move = 0.0, 0
        still_run = still_run + 1 if move == 1 else 0
        d = last_d if (present or DIST_WHEN_ABSENT == "hold") else 0.0
        out[i] = (present, move, int(round(a)), int(still_run * PERIOD_S >= RESIDENCE_S),
                  int(round(min(max(d * 100, 0), 1100))))
    return out


def window_labels(labs):
    """Nhãn cửa sổ cho dữ liệu công khai: 1 có ngã / 0 sinh hoạt thường / -1 bỏ qua.

    Có ngã = cửa sổ kết thúc quanh lúc CHẠM SÀN (cuối đoạn "Falling"): cửa sổ khi đó chứa cả pha rơi
    lẫn lúc bắt đầu nằm im, đúng thứ model cần học, và khớp cách gán nhãn quanh cú va chạm của dữ liệu
    tự đo. Cửa sổ giữa lúc đang rơi (mới thấy nửa cú ngã) để ngoài, không tính 0 cũng không tính 1.
    """
    n = len(labs)
    if n < WINDOW_SIZE:
        return np.zeros(0, int)
    is_fall = np.array([l == "Falling" for l in labs])
    is_neg = np.array([l in NEG_LABELS for l in labs], int)
    nn = np.lib.stride_tricks.sliding_window_view(is_neg, WINDOW_SIZE).sum(axis=1)
    nf = np.lib.stride_tricks.sliding_window_view(is_fall.astype(int), WINDOW_SIZE).sum(axis=1)
    y = np.where(nn == WINDOW_SIZE, 0, -1)
    ends = np.where(is_fall & ~np.concatenate([is_fall[1:], [False]]))[0]   # mẫu cuối mỗi đoạn Falling
    lo_k, hi_k = int(round(LANDING_WIN[0] / PERIOD_S)), int(round(LANDING_WIN[1] / PERIOD_S))
    for b in ends:
        for e in range(b + lo_k, b + hi_k + 1):     # e = mẫu cuối của cửa sổ
            j = e - (WINDOW_SIZE - 1)
            if 0 <= j < len(y) and nf[j] >= 2:
                y[j] = 1
    return y


def load_public(src, kind):
    """Đọc + chuyển đổi mọi bản ghi của một bộ dữ liệu công khai."""
    seqs = []
    if src is None:
        return seqs
    recs = list_recordings(src, kind)
    t_start = time.time()
    for k, rec in enumerate(recs, 1):
        try:
            pts = src.read_csv(rec["points"])
            iv = label_intervals(src.read_csv(rec["base"] + "frame_labels.csv"),
                                 src.read_csv(rec["base"] + "timestamps.csv"))
            r = to_c1001(pts, kind, iv) if iv else None
        except Exception as err:   # một bản ghi hỏng không được làm hỏng cả lượt train
            print(f"  bo {rec['points']}: {err}")
            continue
        if r is None:
            continue
        seqs.append(dict(domain=kind, group=rec["group"], name=f"{rec['subject']}/{rec['protocol']}/{rec['run']}",
                         protocol=rec["protocol"], raw=r, y=window_labels(r["labs"])))
        if k % 10 == 0 or k == len(recs):
            print(f"  {kind}: {k}/{len(recs)} ban ghi ({time.time() - t_start:.0f} s)")
    return seqs


# ---- RadHAR: point cloud TI mmWave, 5 hoat dong THUONG (boxing/jack/jump/squats/walk) ----
# Khong co nhan "nga" -> toan bo gan nhan 0 ("khong nga"), lam day lop am de GIAM BAO NHAM.
# File .txt dang khoi phan tach bang "---", moi diem la cac dong "key: value"
# (point_id=0 bat dau mot frame). Tai thang tu GitHub raw khi chay Kaggle co Internet,
# hoac doc tu dataset da add-data (tim file *_walk_*.txt ... trong /kaggle/input).
RADHAR_RAW = "https://raw.githubusercontent.com/nesl/RadHAR/master/Data/"
RADHAR_SPLITS = {"Train": ["boxing", "jack", "jump", "squats", "walk"]}
RADHAR_MAX_FILES = int(os.environ.get("OALPHA_RADHAR_MAX", "40"))  # gioi han so file cho nhanh; 0 = lay het


def _radhar_list_remote():
    """Liet ke duong dan file .txt cua RadHAR qua git trees API (khong can tai ca repo)."""
    try:
        import urllib.request as _u
        req = _u.Request("https://api.github.com/repos/nesl/RadHAR/git/trees/master?recursive=1",
                         headers={"User-Agent": "oalpha"})
        tree = json.loads(_u.urlopen(req, timeout=30).read())["tree"]
    except Exception as err:
        print(f"  RadHAR: khong liet ke duoc qua API ({err})")
        return []
    out = []
    for node in tree:
        path = node.get("path", "")
        for split, acts in RADHAR_SPLITS.items():
            for act in acts:
                if path.startswith(f"Data/{split}/{act}/") and path.endswith(".txt"):
                    out.append((act, path))
    return out


def _radhar_find_local():
    """Tim file RadHAR da add-data tren Kaggle: */Data/<split>/<act>/*.txt."""
    out = []
    for act in sum(RADHAR_SPLITS.values(), []):
        for pth in walk([f"**/Data/*/{act}/*.txt", f"**/{act}/*_{act}_*.txt"]):
            out.append((act, pth))
    return out


def _radhar_parse(text):
    """Chuoi file RadHAR -> cac frame: moi frame la (secs.nsecs, mang diem [x,y,z,v])."""
    frames, cur, t_cur = [], [], None
    rec = {}
    for blk in text.split("---"):
        rec = {}
        for line in blk.splitlines():
            line = line.strip()
            m = re.match(r"^(secs|nsecs|point_id|x|y|z|velocity):\s*(-?[\d.]+)", line)
            if m:
                rec[m.group(1)] = m.group(2)
        if "point_id" not in rec or "x" not in rec:
            continue
        pid = int(float(rec["point_id"]))
        if pid == 0 and cur:                    # point_id ve 0 => frame moi
            frames.append((t_cur, np.array(cur, float)))
            cur = []
        if "secs" in rec and "nsecs" in rec:
            t_cur = float(rec["secs"]) + float(rec["nsecs"]) * 1e-9
        cur.append([float(rec.get("x", 0)), float(rec.get("y", 0)),
                    float(rec.get("z", 0)), float(rec.get("velocity", 0))])
    if cur:
        frames.append((t_cur, np.array(cur, float)))
    return [(tt, pts) for tt, pts in frames if tt is not None and len(pts)]


def _radhar_to_raw(frames):
    """Frame RadHAR -> dict 'raw' giong to_c1001 (has, amp, dist, ang, labs, times), nhan 0 het.

    Dung CHUNG cach dung tin hieu cua 'radar ao gan tran' nhu mm-ADL: khoang cach va goc
    tinh tu radar tren tran cao INSTALL_HEIGHT_M, bien do tu van toc theo huong nhin + rung
    tay chan, qua ham bao hoa 100*(1-exp(-v/AMP_V0)).
    """
    if not frames:
        return None
    t0 = frames[0][0]
    B = int(np.floor((frames[-1][0] - t0) / PERIOD_S)) + 1
    P = np.full((B, 3), np.nan); vstd = np.zeros(B); has = np.zeros(B, bool)
    acc = {}
    for tt, pts in frames:
        b = int(np.floor((tt - t0) / PERIOD_S))
        if 0 <= b < B:
            acc.setdefault(b, []).append(pts)
    for b, lst in acc.items():
        allp = np.vstack(lst)
        z = allp[:, 2]
        h = z + MMADL_SENSOR_H if np.median(z) < 0.5 else z   # Z tu radar hay tu san
        P[b] = [np.median(allp[:, 0]), np.median(allp[:, 1]), np.median(h)]
        vstd[b] = np.std(allp[:, 3]) if len(allp) > 1 else 0.0
        has[b] = True
    # Radar ao: dat ngay tren tam vung hoat dong cua nguoi
    x0, y0 = np.nanmedian(P[has, 0]), np.nanmedian(P[has, 1])
    radar = np.array([x0, y0, INSTALL_HEIGHT_M])
    Ps = pd.DataFrame(P).rolling(3, center=True, min_periods=1).median().to_numpy()
    los = Ps - radar
    dist = np.linalg.norm(los, axis=1)
    rh = np.linalg.norm(los[:, :2], axis=1)
    ang = np.degrees(np.arctan2(rh, np.maximum(INSTALL_HEIGHT_M - Ps[:, 2], 0.05)))
    vel = np.gradient(Ps, PERIOD_S, axis=0)
    v_los = np.abs(np.nansum(vel * los, axis=1) / np.maximum(dist, 1e-6))
    v_los[~np.isfinite(v_los) | ~has] = 0.0
    motion = np.maximum(np.maximum(v_los, MICRO_GAIN * vstd) - AMP_DEADBAND, 0.0)
    amp = np.clip(np.round(100 * (1 - np.exp(-motion / AMP_V0))), 0, 100)
    labs = np.array(["Walking"] * B, dtype=object)   # toan bo la sinh hoat thuong -> nhan 0
    times = t0 + (np.arange(B) + 0.5) * PERIOD_S
    return dict(has=has, amp=amp, dist=dist, ang=ang, labs=labs, times=times)


def load_radhar():
    """Doc RadHAR (local da add-data truoc, khong co thi tai tu GitHub) -> seqs nhan 0."""
    if not USE_RADHAR:
        return []
    items = _radhar_find_local()
    source = "local"
    if not items and ALLOW_DOWNLOAD:
        items = _radhar_list_remote()
        source = "github"
    if not items:
        print("RadHAR: khong tim thay (add-data tren Kaggle, hoac bat Internet de tai)")
        return []
    if RADHAR_MAX_FILES and len(items) > RADHAR_MAX_FILES:
        # Lay deu cac hoat dong cho can bang
        by_act = {}
        for act, ref in items:
            by_act.setdefault(act, []).append((act, ref))
        per = max(1, RADHAR_MAX_FILES // len(by_act))
        items = sum([v[:per] for v in by_act.values()], [])
    seqs, t_start = [], time.time()
    import urllib.request as _u
    for k, (act, ref) in enumerate(items, 1):
        try:
            if source == "github":
                url = RADHAR_RAW + act + "/" + Path(ref).name.replace(" ", "%20") \
                      if "/" not in ref else RADHAR_RAW.rsplit("/Data/", 1)[0] + "/" + ref.replace(" ", "%20")
                url = "https://raw.githubusercontent.com/nesl/RadHAR/master/" + ref.replace(" ", "%20")
                req = _u.Request(url, headers={"User-Agent": "oalpha"})
                text = _u.urlopen(req, timeout=60).read().decode("utf-8", "ignore")
            else:
                text = Path(ref).read_text(encoding="utf-8", errors="ignore")
            raw = _radhar_to_raw(_radhar_parse(text))
        except Exception as err:
            print(f"  bo RadHAR {ref}: {err}")
            continue
        if raw is None:
            continue
        seqs.append(dict(domain="radhar", group=f"radhar-{act}", name=f"radhar/{act}/{k}",
                         protocol=act, raw=raw, y=window_labels(raw["labs"])))
        if k % 10 == 0 or k == len(items):
            print(f"  radhar: {k}/{len(items)} file ({time.time() - t_start:.0f} s)")
    return seqs


PUB_SEQS = load_public(SRC_MMADL, "mm-adl") + load_public(SRC_HOME, "mm-adl-home") + load_radhar()
for _s in PUB_SEQS:
    _s["seq"] = c1001_samples(_s["raw"])
if PUB_SEQS:
    _tab = pd.DataFrame([dict(bo=s["domain"], protocol=s["protocol"], co_nga=int((s["y"] == 1).sum()),
                              khong_nga=int((s["y"] == 0).sum()), bo_qua=int((s["y"] == -1).sum()))
                         for s in PUB_SEQS]).groupby(["bo", "protocol"]).sum()
    print(_tab)

# %% [markdown]
# ### 5b. Khớp thang biên độ với C1001 thật
# Biên độ 0–100 của C1001 là thuật toán riêng của hãng, nên công thức ở trên chỉ đúng về hình dạng
# (vọt lên khi ngã, về 0 khi nằm im). Khi đã có đủ dữ liệu tự đo, notebook **ánh xạ phân vị**
# (quantile mapping) biên độ của mm-ADL về đúng phân bố biên độ C1001 đo được lúc sinh hoạt bình thường.

# %%
def calibrate_amplitude(pub, own):
    if not (CALIBRATE_AMPLITUDE and pub and own):
        return None
    own_amp = np.concatenate([s["seq"][s["seq"][:, 0] == 1, 2] for s in own if not s["trial"]["expectFall"]]
                             or [np.zeros(0)])
    if len(own_amp) < 400:
        print(f"Chua khop thang bien do: moi co {len(own_amp)} mau sinh hoat tu do (can >= 400)")
        return None
    pub_amp = np.concatenate([s["raw"]["amp"][s["raw"]["has"] & np.array([l in NEG_LABELS for l in s["raw"]["labs"]])]
                              for s in pub])
    q = np.linspace(0, 1, 101)
    src = np.quantile(pub_amp, q) + np.arange(101) * 1e-6   # phải tăng ngặt cho np.interp
    dst = np.quantile(own_amp, q)
    for s in pub:
        s["seq"] = c1001_samples(s["raw"], amp=np.interp(s["raw"]["amp"], src, dst))
    print(f"Da khop thang bien do mm-ADL -> C1001 (trung vi {np.median(pub_amp):.0f} -> {np.median(own_amp):.0f})")
    return dict(src=src.round(3).tolist(), dst=dst.round(3).tolist())


AMP_MAP = calibrate_amplitude(PUB_SEQS, OWN_SEQS)

# %% [markdown]
# ## 6. Xem thử một cú ngã sau khi chuyển đổi
# Biểu đồ dưới đây nên đưa vào báo cáo để giải thích đặc trưng: lúc ngã biên độ vọt lên rồi tụt về gần 0,
# khoảng cách tới radar trần tăng (người từ đứng chuyển sang nằm sát sàn).

# %%
def plot_example():
    cand = [s for s in PUB_SEQS if s["protocol"] == "fall"] or OWN_SEQS
    if not (HAS_PLT and cand):
        return
    s = cand[0]
    if "raw" in s:
        labs = s["raw"]["labs"]
        i0 = next(i for i, l in enumerate(labs) if l == "Falling")
        lo, hi = max(0, i0 - 40), min(len(labs), i0 + 60)
        shade = [k - lo for k in range(lo, hi) if labs[k] == "Falling"]
    else:
        lo, hi, shade = 0, len(s["seq"]), []
    seq = s["seq"][lo:hi]
    t = np.arange(len(seq)) * PERIOD_S
    fig, ax = plt.subplots(figsize=(10, 3.4))
    ax.plot(t, seq[:, 2], color="#1f3f87", label="Bien do chuyen dong (0-100)")
    ax2 = ax.twinx()
    ax2.plot(t, seq[:, 4], color="#e3a21a", label="Khoang cach toi radar tran (cm)")
    if shade:
        ax.axvspan(shade[0] * PERIOD_S, (shade[-1] + 1) * PERIOD_S, color="#e23d4b", alpha=0.15, label="Nhan Falling")
    ax.set_xlabel("giay"); ax.set_ylabel("bien do"); ax2.set_ylabel("cm")
    ax.set_title(f"Mot cu nga sau khi chuyen sang tin hieu kieu C1001 ({s['name']})")
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper left", fontsize=8, framealpha=0.9)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "vi_du_cu_nga.png", dpi=130)
    plt.show()


plot_example()

# %% [markdown]
# ## 7. Huấn luyện + đánh giá chéo theo nhóm
# - **Không chuẩn hóa thêm**, không đổi mô hình: firmware chỉ chạy được hồi quy logistic 10 đặc trưng thô.
# - **Cân lớp** (`class_weight="balanced"`): cửa sổ không ngã nhiều gấp chục lần cửa sổ ngã.
# - **Chia theo nhóm**: mm-ADL chia theo **người** (người trong tập kiểm tra chưa từng xuất hiện khi học),
#   dữ liệu tự đo chia theo **lần thử**. Chia theo cửa sổ sẽ rò rỉ dữ liệu, điểm số đẹp giả.
# - Chọn `C` (độ chặt điều chuẩn L2) và ngưỡng trên dự đoán ngoài-tập (out-of-fold), ưu tiên dữ liệu tự đo.

# %%
ALL_SEQS = OWN_SEQS + PUB_SEQS
for _s in ALL_SEQS:
    _s["X"] = window_features(_s["seq"])
    assert len(_s["X"]) == len(_s["y"]), _s["name"]

_lab = [(k, j) for k, s in enumerate(ALL_SEQS) for j in np.where(s["y"] >= 0)[0]]
SEQ_IDX = np.array([k for k, _ in _lab])
X = np.vstack([ALL_SEQS[k]["X"][j] for k, j in _lab]) if _lab else np.zeros((0, 10))
y = np.array([ALL_SEQS[k]["y"][j] for k, j in _lab])
DOM = np.array([ALL_SEQS[k]["domain"] for k in SEQ_IDX])
GROUP_NAMES = sorted({s["group"] for s in ALL_SEQS})
GID = np.array([GROUP_NAMES.index(ALL_SEQS[k]["group"]) for k in SEQ_IDX])
W = np.where(DOM == "own", W_OWN, 1.0)
if y.sum() == 0 or (y == 0).sum() == 0:
    raise SystemExit("Can ca cua so co nga lan khong nga de huan luyen.")
print(pd.crosstab(DOM, y, rownames=["nguon"], colnames=["nhan (1 = co nga)"]))

OWN_OK = int(((DOM == "own") & (y == 1)).sum()) >= 20 and len({g for g, d in zip(GID, DOM) if d == "own"}) >= N_FOLDS
TARGET = "own" if OWN_OK else ("mm-adl" if (DOM == "mm-adl").any() else DOM[0])
print("Chon C va nguong theo du lieu:", TARGET, "" if OWN_OK else "(chua du du lieu tu do, chi so CHUA dung de bao cao)")

_n_splits = max(2, min(N_FOLDS, len(set(GID))))
FOLDS = list(StratifiedGroupKFold(n_splits=_n_splits, shuffle=True, random_state=SEED).split(X, y, GID))
FOLD_OF_GROUP = {}
for f, (_, te) in enumerate(FOLDS):
    for gi in set(GID[te]):
        FOLD_OF_GROUP[GROUP_NAMES[gi]] = f


def fit(Xa, ya, wa, C):
    m = LogisticRegression(C=C, class_weight="balanced", max_iter=5000)
    m.fit(Xa, ya, sample_weight=wa)
    return m


def best_threshold(yt, pt):
    grid = np.round(np.arange(0.05, 0.951, 0.01), 2)
    f1s = [precision_recall_fscore_support(yt, pt >= t, average="binary", zero_division=0)[2] for t in grid]
    i = int(np.argmax(f1s))
    return float(grid[i]), float(f1s[i])


def oof(C):
    p = np.full(len(y), np.nan)
    for tr, te in FOLDS:
        p[te] = fit(X[tr], y[tr], W[tr], C).predict_proba(X[te])[:, 1]
    return p


_scores = []
for C in C_GRID:
    _p = oof(C)
    _m = DOM == TARGET
    _th, _f1 = best_threshold(y[_m], _p[_m])
    _scores.append((C, _th, _f1, _p))
    print(f"C={C:<5} F1 ngoai-tap ({TARGET}) = {_f1:.3f} tai nguong {_th:.2f}")
BEST_C, THRESHOLD, _, P_OOF = max(_scores, key=lambda r: r[2])
print(f"=> Chon C = {BEST_C}, nguong = {THRESHOLD:.2f}")


def window_report(mask):
    if mask.sum() == 0 or y[mask].min() == y[mask].max():
        return None
    pr, rc, f1, _ = precision_recall_fscore_support(y[mask], P_OOF[mask] >= THRESHOLD, average="binary", zero_division=0)
    return dict(cua_so=int(mask.sum()), co_nga=int(y[mask].sum()), precision=round(pr, 3), recall=round(rc, 3),
                f1=round(f1, 3), auc=round(roc_auc_score(y[mask], P_OOF[mask]), 3),
                ap=round(average_precision_score(y[mask], P_OOF[mask]), 3))


WINDOW_METRICS = {d: window_report(DOM == d) for d in sorted(set(DOM))}
print(pd.DataFrame({k: v for k, v in WINDOW_METRICS.items() if v}).T)

# %% [markdown]
# ## 8. Đánh giá theo SỰ KIỆN, mô phỏng đúng firmware
# Firmware chạy model mỗi 250 ms và chỉ báo ngã khi **2 cửa sổ liên tiếp** vượt ngưỡng. Ô này dùng đúng
# luật đó trên dự đoán ngoài-tập:
# - **mm-ADL**: tỉ lệ cú ngã bắt được (báo trong lúc ngã tới 3 s sau) và số **báo nhầm mỗi giờ** sinh hoạt,
#   kèm bảng *điểm vận hành* theo từng ngưỡng (muốn ít báo nhầm hơn thì đặt `THRESHOLD_OVERRIDE` ở mục 1);
# - **tự đo**: chấm TP/FP/FN/TN **từng lần thử** cho cả **model** và **thuật toán của chip** để so sánh
#   (đây là bảng "model của em vs chip" cho chương 4).

# %%
def seq_probs():
    """Xác suất ngoài-tập cho MỌI cửa sổ (cả cửa sổ bỏ qua) của từng chuỗi, theo fold của nhóm nó."""
    models = [fit(X[tr], y[tr], W[tr], BEST_C) for tr, _ in FOLDS]
    out = []
    for s in ALL_SEQS:
        f = FOLD_OF_GROUP.get(s["group"])
        out.append(None if f is None or len(s["X"]) == 0 else models[f].predict_proba(s["X"])[:, 1])
    return out


def fires(p, th):
    """Luật của firmware: cửa sổ j báo ngã nếu j và j-1 đều vượt ngưỡng."""
    hit = p >= th
    return hit & np.concatenate([[False], hit[:-1]]) if CONFIRM_WINDOWS == 2 else hit


SEQ_P = seq_probs()
EVENT = {}
_pub = [(s, p) for s, p in zip(ALL_SEQS, SEQ_P) if s["domain"] != "own" and p is not None]


def public_events(th):
    """Cú ngã bắt được + báo nhầm/giờ trên dữ liệu công khai, đúng luật 2 cửa sổ của firmware."""
    caught = total = fa = 0
    neg_windows = 0
    for s, p in _pub:
        f = fires(p, th)
        labs = s["raw"]["labs"]
        isf = np.array([l == "Falling" for l in labs])
        starts = np.where(isf & ~np.concatenate([[False], isf[:-1]]))[0]
        for a in starts:
            b = a
            while b + 1 < len(isf) and isf[b + 1]:
                b += 1
            total += 1
            lo, hi = max(0, a - (WINDOW_SIZE - 1)), min(len(f), b + 12 - (WINDOW_SIZE - 1) + 1)
            caught += bool(f[lo:hi].any())
        last = -10 ** 9
        for j in np.where(f & (s["y"] == 0))[0]:
            if j - last >= 40:      # cách nhau >= 10 s mới tính là một lần báo nhầm mới
                fa += 1
                last = j
        neg_windows += int((s["y"] == 0).sum())
    hours = neg_windows * PERIOD_S / 3600
    return dict(cu_nga=total, bat_duoc=caught, ti_le_bat=round(caught / max(total, 1), 3),
                bao_nham=fa, gio_sinh_hoat=round(hours, 2), bao_nham_moi_gio=round(fa / max(hours, 1e-9), 1))


if _pub:
    # Bảng điểm vận hành: ngưỡng càng cao càng ít báo nhầm nhưng bỏ sót nhiều hơn
    OPERATING = pd.DataFrame([dict(nguong=th, **public_events(th)) for th in
                              sorted({0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, round(THRESHOLD, 2)})])
    print(OPERATING[["nguong", "bat_duoc", "cu_nga", "ti_le_bat", "bao_nham_moi_gio"]].to_string(index=False))
    if THRESHOLD_OVERRIDE is not None:
        THRESHOLD = float(THRESHOLD_OVERRIDE)
        print(f"Dung nguong tu dat: {THRESHOLD}")
    EVENT["mm-adl"] = public_events(THRESHOLD)
    print("Cong khai (theo su kien, nguong xuat ra firmware):", EVENT["mm-adl"])
elif THRESHOLD_OVERRIDE is not None:
    THRESHOLD = float(THRESHOLD_OVERRIDE)


def confusion(rows, key):
    c = dict(TP=0, FP=0, FN=0, TN=0)
    for r in rows:
        c[("T" if r[key] == r["that"] else "F") + ("P" if r[key] else "N")] += 1
    pr = c["TP"] / max(c["TP"] + c["FP"], 1)
    rc = c["TP"] / max(c["TP"] + c["FN"], 1)
    return dict(c, precision=round(pr, 3), recall=round(rc, 3), f1=round(2 * pr * rc / max(pr + rc, 1e-9), 3))


_own = [(s, p) for s, p in zip(ALL_SEQS, SEQ_P) if s["domain"] == "own" and p is not None]
_rows = [dict(kich_ban=s["name"], that=bool(s["trial"]["expectFall"]), model=bool(fires(p, THRESHOLD).any()),
              chip=s["trial"].get("detectedAt") is not None)
         for s, p in _own if s["trial"].get("countInDetection", True)]
if _rows:
    EVENT["own_model"] = confusion(_rows, "model")
    EVENT["own_chip"] = confusion(_rows, "chip")
    print(pd.DataFrame({"Model hoi quy logistic": EVENT["own_model"], "Thuat toan chip C1001": EVENT["own_chip"]}))
    _by = pd.DataFrame(_rows).groupby("kich_ban").agg(so_lan=("that", "size"), nga_that=("that", "first"),
                                                      model_bao=("model", "sum"), chip_bao=("chip", "sum"))
    print(_by)

# %% [markdown]
# ## 9. Model cuối cùng + giải thích trọng số
# Học lại trên **toàn bộ** cửa sổ có nhãn với `C` đã chọn. Trọng số dương đẩy về "ngã", âm đẩy về
# "không ngã": đây là phần trả lời câu hỏi "vì sao model quyết định như vậy" khi bảo vệ.

# %%
FINAL = fit(X, y, W, BEST_C)
WEIGHTS = FINAL.coef_[0].astype(float)
BIAS = float(FINAL.intercept_[0])
_wt = pd.DataFrame({"dac_trung": [f"f{i} {n}" for i, n in enumerate(FEATURE_NAMES)], "trong_so": WEIGHTS.round(4),
                    "huong": ["-> nga" if w > 0 else "-> khong nga" for w in WEIGHTS]})
print(_wt.reindex(_wt["trong_so"].abs().sort_values(ascending=False).index).to_string(index=False))
print(f"bias = {BIAS:.4f} | nguong = {THRESHOLD:.2f}")

if HAS_PLT:
    fig, ax = plt.subplots(1, 2, figsize=(12, 3.8))
    order = np.argsort(WEIGHTS)
    ax[0].barh([FEATURE_NAMES[i] for i in order], WEIGHTS[order],
               color=["#1f3f87" if WEIGHTS[i] < 0 else "#e3a21a" for i in order])
    ax[0].set_title("Trong so model (duong = day ve 'nga')")
    from sklearn.metrics import precision_recall_curve
    for d in sorted(set(DOM)):
        m = DOM == d
        if y[m].min() != y[m].max():
            pr, rc, _ = precision_recall_curve(y[m], P_OOF[m])
            ax[1].plot(rc, pr, label=d)
    ax[1].set_xlabel("Recall"); ax[1].set_ylabel("Precision"); ax[1].set_title("Precision-Recall ngoai-tap")
    ax[1].legend()
    fig.tight_layout()
    fig.savefig(OUT_DIR / "trong_so_va_pr.png", dpi=130)
    plt.show()

# %% [markdown]
# ## 10. Xuất `model_weights.h` cho firmware
# Định dạng giống hệt file dashboard từng sinh (`generateHeader()` trong `train.ts`). Ô này đọc lại chính
# file vừa ghi, tính xác suất bằng số thực 32 bit như ESP32 và so với scikit-learn.

# %%
def _fmt(v):
    return "-" if v is None else f"{v * 100:.1f}%"


def header_text():
    now = datetime.now(timezone(timedelta(hours=7)))
    n_own = int((DOM == "own").sum())
    n_pub = int((DOM != "own").sum())
    people = len({g for g, d in zip(GID, DOM) if d != "own"})
    trials = len({g for g, d in zip(GID, DOM) if d == "own"})
    wm = WINDOW_METRICS.get(TARGET) or {}
    info = f"kaggle {now:%d/%m/%Y} | tu do {n_own} cua so, cong khai {n_pub} | F1 {TARGET} {_fmt(wm.get('f1'))}"
    lines = [
        "/**",
        " * @file  model_weights.h",
        " * @brief Trong so model phat hien te nga. FILE NAY DUOC SINH TU DONG.",
        " *",
        f" * Sinh luc: {now:%H:%M %d/%m/%Y} (gio Viet Nam)",
        " * Sinh boi: tools/kaggle/huan_luyen_model_te_nga.ipynb",
        " *",
        " * DUNG SUA TAY. Muon doi thi huan luyen lai roi tai file moi.",
        " *",
        " * ----------------------------- SO LIEU -----------------------------------",
        f" * Du lieu tu do C1001 : {n_own} cua so co nhan, {trials} lan thu",
        f" * Du lieu cong khai   : {n_pub} cua so co nhan, {people} nguoi (mm-ADL, doi sang tin hieu C1001)",
        f" * Hoi quy logistic, C = {BEST_C}, can lop, danh gia cheo {len(FOLDS)} phan theo nguoi/lan thu",
    ]
    for d, m in WINDOW_METRICS.items():
        if m:
            lines.append(f" * Ngoai-tap {d:<12}: Precision {_fmt(m['precision'])}, Recall {_fmt(m['recall'])}, "
                         f"F1 {_fmt(m['f1'])}, AUC {m['auc']}")
    if "own_model" in EVENT:
        e, c = EVENT["own_model"], EVENT["own_chip"]
        lines.append(f" * Theo lan thu (2 cua so lien tiep): model TP={e['TP']} FP={e['FP']} FN={e['FN']} TN={e['TN']}"
                     f" | chip TP={c['TP']} FP={c['FP']} FN={c['FN']} TN={c['TN']}")
    if "mm-adl" in EVENT:
        e = EVENT["mm-adl"]
        lines.append(f" * mm-ADL theo su kien: bat {e['bat_duoc']}/{e['cu_nga']} cu nga, {e['bao_nham_moi_gio']} bao nham/gio")
    if not OWN_OK:
        lines.append(" * CHUA CO DU DU LIEU TU DO: so lieu tren chi de thu, KHONG dua vao bao cao.")
    lines += [" * -------------------------------------------------------------------------", " */",
              "#pragma once", "#include <Arduino.h>", "",
              "#define FALL_MODEL_TRAINED 1", f"#define FALL_MODEL_SPEC_VERSION {FEATURE_SPEC_VERSION}",
              f'#define FALL_MODEL_INFO "{info}"', "",
              f"constexpr float FALL_MODEL_THRESHOLD = {THRESHOLD:.6f}f;",
              f"constexpr float FALL_MODEL_BIAS      = {BIAS:.6f}f;", "",
              "// Thu tu dac trung xem src/core/fall_model.h",
              "constexpr float FALL_MODEL_WEIGHTS[10] = {"]
    lines += [f"    {w:.6f}f,  // f{i} {FEATURE_NAMES[i]}" for i, w in enumerate(WEIGHTS)]
    lines += ["};", ""]
    return "\n".join(lines)


HEADER_PATH = OUT_DIR / "model_weights.h"
HEADER_PATH.write_text(header_text(), encoding="ascii")

# Kiểm tra: đọc lại file vừa ghi, tính như ESP32 (float32, sigmoid chặn biên ±30)
_h = HEADER_PATH.read_text(encoding="ascii")
_w = np.array([float(v) for v in re.findall(r"^\s+(-?\d+\.\d+)f,", _h, re.M)], np.float32)
_b = np.float32(re.search(r"FALL_MODEL_BIAS\s*=\s*(-?\d+\.\d+)f", _h).group(1))
_t = float(re.search(r"FALL_MODEL_THRESHOLD\s*=\s*(-?\d+\.\d+)f", _h).group(1))
assert len(_w) == 10 and f"FALL_MODEL_SPEC_VERSION {FEATURE_SPEC_VERSION}" in _h
_z = np.clip(X.astype(np.float32) @ _w + _b, -30, 30)
_p32 = 1.0 / (1.0 + np.exp(-_z))
_diff = float(np.max(np.abs(_p32 - FINAL.predict_proba(X)[:, 1])))
_agree = float(np.mean((_p32 >= _t) == (FINAL.predict_proba(X)[:, 1] >= THRESHOLD)))
assert _diff < 1e-3, f"File .h lech model qua nhieu: {_diff}"
print(f"Da ghi {HEADER_PATH} | lech xac suat lon nhat {_diff:.1e} | khop quyet dinh {_agree * 100:.3f}% cua so")

REPORT = dict(sinh_luc=datetime.now(timezone.utc).isoformat(), feature_spec=FEATURE_SPEC_VERSION, C=BEST_C,
              threshold=THRESHOLD, bias=BIAS, weights=WEIGHTS.tolist(), feature_names=FEATURE_NAMES,
              chon_theo=TARGET, du_lieu_tu_do_du=OWN_OK, window_metrics=WINDOW_METRICS, event_metrics=EVENT,
              amp_map=AMP_MAP, chuyen_doi=dict(AMP_V0=AMP_V0, AMP_DEADBAND=AMP_DEADBAND, MICRO_GAIN=MICRO_GAIN,
                                                ACTIVE_AMP=ACTIVE_AMP, FOV_HALF_DEG=FOV_HALF_DEG,
                                                INSTALL_HEIGHT_M=INSTALL_HEIGHT_M))
(OUT_DIR / "model_report.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding="utf-8")
print(HEADER_PATH.read_text(encoding="ascii"))

# %% [markdown]
# ## 11. Nạp vào ESP32
# 1. Tải `model_weights.h` ở tab *Output* (kèm `model_report.json` và 2 ảnh `.png` cho báo cáo).
# 2. Chép đè `include/model_weights.h` trong project → `pio run -t upload`.
# 3. Mở serial: phải thấy `[MODEL] Da nap model: kaggle ...`. Trang giám sát thiết bị hiện xác suất của model
#    song song với cờ ngã của chip.
#
# **Viết vào báo cáo:** số liệu chính lấy ở bảng "Model vs chip" (mục 8, dữ liệu tự đo); số liệu mm-ADL chỉ
# dùng để nói model đã được kiểm tra trên 11 người lạ. Nhớ ghi rõ phép chuyển point cloud → tín hiệu C1001 là
# xấp xỉ, và trích dẫn mm-ADL theo giấy phép CC BY 4.0.
