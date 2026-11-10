"""N3 (H2): a copy of a `--late` results file for regrade.ts, each late-planted request's `answer` set to its later
replies (`lateText`) and its `facts` to their grade (`lateFacts`), every other result dropped, so `regrade.ts
--only-concerns` regrades exactly the control replies Haiku called alarms (A9's method). usage: late-copy.py IN OUT"""
import json, sys

d = json.load(open(sys.argv[1]))
out = []
for r in d["results"]:
    if r.get("lateFacts") is None:
        continue
    out.append({**r, "answer": r.get("lateText", ""), "facts": r["lateFacts"]})
d["results"] = out
json.dump(d, open(sys.argv[2], "w"))
print(f"{len(out)} late results -> {sys.argv[2]}")
