"""fix-s7: revisionNotice off vs on in `pi-ab --day`, paired by day (recap measures) and by task (grades, cost).

python3 -I day-pairs.py RESULTS.json [...]   (one pi-ab results file per seed; conditions X and X+revisionNotice)
Paired bootstrap, 5,000 resamples, seed 1; intervals are 95% percentile intervals of the mean difference (on - off).
"""
import json, random, sys

ON = "+revisionNotice"
days, res, kinds = {}, {}, {}
for f in sys.argv[1:]:
    d = json.load(open(f))
    for t in d["tasks"]:
        kinds[t["id"]] = t["kind"]
    for x in d["days"]:
        days[(x["day"], x["condition"])] = x
    for r in d["results"]:
        res[(r["task"], r["condition"])] = r
bases = sorted({c for (_, c) in days if not c.endswith(ON)})


def boot(diffs):
    random.seed(1)
    n = len(diffs)
    m = sum(diffs) / n
    bs = sorted(sum(random.choice(diffs) for _ in range(n)) / n for _ in range(5000))
    return f"{m:+.3f} ({bs[124]:+.3f}..{bs[4874]:+.3f})"


print("== recap, per day: sums off -> on, and the paired mean difference per day (on - off)")
for b in bases:
    for kind in ["hidden", "control", "neutral"]:
        ids = sorted({d for (d, c) in days if c == b and days[(d, c)]["kind"] == kind and (d, b + ON) in days})
        if not ids:
            continue
        off = [days[(i, b)] for i in ids]
        on = [days[(i, b + ON)] for i in ids]
        line = [f"{b:9s} {kind:8s} days {len(ids):2d}"]
        for k in ["staleRecap", "freshRecap", "updatePackets", "staleDeliveries", "changed"]:
            s0, s1 = sum(x[k] for x in off), sum(x[k] for x in on)
            line.append(f"{k} {s0}->{s1}")
        print("  ".join(line))
        if kind != "neutral":
            for k in ["staleRecap", "freshRecap"]:
                print(f"    {k} per day on-off {boot([y[k] - x[k] for x, y in zip(off, on)])}")

print("\n== graded tasks, paired by task (on - off): rate = any fact raised (hidden: raised; control/neutral: a concern)")
for b in bases:
    for kind in ["hidden", "control", "neutral"]:
        ids = [t for t, k in kinds.items() if k == kind and (t, b) in res and (t, b + ON) in res]
        ids = [t for t in ids if res[(t, b)].get("facts") is not None and res[(t, b + ON)].get("facts") is not None]
        if not ids:
            continue
        rate = lambda r: 1.0 if any(r["facts"].values()) else 0.0
        cost = lambda r: (r["costUsd"] + r["edenCostUsd"]) * 1000
        r0 = sum(rate(res[(t, b)]) for t in ids) / len(ids)
        r1 = sum(rate(res[(t, b + ON)]) for t in ids) / len(ids)
        print(
            f"{b:9s} {kind:8s} n {len(ids)} rate {r0:.3f}->{r1:.3f} diff {boot([rate(res[(t, b + ON)]) - rate(res[(t, b)]) for t in ids])}"
        )
        print(f"    items injected/task diff {boot([res[(t, b + ON)]['injectedItems'] - res[(t, b)]['injectedItems'] for t in ids])}")
        print(f"    $/1k (agent+Eden per task) diff {boot([cost(res[(t, b + ON)]) - cost(res[(t, b)]) for t in ids])}")
