#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Đồng bộ hóa trực tiếp tools/huan_luyen_local.py -> tools/huan_luyen_local.ipynb
Giữ nguyên 100% toàn bộ các ô Markdown (# %% [markdown]) và Code (# %%) bao gồm:
- Tích hợp Đa Bộ Dữ liệu (mm-ADL, mm-ADL-Home, RadHAR, C1001-Ext) & Chuẩn hóa Vật lý Góc tới AoA
- 10 bài toán Trực quan hóa dữ liệu (EDA 6a-6j)
- Chưng cất Tri thức (Knowledge Distillation: Teacher Ensemble -> Student LR & Student MLP)
- Kiểm tra Chuyển miền (CORAL + KD) & Mạng Tư thế 5 Lớp (10-32-16-5)
- Kiểm toán Ma trận Nhầm lẫn Đa cấp độ & Kiểm toán Độ chệch (Bias Audit) (Mục 13b)
"""

import json
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def split_cells(py_text: str):
    cells = []
    kind = None
    buf = []

    def flush():
        if kind is None:
            return
        while buf and not buf[-1].strip():
            buf.pop()
        if not buf:
            return
        if kind == "markdown":
            lines = []
            for ln in buf:
                if ln.startswith("# "):
                    lines.append(ln[2:])
                elif ln == "#":
                    lines.append("")
                else:
                    lines.append(ln)
            src = [l + "\n" for l in lines]
            if src:
                src[-1] = src[-1].rstrip("\n")
            cells.append({"cell_type": "markdown", "metadata": {}, "source": src})
        else:
            src = [l + "\n" for l in buf]
            if src:
                src[-1] = src[-1].rstrip("\n")
            cells.append({
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": src,
            })

    for line in py_text.splitlines():
        if line.startswith("# %% [markdown]"):
            flush()
            kind, buf = "markdown", []
        elif line.startswith("# %%"):
            flush()
            kind, buf = "code", []
        elif kind is not None:
            buf.append(line)
    flush()
    return cells


def build_local_notebook():
    py_path = Path("tools/huan_luyen_local.py")
    dst_path = Path("tools/huan_luyen_local.ipynb")
    cells = split_cells(py_path.read_text(encoding="utf-8"))

    # Đảm bảo ô code đầu tiên có cấu hình UTF-8 và import shutil
    for c in cells:
        if c["cell_type"] == "code":
            first_src = "".join(c["source"])
            prefix = (
                "import sys, shutil\n"
                "if sys.platform == 'win32':\n"
                "    try:\n"
                "        sys.stdout.reconfigure(encoding='utf-8', errors='replace')\n"
                "        sys.stderr.reconfigure(encoding='utf-8', errors='replace')\n"
                "    except Exception:\n"
                "        pass\n\n"
            )
            if "import shutil" not in first_src:
                merged = prefix + first_src
                c["source"] = [l + "\n" for l in merged.splitlines()]
                if c["source"]:
                    c["source"][-1] = c["source"][-1].rstrip("\n")
            break

    nb = {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "pygments_lexer": "ipython3"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    dst_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n_md = sum(c["cell_type"] == "markdown" for c in cells)
    n_code = sum(c["cell_type"] == "code" for c in cells)
    print(f"Đã đồng bộ {py_path} -> {dst_path}: {len(cells)} ô ({n_md} markdown, {n_code} code)")


if __name__ == "__main__":
    build_local_notebook()
