# B1 (docs/research/b1-scale-path.md): Eden's time on the agent's path per task (Eden's spans on the "path" lane
# of a pi-ab timeline: `eden.observe` with its push, and each `tool.ask_context`), paired by task between two arms.
# usage: python3 -I path-pair.py A=STEM[,STEM...] B=STEM[,STEM...]   (STEM.tl/tasks.jsonl); bootstrap 95%, seed 1.
import json, random, statistics as st, sys

def load(stems):
    out = {}
    for stem in stems.split(","):
        for line in open(stem + ".tl/tasks.jsonl"):
            if not line.strip():
                continue
            r = json.loads(line)
            open_, ms, obs, ask = {}, 0.0, 0.0, 0.0
            for e in r["events"]:
                if e.get("lane") != "path" or e.get("cat") != "eden":
                    continue
                if e["ph"] == "B":
                    open_[e["id"]] = (e["t"], e["ev"])
                elif e["ph"] == "E" and e["id"] in open_:
                    t0, ev = open_.pop(e["id"])
                    ms += e["t"] - t0
                    if ev == "eden.observe":
                        obs += e["t"] - t0
                    else:
                        ask += e["t"] - t0
            out[r["task"]] = (ms, obs, ask)
    return out

(la, sa), (lb, sb) = (a.split("=", 1) for a in sys.argv[1:3])
A, B = load(sa), load(sb)
both = sorted(set(A) & set(B))
for lab, X in ((la, A), (lb, B)):
    xs = [X[t] for t in both]
    q = sorted(x[0] for x in xs)
    print(f"{lab:6} n {len(xs)}  path mean {st.mean(x[0] for x in xs):7.0f} ms  p50 {q[len(q)//2]:6.0f}  p90 "
          f"{q[int(len(q)*0.9)]:6.0f}  observe mean {st.mean(x[1] for x in xs):6.0f}  ask mean {st.mean(x[2] for x in xs):6.0f}")
d = [B[t][0] - A[t][0] for t in both]
rng = random.Random(1)
boot = sorted(st.mean(rng.choice(d) for _ in d) for _ in range(5000))
print(f"{lb} - {la}: path {st.mean(d):+.0f} ms ({boot[124]:+.0f}..{boot[4874]:+.0f})")
