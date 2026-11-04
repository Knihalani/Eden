"""Eden's effect on an agent's cost, speed and quality with market connector latency and prices.

Reads pi-ab.ts results files (with their timelines) for the `tools` (agent alone) and `eden` (agent with Eden)
conditions, and writes per-task figures:
- quality: hidden facts raised and false concerns, with paired bootstrap intervals;
- speed: wall p50/p90/mean and the paired wall difference;
- connector calls per task: the agent's searches and Eden's source calls (everything Eden called during the task);
- cost per 1,000 tasks: the agent re-priced for several agent models from each request's token split (uncached
  input, cache writes, cache reads, output), Eden's own per-task model calls as billed (Haiku), and connector calls
  priced on several market plans.

  python3 -I market.py OUT.md PROFILE=file1.json,file2.json [PROFILE=...]

Prices are per million tokens (input, output, cache read; cache writes at 1.25 × input) and per 1,000 connector calls,
from the sources named in docs/research/eden-market-effect.md. Re-pricing assumes a bigger agent model would read and
write the same tokens as the Haiku agent did: an estimate, labelled so in the write-up.
"""

import json
import os
import random
import statistics
import sys

MODELS = {  # $ per 1M tokens: input, output, cache read
    "Haiku 5.5": (0.10, 0.50, 0.01),
    "Sonnet 5.5": (2.00, 10.00, 0.20),
    "Opus 5.5": (4.00, 20.00, 0.20),
}
CONNECTORS = {  # $ per 1,000 tool calls
    "First-party APIs (quota only)": 0.0,
    "Composio (overage)": 0.30,
    "Unified.to (Pro)": 0.75,
    "Arcade.dev (Team)": 10.0,
    "Pipedream Connect (overage)": 12.0,
    "Zapier MCP (10k tasks)": 25.8,
}


def load(paths):
    """Task runs keyed by (condition, task id), each with its result and timeline record."""
    runs = {}
    for p in paths:
        d = json.load(open(p))
        tasks = {t["id"]: t for t in d["tasks"]}
        tl = os.path.join(d.get("timeline") or p[: -len(".json")], "tasks.jsonl")
        lines = {}
        for line in open(tl):
            t = json.loads(line)
            lines[(t["condition"], t["task"])] = t
        for r in d["results"]:
            cond, tid = r["condition"], r["task"]
            t = lines.get((cond, tid))
            if t is None or r.get("error"):
                continue
            must = tasks[tid]["must"]
            r = dict(r, rate=sum(1 for m in must if (r.get("facts") or {}).get(m["id"])) / max(1, len(must)))
            runs[(cond, tid)] = (r, t)
    return runs


def raised(r):
    """The share of the task's must-facts raised (analyze.py and pi-ab-report.ts use the same definition)."""
    return r["rate"]


def agent_cost(t, model):
    i, o, c = MODELS[model]
    usd = 0.0
    for q in t["requests"]:
        cached = q.get("cached", 0)
        write = q.get("cacheWrite", 0)
        fresh = q["in"] - cached - write
        usd += (fresh * i + write * i * 1.25 + cached * c + q["out"] * o) / 1e6
    return usd


def eden_sources(t, op=None):
    """Eden's connector calls during the task; `op` "list" counts its sync polls, "search" its searches and fetches."""
    n = 0
    for e in t["events"]:
        if e.get("ev") != "eden.source" or e.get("ph") != "B":
            continue
        is_list = (e.get("data") or {}).get("op") == "list"
        if op is None or (op == "list") == is_list:
            n += 1
    return n


def boot(diffs, n=4000, seed=7):
    rng = random.Random(seed)
    m = [statistics.mean(rng.choices(diffs, k=len(diffs))) for _ in range(n)]
    m.sort()
    return statistics.mean(diffs), m[int(0.025 * n)], m[int(0.975 * n)]


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]


