# RealUse-3 (docs/research/realuse-3/pi-heldout16.md): control and neutral concerns per arm, as the run's Haiku grader
# graded them and as regraded (regrade.ts --only-concerns with Haiku and Sonnet: kept when both regraders keep it; when
# they disagree, the disputed one, Sonnet decides), and the pre-registered pooled pair ARM − BASE over control + neutral
# tasks, paired by task, each run resampled on its own (bootstrap 95%, 5,000 draws, seed 1).
# usage: python3 -I concerns.py ARM BASE STEM [STEM ...]   (STEM.json and STEM.regrade.json)
import json, random, sys, collections

arm, base, stems = sys.argv[1], sys.argv[2], sys.argv[3:]
HAIKU, SONNET = "claude-haiku-5-5", "claude-sonnet-5-5"
count = collections.Counter()
disputed, per = [], {"haiku": [], "regraded": []}
for stem in stems:
    d = json.load(open(stem + ".json"))
    kinds = {t["id"]: t["kind"] for t in d["tasks"]}
    rg = json.load(open(stem + ".regrade.json"))["graded"]
    by = collections.defaultdict(dict)
    for g in rg:
        if g.get("facts") is not None:
            by[(g["task"], g["condition"])][g["grader"]] = any(g["facts"].values())
    hk, kept = {}, {}
    for r in d["results"]:
        k = kinds[r["task"]]
        if k == "hidden" or r.get("facts") is None:
            continue
        key = (r["task"], r["condition"])
        h = float(any(r["facts"].values()))
        v = by.get(key, {})
        if h and (HAIKU not in v or SONNET not in v):
            sys.exit(f"{stem}: concern {key} has no regrade by both graders")
        final = (v[SONNET] if v[HAIKU] != v[SONNET] else v[HAIKU]) if h else False
        if h and v[HAIKU] != v[SONNET]:
            disputed.append((stem.split("/")[-1], *key, "sonnet keeps" if v[SONNET] else "sonnet drops"))
        hk[key], kept[key] = h, float(final)
        count[(r["condition"], k, "haiku")] += h
        count[(r["condition"], k, "regraded")] += final
        count[(r["condition"], k, "n")] += 1
    for name, m in (("haiku", hk), ("regraded", kept)):
        v = [m[(t, arm)] - m[(t, base)] for t, k in kinds.items() if k != "hidden" and (t, arm) in m and (t, base) in m]
        if v:
            per[name].append(v)
for c in sorted({k[0] for k in count}):
    for k in ("control", "neutral"):
        print(f"{c:12} {k:8} n {count[(c, k, 'n')]:4}  haiku {count[(c, k, 'haiku')]:3}  regraded {count[(c, k, 'regraded')]:3}")
for x in disputed:
    print("disputed:", *x)
for name, runs in per.items():
    n = sum(len(v) for v in runs)
    rng = random.Random(1)
    draws = sorted(sum(sum(rng.choice(v) for _ in v) for v in runs) / n for _ in range(5000))
    point = sum(sum(v) for v in runs) / n
    print(f"{arm} − {base} control+neutral concern ({name}) runs {len(runs)} n {n} diff {point:+.4f} ({draws[125]:+.4f}..{draws[4875]:+.4f})")
