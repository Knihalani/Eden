#!/usr/bin/env python3
"""C4 (D430): two funnel JSONs task by task, for the ask.

Hidden and decoys delivered (the push), ask-cited, cited in the ask's follow-up packet (`askLateMs`), surfaced
(delivered, ask-cited or in the follow-up), connector calls a task, and the ask's wall ms (p50/p90).

    python3 -I packages/sim/lab/c4/ask-pair.py base.json trial.json
"""
import json
import sys


def rows(path):
    d = json.load(open(path))
    return {(t["suite"], t["seed"], t["variant"], t["template"]): t for t in d["perTask"]}


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(-(-p * len(xs) // 1)) - 1))] if xs else 0


def summary(name, r):
    for v in ("hidden", "control"):
        ts = [t for t in r.values() if t["variant"] == v]
        if not ts:
            continue
        dl = sum(bool(t.get("delivered")) for t in ts)
        ac = sum(bool(t.get("askCited")) for t in ts)
        late = sum("askLateMs" in t for t in ts)
        surf = sum(bool(t.get("delivered") or t.get("askCited") or "askLateMs" in t) for t in ts)
        ms = [t["askMs"] for t in ts if "askMs" in t]
        calls = sum(t.get("calls", 0) for t in ts) / len(ts)
        print(
            f"{name:>8} {v:<8} n {len(ts):>3}  delivered {dl:>3}  ask-cited {ac:>3}  follow-up {late:>3}  "
            f"surfaced {surf:>3}  calls/task {calls:6.1f}  ask ms p50 {q(ms, .5):7.1f} p90 {q(ms, .9):7.1f}"
        )


def main():
    a, b = rows(sys.argv[1]), rows(sys.argv[2])
    summary("base", a)
    summary("trial", b)
    keys = sorted(set(a) & set(b))
    print(f"paired tasks: {len(keys)}")
    for field in ("delivered", "askCited"):
        gained = [k for k in keys if b[k].get(field) and not a[k].get(field)]
        lost = [k for k in keys if a[k].get(field) and not b[k].get(field)]
        print(f"{field}: +{len(gained)} -{len(lost)}")
        for k in lost:
            late = "askLateMs" in b[k]
            print(f"  lost {'/'.join(map(str, k))}{'  (in the follow-up)' if late else ''}")
        for k in gained:
            print(f"  gained {'/'.join(map(str, k))}")


if __name__ == "__main__":
    main()
