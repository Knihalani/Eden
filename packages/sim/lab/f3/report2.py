"""F3 (D1124): the pre-registered readout of the dev20 silent-edit run, one pair of arms at a time. Lab tooling.

    python3 -I packages/sim/lab/f3/report2.py both~CH+ask both+ask .local/f3/runs2/*.json   # primary (D1123)
    python3 -I packages/sim/lab/f3/report2.py both~CW+ask both~CH+ask .local/f3/runs2/*.json  # secondary (D1122)

Every hidden task of the run is a silent-edit template (go2.sh runs only DEV20X_SILENT), so the primary is every hidden
task. The rest is report.py's (D1120).

Each results file holds both arms (`both+ask`, `both~WHY+ask`) paired task by task. Prints, WHY minus base on the
tasks both arms finished: hidden facts raised on the primary tasks (sets.json, the 50 hidden tasks where the $0 funnel
notes the planted fact) and on every hidden task; concerns on control and neutral tasks (the run's Sonnet grader:
read them with b19/concerns.py before calling one confirmed); packet characters a task. 95% intervals from 5,000
bootstrap draws (seed 1), tasks resampled within clusters of suite and template (a template's variants and seeds move
together; a reworded suite clusters with its base, since it is the same template).
"""
import collections
import json
import random
import sys

WHY, BASE = sys.argv[1], sys.argv[2]
DRAWS = 5000


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
        out.append(
            {
                "kind": t["kind"],
                "primary": t["kind"] == "hidden",
                "cluster": f"{suite}:{t.get('type', '')}",
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
    rs = [r for p in sys.argv[3:] for r in rows(p)]
    hidden = [r for r in rs if r["kind"] == "hidden"]
    prim = [r for r in hidden if r["primary"]]
    concerns = [r for r in rs if r["kind"] in ("control", "neutral")]
    for name, sub in (("primary", prim), ("hidden", hidden), ("control+neutral", concerns)):
        b = sum(r["b"] for r in sub)
        w = sum(r["w"] for r in sub)
        print(f"{name:16s} {BASE} {b:.0f}/{len(sub)}  {WHY} {w:.0f}/{len(sub)}")
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
