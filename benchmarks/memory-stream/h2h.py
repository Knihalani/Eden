"""C5-E7 head-to-head report: per-group mean (condition − none), the per-turn utility with dev's real group shares,
and a paired bootstrap 95% CI of verify − eden (turns resampled within each group; 4000 draws, seed 1).

    python3 benchmarks/memory-stream/h2h.py code life [--pool h2h2]
"""
import glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARES = {"code": {"plan": 0.141, "labeler-only": 0.171, "no-need": 0.688},
          "life": {"plan": 0.137, "labeler-only": 0.215, "no-need": 0.648}}


def _judged(d):
    judged = {}
    for p in glob.glob(os.path.join(d, "out", "judged-*.json")):
        judged.update({c["event"]: c["scores"] for c in json.load(open(p))["cases"]})
    return judged


def _ci(by, world, value):
    """Stratified bootstrap 95% CI of Σ share × mean(value(x)) (4000 draws, seed 1)."""
    rng = random.Random(1)
    draws = sorted(sum(SHARES[world][g] * sum(value(rng.choice(xs)) for _ in xs) / len(xs) for g, xs in by.items())
                   for _ in range(4000))
    return round(draws[100], 4), round(draws[3899], 4)


def deltas(subs, runs=()):
    """{group: [(verify − none, eden − none) per turn]}, pooled over the given downstream subs. With `runs`, each
    turn's deltas are averaged over the sub and its repeat runs (`<sub>-<run>`, same turns and conditions)."""
    out = {}
    for sub in subs:
        base = _deltas(sub)
        reps = [_deltas(f"{sub}-{r}") for r in runs]
        for eid, (g, v, e) in base.items():
            missing = [r for r, x in zip(runs, reps) if eid not in x]
            assert not missing, f"{eid} missing from repeat run(s) {missing} of {sub}"
            vals = [(v, e)] + [(x[eid][1], x[eid][2]) for x in reps]
            out.setdefault(g, []).append((sum(a for a, _ in vals) / len(vals), sum(b for _, b in vals) / len(vals)))
    return out


def _deltas(sub):
    """{event: (group, verify − none, eden − none)} for one downstream sub."""
    d = os.path.join(HERE, "downstream", sub)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = _judged(d)
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
    ci = _ci(by, world, lambda x: x[0] - x[1])
    print(world, "utility per turn:", util, "verify − eden:", round(util["verify"] - util["eden"], 4),
          "95% CI:", ci)


def single(world, sub, cond="system"):
    """One condition vs none (e.g. C6-E3's dated hook vote): per-group means, per-turn utility, bootstrap 95% CI."""
    d = os.path.join(HERE, "downstream", sub)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = _judged(d)
    by = {}
    for eid, k in key.items():
        if eid in judged:
            s = dict(zip(k["order"], judged[eid]))
            by.setdefault(k["group"], []).append(s[cond] - s["none"])
    for g, xs in by.items():
        print(world, g, {"n": len(xs), cond: round(sum(xs) / len(xs), 3),
                         "better/worse": (sum(x > 0 for x in xs), sum(x < 0 for x in xs))})
    util = sum(SHARES[world][g] * sum(xs) / len(xs) for g, xs in by.items())
    ci = _ci(by, world, lambda x: x)
    print(world, f"{cond} − none utility per turn:", round(util, 4), "95% CI:", ci,
          f"({len([e for e in key if e in judged])} of {len(key)} judged)")


def four(world, sub):
    """C10-E3: none / eden / verify / jev on one sub: each condition − none per group and per turn (dev shares), and
    bootstrap 95% CIs of jev − eden and jev − verify."""
    d = os.path.join(HERE, "downstream", sub)
    key = json.load(open(os.path.join(d, "key.json")))["key"]
    judged = _judged(d)
    by = {}
    for eid, k in key.items():
        if eid in judged:
            sc = dict(zip(k["order"], judged[eid]))
            by.setdefault(k["group"], []).append({c: sc[c] - sc["none"] for c in ("eden", "verify", "jev")})
    for g, xs in by.items():
        print(world, g, {"n": len(xs), **{c: round(sum(x[c] for x in xs) / len(xs), 3) for c in ("eden", "verify",
                                                                                                    "jev")}})
    util = {c: round(sum(SHARES[world][g] * sum(x[c] for x in xs) / len(xs) for g, xs in by.items()), 4)
            for c in ("eden", "verify", "jev")}
    print(world, "utility per turn:", util, f"({sum(len(x) for x in by.values())} of {len(key)} judged)")
    for other in ("eden", "verify"):
        print(world, f"jev − {other}:", round(util["jev"] - util[other], 4), "95% CI:",
              _ci(by, world, lambda x, o=other: x["jev"] - x[o]))


if __name__ == "__main__":
    # h2h.py code life                 → C5-E7 alone
    # h2h.py code life --pool h2h2     → C5-E7 pooled with downstream/<world>-h2h2 (C6-E1)
    # h2h.py code --pool h2h2 --runs r2 → each turn averaged over its first run and the repeat run (C6-E2)
    # h2h.py --single code code-vote-dated → one condition vs none (C6-E3)
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("worlds", nargs="*")
    ap.add_argument("--pool", nargs="*", default=[], help="extra downstream subs per world, e.g. h2h2")
    ap.add_argument("--runs", nargs="*", default=[], help="repeat runs to average per turn, e.g. r2")
    ap.add_argument("--single", nargs=2, metavar=("WORLD", "SUB"), help="one condition vs none")
    ap.add_argument("--four", nargs=2, metavar=("WORLD", "SUB"), help="C10-E3: none / eden / verify / jev")
    a = ap.parse_args()
    if a.single:
        single(*a.single)
    if a.four:
        four(*a.four)
    for w in a.worlds:
        report(w, [f"{w}-h2h"] + [f"{w}-{x}" for x in a.pool], a.runs)
