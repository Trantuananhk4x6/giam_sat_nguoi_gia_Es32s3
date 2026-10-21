# -*- coding: utf-8 -*-
"""
Doi chieu cach tinh dac trung o HAI NOI phai giong nhau tung con so:

    C++        : src/fall_model.cpp              -> FallModel::extractFeatures()
    TypeScript : dashboard/src/lib/features.ts   -> extractFeatures()

VI SAO QUAN TRONG: model duoc huan luyen bang ban TypeScript nhung chay bang ban
C++ tren ESP32. Neu hai ben tinh lech nhau mot con so, model se chay sai ma
khong he bao loi gi — rat kho phat hien. Hay chay lai bai kiem tra nay moi lan
sua cach tinh dac trung.

CACH DUNG (can cai Node.js):
    python tools/kiem_tra_dac_trung.py
"""
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile

WINDOW = 12
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cpp_extract(window):
    """Port tung dong tu src/fall_model.cpp -> FallModel::extractFeatures()"""
    sum_range = max_range = sum_dist = 0.0
    min_dist = 1e9
    n_present = n_active = n_static = 0

    for s in window:
        r, d = float(s["range"]), float(s["distanceCm"])
        sum_range += r
        max_range = max(max_range, r)
        sum_dist += d
        min_dist = min(min_dist, d)
        n_present += 1 if s["present"] else 0
        n_active += 1 if s["movement"] == 2 else 0
        n_static += 1 if s["staticStay"] else 0

    mean_range = sum_range / WINDOW
    var_range = sum((float(s["range"]) - mean_range) ** 2 for s in window)
    std_range = math.sqrt(var_range / WINDOW)

    first, last, n = window[0], window[WINDOW - 1], float(WINDOW)
    return [
        mean_range / 100.0,
        max_range / 100.0,
        std_range / 50.0,
        (float(last["range"]) - float(first["range"])) / 100.0,
        (sum_dist / n) / 400.0,
        (float(last["distanceCm"]) - float(first["distanceCm"])) / 200.0,
        min_dist / 400.0,
        n_present / n,
        n_active / n,
        n_static / n,
    ]


def make_cases():
    random.seed(20261019)
    cases = []
    for _ in range(60):
        cases.append([{
            "t": 1000 + i * 250,
            "present": random.choice([0, 1]),
            "movement": random.choice([0, 1, 2]),
            "range": random.randint(0, 100),
            "staticStay": random.choice([0, 1]),
            "distanceCm": random.randint(0, 600),
            "trackX": 0, "trackY": 0, "recvAt": 0,
        } for i in range(WINDOW)])

    def flat(**kw):
        base = {"t": 0, "present": 0, "movement": 0, "range": 0, "staticStay": 0,
                "distanceCm": 0, "trackX": 0, "trackY": 0, "recvAt": 0}
        base.update(kw)
        return [dict(base) for _ in range(WINDOW)]

    cases.append(flat())                                                   # tat ca 0
    cases.append(flat(present=1, movement=2, range=100, staticStay=1,
                      distanceCm=1100))                                    # tat ca cuc dai
    return cases


def main():
    if shutil.which("node") is None or shutil.which("npx") is None:
        print("Can cai Node.js de chay bai kiem tra nay (dung de bien dich ban TypeScript).")
        return 2

    dash = os.path.join(ROOT, "dashboard")
    src = os.path.join(dash, "src", "lib", "features.ts")
    if not os.path.exists(src):
        print("Khong tim thay", src)
        return 2

    tmp = tempfile.mkdtemp(prefix="kiemtra_dactrung_")
    try:
        print("Dang bien dich ban TypeScript...")
        r = subprocess.run(
            ["npx", "tsc", "src/lib/features.ts", "--target", "es2022",
             "--module", "esnext", "--moduleResolution", "bundler", "--outDir", tmp],
            cwd=dash, capture_output=True, text=True, shell=(os.name == "nt"),
        )
        js = os.path.join(tmp, "features.js")
        if not os.path.exists(js):
            print("Bien dich that bai:")
            print(r.stdout[-1500:], r.stderr[-1500:])
            return 1

        cases = make_cases()
        with open(os.path.join(tmp, "cases.json"), "w", encoding="utf-8") as f:
            json.dump(cases, f)
        with open(os.path.join(tmp, "run.mjs"), "w", encoding="utf-8") as f:
            f.write(
                'import { readFileSync } from "node:fs";\n'
                'import { extractFeatures } from "./features.js";\n'
                'const cases = JSON.parse(readFileSync("./cases.json", "utf8"));\n'
                'console.log(JSON.stringify(cases.map((w) => extractFeatures(w))));\n'
            )

        out = subprocess.run(["node", "run.mjs"], cwd=tmp, capture_output=True, text=True)
        if out.returncode != 0:
            print("Khong chay duoc ban TypeScript:")
            print(out.stdout[-1500:], out.stderr[-1500:])
            return 1

        ts_results = json.loads(out.stdout)
        worst, bad = 0.0, 0
        for i, w in enumerate(cases):
            cpp, ts = cpp_extract(w), ts_results[i]
            if ts is None:
                print(f"  ca {i}: ban TypeScript tra ve null")
                bad += 1
                continue
            for k in range(10):
                d = abs(cpp[k] - ts[k])
                worst = max(worst, d)
                if d > 1e-9:
                    bad += 1
                    print(f"  LECH ca {i} dac trung f{k}: C++={cpp[k]!r} TS={ts[k]!r}")

        print(f"So ca kiem tra    : {len(cases)}")
        print(f"Sai lech lon nhat : {worst:.3e}")
        print("KET QUA:", "KHOP HOAN TOAN" if bad == 0 else f"CO {bad} CHO LECH")
        return 0 if bad == 0 else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
