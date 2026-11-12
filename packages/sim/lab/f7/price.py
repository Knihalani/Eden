"""F7: two arms' model spend and the push check's wait, priced per role from token counts ([EST]).

    python3 -I price.py LEDGER --arm NAME=RUN_PREFIX:TASKS [--arm …] [--path-roles eden.check]

For the final comparison (final main against 006b505c) when calls are answered by a stand-in (subagents) that bills
nothing real: each ledger row's input, cache-read, cache-write and output tokens are priced at Haiku 5.5's list
prices (input $0.10, cache read $0.01, cache write $0.125, output $0.50 per million) whatever the row's own cost says.
Per arm and role: calls, calls a task, tokens a call, $ per 1,000 tasks. The roles in `--path-roles` (on the request
path: the push check) also get their modelled wait a task, H3's fit: 596 ms + 2.93 ms an output token a call. TASKS is
the arm's finished task count (a role's calls are spread over them). Rows are matched by `run` starting with the
prefix.
"""
import argparse
import json
from collections import defaultdict

PRICE = {"in": 0.10e-6, "cr": 0.01e-6, "cw": 0.125e-6, "out": 0.50e-6}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ledger", nargs="+")
    ap.add_argument("--arm", action="append", required=True)
    ap.add_argument("--path-roles", default="eden.check")
    a = ap.parse_args()
    path = set(a.path_roles.split(","))
    rows = [json.loads(l) for f in a.ledger for l in open(f) if l.strip()]
    for spec in a.arm:
        name, rest = spec.split("=", 1)
        prefix, tasks = rest.rsplit(":", 1)
        tasks = int(tasks)
        by = defaultdict(lambda: defaultdict(float))
        for r in rows:
            if not str(r.get("run", "")).startswith(prefix):
                continue
            u = r.get("usage", {})
            role = r.get("role", "?")
            d = by[role]
            d["calls"] += 1
            cr, cw = u.get("cachedInputTokens", 0), u.get("cacheWriteTokens", 0) or 0
            d["in"] += u.get("inputTokens", 0) - cr - cw
            d["cr"] += cr
            d["cw"] += cw
            d["out"] += u.get("outputTokens", 0)
            d["wait"] += 596 + 2.93 * u.get("outputTokens", 0)
        total = 0.0
        print(f"{name} ({prefix}, {tasks} tasks) [EST]")
        for role, d in sorted(by.items()):
            usd = sum(d[k] * PRICE[k] for k in PRICE)
            total += usd
            n = d["calls"]
            line = (
                f"  {role}: {n:.0f} calls, {n / tasks:.3f} a task; a call {d['in'] / n:.0f} in + {d['cr'] / n:.0f} "
                f"cache read + {d['cw'] / n:.0f} cache write, {d['out'] / n:.0f} out; ${1000 * usd / tasks:.4f} per 1,000"
            )
            if role in path:
                line += f"; wait {d['wait'] / tasks:.0f} ms a task"
            print(line)
        print(f"  all roles: ${1000 * total / tasks:.4f} per 1,000 tasks")


main()
