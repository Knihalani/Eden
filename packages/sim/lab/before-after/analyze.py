"""The before/after tables of docs/research/final-before-after.md, from pi-ab.ts / hermes-ab.ts results and timelines.

    python3 -I analyze.py OUT.md 'NAME=a.json,b.json:condition' ...

Each argument is one arm: its results files (one per seed, comma-separated) and the condition name inside them, so
arms from two trees (whose conditions share names) are told apart. Prints, and writes to OUT.md, one row per arm and
the paired differences (bootstrap 95% CI over the same task ids) of every arm whose name starts with AFTER against
each other arm. Definitions follow pi-ab-report.ts: rate = the share of the task's must-facts raised; $ = the agent's
cost plus Eden's per-task calls (the reader); background = cards and bridge spend, spread over the arm's task runs;
wall percentiles are nearest-rank (pi-timeline.ts); "Eden on the critical path" is the union of Eden's spans on the
task's `path` lane. Columns that pool hidden and control tasks say so.
"""

import json
import math
import os
import random
import statistics
import sys


def eden_path_ms(events):
    """The union, in ms, of Eden's spans on the task's critical path (lane `path`)."""
    spans, open_ = [], {}
    for e in events:
        if e.get("cat") != "eden" or e.get("lane") != "path":
            continue
        if e["ph"] == "B":
            open_[e["id"]] = e["t"]
        elif e["ph"] == "E" and e["id"] in open_:
            spans.append((open_.pop(e["id"]), e["t"]))
    total, end = 0.0, -1.0
    for a, b in sorted(spans):
        if b > end:
            total += b - max(a, end)
            end = b
    return total


def load(spec):
    name, rest = spec.split("=", 1)
    files, cond = rest.rsplit(":", 1)
    rows, background, samples = {}, 0.0, []
    for f in files.split(","):
        d = json.load(open(f))
        tasks = {t["id"]: t for t in d["tasks"]}
        tdir = d.get("timeline") or f[:-5] + ".timeline"
        timeline = {}
        if os.path.exists(tdir + "/tasks.jsonl"):
            for line in open(tdir + "/tasks.jsonl"):
                if line.strip():
                    rec = json.loads(line)
                    if rec["condition"] == cond:
                        timeline[rec["task"]] = rec
        if os.path.exists(tdir + "/samples.jsonl"):
            samples += [json.loads(line) for line in open(tdir + "/samples.jsonl") if line.strip()]
        background += sum(b["cardsUsd"] + b["bridgeUsd"] for b in d.get("background") or [] if b["condition"] == cond)
        for r in d["results"]:
            if r["condition"] != cond or r.get("error"):
                continue
            must = tasks[r["task"]]["must"]
            raised = sum(1 for m in must if (r.get("facts") or {}).get(m["id"]))
            rec = timeline.get(r["task"], {})
            events = rec.get("events", [])
            requests = rec.get("requests", [])
            rows[r["task"]] = {
                "kind": tasks[r["task"]]["kind"],
                "rate": raised / max(1, len(must)),
                "wall": r["wallMs"] / 1000,
                "agent": r["costUsd"],
                "eden": r.get("edenCostUsd", 0),
                "ttft": rec.get("firstTokenMs"),
                "in": r.get("promptTokens", 0),
                "out": r.get("completionTokens", 0),
                "req_in": sum(q.get("in", 0) for q in requests),
                "cached": sum(q.get("cached", 0) or 0 for q in requests),
                "path": eden_path_ms(events),
                "sources": sum(1 for e in events if e.get("ev") == "eden.source" and e["ph"] == "B"),
                "tools": sum(1 for e in events if str(e.get("ev", "")).startswith("tool.") and e["ph"] == "B"),
            }
    rss = max((s["rssMb"] for s in samples), default=None)
    heap = max((s.get("heapMb", 0) for s in samples), default=None)
    return name, rows, background, rss, heap


def quantile(xs, p):
    """pi-timeline.ts's quantile (nearest rank), as pi-ab-report.ts prints it."""
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, math.ceil(p * len(xs)) - 1))] if xs else float("nan")


