"""A22 (D360): hidden raised with Sonnet's regrade of every Haiku miss (`regrade.sh STEM miss-STEM --only-misses`):
an answer Haiku called a miss takes Sonnet's verdict; Haiku's "raised" stand (A12 found Sonnet agreed with 172 of
180). Paired ARM − BASE by task, pooled over runs, bootstrap 95% (5,000 draws, seed 1).
usage: python3 -I hidden.py ARM BASE STEM [STEM ...]   (STEM.json and DIR/miss-NAME.json)"""
import json, os, random, sys

arm, base, stems = sys.argv[1], sys.argv[2], sys.argv[3:]
per, rates = [], {arm: [], base: []}
for stem in stems:
    d = json.load(open(stem + ".json"))
    kinds = {t["id"]: t["kind"] for t in d["tasks"]}
    flag = {(r["task"], r["condition"]): float(any(r["facts"].values())) for r in d["results"] if r.get("facts")}
    rg = os.path.join(os.path.dirname(stem), "miss-" + os.path.basename(stem) + ".json")
    for g in json.load(open(rg))["graded"]:
        flag[(g["task"], g["condition"])] = float(any(g["facts"].values()))
    v = []
    for t, k in kinds.items():
        if k == "hidden" and (t, arm) in flag and (t, base) in flag:
            v.append(flag[(t, arm)] - flag[(t, base)])
            rates[arm].append(flag[(t, arm)])
            rates[base].append(flag[(t, base)])
    per.append(v)
n = sum(map(len, per))
rng = random.Random(1)
draws = sorted(sum(sum(rng.choice(v) for _ in v) for v in per) / n for _ in range(5000))
for c, r in rates.items():
    print(f"{c:16s} n {len(r)}  Sonnet-corrected hidden raised {sum(r)/len(r):.3f}")
mean = sum(map(sum, per)) / n
print(f"{arm} − {base}: {100*mean:+.1f} points ({100*draws[125]:+.1f}..{100*draws[4874]:+.1f}), n {n}")
