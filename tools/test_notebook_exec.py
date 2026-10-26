#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Thực thi tuần tự toàn bộ các ô code của tools/huan_luyen_local.ipynb,
thu thập đầu ra văn bản (stdout) và hình ảnh biểu đồ (image/png base64)
rồi lưu trực tiếp vào tools/huan_luyen_local.ipynb để hiển thị sẵn kết quả khi mở trên VS Code / Jupyter.
"""

import base64
import io
import json
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def test_run():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    nb_path = Path("tools/huan_luyen_local.ipynb")
    with open(nb_path, encoding="utf-8") as f:
        nb = json.load(f)

    print(f"Bắt đầu thực thi và lưu kết quả cho {len(nb['cells'])} cells của {nb_path}...")
    glob = {
        "__name__": "__main__",
        "__file__": str(nb_path.resolve()),
        "get_ipython": lambda: True,  # Để EDA_NOTEBOOK = True và kích hoạt plt.show() lưu ảnh vào cell
    }

    code_cells = [(i, c) for i, c in enumerate(nb["cells"]) if c["cell_type"] == "code"]
    print(f"Tổng số code cells cần thực thi: {len(code_cells)}")

    t_start = time.time()
    for idx, (cell_i, cell) in enumerate(code_cells, 1):
        src = "".join(cell["source"])
        print(f"\n[{idx}/{len(code_cells)}] Đang chạy Cell {cell_i}...")
        t0 = time.time()
        buf = io.StringIO()
        captured_pngs = []

        orig_show = plt.show

        def _capture_show(*args, **kwargs):
            for num in plt.get_fignums():
                fig = plt.figure(num)
                bio = io.BytesIO()
                fig.savefig(bio, format="png", dpi=130, bbox_inches="tight")
                captured_pngs.append(base64.b64encode(bio.getvalue()).decode("ascii"))
            plt.close("all")

        plt.show = _capture_show
        try:
            with redirect_stdout(buf):
                exec(src, glob)
            # Nếu còn figure nào chưa đóng sau khi chạy cell
            if plt.get_fignums():
                _capture_show()
        except Exception as e:
            plt.show = orig_show
            import traceback
            sys.stdout.write(buf.getvalue())
            print(f"  [!] LỖI TẠI CELL {cell_i}: {e}")
            traceback.print_exc()
            return False
        finally:
            plt.show = orig_show

        out_text = buf.getvalue()
        if out_text:
            sys.stdout.write(out_text)

        outputs = []
        if out_text:
            lines = [l + "\n" for l in out_text.splitlines()]
            outputs.append({
                "name": "stdout",
                "output_type": "stream",
                "text": lines,
            })
        for b64_png in captured_pngs:
            outputs.append({
                "data": {
                    "image/png": b64_png,
                    "text/plain": ["<Figure>"],
                },
                "metadata": {},
                "output_type": "display_data",
            })

        cell["execution_count"] = idx
        cell["outputs"] = outputs
        print(f"  -> Hoàn thành Cell {cell_i} ({time.time() - t0:.2f}s | {len(captured_pngs)} ảnh)")

    with open(nb_path, "w", encoding="utf-8") as f:
        json.dump(nb, f, ensure_ascii=False, indent=1)

    print(f"\n=======================================================")
    print(f"TẤT CẢ {len(code_cells)} CODE CELLS ĐÃ CHẠY & LƯU OUTPUT VÀO {nb_path} TRONG {time.time() - t_start:.1f}s!")
    print(f"=======================================================")
    return True


if __name__ == "__main__":
    success = test_run()
    sys.exit(0 if success else 1)
