# CL8 (docs/research/cl-cl8.md): ARM against BASE, paired by task and pooled over pi-ab runs: hidden raised, and control
# + neutral concerns as graded and as regraded (`regrade.ts --only-concerns`: a regraded answer takes the regrade's
# verdict, the rest keep the run's). Bootstrap 95% (5,000 draws, seed 1; each run's tasks resampled on their own).
# usage: python3 -I pooled.py ARM BASE STEM [STEM ...]   (STEM.json; STEM's regrade at DIR/regrade-NAME.json, NAME =
# STEM's file name without the "cl8-" prefix, read when present)
import json, os, random, sys

arm, base, stems = sys.argv[1], sys.argv[2], sys.argv[3:]


def boot(per):
    n = sum(len(v) for v in per)
    mean = sum(sum(v) for v in per) / n
    rng = random.Random(1)
    draws = []
    for _ in range(5000):
        s = 0.0
        for v in per:
            s += sum(rng.choice(v) for _ in v)
        draws.append(s / n)
    draws.sort()
    return n, mean, draws[125], draws[4874]


hidden, graded, regraded = [], [], []
for stem in stems:
    d = json.load(open(stem + ".json"))
    kinds = {t["id"]: t["kind"] for t in d["tasks"]}
    flag = {(r["task"], r["condition"]): float(any(r["facts"].values())) for r in d["results"] if r.get("facts")}
    again = dict(flag)
    rg = os.path.join(os.path.dirname(stem), "regrade-" + os.path.basename(stem).removeprefix("cl8-") + ".json")
    if os.path.exists(rg):
        for g in json.load(open(rg))["graded"]:
            again[(g["task"], g["condition"])] = float(any(g["facts"].values()))
    h, c, c2 = [], [], []
    for t, k in kinds.items():
        if (t, arm) not in flag or (t, base) not in flag:
            continue
        if k == "hidden":
            h.append(flag[(t, arm)] - flag[(t, base)])
        else:
            c.append(flag[(t, arm)] - flag[(t, base)])
            c2.append(again[(t, arm)] - again[(t, base)])
    for out, v in ((hidden, h), (graded, c), (regraded, c2)):
        if v:
            out.append(v)
for name, per in (("hidden raised", hidden), ("concerns (control+neutral), graded", graded), ("concerns, regraded", regraded)):
    if per:
        n, m, lo, hi = boot(per)
        print(f"{arm} − {base}  {name:36s} runs {len(per)} n {n:4d}  {100*m:+.1f} points ({100*lo:+.1f}..{100*hi:+.1f})")
