"""M10: one training file of strict items with Haiku labels, splits and aligned targets (lab only).

    python3 -I packages/sim/lab/m10/build_set.py --items A.jsonl,B.jsonl --labels REF.jsonl,... --out set.jsonl.gz
"""
import argparse, gzip, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import align, family, load_jsonl, load_labels, split_of

ap = argparse.ArgumentParser()
ap.add_argument("--items", required=True)
ap.add_argument("--labels", required=True)
ap.add_argument("--self", default="", help="a second Haiku labelling (self-agreement), kept as `card2`")
ap.add_argument("--out", required=True)
a = ap.parse_args()
lab = load_labels(*a.labels.split(","))
lab2 = load_labels(*a.self.split(",")) if a.self else {}
seen = set()
n = 0
with gzip.open(a.out, "wt") as f:
    for p in a.items.split(","):
        for r in load_jsonl(p):
            if not r["strict"] or r["h"] in seen or r["h"] not in lab:
                continue
            seen.add(r["h"])
            c = lab[r["h"]]
            row = {
                k: r[k]
                for k in ("h", "suite", "seed", "variant", "planted", "title", "own", "dated", "now", "source", "toks", "dates", "amounts")
            }
            row.update(card=c, split=split_of(r), family=family(r)[:16], target=align(r, c))
            if r["h"] in lab2:
                row["card2"] = lab2[r["h"]]
            f.write(json.dumps(row) + "\n")
            n += 1
print(n)
