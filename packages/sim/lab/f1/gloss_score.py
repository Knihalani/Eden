"""F1: the requestGloss pair through the subagent queue (rule in 67a019b6). Usage: gloss_score.py BASE.json GLOSS.json
Hidden facts and look-alikes delivered (row `delivered`), paired by suite/seed/template, with a template-clustered
bootstrap 95% interval on the hidden difference; neutral tasks with any delivery from the funnel's NEUTRAL totals."""
import json, random, sys
from collections import defaultdict

B, G = (json.load(open(f)) for f in sys.argv[1:3])
key = lambda r: (r["suite"], r["seed"], r["variant"], r["template"])
b = {key(r): r for r in B["perTask"]}
g = {key(r): r for r in G["perTask"]}
out = {}
for v in ("hidden", "control"):
    ks = [k for k in b if k[2] == v and k in g]
    db = sum(b[k]["delivered"] for k in ks)
    dg = sum(g[k]["delivered"] for k in ks)
    up = sum(g[k]["delivered"] and not b[k]["delivered"] for k in ks)
    down = sum(b[k]["delivered"] and not g[k]["delivered"] for k in ks)
    out[v] = dict(n=len(ks), base=db, gloss=dg, up=up, down=down)
    if v == "hidden":
        by = defaultdict(list)
        for k in ks:
            by[k[3]].append(int(g[k]["delivered"]) - int(b[k]["delivered"]))
        t = list(by)
        rnd = random.Random(1)
        sims = []
        for _ in range(10000):
            s = [rnd.choice(t) for _ in t]
            d = [x for tt in s for x in by[tt]]
            sims.append(100 * sum(d) / len(d))
        sims.sort()
        out[v]["diff_pts"] = 100 * (dg - db) / len(ks)
        out[v]["ci95"] = (sims[250], sims[9750])
nb, ng = B["neutral"]["total"], G["neutral"]["total"]
out["neutral"] = dict(n=nb["n"], base=nb["anyDelivered"], gloss=ng["anyDelivered"],
                      diff_pts=100 * (ng["anyDelivered"] - nb["anyDelivered"]) / nb["n"])
for k, v in out.items():
    print(k, json.dumps(v))
h, c, n = out["hidden"], out["control"], out["neutral"]
ok = h["ci95"][0] > 0 and (c["gloss"] - c["base"]) <= (h["gloss"] - h["base"]) and n["diff_pts"] <= 2
print("RULE:", "PASS" if ok else "FAIL",
      f"(hidden lower bound {h['ci95'][0]:+.1f} > 0; look-alikes {c['gloss'] - c['base']:+d} <= facts "
      f"{h['gloss'] - h['base']:+d}; neutral {n['diff_pts']:+.1f} <= +2)")
for a, d in (("base", B), ("gloss", G)):
    print(a, "check:", json.dumps(d.get("check"))[:300])
