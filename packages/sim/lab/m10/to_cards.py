"""M10: a tagger's raw outputs (`{h, out}`) decoded to cards (`{h, c}`) with evalset.decode's rules (lab only).

    python3 -I packages/sim/lab/m10/to_cards.py --rows predict.jsonl.gz --outs predict.jsonl --out cards.jsonl
        [--t-flag 0.5 --t-act 0.5 --t-role 0.5 --t-amt 0.5]
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evalset import decode, load

ap = argparse.ArgumentParser()
ap.add_argument("--rows", required=True)
ap.add_argument("--outs", required=True)
ap.add_argument("--out", required=True)
for k in ("flag", "act", "role", "amt"):
    ap.add_argument(f"--t-{k}", type=float, default=0.5)
ap.add_argument("--t-ent", type=float, default=None)
a = ap.parse_args()
rows = {r["h"]: r for r in load(a.rows)}
n = f = 0
with open(a.out, "w") as w:
    for p in load(a.outs):
        r = rows.get(p["h"])
        if r is None:
            continue
        c = decode(r, p["out"], a.t_flag, a.t_act, a.t_role, a.t_amt, a.t_ent)
        w.write(json.dumps({"h": p["h"], "c": c}) + "\n")
        n += 1
        f += c["kind"] != "none"
print(n, f)
