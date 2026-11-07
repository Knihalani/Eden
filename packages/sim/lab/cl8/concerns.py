# CL8: control and neutral concerns per horizon and arm: what the run's Haiku grader flagged, and how many a second
# Haiku pass (`regrade.ts --only-concerns`) kept. usage: python3 -I concerns.py regrade-*.json
import json, sys, collections

c = collections.Counter()
arms = []
for f in sys.argv[1:]:
    d = json.load(open(f))
    hz = "short" if "short" in f.rsplit("/", 1)[-1] else "long"
    for g in d["graded"]:
        kind = "control" if "-control:" in g["task"] else "neutral"
        if g["condition"] not in arms:
            arms.append(g["condition"])
        c[(hz, g["condition"], kind, "run")] += 1
        c[(hz, g["condition"], kind, "kept")] += any(g["facts"].values())
for hz in ("short", "long"):
    for arm in sorted(arms):
        print(hz, f"{arm:10s}", " ".join(f"{k} {c[(hz, arm, k, 'run')]} -> {c[(hz, arm, k, 'kept')]}" for k in ("control", "neutral")))
