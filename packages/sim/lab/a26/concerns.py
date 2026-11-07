# A26: concerns per arm before and after the Sonnet regrade (regrade.ts --only-concerns output; rule (c) of
# docs/research/a26-reshow.md). usage: python3 -I concerns.py RG.json [RG.json ...]
import json, sys, collections
run, conf = collections.Counter(), collections.Counter()
for f in sys.argv[1:]:
    for g in json.load(open(f))["graded"]:
        run[g["condition"]] += 1
        conf[g["condition"]] += bool(g.get("readable")) and any((g.get("facts") or {}).values())
for c in sorted(run): print(f"{c:18} Haiku concerns {run[c]:3}  Sonnet-confirmed {conf[c]:3}")
