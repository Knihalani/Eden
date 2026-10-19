"""C5-E7 head-to-head report: per-group mean (condition − none), the per-turn utility with dev's real group shares,
and a paired bootstrap 95% CI of verify − eden (turns resampled within each group; 4000 draws, seed 1).

    python3 benchmarks/memory-stream/h2h.py code life [--pool h2h2]
"""
import glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARES = {"code": {"plan": 0.141, "labeler-only": 0.171, "no-need": 0.688},
          "life": {"plan": 0.137, "labeler-only": 0.215, "no-need": 0.648}}


def deltas(subs, runs=()):
    """{group: [(verify − none, eden − none) per turn]}, pooled over the given downstream subs. With `runs`, each
    turn's deltas are averaged over the sub and its repeat runs (`<sub>-<run>`, same turns and conditions)."""
    out = {}
    for sub in subs:
        base = _deltas(sub)
        reps = [_deltas(f"{sub}-{r}") for r in runs]
        for eid, (g, v, e) in base.items():
            vals = [(v, e)] + [(x[eid][1], x[eid][2]) for x in reps if eid in x]
            out.setdefault(g, []).append((sum(a for a, _ in vals) / len(vals), sum(b for _, b in vals) / len(vals)))
    return out


def _deltas(sub):
    """{event: (group, verify − none, eden − none)} for one downstream sub."""
    d = os.path.join(HERE, "downstream", sub)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = {}
    for p in glob.glob(os.path.join(d, "out", "judged-*.json")):
        judged.update({c["event"]: c["scores"] for c in json.load(open(p))["cases"]})
    out = {}
    for eid, k in key.items():
        if eid in judged:
            s = dict(zip(k["order"], judged[eid]))
            out[eid] = (k["group"], s["verify"] - s["none"], s["eden"] - s["none"])
    return out


def report(world, subs, runs=()):
    by = deltas(subs, runs)
    util = {}
    for j, c in enumerate(("verify", "eden")):
        util[c] = round(sum(SHARES[world][g] * sum(x[j] for x in xs) / len(xs) for g, xs in by.items()), 4)
    for g, xs in by.items():
        row = {"n": len(xs)}
        for j, c in enumerate(("verify", "eden")):
            row[c] = round(sum(x[j] for x in xs) / len(xs), 3)
            row[c + " better/worse"] = (sum(x[j] > 0 for x in xs), sum(x[j] < 0 for x in xs))
        print(world, g, row)
    rng = random.Random(1)
    draws = []
    for _ in range(4000):
        u = 0.0
        for g, xs in by.items():
            sample = [rng.choice(xs) for _ in xs]
            u += SHARES[world][g] * sum(a - b for a, b in sample) / len(sample)
        draws.append(u)
    draws.sort()
    print(world, "utility per turn:", util, "verify − eden:", round(util["verify"] - util["eden"], 4),
          "95% CI:", (round(draws[100], 4), round(draws[3899], 4)))


if __name__ == "__main__":
    # h2h.py code life                 → C5-E7 alone
    # h2h.py code life --pool h2h2     → C5-E7 pooled with downstream/<world>-h2h2 (C6-E1)
    # h2h.py code --pool h2h2 --runs r2 → each turn averaged over its first run and the repeat run (C6-E2)
    args = sys.argv[1:]
    runs = args[args.index("--runs") + 1:] if "--runs" in args else []
    args = args[:args.index("--runs")] if "--runs" in args else args
    extra = args[args.index("--pool") + 1:] if "--pool" in args else []
    worlds = args[:args.index("--pool")] if "--pool" in args else args
    for w in worlds:
        report(w, [f"{w}-h2h"] + [f"{w}-{x}" for x in extra], runs)
