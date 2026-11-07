# CL7 (docs/research/cl-cl7.md; CL4's arms.py with a per-stem arm filter): per-arm figures and paired differences from pi-ab result JSONs and timelines.
# Per arm and kind: rate (hidden raised, false concern on control, any concern on neutral), wall p50/p90/mean, all-in
# $/1k (agent billed + Eden per-task + each file's background cards spread over its Eden task runs), Eden's
# critical-path ms (the union of its path spans: the observe and every ask_context), observe and ask ms, model turns,
# ask_context calls, reader calls and connector calls (agent source tools + Eden's eden.source spans) per task.
# Pairs: each arm against `eden` and `tools` per kind, and the 1:1:8 traffic mix (an assumption) when all three kinds
# are present, with bootstrap 95% intervals (5,000 draws, seed 1; each kind resampled on its own; paired by task).
# usage: python3 -I arms.py --arms tools,eden,eden~note STEM[:arm,arm] [...]   (STEM.json and STEM.tl/tasks.jsonl)
# A stem's `:arm,arm` suffix takes only those arms from it: CL7 pairs the signals runs' Eden arms with the payload
# runs' `tools` arm (the push mode reaches only Eden's partner, connector-options.ts `pushNotifier`).
import json, sys, random, statistics as st

args = sys.argv[1:]
ARMS = args[args.index("--arms") + 1].split(",")
stems = [a for i, a in enumerate(args) if a != "--arms" and (i == 0 or args[i - 1] != "--arms")]
X, KIND = {}, {}


def union(spans):
    total, end = 0.0, -1e18
    for a, b in sorted(spans):
        if b <= end:
            continue
        total += b - max(a, end)
        end = b
    return total


for spec in stems:
    stem, _, only = spec.partition(":")
    take = set(only.split(",")) if only else set(ARMS)
    d = json.load(open(stem + ".json"))
    for t in d["tasks"]:
        KIND[t["id"]] = t["kind"]
    eden_runs = sum(1 for r in d["results"] if r["condition"] != "tools")
    bk = sum(b["cardsUsd"] + b["bridgeUsd"] for b in d["background"]) / max(eden_runs, 1)
    for r in d["results"]:
        if r.get("facts") is None or r["condition"] not in ARMS or r["condition"] not in take:
            continue
        eden = r["condition"] != "tools"
        X[(r["task"], r["condition"])] = {
            "raised": float(any(r["facts"].values())),
            "wall": r["wallMs"] / 1000,
            "usd": (r["costUsd"] + r["edenCostUsd"] + (bk if eden else 0)) * 1000,
            "agent": r["costUsd"] * 1000,
            "edenusd": r["edenCostUsd"] * 1000,
            "turns": r["modelCalls"],
        }
    for l in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(l)
        x = X.get((t["task"], t["condition"]))
        if x is None or t["condition"] not in take:
            continue
        opened, path, obs, ask = {}, [], [], []
        x["conn"] = x["reader"] = x["asks"] = x["restarts"] = 0
        for e in t["events"]:
            if e["ph"] in ("B", "I"):
                x["conn"] += e["ev"].startswith("tool.search_") or e["ev"] == "eden.source"
                x["reader"] += e["ev"] == "eden.reader"
                x["asks"] += e["ev"] == "tool.ask_context" and e["ph"] == "B"
                x["restarts"] += e["ev"] == "spec.restart"
            if e["ph"] == "B":
                opened[e["id"]] = e
            elif e["ph"] == "E" and e["id"] in opened:
                b = opened.pop(e["id"])
                if b.get("lane") != "path":
                    continue
                if b["ev"] == "eden.observe":
                    obs.append((b["t"], e["t"]))
                    path.append((b["t"], e["t"]))
                elif b["ev"] == "tool.ask_context":
                    ask.append((b["t"], e["t"]))
                    path.append((b["t"], e["t"]))
        x["edenms"], x["obsms"], x["askms"] = union(path), union(obs), union(ask)

