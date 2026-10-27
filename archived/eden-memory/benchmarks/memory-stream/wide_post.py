"""C11-E8 post hoc: recall and firing of the wide Jev check at other thresholds and pick caps.

    python3 benchmarks/memory-stream/wide_post.py
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from recall_funnel import Generators

for w in ("code", "life"):
    g = Generators(w)
    out = json.load(open(os.path.join(HERE, "dream", w, "wide", "out.json")))
    for thr, top in ((0.7, 4), (0.7, 8), (0.7, 999), (0.5, 4), (0.5, 8)):
        tot = hit = fired_no = 0
        npk = []
        for r in out.values():
            sc = {i: p for i, p in r["scores"].items() if p is not None}
            picks = sorted((i for i in sc if sc[i] >= thr), key=lambda i: (-sc[i], i))[:top]
            npk.append(len(picks))
            fired_no += (not r["need"]) and bool(picks)
            for item in r["need"]:
                cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
                if cover:
                    tot += 1
                    hit += any(i in picks for i in cover)
        print(w, f"p>={thr} top{top}: recall {hit}/{tot} = {hit / tot:.3f}, no-need turns firing {fired_no}, "
                 f"mean picks {sum(npk) / len(npk):.2f}")