def main():
    out, specs = sys.argv[1], sys.argv[2:]
    lines = []
    for spec in specs:
        name, files = spec.split("=", 1)
        runs = load(files.split(","))
        lines.append(f"## {name}\n")
        for kind in ("hidden", "control"):
            ids = sorted(
                tid
                for (c, tid), (r, t) in runs.items()
                if c == "tools" and t["kind"] == kind and ("eden", tid) in runs
            )
            if not ids:
                continue
            rows = {}
            for cond in ("tools", "eden"):
                rs = [runs[(cond, i)] for i in ids]
                rows[cond] = {
                    "rate": [raised(r) for r, _ in rs],
                    "wall": [t["wallMs"] / 1000 for _, t in rs],
                    "agentCalls": [r["toolCalls"] for r, _ in rs],
                    "edenCalls": [eden_sources(t) for _, t in rs],
                    "edenLists": [eden_sources(t, "list") for _, t in rs],
                    "edenUsd": [r.get("edenCostUsd", 0) for r, _ in rs],
                    "agentUsd": {m: [agent_cost(t, m) for _, t in rs] for m in MODELS},
                    "billed": [r["costUsd"] for r, _ in rs],
                }
            a, b = rows["eden"], rows["tools"]
            what = "hidden facts raised" if kind == "hidden" else "false concerns"
            lines.append(f"### {kind} tasks (n = {len(ids)} paired)\n")
            lines.append("| | Agent alone | Agent + Eden | Difference (95% CI) |")
            lines.append("|---|---|---|---|")
            d = boot([x - y for x, y in zip(a["rate"], b["rate"])])
            lines.append(
                f"| {what} | {100 * statistics.mean(b['rate']):.1f}% | {100 * statistics.mean(a['rate']):.1f}% "
                f"| {100 * d[0]:+.1f} pts ({100 * d[1]:+.1f}..{100 * d[2]:+.1f}) |"
            )
            d = boot([x - y for x, y in zip(a["wall"], b["wall"])])
            lines.append(
                f"| wall p50 / p90 / mean (s) | {q(b['wall'], .5):.2f} / {q(b['wall'], .9):.2f} / "
                f"{statistics.mean(b['wall']):.2f} | {q(a['wall'], .5):.2f} / {q(a['wall'], .9):.2f} / "
                f"{statistics.mean(a['wall']):.2f} | {d[0]:+.2f} s ({d[1]:+.2f}..{d[2]:+.2f}) |"
            )
            ca = [x + y for x, y in zip(a["agentCalls"], a["edenCalls"])]
            lines.append(
                f"| connector calls/task (agent + Eden) | {statistics.mean(b['agentCalls']):.2f} + 0 | "
                f"{statistics.mean(a['agentCalls']):.2f} + {statistics.mean(a['edenCalls']):.2f} | "
                f"{statistics.mean(ca) - statistics.mean(b['agentCalls']):+.2f} |"
            )
            lines.append(
                f"| of Eden's: sync polls (list) / searches | | {statistics.mean(a['edenLists']):.2f} / "
                f"{statistics.mean(a['edenCalls']) - statistics.mean(a['edenLists']):.2f} | |"
            )
            lines.append(
                f"| billed $/1k (Haiku agent + Eden per-task) | {1000 * statistics.mean(b['billed']):.3f} | "
                f"{1000 * statistics.mean(a['billed']) + 1000 * statistics.mean(a['edenUsd']):.3f} | |"
            )
            lines.append("")
            lines.append("Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; "
                         "connector calls per plan):\n")
            lines.append(
                "| Agent model | Connector plan | Agent alone | Agent + Eden | Change "
                "| Agent + Eden, sync by push (no polls billed) | Change |"
            )
            lines.append("|---|---|---|---|---|---|---|")
            for m in MODELS:
                for cn, per_k in CONNECTORS.items():
                    alone = 1000 * statistics.mean(b["agentUsd"][m]) + statistics.mean(b["agentCalls"]) * per_k
                    with_e = (
                        1000 * statistics.mean(a["agentUsd"][m])
                        + 1000 * statistics.mean(a["edenUsd"])
                        + statistics.mean(ca) * per_k
                    )
                    push = with_e - statistics.mean(a["edenLists"]) * per_k
                    lines.append(
                        f"| {m} | {cn} | {alone:.3f} | {with_e:.3f} | {with_e - alone:+.3f} "
                        f"({100 * (with_e / alone - 1):+.0f}%) | {push:.3f} | {push - alone:+.3f} "
                        f"({100 * (push / alone - 1):+.0f}%) |"
                    )
            lines.append("")
    open(out, "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
