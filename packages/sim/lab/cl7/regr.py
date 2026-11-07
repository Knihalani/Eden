# Concerns (control, neutral) per arm: the run's Haiku grader, and how many Sonnet's regrade kept.
import json, sys, collections
c = collections.Counter()
for f in sys.argv[1:]:
    d = json.load(open(f))
    run = f.split("regrade-")[1].rsplit(".", 1)[0]
    for g in d["graded"]:
        kind = "control" if "-control:" in g["task"] or ":control" in g["task"] else "neutral" if "-neutral" in g["task"] else "?"
        c[(run[:-3], g["condition"], kind, "haiku")] += 1
        c[(run[:-3], g["condition"], kind, "sonnet")] += any(g["facts"].values())
for k in sorted(c): print(*k, c[k])
