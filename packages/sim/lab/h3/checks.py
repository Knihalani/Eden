"""H3 (docs/research/h3-pushcheck-lean.md): the push check's calls by arm from pi-ab timelines.

    python3 -I checks.py RUN_DIR [RUN_DIR ...]

Per arm, from each task's `eden.check` spans (`out.tl/tasks.jsonl`): tasks, check calls a task, $ a call, input and
output tokens a call, the call's p50 and p90 seconds, and the check's $ per 1,000 tasks on the 1:1:8 mix (each kind's
mean per task, then 0.1 hidden + 0.1 control + 0.8 neutral, as `n5/mix.py` weights).
"""
import collections
import json
import os
import sys

W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0


def main():
    calls = collections.defaultdict(list)
    per_kind = collections.defaultdict(lambda: collections.defaultdict(list))
    for d in sys.argv[1:]:
        for line in open(os.path.join(d, "out.tl", "tasks.jsonl")):
            t = json.loads(line)
            arm = t["condition"]
            opened = {}
            usd = 0.0
            for e in t["events"]:
                if e["ev"] != "eden.check":
                    continue
                if e["ph"] == "B":
                    opened[e["id"]] = e
                elif e["ph"] == "E" and e["id"] in opened:
                    b = opened.pop(e["id"])
                    data = b.get("data") or {}
                    calls[arm].append((e["t"] - b["t"], data.get("in", 0), data.get("out", 0), data.get("cost", 0)))
                    usd += data.get("cost", 0)
            per_kind[arm][t["kind"]].append(usd)
    print(f"{'arm':8} {'tasks':>6} {'calls/task':>10} {'$/call':>9} {'in':>6} {'out':>5} {'p50 s':>6} {'p90 s':>6} {'$/1k mix':>9}")
    for arm in sorted(calls):
        cs = calls[arm]
        n = sum(len(v) for v in per_kind[arm].values())
        mix = sum(W[k] * 1000 * sum(v) / len(v) for k, v in per_kind[arm].items() if k in W and v)
        print(
            f"{arm:8} {n:6d} {len(cs) / n:10.3f} {sum(c[3] for c in cs) / len(cs):9.6f}"
            f" {sum(c[1] for c in cs) / len(cs):6.0f} {sum(c[2] for c in cs) / len(cs):5.0f}"
            f" {pct([c[0] for c in cs], .5) / 1000:6.2f} {pct([c[0] for c in cs], .9) / 1000:6.2f} {mix:9.4f}"
        )


if __name__ == "__main__":
    main()
