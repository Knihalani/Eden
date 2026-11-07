# CL2's per-arm figures and paired intervals from pi-ab result JSONs and timelines (RealUse-2's arms.py/pairs.py
# method: paired bootstrap over tasks, 5000 draws, seed 1). Cost split: agent (billed), Eden per-task (reader),
# backfill (each suite x condition's background cards spread over that condition's runs in it).
# usage: python3 -I arms.py STEM [STEM ...]     (STEM.json and STEM.timeline/tasks.jsonl)
# Day runs (--day K) carry recap runs with no facts: they are left out of every figure, as pi-ab's report does.
import json, sys, random, statistics as st

X, KIND = {}, {}
for stem in sys.argv[1:]:
    d = json.load(open(stem + ".json"))
    for t in d["tasks"]:
        KIND[t["id"]] = t["kind"]
    bk = {}
    for b in d["background"]:
        n = sum(1 for r in d["results"] if r["condition"] == b["condition"] and r["task"] in set(b["tasks"]))
        for t in b["tasks"]:
            bk[(t, b["condition"])] = (b["cardsUsd"] + b["bridgeUsd"]) / max(n, 1)
    for r in d["results"]:
        if r.get("facts") is None:
            continue
        X[(r["task"], r["condition"])] = {
            "raised": float(any(r["facts"].values())),
            "wall": r["wallMs"] / 1000,
            "agent": r["costUsd"] * 1000,
            "eden": r["edenCostUsd"] * 1000,
            "bk": bk.get((r["task"], r["condition"]), 0) * 1000,
            "reader": 0,
            "conn": 0,
            "crit": 0.0,
        }
    for l in open(stem + ".timeline/tasks.jsonl"):
        t = json.loads(l)
        x = X.get((t["task"], t["condition"]))
        if x is None:
            continue
        evs = [e for e in t["events"] if e.get("ph") in ("B", "I")]
        x["conn"] = sum(1 for e in evs if e["ev"].startswith("tool.search_") or e["ev"] == "eden.source")
        x["reader"] = sum(1 for e in evs if e["ev"] == "eden.reader")
for x in X.values():
    x["usd"] = x["agent"] + x["eden"] + x["bk"]
C = sorted({c for _, c in X}, key=lambda c: ["tools", "eden"].index(c) if c in ("tools", "eden") else 9)
q = lambda v, p: sorted(v)[min(len(v) - 1, int(p * len(v)))]
kinds = [k for k in ["hidden", "control", "neutral"] if k in KIND.values()]
print("arm        kind      n  rate   wall p50/p90/mean s  $/1k all-in = agent + eden + backfill  reader/t conn/t")
for c in C:
    for k in kinds:
        xs = [X[(t, c)] for t, kk in KIND.items() if kk == k and (t, c) in X]
        if not xs:
            continue
        w = [x["wall"] for x in xs]
        m = lambda f: st.mean(x[f] for x in xs)
        print(f"{c:10} {k:8} {len(xs):3} {m('raised'):.3f}  {st.median(w):.2f}/{q(w, 0.9):.2f}/{st.mean(w):.2f}"
              f"       {m('usd'):.3f} = {m('agent'):.3f} + {m('eden'):.3f} + {m('bk'):.3f}"
              f"      {m('reader'):.2f}    {m('conn'):.2f}")
random.seed(1)
print("\n== paired differences a - b, bootstrap 95% (5000 draws)")
pairs = [(a, b) for a, b in [("eden~diet", "eden"), ("eden~stop", "eden"), ("eden~diet", "eden~stop"), ("eden~diet", "tools"), ("eden", "tools")] if a in C and b in C]
for a, b in pairs:
    for k in kinds:
        ids = [t for t, kk in KIND.items() if kk == k and (t, a) in X and (t, b) in X]
        if not ids:
            continue
        cells = []
        for f in ["raised", "wall", "usd", "eden", "reader"]:
            dd = [X[(t, a)][f] - X[(t, b)][f] for t in ids]
            m = sum(dd) / len(dd)
            bs = sorted(sum(random.choice(dd) for _ in dd) / len(dd) for _ in range(5000))
            cells.append(f"{f} {m:+.3f} ({bs[124]:+.3f}..{bs[4874]:+.3f})")
        print(f"{a} - {b} {k} n={len(ids)}: " + "  ".join(cells))
