# CL8 (docs/research/cl-cl8.md): per Eden arm and kind, packet characters a task (the packets the agent's requests saw)
# and `ask_context` calls and answer bytes, from pi-ab timelines (STEM.tl/tasks.jsonl, uptake.ts records).
# usage: python3 -I asks.py STEM [STEM ...]
import json, sys, collections

agg = collections.defaultdict(collections.Counter)
for stem in sys.argv[1:]:
    for line in open(stem + ".tl/tasks.jsonl"):
        d = json.loads(line)
        if d["condition"] == "tools":
            continue
        a = agg[(d["condition"], d["kind"])]
        a["n"] += 1
        a["packet"] += len(d.get("packets") or "")
        for x in d.get("asks") or []:
            a["asks"] += 1
            a["bytes"] += x.get("bytes", 0)
for (arm, kind), a in sorted(agg.items()):
    n = a["n"]
    print(
        f"{arm:10s} {kind:8s} n {n:4d}  packet chars/task {a['packet']/n:5.0f}  asks/task {a['asks']/n:.2f}  "
        f"answer bytes/task {a['bytes']/n:4.0f}  bytes/ask {a['bytes']/max(1, a['asks']):4.0f}"
    )
