# CL4 (docs/research/cl-cl4.md): one arm against another, paired by task and pooled over several pi-ab runs, per kind:
# the rate difference (hidden raised, false concern, any concern) with a bootstrap 95% interval (5,000 draws, seed 1;
# each run's tasks resampled on their own).
# usage: python3 -I pooled.py ARM BASE STEM [STEM ...]   (STEM.json)
import json, random, sys

arm, base, stems = sys.argv[1], sys.argv[2], sys.argv[3:]
for kind in ["hidden", "control", "neutral"]:
    per = []
    for stem in stems:
        d = json.load(open(stem + ".json"))
        kinds = {t["id"]: t["kind"] for t in d["tasks"]}
        got = {(r["task"], r["condition"]): float(any(r["facts"].values())) for r in d["results"] if r.get("facts")}
        v = [got[(t, arm)] - got[(t, base)] for t, k in kinds.items() if k == kind and (t, arm) in got and (t, base) in got]
        if v:
            per.append(v)
    if not per:
        continue
    n = sum(len(v) for v in per)
    rng = random.Random(1)
    draws = sorted(sum(sum(rng.choice(v) for _ in v) for v in per) / n for _ in range(5000))
    point = sum(sum(v) for v in per) / n
    print(f"{arm} − {base} {kind:8} runs {len(per)} n {n:4} diff {point:+.3f} ({draws[125]:+.3f}..{draws[4875]:+.3f})")
