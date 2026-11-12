"""F3 (D1125): the subagent-simulated pilot's readout. Lab tooling; sim data only.

    python3 -I packages/sim/lab/f3/pilot-report.py .local/f3/pilot/graded.jsonl [A:B …]   # default CH:base CW:CH CW:base

Per arm: hidden facts raised on the silent-edit hidden tasks, concerns on control and neutral. Pairs (CH − base,
CW − CH): the difference on the tasks both arms graded, with a 95% interval from 5,000 bootstrap draws (seed 1), tasks
resampled within clusters of suite and template (a template's seeds and variants move together).
"""
import collections
import json
import random
import sys

# `--same-zero` (D1128): a task whose arms got the same prompt was answered for neither (its difference is exactly 0).
SAME_ZERO = "--same-zero" in sys.argv
args = [a for a in sys.argv[1:] if a != "--same-zero"]
rows = [json.loads(line) for line in open(args[0])]
by = collections.defaultdict(dict)
for r in rows:
    if r["raised"] is None and not SAME_ZERO:
        continue
    by[(r["suite"], r["seed"], r["variant"], r["template"])][r["arm"]] = r


def boot(pairs):
    clusters = collections.defaultdict(list)
    for key, d in pairs:
        clusters[f"{key[0]}:{key[3]}"].append(d)
    keys = sorted(clusters)
    rng = random.Random(1)
    est = sum(d for _, d in pairs) / len(pairs)
    draws = []
    for _ in range(5000):
        pick = [d for k in (rng.choice(keys) for _ in keys) for d in clusters[k]]
        draws.append(sum(pick) / len(pick))
    draws.sort()
    return est, draws[124], draws[4874]


ARMS = sorted({r["arm"] for r in rows}, key=lambda a: (a != "base", a))
PAIRS = [tuple(p.split(":")) for p in args[1:]] or [("CH", "base"), ("CW", "CH"), ("CW", "base")]
for arm in ARMS:
    out = []
    for kind in ("hidden", "control", "neutral"):
        xs = [d[arm] for k, d in by.items() if k[2] == kind and arm in d]
        handed = [r for r in xs if r["handed"]] if kind == "hidden" else []
        out.append(f"{kind} {sum(bool(r['raised']) for r in xs)}/{len(xs)} (graded {sum(r['raised'] is not None for r in xs)})")
        if kind == "hidden":
            out.append(f"(fact handed: {sum(bool(r['raised']) for r in handed)}/{len(handed)})")
    chars = sum(d[arm]["chars"] for d in by.values() if arm in d)
    lines = sum(d[arm]["changeLines"] for d in by.values() if arm in d)
    print(f"{arm:5s} " + "  ".join(out) + f"  packet chars {chars}  change lines {lines}")

for a, b in PAIRS:
    for kind in ("hidden", "control+neutral"):
        kinds = ("hidden",) if kind == "hidden" else ("control", "neutral")
        pairs = [
            (k, 0.0 if d[a]["prompt"] == d[b]["prompt"] else float(d[a]["raised"]) - float(d[b]["raised"]))
            for k, d in by.items()
            if k[2] in kinds and a in d and b in d and (d[a]["prompt"] == d[b]["prompt"] or d[a]["raised"] is not None and d[b]["raised"] is not None)
        ]
        if not pairs:
            continue
        gained = sum(1 for _, x in pairs if x > 0)
        lost = sum(1 for _, x in pairs if x < 0)
        e, lo, hi = boot(pairs)
        print(f"{a} - {b} {kind:16s} n={len(pairs):3d} {100 * e:+6.1f} pts ({100 * lo:+.1f}..{100 * hi:+.1f})  +{gained} -{lost}")