q = lambda v, p: sorted(v)[min(len(v) - 1, int(p * len(v)))]
KINDS = [k for k in ["hidden", "control", "neutral"] if k in KIND.values()]
ids = {k: sorted(t for t, kk in KIND.items() if kk == k and all((t, c) in X for c in ARMS)) for k in KINDS}
F = ["usd", "agent", "edenusd", "wall", "edenms", "obsms", "askms", "turns", "asks", "reader", "conn", "restarts"]
print("arm              kind      n  rate   wall p50/p90/mean s  all-in $/1k (agent, Eden)  Eden path ms (obs, ask)"
      "  turns  asks  reader  conn  restarts")
for c in ARMS:
    for k in KINDS:
        xs = [X[(t, c)] for t in ids[k]]
        m = {f: st.mean(x[f] for x in xs) for f in F}
        w = [x["wall"] for x in xs]
        print(f"{c:16} {k:8} {len(xs):3} {st.mean(x['raised'] for x in xs):.3f}  {st.median(w):5.2f}/{q(w, .9):5.2f}/"
              f"{st.mean(w):5.2f}   {m['usd']:.3f} ({m['agent']:.3f}, {m['edenusd']:.3f})     "
              f"{m['edenms']:5.0f} ({m['obsms']:4.0f}, {m['askms']:4.0f})   {m['turns']:.2f}  {m['asks']:.2f}  "
              f"{m['reader']:.2f}  {m['conn']:5.2f}  {m['restarts']:.2f}")

rng = random.Random(1)
DRAWS = 5000


def boot(stat):
    """stat(pick) over each kind's tasks resampled with replacement; returns (point, lo, hi)."""
    point = stat(ids)
    vals = sorted(stat({k: [rng.choice(v) for _ in v] for k, v in ids.items()}) for _ in range(DRAWS))
    return point, vals[int(0.025 * DRAWS)], vals[int(0.975 * DRAWS)]


fmt = lambda p: f"{p[0]:+.3f} ({p[1]:+.3f}..{p[2]:+.3f})" + ("*" if p[1] > 0 or p[2] < 0 else " ")
print("\n== paired differences per kind (a − b), bootstrap 95%; * the interval excludes zero")
for b in [x for x in ["eden", "tools"] if x in ARMS]:
    for a in ARMS:
        if a == b or (b == "eden" and a == "tools"):
            continue
        for k in KINDS:
            one = {k: ids[k]}
            d = lambda f: (lambda pick: st.mean(X[(t, a)][f] - X[(t, b)][f] for t in pick[k]))
            saved = ids.copy()
            ids.clear(), ids.update(one)
            r = [boot(d(f)) for f in ["raised", "wall", "usd", "edenms", "turns"]]
            ids.clear(), ids.update(saved)
            print(f"{a:16} − {b:6} {k:8} rate {fmt(r[0])} wall s {fmt(r[1])} $/1k {fmt(r[2])} "
                  f"Eden ms {r[3][0]:+.0f} ({r[3][1]:+.0f}..{r[3][2]:+.0f}) turns {fmt(r[4])}")

if len(KINDS) == 3:
    W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}

    def mix(c, f, pick):
        if f == "raised":
            return 0.1 * st.mean(X[(t, c)]["raised"] for t in pick["hidden"])
        if f == "wrong":
            return 0.1 * st.mean(X[(t, c)]["raised"] for t in pick["control"]) + 0.8 * st.mean(
                X[(t, c)]["raised"] for t in pick["neutral"])
        return sum(W[k] * st.mean(X[(t, c)][f] for t in pick[k]) for k in W)

    MF = ["raised", "wrong", "usd", "agent", "edenusd", "wall", "edenms", "turns", "asks", "reader", "conn"]
    print("\n== traffic mix (assumed 1 hidden : 1 control : 8 neutral)")
    print("arm              " + "  ".join(f"{f:>7}" for f in MF))
    for c in ARMS:
        print(f"{c:16} " + "  ".join(f"{mix(c, f, ids):7.3f}" for f in MF))
    print("\n== mix pairs (a − b), bootstrap 95%; * excludes zero")
    for b in [x for x in ["eden", "tools"] if x in ARMS]:
        for a in ARMS:
            if a == b or (b == "eden" and a == "tools"):
                continue
            r = {f: boot(lambda pick, f=f: mix(a, f, pick) - mix(b, f, pick)) for f in
                 ["raised", "wrong", "usd", "wall", "edenms", "conn"]}
            print(f"{a:16} − {b:6} " + "  ".join(f"{f} {fmt(v)}" for f, v in r.items()))
