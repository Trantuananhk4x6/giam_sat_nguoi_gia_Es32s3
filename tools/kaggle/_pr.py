import os
os.environ["OALPHA_DOWNLOAD"]="1"
os.environ["OALPHA_RADHAR_MAX"]="2"
print("start", flush=True)
src = open("huan_luyen_model_te_nga.py", encoding="utf-8").read()
cut = src.index("PUB_SEQS = load_public")
ns = {}
exec(compile(src[:cut], "nb", "exec"), ns)
print("loaded defs", flush=True)
seqs = ns["load_radhar"]()
print("RADHAR_SEQS", len(seqs), flush=True)
