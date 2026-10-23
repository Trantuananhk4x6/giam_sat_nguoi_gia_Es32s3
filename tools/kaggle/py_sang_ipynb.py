"""Sinh file .ipynb tu file .py dang 'percent' (# %% / # %% [markdown]).

Hai file trong thu muc nay la MOT noi dung o hai dang:
    huan_luyen_model_te_nga.py    <- ban de sua, de doc diff tren git
    huan_luyen_model_te_nga.ipynb <- ban de tai len Kaggle

Sua file .py roi chay lenh nay de dong bo lai file .ipynb:
    python tools/kaggle/py_sang_ipynb.py
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def to_cells(text):
    """Cat noi dung .py thanh danh sach o (cell) theo moc '# %%'."""
    lines = text.replace("\r\n", "\n").split("\n")
    cells, cur, kind = [], None, None

    def flush():
        if cur is None:
            return
        body = "\n".join(cur).strip("\n")
        if kind == "markdown":
            # Bo tien to '# ' cua tung dong markdown
            body = "\n".join(re.sub(r"^# ?", "", l) for l in body.split("\n")).strip("\n")
        if body:
            cells.append((kind, body))

    for line in lines:
        m = re.match(r"^# %%(.*)$", line)
        if m:
            flush()
            kind = "markdown" if "[markdown]" in m.group(1) else "code"
            cur = []
        elif cur is not None:
            cur.append(line)
    flush()
    return cells


def build(cells):
    out = []
    for i, (kind, body) in enumerate(cells, 1):
        src = [l + "\n" for l in body.split("\n")]
        src[-1] = src[-1].rstrip("\n")
        cell = {"cell_type": kind, "id": f"cell-{i:02d}", "metadata": {}, "source": src}
        if kind == "code":
            cell["execution_count"] = None
            cell["outputs"] = []
        out.append(cell)
    return {
        "cells": out,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def main(argv):
    stems = argv[1:] or ["huan_luyen_model_te_nga"]
    for stem in stems:
        py = HERE / f"{Path(stem).stem}.py"
        nb = py.with_suffix(".ipynb")
        cells = to_cells(py.read_text(encoding="utf-8-sig"))
        nb.write_text(json.dumps(build(cells), ensure_ascii=False, indent=1), encoding="utf-8")
        n_md = sum(1 for k, _ in cells if k == "markdown")
        print(f"{py.name} -> {nb.name}: {len(cells)} o ({n_md} markdown, {len(cells) - n_md} code)")


if __name__ == "__main__":
    main(sys.argv)
