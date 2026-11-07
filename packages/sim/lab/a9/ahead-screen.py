"""A9 $0 screen of `pushAhead` (docs/research/a9-ahead.md): the funnel's `--packets` files of the default and of the
default with the switch on, task by task. Per kind: tasks with an ahead packet, its items and bytes, the planted item
(the fact on hidden tasks, the look-alike on control) in an ahead packet, and in an ahead packet only.
python3 -I ahead-screen.py BASE.packets.jsonl AHEAD.packets.jsonl"""
import json, sys
from collections import defaultdict


def load(path):
    out = {}
    for line in open(path):
        r = json.loads(line)
        out[(r["suite"], r["seed"], r["variant"], r["template"])] = r
    return out


base, ahead = load(sys.argv[1]), load(sys.argv[2])
agg = defaultdict(lambda: defaultdict(float))
for k, r in ahead.items():
    v = r["variant"]
    a = agg[v]
    a["tasks"] += 1
    pk = [p for p in r["packets"] if p["reason"].startswith("ahead")]
    other = {i for p in r["packets"] if not p["reason"].startswith("ahead") for i in p["ids"]}
    ids = {i for p in pk for i in p["ids"]}
    a["with"] += bool(pk)
    a["items"] += len(ids)
    a["bytes"] += sum(len(p["text"]) for p in pk)
    planted = r.get("planted")
    if planted and planted in ids:
        a["planted in ahead"] += 1
        a["planted only in ahead"] += planted not in other
    b = base.get(k)
    if b:
        a["base bytes"] += sum(len(p["text"]) for p in b["packets"])
        a["other bytes"] += sum(len(p["text"]) for p in r["packets"] if not p["reason"].startswith("ahead"))
        a["same other ids"] += other == {i for p in b["packets"] for i in p["ids"]}
for v, a in agg.items():
    n = a["tasks"]
    print(f"{v:8} tasks {int(n)}  with ahead {int(a['with'])} ({a['with']/n:.0%})  items/task {a['items']/n:.2f}  "
          f"ahead bytes/task {a['bytes']/n:.0f}  other packets' bytes/task {a['other bytes']/n:.0f} "
          f"(default {a['base bytes']/n:.0f}; same other items {int(a['same other ids'])}/{int(n)})  "
          f"planted in ahead {int(a['planted in ahead'])}, only there {int(a['planted only in ahead'])}")
