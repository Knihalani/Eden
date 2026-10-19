"""C5-E7 head-to-head report: per-group mean (condition − none), the per-turn utility with dev's real group shares,
and a paired bootstrap 95% CI of verify − eden (turns resampled within each group; 4000 draws, seed 1).

    python3 benchmarks/memory-stream/h2h.py code life [--pool h2h2]
"""
import glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARES = {"code": {"plan": 0.141, "labeler-only": 0.171, "no-need": 0.688},
          "life": {"plan": 0.137, "labeler-only": 0.215, "no-need": 0.648}}


def deltas(subs):
    """{group: [(verify − none, eden − none) per turn]}, pooled over the given downstream subs."""
    out = {}
    for sub in subs:
        for g, xs in _deltas(sub).items():
            out.setdefault(g, []).extend(xs)
    return out


def _deltas(sub):
    d = os.path.join(HERE, "downstream", sub)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = {}
    for p in glob.glob(os.path.join(d, "out", "judged-*.json")):
        judged.update({c["event"]: c["scores"] for c in json.load(open(p))["cases"]})
    out = {}
    for eid, k in key.items():
        if eid in judged:
            s = dict(zip(k["order"], judged[eid]))
            out.setdefault(k["group"], []).append((s["verify"] - s["none"], s["eden"] - s["none"]))
    return out


def report(world, subs):
    by = deltas(subs)
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
    args = sys.argv[1:]
    extra = args[args.index("--pool") + 1:] if "--pool" in args else []
    worlds = args[:args.index("--pool")] if "--pool" in args else args
    for w in worlds:
        report(w, [f"{w}-h2h"] + [f"{w}-{x}" for x in extra])
