"""M6: the no-model baselines on the offline screen (B0 shipped, B1 pick at smaller budgets, title only).

    python3 -I packages/sim/lab/m6/baselines.py DIR/items.jsonl [--sets val,test,sim]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m6lib as L  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("items")
ap.add_argument("--sets", default="val,test,sim")
a = ap.parse_args()
for s in a.sets.split(","):
    rows = L.load(a.items, {s})
    if not rows:
        continue
    print(f"== {s}")
    print(L.fmt(L.screen(rows, lambda r: r["shipped"], "B0 shipped")))
    for b in (240, 200, 160, 120, 80):
        print(L.fmt(L.screen(rows, lambda r, b=b: L.pick(r, b), f"B1 pick {b}")))
    print(L.fmt(L.screen(rows, lambda r: "", "title only")))
