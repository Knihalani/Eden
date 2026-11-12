"""F7: wall p50 a task on the 1:1:8 mix, an arm against the base, with a template-clustered bootstrap.

    python3 -I wall.py --base both+ask --arms 'both+ask~V,…' OUT.json [OUT.json ...]

The mix's p50 is the weighted median of the tasks' wall seconds, each task weighted so its kind carries its share
(0.1 hidden, 0.1 control, 0.8 neutral) whatever the kind's count. Only tasks both arms finished are read. The
interval resamples whole templates (suite and type) with the same draw for both arms: 95%, 5,000 draws.
"""
import argparse
import json
import random

W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}


def wmedian(pairs):
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= total / 2:
            return v
    return pairs[-1][0] if pairs else 0.0


def p50(rows, arm):
    n = {k: sum(1 for r in rows if r["kind"] == k) for k in W}
    return wmedian([(r[arm], W[r["kind"]] / n[r["kind"]]) for r in rows if n[r["kind"]]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--arms", required=True)
    ap.add_argument("--draws", type=int, default=5000)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    arms = a.arms.split(",")
    by = {}
    for f in a.files:
        j = json.load(open(f))
        seed = j["seeds"][0] if j.get("seeds") else 0
        tasks = {t["id"]: t for t in j["tasks"]}
        for r in j["results"]:
            t = tasks.get(r["task"])
            if not t or t["kind"] not in W or "wallMs" not in r:
                continue
            row = by.setdefault((f, seed, r["task"]), {"kind": t["kind"], "template": f"{t['suite']}/{t['type']}"})
            row[r["condition"]] = r["wallMs"] / 1000
    for arm in arms:
        rows = [r for r in by.values() if a.base in r and arm in r]
        clusters = {}
        for r in rows:
            clusters.setdefault(r["template"], []).append(r)
        keys = list(clusters)
        est = p50(rows, arm) - p50(rows, a.base)
        rnd = random.Random(7)
        diffs = []
        for _ in range(a.draws):
            draw = [r for k in (rnd.choice(keys) for _ in keys) for r in clusters[k]]
            diffs.append(p50(draw, arm) - p50(draw, a.base))
        diffs.sort()
        lo, hi = diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs)) - 1]
        print(
            f"{arm}: wall p50 on the mix {p50(rows, a.base):.3f} -> {p50(rows, arm):.3f} s, "
            f"{est:+.3f} ({lo:+.3f}..{hi:+.3f}); {len(rows)} tasks, {len(keys)} templates"
        )


main()
