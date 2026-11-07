# A12 (docs/research/a12-quality.md): where askNudge (D316) fires in a funnel run, by kind.
# usage: python3 -I nudge-screen.py NUDGE.json BASE.json
import json, sys
from collections import Counter
nud, base = (json.load(open(f)) for f in sys.argv[1:3])
key = lambda r: (r["suite"], r["template"], r["variant"], r["seed"])
b = {key(r): r for r in base["perTask"]}

c = Counter()
for r in nud["perTask"]:
    v = r["variant"]
    c[v, "n"] += 1
    if "pushUnsettled" in r:
        c[v, "packet"] += 1
        if r["pushUnsettled"]:
            c[v, "nudged"] += 1
            c[v, "nudged+handed"] += bool(r.get("pushHanded"))
            c[v, "nudged+inpool6+"] += r.get("pushPoolAt", -1) >= 5
            c[v, "nudged+askCited"] += bool(r.get("askCited"))
            c[v, "nudged+askCited base"] += bool(b[key(r)].get("askCited"))
        else:
            c[v, "settled+handed"] += bool(r.get("pushHanded"))
    c[v, "askBytes"] += r.get("askBytes", 0)
    c[v, "askBytes base"] += b[key(r)].get("askBytes", 0)
    c[v, "askItems"] += r.get("askItems", 0)
    c[v, "askItems base"] += b[key(r)].get("askItems", 0)
for v in sorted({k[0] for k in c}):
    print(v, {k[1]: c[k] for k in c if k[0] == v})
