# M1 (docs/research/m1-lab-scale.md): each arm against `eden` and `tools`, paired by task and pooled over the shards
# of one or more lab_fanout runs (.local/modal/<run>/<shard>/out.json and out.timeline/tasks.jsonl). Per pair:
# hidden raised, concerns on control + neutral (as graded, and regraded where <shard>/regrade.json exists: a regraded
# answer takes the regrade's verdict, the rest keep the run's), $/1k over the horizon's tasks (agent billed + Eden per
# task + the shard's background cards spread over its Eden task runs), wall mean s, Eden path ms (the union of
# eden.observe and tool.ask_context path spans), connector calls a task. Bootstrap 95%: 5,000 draws, seed 1, tasks
# resampled within each (shard, kind) stratum, so every seed keeps its weight. `--seeds 41,42` keeps those seeds.
# usage: python3 -I parts.py --arms tools,eden,eden~minus-nudge [--base eden,tools] [--seeds S] [--json OUT] RUN_DIR...
import json, os, random, statistics as st, sys

args = sys.argv[1:]


def opt(name, default=None):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i : i + 2]
        return v
    return default


ARMS = opt("--arms").split(",")
BASES = opt("--base", "eden,tools").split(",")
SEEDS = set(opt("--seeds", "").split(",")) - {""}
OUT = opt("--json")
DRAWS = 5000
runs = args

X = {}  # (shard, task) -> {arm: metrics}
KIND, SEED = {}, {}


def union(spans):
    total, end = 0.0, -1e18
    for a, b in sorted(spans):
        if b <= end:
            continue
        total += b - max(a, end)
        end = b
    return total


shards = []
for run in runs:
    for name in sorted(os.listdir(run)):
        p = os.path.join(run, name, "out.json")
        if os.path.exists(p):
            shards.append((os.path.join(run, name), p))

for sdir, p in shards:
    d = json.load(open(p))
    seed = str(d.get("seeds", [""])[0]) if isinstance(d.get("seeds"), list) else ""
    if not seed:
        seed = name_seed = os.path.basename(sdir).rsplit("-", 1)[-1]
    if SEEDS and seed not in SEEDS:
        continue
    key = os.path.relpath(sdir)
    kinds = {t["id"]: t["kind"] for t in d["tasks"]}
    eden_runs = sum(1 for r in d["results"] if r["condition"] != "tools")
    bk = sum(b.get("cardsUsd", 0) + b.get("bridgeUsd", 0) for b in d.get("background", [])) / max(eden_runs, 1)
    regraded = {}
    rg = os.path.join(sdir, "regrade.json")
    if os.path.exists(rg):
        for g in json.load(open(rg)).get("graded", []):
            regraded[(g["task"], g["condition"])] = float(any(g["facts"].values()))
    for r in d["results"]:
        if r.get("facts") is None or r["condition"] not in ARMS:
            continue
        flag = float(any(r["facts"].values()))
        k = (key, r["task"])
        KIND[k], SEED[k] = kinds[r["task"]], seed
        X.setdefault(k, {})[r["condition"]] = {
            "raised": flag,
            "regraded": regraded.get((r["task"], r["condition"]), flag),
            "wall": r["wallMs"] / 1000,
            "usd": (r["costUsd"] + r["edenCostUsd"] + (bk if r["condition"] != "tools" else 0)) * 1000,
            "edenms": 0.0,
            "conn": 0,
        }
    tl = os.path.join(sdir, "out.timeline", "tasks.jsonl")
    if os.path.exists(tl):
        for line in open(tl):
            t = json.loads(line)
            x = X.get((key, t["task"]), {}).get(t["condition"])
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

# Only tasks every named arm finished (a shard stopped by its cap leaves some out).
done = [k for k in X if all(a in X[k] for a in ARMS)]
dropped = len(X) - len(done)
strata = {}
for k in done:
    strata.setdefault((k[0], KIND[k]), []).append(k)
