"""F7: cost and latency per role for runs served by subagents (D1101), from the queue's own records ([EST]).

    python3 -I price-queue.py QUEUE_DIR --arm NAME=RUN:TASKS [--arm …] [--hit 0.9] [--chars-per-token 4]

The queue transport books no usage, so tokens are estimated from sizes: each call in `QUEUE_DIR/calls.jsonl` whose
`run` is RUN (set `EDEN_LAB_QUEUE_RUN=RUN` for the command) is joined by its key to `done/<key>.json`, whose `size`
(characters of system, messages, last message, tools and answer; `batch.ts put` records it) gives its tokens at about
four characters each. A replayed call (a hit) is still a call the product would make, so it counts.

Prices: Haiku 5.5 list, input $0.10, cache read $0.01, cache write $0.125 (5 min), output $0.50 per million (a role
on `claude-sonnet-*` at $1.00 / $0.10 / $1.25 / $5.00 [EST: verify before quoting]). Caching: for Eden's roles the
system prompt is the cached prefix, read on `--hit` of calls (0.90 measured on the real API for the push check, F7
§3) and written on the rest; for the agent, everything before its last message (system, tools, the turns so far) is
the prefix, read on `--hit` of calls. Latency: H3's fit for a Haiku call, 596 ms + 2.93 ms an output token, summed per
task for the roles on the request path (`eden.check`, `agent`) [EST: the agent's own calls were never fitted].

Per arm and role: calls, calls a task, tokens a call, $ per 1,000 tasks and per task, and the path roles' wait a
task. TASKS is the arm's finished task count.
"""
import argparse
import json
import os
from collections import defaultdict

HAIKU = {"in": 0.10e-6, "cr": 0.01e-6, "cw": 0.125e-6, "out": 0.50e-6}
SONNET = {"in": 1.00e-6, "cr": 0.10e-6, "cw": 1.25e-6, "out": 5.00e-6}
PATH = {"eden.check", "agent"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("queue")
    ap.add_argument("--arm", action="append", required=True)
    ap.add_argument("--hit", type=float, default=0.9)
    ap.add_argument("--chars-per-token", type=float, default=4.0)
    a = ap.parse_args()
    cpt = a.chars_per_token
    calls = [json.loads(l) for l in open(os.path.join(a.queue, "calls.jsonl")) if l.strip()]
    sizes = {}
    for f in os.listdir(os.path.join(a.queue, "done")):
        d = json.load(open(os.path.join(a.queue, "done", f)))
        if "size" in d:
            sizes[d["id"]] = d["size"]
    for spec in a.arm:
        name, rest = spec.split("=", 1)
        run, tasks = rest.rsplit(":", 1)
        tasks = int(tasks)
        by = defaultdict(lambda: defaultdict(float))
        unsized = 0
        for c in calls:
            if c.get("run") != run:
                continue
            s = sizes.get(c["key"])
            if not s:
                unsized += 1
                continue
            role = c.get("role") or "agent"
            total_in = (s["system"] + s["messages"] + s["tools"]) / cpt
            prefix = (s["system"] / cpt) if role.startswith("eden.") else total_in - s["last"] / cpt
            price = SONNET if "sonnet" in str(c.get("model", "")) else HAIKU
            out = s["out"] / cpt
            d = by[role]
            d["calls"] += 1
            d["in"] += total_in
            d["prefix"] += prefix
            d["out"] += out
            d["usd"] += (
                (total_in - prefix) * price["in"]
                + prefix * (a.hit * price["cr"] + (1 - a.hit) * price["cw"])
                + out * price["out"]
            )
            if role in PATH:
                d["wait"] += 596 + 2.93 * out
        print(f"{name} (run {run}, {tasks} tasks) [EST; served by subagents (D1101)]")
        if unsized:
            print(f"  {unsized} calls had no sized answer in done/ (answered before batch.ts kept sizes): not priced")
        total = 0.0
        wait = 0.0
        for role, d in sorted(by.items()):
            n = d["calls"]
            total += d["usd"]
            wait += d["wait"]
            line = (
                f"  {role}: {n:.0f} calls, {n / tasks:.3f} a task; a call {d['in'] / n:.0f} in "
                f"({d['prefix'] / n:.0f} cacheable), {d['out'] / n:.0f} out, ${d['usd'] / n:.6f}; "
                f"${1000 * d['usd'] / tasks:.4f} per 1,000 tasks"
            )
            if role in PATH:
                line += f"; modelled wait {d['wait'] / tasks:.0f} ms a task"
            print(line)
        print(
            f"  all roles: ${1000 * total / tasks:.4f} per 1,000 tasks; "
            f"path roles' modelled wait {wait / tasks:.0f} ms a task"
        )


main()
