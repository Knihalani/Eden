"""F3 (D1120): the pre-registered readout of the `packetWhy` Pi pair. Lab tooling; sim data only.

    python3 -I packages/sim/lab/f3/report.py .local/f3/runs/*.json

Each results file holds both arms (`both+ask`, `both~WHY+ask`) paired task by task. Prints, WHY minus base on the
tasks both arms finished: hidden facts raised on the primary tasks (sets.json, the 50 hidden tasks where the $0 funnel
notes the planted fact) and on every hidden task; concerns on control and neutral tasks (the run's Sonnet grader:
read them with b19/concerns.py before calling one confirmed); packet characters a task. 95% intervals from 5,000
bootstrap draws (seed 1), tasks resampled within clusters of suite and template (a template's variants and seeds move
together; a reworded suite clusters with its base, since it is the same template).
"""
import collections
import json
import os
import random
import sys

BASE, WHY = "both+ask", "both~WHY+ask"
DRAWS = 5000
HERE = os.path.dirname(os.path.abspath(__file__))
SETS = json.load(open(os.path.join(HERE, "sets.json")))
PRIMARY = {(s, int(seed), t) for s, seed, t in SETS["primary"]}


def base_suite(suite):
    for tail in ("-control", "-neutral"):
        if suite.endswith(tail):
            suite = suite[: -len(tail)]
    return suite


def rows(path):
    res = json.load(open(path))
    tasks = {t["id"]: t for t in res["tasks"]}
    by = collections.defaultdict(dict)
    for r in res["results"]:
        t = tasks.get(r["task"])
        if not t or r.get("error") or r.get("facts") is None:
            continue
        by[r["task"]][r["condition"]] = r
    out = []
    for tid, arms in by.items():
        if BASE not in arms or WHY not in arms:
            continue
        t = tasks[tid]
        suite = base_suite(t.get("suite", ""))
        # The seed is the world's, in the task id ("w41:train2:template").
        seed = int(t["seed"]) if "seed" in t else int(tid.split(":", 1)[0].lstrip("w"))
        key = (suite, seed, t.get("type", ""))
        out.append(
            {
                "kind": t["kind"],
                "primary": t["kind"] == "hidden" and key in PRIMARY,
                "cluster": f"{suite.rstrip('r')}:{t.get('type', '')}",
                "b": 1.0 if any(arms[BASE]["facts"].values()) else 0.0,
                "w": 1.0 if any(arms[WHY]["facts"].values()) else 0.0,
                "bChars": float(arms[BASE].get("injectedChars", 0)),
                "wChars": float(arms[WHY].get("injectedChars", 0)),
                "bUsd": arms[BASE].get("costUsd", 0.0),
                "wUsd": arms[WHY].get("costUsd", 0.0),
            }
        )
    return out


def boot(rs, f):
    """The mean of f over rows, and its 95% interval, rows resampled by cluster."""
    clusters = collections.defaultdict(list)
    for r in rs:
        clusters[r["cluster"]].append(r)
    keys = sorted(clusters)
    rng = random.Random(1)
    est = sum(f(r) for r in rs) / len(rs)
    draws = []
    for _ in range(DRAWS):
        pick = [r for k in (rng.choice(keys) for _ in keys) for r in clusters[k]]
        draws.append(sum(f(r) for r in pick) / len(pick))
    draws.sort()
    return est, draws[int(0.025 * DRAWS)], draws[int(0.975 * DRAWS) - 1]


def line(name, rs, f, scale=100.0):
    if not rs:
        print(f"{name:34s} n=0")
        return
    e, lo, hi = boot(rs, f)
    print(f"{name:34s} n={len(rs):4d}  {scale * e:+7.2f}  ({scale * lo:+.2f}..{scale * hi:+.2f})")


def main():
    rs = [r for p in sys.argv[1:] for r in rows(p)]
    hidden = [r for r in rs if r["kind"] == "hidden"]
    prim = [r for r in hidden if r["primary"]]
    concerns = [r for r in rs if r["kind"] in ("control", "neutral")]
    for name, sub in (("primary", prim), ("hidden", hidden), ("control+neutral", concerns)):
        b = sum(r["b"] for r in sub)
        w = sum(r["w"] for r in sub)
        print(f"{name:16s} base {b:.0f}/{len(sub)}  why {w:.0f}/{len(sub)}")
    line("primary hidden raised (pts)", prim, lambda r: r["w"] - r["b"])
    line("all hidden raised (pts)", hidden, lambda r: r["w"] - r["b"])
    line("control+neutral concerns (pts)", concerns, lambda r: r["w"] - r["b"])
    for k in ("control", "neutral"):
        line(f"{k} concerns (pts)", [r for r in rs if r["kind"] == k], lambda r: r["w"] - r["b"])
    bc = sum(r["bChars"] for r in rs)
    wc = sum(r["wChars"] for r in rs)
    print(f"packet chars: base {bc:.0f}, why {wc:.0f}, {100 * (wc / bc - 1) if bc else 0:+.2f}%")
    print(f"agent $: base {sum(r['bUsd'] for r in rs):.4f}, why {sum(r['wUsd'] for r in rs):.4f}")


main()
