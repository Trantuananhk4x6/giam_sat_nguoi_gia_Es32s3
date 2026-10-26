#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bộ Tự Kiểm Tra & Giám Sát Chất Lượng Toàn Hệ Thống OALPHA (Self-Check & Audit Suite)
Kiểm tra tự động 5 tầng:
  1. Bảo mật Git (.gitignore & secrets.h không bị lộ)
  2. Parser khung truyền UART Radar C1001 (16 ca kiểm thử)
  3. Hợp đồng 10 đặc trưng 3 ngôn ngữ C++ <-> Python <-> TypeScript (62 ca kiểm thử)
  4. Kiểm toán Trọng số AI Chưng Cất, Độ chệch (Bias Audit) & Ma trận nhầm lẫn
  5. Biên dịch tĩnh TypeScript cho Dashboard Next.js (npx tsc --noEmit)
"""

import json
import subprocess
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent


def run_step(title: str, cmd: list[str], cwd: Path = ROOT) -> bool:
    print(f"\n[KIỂM TRA] {title}...")
    res = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        print(f"  [THẤT BẠI] Lệnh: {' '.join(cmd)}")
        if res.stdout:
            print(res.stdout.strip())
        if res.stderr:
            print(res.stderr.strip())
        return False
    print(f"  [ĐẠT] {title}")
    return True


def audit_ai_and_bias() -> bool:
    print("\n[KIỂM TRA] 4. Kiểm toán Mô hình AI Chưng Cất, Độ chệch (Bias) & C++ Headers...")
    report_path = ROOT / "oalpha_output" / "model_report.json"
    lr_header = ROOT / "include" / "model_weights.h"
    nn_header = ROOT / "include" / "nn_weights.h"

    if not report_path.exists() or not lr_header.exists() or not nn_header.exists():
        print("  [THẤT BẠI] Thiếu file model_report.json hoặc C++ headers trong include/")
        return False

    r = json.loads(report_path.read_text(encoding="utf-8"))
    weights = r.get("weights", [])
    if len(weights) != 10:
        print(f"  [THẤT BẠI] Số trọng số Logistic không đúng 10: {len(weights)}")
        return False

    # Kiểm tra toàn bộ 10 trọng số đều dương hợp lý về mặt vật lý (không đảo dấu f0, không liệt f9)
    neg_features = [(i, w) for i, w in enumerate(weights) if w <= 0]
    if neg_features:
        print(f"  [THẤT BẠI] Phát hiện trọng số bị âm hoặc bằng 0: {neg_features}")
        return False

    mlp_ev = r.get("event_metrics", {}).get("nn_cong_khai", {})
    lr_ev = r.get("event_metrics", {}).get("cong_khai", {})
    posture_acc = r.get("mlp", {}).get("tu_the", {}).get("do_chinh_xac", 0.0)

    mlp_recall = float(mlp_ev.get("ti_le_bat", 0.0))
    mlp_fa = float(mlp_ev.get("bao_nham_moi_gio", 99.0))
    lr_recall = float(lr_ev.get("ti_le_bat", 0.0))
    lr_fa = float(lr_ev.get("bao_nham_moi_gio", 99.0))

    print(f"  -> Student MLP (10-64-32-16-1): Bắt ngã = {mlp_recall*100:.1f}% @ {mlp_fa:.1f} FA/h")
    print(f"  -> Student LR  (10 đặc trưng) : Bắt ngã = {lr_recall*100:.1f}% @ {lr_fa:.1f} FA/h")
    print(f"  -> Posture MLP (10-32-16-5)   : Accuracy = {posture_acc*100:.1f}%")
    print(f"  -> Kiểm tra dấu vật lý 10 đặc trưng: TẤT CẢ DƯƠNG (f0={weights[0]:+.2f}, f5={weights[5]:+.2f}, f9={weights[9]:+.2f})")

    if mlp_recall < 0.85 or mlp_fa > 6.5 or lr_recall < 0.85 or posture_acc < 0.85:
        print("  [THẤT BẠI] Chỉ số mô hình chưa đạt ngưỡng chất lượng tối thiểu!")
        return False

    lr_text = lr_header.read_text(encoding="utf-8")
    nn_text = nn_header.read_text(encoding="utf-8")
    if "#define FALL_MODEL_TRAINED 1" not in lr_text or "#define NN_MODEL_TRAINED 1" not in nn_text:
        print("  [THẤT BẠI] Header C++ trong include/ chưa bật cờ TRAINED = 1")
        return False

    print("  [ĐẠT] 4. Kiểm toán Mô hình AI Chưng Cất & Độ chệch (Bias Audit)")
    return True


def main() -> int:
    print("=" * 76)
    print("  HỆ THỐNG TỰ KIỂM ĐỊNH TOÀN DIỆN OALPHA (FIRMWARE + AI KD + DASHBOARD)")
    print("=" * 76)

    ok = True

    # 1. Kiểm tra bảo mật Git
    print("\n[KIỂM TRA] 1. Bảo mật Git (include/secrets.h không bị theo dõi)...")
    res = subprocess.run(["git", "ls-files", "include/secrets.h"], cwd=str(ROOT), capture_output=True, text=True)
    if res.stdout.strip():
        print("  [THẤT BẠI] include/secrets.h vẫn đang nằm trong Git index!")
        ok = False
    else:
        print("  [ĐẠT] 1. Bảo mật Git (include/secrets.h đã được gỡ khỏi Git index)")

    # 2. Kiểm tra parser khung truyền UART C++
    ok = run_step("2. Kiểm thử Parser Khung truyền UART Radar (16 ca)", [sys.executable, "tools/test_radar_frame.py"]) and ok

    # 3. Kiểm tra hợp đồng đặc trưng 3 ngôn ngữ
    ok = run_step("3. Hợp đồng 10 Đặc trưng C++ / Python / TypeScript (62 ca)", [sys.executable, "tools/kiem_tra_dac_trung.py"]) and ok

    # 4. Kiểm toán AI & Bias
    ok = audit_ai_and_bias() and ok

    # 5. Kiểm tra TypeScript Dashboard
    npx_cmd = "npx.cmd" if sys.platform == "win32" else "npx"
    ok = run_step("5. Biên dịch tĩnh TypeScript Dashboard Next.js", [npx_cmd, "tsc", "--noEmit"], cwd=ROOT / "dashboard") and ok

    print("\n" + "=" * 76)
    if ok:
        print("  KẾT QUẢ CHUNG: TẤT CẢ 5 TẦNG KIỂM ĐỊNH ĐỀU PASS 100%!")
        print("=" * 76)
        return 0
    else:
        print("  KẾT QUẢ CHUNG: CÓ HẠNG MỤC CHƯA ĐẠT — VUI LÒNG XEM CHI TIẾT Ở TRÊN!")
        print("=" * 76)
        return 1


if __name__ == "__main__":
    sys.exit(main())
