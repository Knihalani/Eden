# Paired bootstrap 95% intervals between funnel runs (surfaced = delivered or cited by the ask), per variant.
# usage: python3 -I funnel-pairs.py BASE.json NAME=RUN.json [NAME=RUN.json ...]
import json, sys, random


def load(path):
    d = json.load(open(path))
    return {(r["suite"], r["seed"], r["variant"], r["template"]): float(r["delivered"] or r["askCited"]) for r in d["perTask"]}


base = load(sys.argv[1])
random.seed(1)
for arg in sys.argv[2:]:
    name, path = arg.split("=")
    run = load(path)
    for v in ["hidden", "control"]:
        ids = [k for k in base if k[2] == v and k in run]
        d = [run[k] - base[k] for k in ids]
        bs = sorted(sum(random.choice(d) for _ in d) / len(d) for _ in range(5000))
        print(f"{name} - base {v} n={len(ids)}: {sum(run[k] for k in ids):.0f} vs {sum(base[k] for k in ids):.0f}, "
              f"{sum(d) / len(d):+.3f} ({bs[124]:+.3f}..{bs[4874]:+.3f})")
