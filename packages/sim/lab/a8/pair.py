# A8 (docs/research/a8-connector-calls.md): two pi-ab runs of the same users compared arm by arm, paired by task.
# Per labelled arm and kind: rate (hidden raised; on control and neutral, any concern raised), all-in $/1k (agent
# billed + Eden per task + the file's background cards spread over its Eden task runs), connector calls a task (the
# agent's source tools + Eden's `eden.source` spans in the task's timeline, which include the sync ticks and notices
# that land in it) and Eden's calls by source and operation. Pairs: B − A per kind and on the 1:1:8 mix (an
# assumption), bootstrap 95% (5,000 draws, seed 1; each kind resampled on its own; paired by task).
# usage: python3 -I pair.py LABEL=STEM:arm[,STEM:arm...] LABEL=... [--pair A,B ...]   (STEM.json, STEM.tl/tasks.jsonl)
import json, random, statistics as st, sys
from collections import Counter, defaultdict

specs, pairs = [], []
args = sys.argv[1:]
i = 0
while i < len(args):
    if args[i] == "--pair":
        pairs.append(tuple(args[i + 1].split(",")))
        i += 2
        continue
    label, _, rest = args[i].partition("=")
    specs.append((label, [s.rsplit(":", 1) for s in rest.split(",")]))
    i += 1

X, KIND, OPS = {}, {}, defaultdict(Counter)
for label, parts in specs:
    for stem, arm in parts:
        d = json.load(open(stem + ".json"))
        for t in d["tasks"]:
            KIND[t["id"]] = t["kind"]
        eden_runs = sum(1 for r in d["results"] if r["condition"] != "tools")
        bk = sum(b["cardsUsd"] + b["bridgeUsd"] for b in d["background"]) / max(eden_runs, 1)
        for r in d["results"]:
            if r.get("facts") is None or r["condition"] != arm:
                continue
            eden = arm != "tools"
            X[(r["task"], label)] = {
                "raised": float(any(r["facts"].values())),
                "usd": (r["costUsd"] + r["edenCostUsd"] + (bk if eden else 0)) * 1000,
                "conn": 0,
                "eden": 0,
                "agent": 0,
            }
        for line in open(stem + ".tl/tasks.jsonl"):
            t = json.loads(line)
            x = X.get((t["task"], label))
            if x is None or t["condition"] != arm:
                continue
            for e in t["events"]:
                if e["ph"] not in ("B", "I"):
                    continue
                if e["ev"].startswith("tool.search_"):
                    x["conn"] += 1
                    x["agent"] += 1
                elif e["ev"] == "eden.source":
                    x["conn"] += 1
                    x["eden"] += 1
                    a = e.get("data") or e.get("args") or {}
                    OPS[label][(a.get("source", "?"), a.get("op", "?"))] += 1

labels = [l for l, _ in specs]
KINDS = [k for k in ["hidden", "control", "neutral"] if k in KIND.values()]
ids = {k: sorted(t for t, kk in KIND.items() if kk == k and all((t, l) in X for l in labels)) for k in KINDS}
MIX = {"hidden": 1, "control": 1, "neutral": 8}
n_all = sum(len(v) for v in ids.values())
print(f"tasks in every arm: {n_all} ({', '.join(f'{k} {len(v)}' for k, v in ids.items())})")
print("arm       kind      n   rate   $/1k   calls/t (agent, Eden)")
for l in labels:
    for k in KINDS:
        xs = [X[(t, l)] for t in ids[k]]
        print(f"{l:9} {k:8} {len(xs):3}  {st.mean(x['raised'] for x in xs):.3f}  {st.mean(x['usd'] for x in xs):.3f}  "
              f"{st.mean(x['conn'] for x in xs):.2f} ({st.mean(x['agent'] for x in xs):.2f}, "
              f"{st.mean(x['eden'] for x in xs):.2f})")
    mix = lambda f: sum(MIX[k] * st.mean(X[(t, l)][f] for t in ids[k]) for k in KINDS) / sum(MIX[k] for k in KINDS)
    print(f"{l:9} mix 1:1:8      {'':5}  {mix('usd'):.3f}  {mix('conn'):.2f} ({mix('agent'):.2f}, {mix('eden'):.2f})")
print("\nEden's connector calls a task by source and operation (all tasks of the arm, in its timelines):")
for l in labels:
    n = sum(1 for (t, ll) in X if ll == l)
    print(f"  {l}: " + ", ".join(f"{s} {op} {c / n:.3f}" for (s, op), c in sorted(OPS[l].items(), key=lambda kv: -kv[1])))

rng = random.Random(1)
DRAWS = 5000


def boot(stat, kinds):
    point = stat({k: ids[k] for k in kinds})
    vals = sorted(stat({k: [rng.choice(ids[k]) for _ in ids[k]] for k in kinds}) for _ in range(DRAWS))
    return point, vals[int(0.025 * DRAWS)], vals[int(0.975 * DRAWS)]


fmt = lambda p: f"{p[0]:+.3f} ({p[1]:+.3f}..{p[2]:+.3f})" + ("*" if p[1] > 0 or p[2] < 0 else " ")
if pairs:
    print("\n== paired B − A, bootstrap 95%; * the interval excludes zero")
for a, b in pairs:
    for f in ["raised", "usd", "conn", "eden"]:
        cells = []
        for k in KINDS:
            cells.append(f"{k} " + fmt(boot(lambda p, f=f, k=k: st.mean(X[(t, b)][f] - X[(t, a)][f] for t in p[k]), [k])))
        mixed = boot(
            lambda p, f=f: sum(MIX[k] * st.mean(X[(t, b)][f] - X[(t, a)][f] for t in p[k]) for k in p)
            / sum(MIX[k] for k in p),
            KINDS,
        )
        print(f"{b} − {a} {f:6}: " + "; ".join(cells) + f"; mix {fmt(mixed)}")
