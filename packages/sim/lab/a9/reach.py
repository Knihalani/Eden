"""A9: hidden raised (and control/neutral concerns as graded) for ARM and BASE on the tasks ARM's ahead packet reached
and on the rest, per kind. python3 -I reach.py ARM BASE STEM [STEM ...]"""
import json, sys
from collections import defaultdict

arm, base, stems = sys.argv[1], sys.argv[2], sys.argv[3:]
agg = defaultdict(lambda: [0, 0, 0])
for stem in stems:
    d = json.load(open(stem + ".json"))
    flag = {(r["task"], r["condition"]): any(r["facts"].values()) for r in d["results"] if r.get("facts")}
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        if t["condition"] != arm:
            continue
        reached = any(w["why"] == "ahead" for w in t.get("ways", []))
        a = agg[(t["kind"], "ahead" if reached else "no ahead")]
        a[0] += 1
        a[1] += flag.get((t["task"], arm), False)
        a[2] += flag.get((t["task"], base), False)
print(f"{'kind':8} {'tasks':9} {'n':>4} {arm:>11} {base:>8}")
for (kind, part), (n, x, y) in sorted(agg.items()):
    print(f"{kind:8} {part:9} {n:4} {x:11} {y:8}")
