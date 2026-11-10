#!/usr/bin/env python3
"""C4 (D430): per arm and kind over pi-ab timelines, the `ask_context` calls a task (Eden's path lane), tasks whose
ask cited the planted item, follow-up packets (`ask-behind`) the agent took and those holding the planted item, and
items left untaken at the task's end (`lateItems`).

    python3 -I packages/sim/lab/c4/ask-uptake.py base=STEM[,STEM...] ab=STEM[,STEM...]   (STEM.json, STEM.tl/)
"""
import json
import sys
from collections import Counter

for spec in sys.argv[1:]:
    label, _, stems = spec.partition("=")
    c = Counter()
    for stem in stems.split(","):
        late = {r["task"]: r.get("lateItems", 0) for r in json.load(open(stem + ".json"))["results"]}
        for line in open(stem + ".tl/tasks.jsonl"):
            if not line.strip():
                continue
            r = json.loads(line)
            k = r["kind"]
            c[k, "n"] += 1
            c[k, "asks"] += sum(1 for e in r["events"] if e.get("lane") == "path" and e.get("cat") == "eden" and e.get("ph") == "B"
                                and e.get("ev") != "eden.observe")
            c[k, "askCited"] += bool(r.get("askCited"))
            for w in r.get("ways") or []:
                if w.get("why") == "ask-behind":
                    c[k, "followUps"] += 1
                    c[k, "followUpPlanted"] += r.get("planted") in w.get("ids", [])
            c[k, "late"] += late.get(r["task"], 0)
    for k in ("hidden", "control", "neutral"):
        n = c[k, "n"]
        print(f"{label:>6} {k:<8} n {n:>3}  asks/task {c[k, 'asks'] / n:.2f}  ask cited planted {c[k, 'askCited']:>3}  "
              f"follow-ups taken {c[k, 'followUps']:>2} (planted {c[k, 'followUpPlanted']})  untaken items {c[k, 'late']}")
