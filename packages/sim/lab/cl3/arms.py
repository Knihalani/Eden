# Per-arm figures and paired bootstrap 95% intervals for CL3's Pi runs (RealUse-2's arms.py and pairs.py definitions):
# rate (hidden raised / false concern on control), wall p50/p90/mean, all-in $/1k (agent billed + Eden per-task +
# backfill), connector calls a task (agent source tools + Eden's eden.source spans, split by op), reader calls a task.
#
# Backfill: pi-ab's arms share one card cache (the first arm to need a card pays for it), so the run's own background
# spend cannot be split by arm. Each arm is charged instead the cold-start cost per user measured by cold-start.ts for
# its configuration (--bk arm=usd, a new user's one-time cost), spread over the arm's tasks for that user: one user
# (world) per seed, so per task = usd / tasks of the arm. A day's arrivals are not in it (docs/research/cl-cl3.md).
#
# usage: python3 -I arms.py --bk eden=0.0211 --bk eden~cl3=0.0082 --bk eden~pending=0 STEM [STEM ...]
#   (stems: <stem>.json and <stem>.timeline/)
import json, sys, random, statistics as st, collections

args = sys.argv[1:]
BK = {}
stems = []
while args:
    a = args.pop(0)
    if a == "--bk":
        k, v = args.pop(0).split("=")
        BK[k] = float(v)
    else:
        stems.append(a)
X = {}
KIND = {}
for stem in stems:
    d = json.load(open(stem + ".json"))
    for t in d["tasks"]:
        KIND[t["id"]] = t["kind"]
    per_arm = collections.Counter(r["condition"] for r in d["results"] if r.get("facts") is not None)
    for r in d["results"]:
        if r.get("facts") is None:
            continue
        c = r["condition"]
        bk = BK.get(c, 0.0) / per_arm[c] if c != "tools" else 0.0
        X[(r["task"], c)] = {
            "raised": float(any(r["facts"].values())),
            "wall": r["wallMs"] / 1000,
            "agent": r["costUsd"] * 1000,
            "eden": r["edenCostUsd"] * 1000,
            "bk": bk * 1000,
            "usd": (r["costUsd"] + r["edenCostUsd"] + bk) * 1000,
        }
    for l in open(stem + ".timeline/tasks.jsonl"):
        t = json.loads(l)
        x = X.get((t["task"], t["condition"]))
        if x is None:
            continue
        evs = [e for e in t["events"] if e.get("ph") in ("B", "I")]
        ops = collections.Counter(e.get("data", {}).get("op") for e in evs if e["ev"] == "eden.source")
        x["agentconn"] = sum(1 for e in evs if e["ev"].startswith("tool.search_"))
        x["list"], x["fetch"], x["search"] = ops["list"], ops["fetch"], ops["search"]
        x["conn"] = x["agentconn"] + sum(ops.values())
        x["reader"] = sum(1 for e in evs if e["ev"] == "eden.reader")
        x["asks"] = sum(1 for e in evs if e["ev"] == "tool.ask_context")
C = sorted({c for (_, c) in X}, key=lambda c: (c != "tools", c != "eden", c))
q = lambda v, p: sorted(v)[min(len(v) - 1, int(p * len(v)))]
KINDS = [k for k in ["hidden", "control", "neutral"] if k in KIND.values()]
print("arm           kind      n  rate    wall p50/p90/mean s   $/1k all-in (agent+eden+bkfill)    conn: agent+list+fetch+search  reader ask")
for c in C:
    for k in KINDS:
        xs = [X[(t, c)] for t, kk in KIND.items() if kk == k and (t, c) in X]
        if not xs:
            continue
        w = [x["wall"] for x in xs]
        m = lambda f: st.mean(x.get(f, 0) for x in xs)
        print(
            f"{c:13} {k:8} {len(xs):3}  {m('raised'):.3f}  {st.median(w):5.2f} / {q(w, 0.9):5.2f} / {m('wall'):5.2f}"
            f"   {m('usd'):.3f} ({m('agent'):.3f}+{m('eden'):.3f}+{m('bk'):.3f})"
            f"       {m('conn'):5.2f} = {m('agentconn'):.2f}+{m('list'):.2f}+{m('fetch'):.2f}+{m('search'):.2f}"
            f"    {m('reader'):.2f}  {m('asks'):.2f}"
        )
random.seed(1)
print("\n== paired differences a - b over tasks of a kind, bootstrap 95% (5000 draws, seed 1)")
pairs = [(a, b) for a in C for b in ("eden", "tools") if a != b and not (a == "tools")]
for a, b in pairs:
    for k in KINDS:
        ids = [t for t, kk in KIND.items() if kk == k and (t, a) in X and (t, b) in X]
        if not ids:
            continue
        cells = []
        for f in ["raised", "wall", "usd", "conn"]:
            d = [X[(t, a)].get(f, 0) - X[(t, b)].get(f, 0) for t in ids]
            mean = sum(d) / len(d)
            bs = sorted(sum(random.choice(d) for _ in d) / len(d) for _ in range(5000))
            cells.append(f"{f} {mean:+.3f} ({bs[124]:+.3f}..{bs[4874]:+.3f})")
        print(f"{a} - {b} {k} n={len(ids)}: " + "  ".join(cells))
