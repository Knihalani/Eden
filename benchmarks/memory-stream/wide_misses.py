"""C11-E8: print the wide checker's misses (turn, needed item, covering rows and their p) for one world, at p ≥ 0.7,
top 8.

    python3 benchmarks/memory-stream/wide_misses.py code
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from recall_funnel import Generators

w = sys.argv[1]
g = Generators(w)
out = json.load(open(os.path.join(HERE, "dream", w, "wide", "out.json")))
ev = {e["id"]: e for s in g.stream["sessions"] for e in s["events"]}
items = {x["id"]: x for x in g.items} if isinstance(g.items, list) else g.items
n = 0
for eid, r in out.items():
    sc = {i: p for i, p in r["scores"].items() if p is not None}
    picks = set(sorted((i for i in sc if sc[i] >= 0.7), key=lambda i: (-sc[i], i))[:8])
    for item in r["need"]:
        cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
        if cover and not picks & set(cover):
            n += 1
            print("---", eid, "| item kind", items[item]["kind"])
            print("TURN:", M.strip_paste(ev[eid]["text_all"])[:300].replace("\n", " "))
            print("ITEM:", items[item].get("text", "")[:200])
            for i in cover[:2]:
                print(f"ROW p={sc.get(i)}:", g.by_id[i]["text"][:200])
print(n, "misses")
