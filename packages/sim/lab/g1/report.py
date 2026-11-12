"""G1 (D1400, D1401): the pair's report. Read-only over a g1/go.sh run directory.

    python3 -I packages/sim/lab/g1/report.py RUN_DIR ARM [ARM ...] [--seeds 41,42]

RUN_DIR holds <arm>-<seed>.json and <arm>-<seed>.tl/tasks.jsonl (pi-ab, single-shot, served by subagents). Per arm:
hidden raised, control and neutral concerns (the in-run Sonnet grade), the planted item handed (in a push pool's
handed list) and reached (handed, or cited by the push or an ask), tasks with a packet, push checks called. Each
later arm against the first, paired by task, with a 95% bootstrap over templates (all of a template's seeds
together; 4,000 resamples, seed 7). Only tasks graded in both arms are paired. The field reading is
packages/sim/lab/final/report.py's.
"""

import collections
import json
import os
import random
import sys


def ids(x):
    if isinstance(x, str):
        try:
            x = json.loads(x)
        except ValueError:
            return []
    return [c.get("itemId", c) if isinstance(c, dict) else c for c in (x or [])]


def load(run, arm, seeds):
    rows = {}
    for seed in seeds:
        f = os.path.join(run, f"{arm}-{seed}.json")
        if not os.path.exists(f):
            continue
        tl = {}
        tf = os.path.join(run, f"{arm}-{seed}.tl", "tasks.jsonl")
        if os.path.exists(tf):
            for line in open(tf):
                t = json.loads(line)
                tl[t["task"]] = t
        for r in json.load(open(f))["results"]:
            task = r["task"]
            w, suite, tmpl = task.split(":")[:3]
            base, _, kind = suite.partition("-")
            t = tl.get(task, {})
            planted = t.get("planted")
            pools = t.get("pushPools") or []
            cited = set(ids(t.get("cited")))
            asked = set(ids(t.get("askCited")))
            rows[task] = dict(
                key=f"{base}:{tmpl}",
                kind=kind or "hidden",
                graded=not r.get("error") and r.get("facts") is not None,
                flag=any((r.get("facts") or {}).values()),
                handed=bool(planted) and any(planted in p.get("handed", []) for p in pools),
                reached=bool(planted) and (planted in cited or planted in asked),
                pooled=bool(planted) and any(planted in p.get("pool", []) for p in pools),
                packet=len(cited) > 0,
                checks=sum(1 for p in pools if p.get("checkCalled")),
                pushed=len(pools) > 0,
            )
    return rows


def boot(pairs):
    """pairs: (template key, difference). Mean difference in points and its 95% interval over templates."""
    by = collections.defaultdict(list)
    for k, d in pairs:
        by[k].append(d)
    keys = sorted(by)
    n = sum(len(v) for v in by.values())
    if not n:
        return 0.0, 0.0, 0.0
    mean = 100 * sum(sum(v) for v in by.values()) / n
    rng = random.Random(7)
    outs = []
    for _ in range(4000):
        pick = [by[rng.choice(keys)] for _ in keys]
        m = sum(len(v) for v in pick)
        outs.append(100 * sum(sum(v) for v in pick) / m)
    outs.sort()
    return mean, outs[100], outs[3899]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    seeds = "41,42,43,44"
    if "--seeds" in sys.argv:
        seeds = sys.argv[sys.argv.index("--seeds") + 1]
        args = [a for a in args if a != seeds]
    run, arms = args[0], args[1:]
    data = {a: load(run, a, seeds.split(",")) for a in arms}
    cols = ["flag", "handed", "reached", "pooled", "packet", "pushed"]
    print(f"== per arm (seeds {seeds}; served by subagents, single-shot)")
    for a in arms:
        for kind in ["hidden", "control", "neutral"]:
            rs = [r for r in data[a].values() if r["kind"] == kind and r["graded"]]
            n = len(rs)
            if not n:
                continue
            parts = " ".join(f"{c} {sum(r[c] for r in rs)}" for c in cols)
            print(f"{a:7} {kind:8} n {n:4} {parts} checks {sum(r['checks'] for r in rs)}")
    base = arms[0]
    for a in arms[1:]:
        print(f"== {a} - {base} (paired, points; 95% interval over templates)")
        for kind, col, label in [
            ("hidden", "flag", "hidden raised"),
            ("hidden", "handed", "fact handed by the push"),
            ("hidden", "reached", "fact reached the agent"),
            ("control", "handed", "look-alike handed by the push"),
            ("control", "reached", "look-alike reached the agent"),
            ("control", "flag", "control concerns"),
            ("neutral", "flag", "neutral concerns"),
            ("neutral", "packet", "neutral tasks with a packet"),
        ]:
            pairs = []
            for task, r in data[a].items():
                b = data[base].get(task)
                if b and r["kind"] == kind and r["graded"] and b["graded"]:
                    pairs.append((r["key"], int(r[col]) - int(b[col])))
            m, lo, hi = boot(pairs)
            print(f"  {label:32} n {len(pairs):4} {m:+6.1f} ({lo:+.1f}..{hi:+.1f})")
        for kind in ["hidden", "control", "neutral"]:
            ca = sum(r["checks"] for t, r in data[a].items() if r["kind"] == kind and t in data[base])
            cb = sum(r["checks"] for t, r in data[base].items() if r["kind"] == kind and t in data[a])
            print(f"  checks called, {kind:8} {cb} -> {ca}")


main()
