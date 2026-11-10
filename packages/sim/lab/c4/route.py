#!/usr/bin/env python3
"""C4 (D430): hidden tasks by how the planted item reached the agent (in a packet, in an ask answer only, neither)
and how many of each the agent raised (`a2/uptake.py`'s split), per arm, from pi-ab results and timelines.

    python3 -I packages/sim/lab/c4/route.py base=STEM[,STEM...] ab=STEM[,STEM...]
"""
import json
import sys
from collections import Counter

for spec in sys.argv[1:]:
    label, _, stems = spec.partition("=")
    c = Counter()
    for stem in stems.split(","):
        res = {r["task"]: r for r in json.load(open(stem + ".json"))["results"]}
        for line in open(stem + ".tl/tasks.jsonl"):
            if not line.strip():
                continue
            r = json.loads(line)
            if r["kind"] != "hidden":
                continue
            raised = any(res[r["task"]]["facts"].values())
            packets = {i for w in r.get("ways") or [] for i in w.get("ids", [])}
            way = "packet" if r.get("planted") in packets else "ask only" if r.get("askCited") else "neither"
            c[way, "n"] += 1
            c[way, "raised"] += raised
    print(f"{label:>6} " + "  ".join(f"{w}: raised {c[w, 'raised']}/{c[w, 'n']}" for w in ("packet", "ask only", "neither")))
