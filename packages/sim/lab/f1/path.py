#!/usr/bin/env python3
"""F1: Eden's time on the agent's path and the task's wall time, one arm against another, paired by task.

As b1/path-pair.py, for runs whose files hold several arms: Eden's spans on the "path" lane of a pi-ab timeline
(`eden.observe` with its push, each `tool.ask_context`), per task, and the task's wall ms. Bootstrap 95%, seed 1.

    python3 -I packages/sim/lab/f1/path.py A=STEM:arm[,STEM:arm...] B=STEM:arm[,...]   (STEM.tl/tasks.jsonl)
"""
import json
import random
import statistics as st
import sys


def load(spec):
    out = {}
    for part in spec.split(","):
        stem, arm = part.rsplit(":", 1)
        for line in open(stem + ".tl/tasks.jsonl"):
            if not line.strip():
                continue
            r = json.loads(line)
            if r["condition"] != arm:
                continue
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
            out[r["task"]] = (ms, obs, ask, r["wallMs"])
    return out


def main():
    (la, sa), (lb, sb) = (a.split("=", 1) for a in sys.argv[1:3])
    A, B = load(sa), load(sb)
    both = sorted(set(A) & set(B))
    for lab, X in ((la, A), (lb, B)):
        xs = [X[t] for t in both]
        q = sorted(x[0] for x in xs)
        w = sorted(x[3] for x in xs)
        print(
            f"{lab:8} n {len(xs)}  path mean {st.mean(x[0] for x in xs):6.0f} ms  p50 {q[len(q) // 2]:6.0f}  p90 "
            f"{q[int(len(q) * 0.9)]:6.0f}  observe {st.mean(x[1] for x in xs):6.0f}  ask {st.mean(x[2] for x in xs):6.0f}"
            f"  wall mean {st.mean(w):6.0f}  p50 {w[len(w) // 2]:6.0f}"
        )
    rng = random.Random(1)
    for name, k in (("path", 0), ("wall", 3)):
        d = [B[t][k] - A[t][k] for t in both]
        boot = sorted(st.mean(rng.choice(d) for _ in d) for _ in range(5000))
        print(f"{lb} - {la}: {name} {st.mean(d):+.0f} ms ({boot[124]:+.0f}..{boot[4874]:+.0f})")


main()
