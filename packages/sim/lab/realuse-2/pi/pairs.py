# Paired bootstrap 95% intervals over tasks for RealUse-2's Pi heldout15 run (fix-s3b/pair.py's method, 5000 draws,
# seed 1), plus the 1:1:8 traffic mix (an assumption) and per-arm counts.
# usage: python3 pairs.py run-41.json run-42.json ...
import json, sys, random
R, K, E = {}, {}, {}
for f in sys.argv[1:]:
    d = json.load(open(f))
    for t in d["tasks"]:
        K[t["id"]] = t["kind"]
    for r in d["results"]:
        if r.get("facts") is None:
            continue
        R[(r["task"], r["condition"])] = (any(r["facts"].values()), r["wallMs"] / 1000)
        E[(r["task"], r["condition"])] = r
conds = ["tools", "eden", "both", "both+ask"]
print("== counts: raised (hidden) / false concern (control) / any concern (neutral)")
for c in conds:
    row = []
    for kind in ["hidden", "control", "neutral"]:
        ids = [t for t, k in K.items() if k == kind and (t, c) in R]
        row.append(f"{kind} {sum(R[(t, c)][0] for t in ids)}/{len(ids)}")
    rc = [E[(t, c)].get("edenModelCalls", 0) for t in K if (t, c) in E]
    print(f"{c:9} " + "  ".join(row) + f"  eden model calls/task {sum(rc) / len(rc):.2f}")
random.seed(1)
print("== paired differences a - b, bootstrap 95%")
for a, b in [("eden", "tools"), ("both+ask", "tools"), ("both+ask", "eden"), ("both", "eden")]:
    for kind in ["hidden", "control", "neutral"]:
        ids = [t for t, k in K.items() if k == kind and (t, a) in R and (t, b) in R]
        d = [(R[(t, a)][0] - R[(t, b)][0], R[(t, a)][1] - R[(t, b)][1]) for t in ids]

        def ci(i):
            m = sum(x[i] for x in d) / len(d)
            bs = sorted(sum(random.choice(d)[i] for _ in d) / len(d) for _ in range(5000))
            return f"{m:+.3f} ({bs[124]:+.3f}..{bs[4874]:+.3f})"

        print(f"{a} - {b} {kind} n={len(d)} rate {ci(0)} wall s {ci(1)}")
