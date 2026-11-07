# Sonnet's verdict against the run's Haiku verdict per condition and kind (any fact true), from regrade.ts's --out
# file and the pi-ab results it regraded: python3 -I regrade-by-condition.py regrade-41.json s3b-ask-41.json
import collections, json, sys
d = json.load(open(sys.argv[1])); run = json.load(open(sys.argv[2]))
K = {t["id"]: t["kind"] for t in run["tasks"]}
R = {(r["task"], r["condition"]): r.get("facts") for r in run["results"]}
c = collections.Counter()
for g in d["graded"]:
    if not g.get("facts"): continue
    a = any(g["facts"].values()); b = any((R[(g["task"], g["condition"])] or {}).values())
    k = (g["condition"], K[g["task"]])
    c[k + ("n",)] += 1; c[k + ("sonnet",)] += a; c[k + ("haiku",)] += b; c[k + ("diff",)] += a != b
for cond in ["tools", "eden", "both", "both+ask"]:
    for kind in ["hidden", "control", "neutral"]:
        print(f"{cond:9s} {kind:8s} n={c[(cond,kind,'n')]} haiku {c[(cond,kind,'haiku')]} sonnet {c[(cond,kind,'sonnet')]} differ {c[(cond,kind,'diff')]}")
