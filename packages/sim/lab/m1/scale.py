# M1 (docs/research/m1-lab-scale.md): the default at 995 noise sources against the same tasks at 5 sources (cross-run:
# ARM in the 1,000-source run's shards against ARM in a 5-source run's shards, joined by task id, which carries the
# seed). Hidden raised, Eden path ms (eden.observe + tool.ask_context path spans, union), connector calls a task
# (agent source tools + eden.source), $/1k (agent + Eden per task + each shard's background spread over its Eden task
# runs), wall mean s. Bootstrap 95%: 5,000 draws, numpy seed 1, tasks resampled within each seed.
# usage: python3 -I scale.py --arm eden --kind hidden SCALE_RUN_DIR BASE_RUN_DIR [BASE_RUN_DIR ...]
import json, os, sys

import numpy as np

args = sys.argv[1:]
ARM = args[args.index("--arm") + 1]
KIND = args[args.index("--kind") + 1]
dirs = [a for i, a in enumerate(args) if not a.startswith("--") and args[i - 1] not in ("--arm", "--kind")]
scale_dir, base_dirs = dirs[0], dirs[1:]


def union(spans):
    total, end = 0.0, -1e18
    for a, b in sorted(spans):
        if b <= end:
            continue
        total += b - max(a, end)
        end = b
    return total


def load(run):
    out = {}
    for name in sorted(os.listdir(run)):
        sdir = os.path.join(run, name)
        p = os.path.join(sdir, "out.json")
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        kinds = {t["id"]: t["kind"] for t in d["tasks"]}
        eden_runs = sum(1 for r in d["results"] if r["condition"] != "tools")
        bk = sum(b.get("cardsUsd", 0) + b.get("bridgeUsd", 0) for b in d.get("background", [])) / max(eden_runs, 1)
        for r in d["results"]:
            if r["condition"] != ARM or r.get("facts") is None or kinds[r["task"]] != KIND:
                continue
            out[r["task"]] = {"raised": float(any(r["facts"].values())), "wall": r["wallMs"] / 1000,
                              "usd": (r["costUsd"] + r["edenCostUsd"] + bk) * 1000, "edenms": 0.0, "conn": 0.0}
        tl = os.path.join(sdir, "out.timeline", "tasks.jsonl")
        for line in open(tl) if os.path.exists(tl) else []:
            t = json.loads(line)
            x = out.get(t["task"]) if t["condition"] == ARM else None
            if x is None:
                continue
            opened, path = {}, []
            for e in t["events"]:
                if e["ph"] in ("B", "I"):
                    x["conn"] += e["ev"].startswith("tool.search_") or e["ev"] == "eden.source"
                if e["ph"] == "B":
                    opened[e["id"]] = e
                elif e["ph"] == "E" and e["id"] in opened:
                    b = opened.pop(e["id"])
                    if b.get("lane") == "path" and b["ev"] in ("eden.observe", "tool.ask_context"):
                        path.append((b["t"], e["t"]))
            x["edenms"] = union(path)
    return out


S = load(scale_dir)
B = {}
for d in base_dirs:
    B.update(load(d))
both = sorted(set(S) & set(B))
seed_of = lambda t: t.split(":")[0]
groups = {}
for t in both:
    groups.setdefault(seed_of(t), []).append(t)
print(f"{ARM}, {KIND}: {len(both)} tasks in both ({len(S)} at scale, {len(B)} in the base), seeds {sorted(groups)}")
rng = np.random.default_rng(1)
for f, scale in (("raised", 100), ("edenms", 1), ("conn", 1), ("usd", 1), ("wall", 1)):
    a = np.mean([S[t][f] for t in both]) * scale
    b = np.mean([B[t][f] for t in both]) * scale
    gs = [np.array([S[t][f] - B[t][f] for t in g]) for g in groups.values()]
    n = sum(len(g) for g in gs)
    sums = np.zeros(5000)
    for g in gs:
        sums += g[rng.integers(0, len(g), size=(5000, len(g)))].sum(axis=1)
    v = np.sort(sums / n) * scale
    lo, hi = v[125], v[4874]
    star = "*" if lo > 0 or hi < 0 else ""
    print(f"{f:7} 995: {a:9.3f}  5: {b:9.3f}  diff {a - b:+.3f} ({lo:+.3f}..{hi:+.3f}){star}")