KINDS = [k for k in ("hidden", "control", "neutral") if any(KIND[t] == k for t in done)]
seeds = sorted({SEED[k] for k in done})
print(f"shards {len(shards)}, seeds {','.join(seeds)}, tasks paired {len(done)} (dropped {dropped} unfinished)")
print("n per kind: " + ", ".join(f"{k} {sum(1 for t in done if KIND[t] == k)}" for k in KINDS))

q = lambda v, p: sorted(v)[min(len(v) - 1, int(p * len(v)))]
print("\narm                    hidden  control  neutral  conc.rg   $/1k   wall p50/mean s  Eden ms  conn")
summary = {"arms": {}, "pairs": [], "paired": len(done), "dropped": dropped, "seeds": seeds}
for a in ARMS:
    rate = lambda k, f="raised": st.mean(X[t][a][f] for t in done if KIND[t] == k) if k in KINDS else float("nan")
    conc = [X[t][a]["regraded"] for t in done if KIND[t] != "hidden"]
    w = [X[t][a]["wall"] for t in done]
    m = {f: st.mean(X[t][a][f] for t in done) for f in ("usd", "edenms", "conn")}
    row = {"hidden": rate("hidden"), "control": rate("control"), "neutral": rate("neutral"),
           "concernsRegraded": st.mean(conc) if conc else None, "usdPer1k": m["usd"], "wallP50": st.median(w),
           "wallMean": st.mean(w), "edenMs": m["edenms"], "conn": m["conn"]}
    summary["arms"][a] = row
    print(f"{a:22} {row['hidden']:.3f}   {row['control']:.3f}    {row['neutral']:.3f}    "
          f"{(row['concernsRegraded'] or 0):.4f}  {m['usd']:6.3f}  {st.median(w):5.2f}/{st.mean(w):5.2f}   "
          f"{m['edenms']:6.0f}  {m['conn']:5.2f}")

rng = random.Random(1)


def boot(stat, keep):
    """stat over the kept tasks, and over 5,000 resamples within each (shard, kind) stratum."""
    groups = [v for (s, k), v in strata.items() if keep(k)]
    point = stat([t for g in groups for t in g])
    vals = sorted(stat([rng.choice(g) for g in groups for _ in g]) for _ in range(DRAWS))
    return point, vals[int(0.025 * DRAWS)], vals[int(0.975 * DRAWS) - 1]


def diff(a, b, f):
    return lambda ts: st.mean(X[t][a][f] - X[t][b][f] for t in ts) if ts else 0.0


ex = lambda p: p[1] > 0 or p[2] < 0
fmt = lambda p, s=1: f"{p[0]*s:+.3f} ({p[1]*s:+.3f}..{p[2]*s:+.3f})" + ("*" if ex(p) else " ")
print("\n== paired differences (a − b), bootstrap 95%; * the interval excludes zero")
print("points for hidden and concerns; $/1k; s; ms")
for b in BASES:
    if b not in ARMS:
        continue
    for a in ARMS:
        if a == b or (b == "eden" and a == "tools"):
            continue
        r = {}
        if "hidden" in KINDS:
            r["hidden"] = boot(diff(a, b, "raised"), lambda k: k == "hidden")
        if any(k != "hidden" for k in KINDS):
            r["concerns"] = boot(diff(a, b, "raised"), lambda k: k != "hidden")
            r["concernsRegraded"] = boot(diff(a, b, "regraded"), lambda k: k != "hidden")
        for f, name in (("usd", "usdPer1k"), ("wall", "wallMean"), ("edenms", "edenMs"), ("conn", "conn")):
            r[name] = boot(diff(a, b, f), lambda k: True)
        summary["pairs"].append({"a": a, "b": b, **{k: list(v) for k, v in r.items()}})
        parts = []
        for k, v in r.items():
            scale = 100 if k in ("hidden", "concerns", "concernsRegraded") else 1
            parts.append(f"{k} {fmt(v, scale)}" if k != "edenMs" else f"{k} {v[0]:+.0f} ({v[1]:+.0f}..{v[2]:+.0f})")
        print(f"{a:22} − {b:6} " + "  ".join(parts))

if OUT:
    with open(OUT, "w") as f:
        json.dump(summary, f, indent=1)
