# Per-arm figures for RealUse-2's Pi heldout15 run, from pi-ab's result JSONs and timelines (A-heldout14.md's
# definitions): wall p50/p90/mean, connector calls (agent source tools + Eden's eden.source spans), reader calls,
# all-in $/1k (agent billed + Eden per-task + each seed's background cards spread over its Eden task runs), and the
# 1:1:8 traffic mix (an assumption) with paired bootstrap intervals resampling each kind on its own.
# usage: python3 arms.py .local/r2/r2-pi-41 .local/r2/r2-pi-42 ...   (stems: <stem>.json and <stem>.timeline/)
import json, sys, random, statistics as st
X = {}  # (task, cond) -> dict
KIND = {}
for stem in sys.argv[1:]:
    d = json.load(open(stem + ".json"))
    for t in d["tasks"]:
        KIND[t["id"]] = t["kind"]
    eden_runs = sum(1 for r in d["results"] if r["condition"] != "tools")
    bk = sum(b["cardsUsd"] + b["bridgeUsd"] for b in d["background"]) / max(eden_runs, 1)
    for r in d["results"]:
        if r.get("facts") is None:
            continue
        X[(r["task"], r["condition"])] = {
            "raised": float(any(r["facts"].values())),
            "wall": r["wallMs"] / 1000,
            "usd": (r["costUsd"] + r["edenCostUsd"] + (bk if r["condition"] != "tools" else 0)) * 1000,
        }
    for l in open(stem + ".timeline/tasks.jsonl"):
        t = json.loads(l)
        x = X.get((t["task"], t["condition"]))
        if x is None:
            continue
        evs = [e for e in t["events"] if e.get("ph") in ("B", "I")]
        x["conn"] = sum(1 for e in evs if e["ev"].startswith("tool.search_") or e["ev"] == "eden.source")
        x["reader"] = sum(1 for e in evs if e["ev"] == "eden.reader")
        x["asks"] = sum(1 for e in evs if e["ev"] == "tool.ask_context")
C = ["tools", "eden", "both", "both+ask"]
q = lambda v, p: sorted(v)[min(len(v) - 1, int(p * len(v)))]
print("arm       kind     n   rate   wall p50/p90/mean s   all-in $/1k  conn/task  reader/task  ask_context/task")
for c in C:
    for k in ["hidden", "control", "neutral"]:
        xs = [X[(t, c)] for t, kk in KIND.items() if kk == k and (t, c) in X]
        w = [x["wall"] for x in xs]
        print(f"{c:9} {k:8} {len(xs):3} {st.mean(x['raised'] for x in xs):.3f}  "
              f"{st.median(w):.2f} / {q(w, 0.9):.2f} / {st.mean(w):.2f}      {st.mean(x['usd'] for x in xs):.3f}"
              f"       {st.mean(x['conn'] for x in xs):5.2f}      {st.mean(x['reader'] for x in xs):.2f}"
              f"         {st.mean(x['asks'] for x in xs):.2f}")
W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
ids = {k: sorted(t for t, kk in KIND.items() if kk == k) for k in W}


def mix(c, pick):
    r = {}
    for f in ["usd", "wall", "conn", "reader"]:
        r[f] = sum(W[k] * st.mean(X[(t, c)][f] for t in pick[k]) for k in W)
    r["raised"] = 0.1 * st.mean(X[(t, c)]["raised"] for t in pick["hidden"])
    r["wrong"] = 0.1 * st.mean(X[(t, c)]["raised"] for t in pick["control"]) + 0.8 * st.mean(
        X[(t, c)]["raised"] for t in pick["neutral"])
    return r


print("\n== traffic mix (assumed 1 hidden : 1 control : 8 neutral)")
print("arm        raised  wrong  all-in $/1k  wall mean s  conn/task  reader/task")
for c in C:
    m = mix(c, ids)
    print(f"{c:9}  {m['raised']:.3f}   {m['wrong']:.3f}  {m['usd']:.3f}        {m['wall']:.2f}         "
          f"{m['conn']:.2f}      {m['reader']:.2f}")
random.seed(1)
print("\n== mix pairs a - b, bootstrap 95% (5000 draws, each kind resampled on its own)")
for a, b in [("eden", "tools"), ("both+ask", "tools"), ("both+ask", "eden"), ("both", "eden")]:
    base = {f: mix(a, ids)[f] - mix(b, ids)[f] for f in ["raised", "wrong", "usd", "wall", "conn"]}
    bs = {f: [] for f in base}
    for _ in range(5000):
        pick = {k: [random.choice(v) for _ in v] for k, v in ids.items()}
        ma, mb = mix(a, pick), mix(b, pick)
        for f in base:
            bs[f].append(ma[f] - mb[f])
    cells = "  ".join(f"{f} {base[f]:+.3f} ({sorted(v)[124]:+.3f}..{sorted(v)[4874]:+.3f})" for f, v in bs.items())
    print(f"{a} - {b}: {cells}")