def bootstrap(diffs, n=4000, seed=7):
    """The mean of the paired differences and its bootstrap 95% interval."""
    rnd, m = random.Random(seed), len(diffs)
    means = sorted(sum(diffs[rnd.randrange(m)] for _ in range(m)) / m for _ in range(n))
    return sum(diffs) / m, means[int(0.025 * n)], means[int(0.975 * n)]


def ci(x, digits):
    return f"{x[0]:+.{digits}f} ({x[1]:+.{digits}f}..{x[2]:+.{digits}f})"


def main():
    out_path, specs = sys.argv[1], sys.argv[2:]
    arms = [load(s) for s in specs]
    lines = [
        "| Arm | Hidden raised | False concerns | Wall p50/p90 hidden (s) | Wall p50/p90 control (s) "
        "| Eden on the critical path, mean ms (pooled) | TTFT p50 ms | Agent tokens in/out per task (pooled) "
        "| Cache-read share | Agent + Eden live $/1k hidden / control | Background $/1k | All-in $/1k (pooled) "
        "| Eden source calls/task | Agent search calls/task | Peak RSS / heap MB (whole process) |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, rows, background, rss, heap in arms:
        v = list(rows.values())
        hidden = [r for r in v if r["kind"] == "hidden"]
        control = [r for r in v if r["kind"] == "control"]
        per_task = lambda rs: 1000 * statistics.mean(r["agent"] + r["eden"] for r in rs)
        bg = 1000 * background / len(v)
        raised, concerns = sum(r["rate"] for r in hidden), sum(r["rate"] for r in control)
        def walls(rs):
            xs = [r["wall"] for r in rs]
            return f"{quantile(xs, 0.5):.2f} / {quantile(xs, 0.9):.2f}"

        mem = "-" if rss is None else f"{rss:.0f} / {heap:.0f}"
        lines.append(
            f"| {name} | {raised / len(hidden):.1%} ({raised:g}/{len(hidden)}) "
            f"| {concerns / len(control):.1%} ({concerns:g}/{len(control)}) | {walls(hidden)} | {walls(control)} "
            f"| {statistics.mean(r['path'] for r in v):,.0f} "
            f"| {quantile([r['ttft'] for r in v if r['ttft']], 0.5):,.0f} "
            f"| {statistics.mean(r['in'] for r in v):,.0f} / {statistics.mean(r['out'] for r in v):,.0f} "
            f"| {sum(r['cached'] for r in v) / max(1, sum(r['req_in'] for r in v)):.1%} "
            f"| {per_task(hidden):.3f} / {per_task(control):.3f} | {bg:.3f} | {per_task(v) + bg:.3f} "
            f"| {statistics.mean(r['sources'] for r in v):.2f} | {statistics.mean(r['tools'] for r in v):.2f} | {mem} |"
        )
    lines += [
        "",
        "| a − b | kind | n | rate (points) | wall (s) | agent + Eden live $/1k |",
        "|---|---|---|---|---|---|",
    ]
    by = {name: rows for name, rows, *_ in arms}
    for a in [n for n in by if n.startswith("AFTER")]:
        for b in [n for n in by if n != a]:
            for kind in ("hidden", "control"):
                common = [t for t in by[a] if t in by[b] and by[a][t]["kind"] == kind]
                if not common:
                    continue
                x, y = by[a], by[b]
                rate = bootstrap([100 * (x[t]["rate"] - y[t]["rate"]) for t in common])
                wall = bootstrap([x[t]["wall"] - y[t]["wall"] for t in common])
                usd = bootstrap(
                    [1000 * (x[t]["agent"] + x[t]["eden"] - y[t]["agent"] - y[t]["eden"]) for t in common]
                )
                lines.append(f"| {a} − {b} | {kind} | {len(common)} | {ci(rate, 1)} | {ci(wall, 2)} | {ci(usd, 3)} |")
    text = "\n".join(lines) + "\n"
    open(out_path, "w").write(text)
    print(text)


main()
