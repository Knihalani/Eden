#!/usr/bin/env python3
"""F1: source-days.bench.ts JSONs, connector calls a user a day over days 2-8.

    python3 -I packages/sim/lab/f1/days.py name=run.json [...]
"""
import json
import sys

for arg in sys.argv[1:]:
    name, path = arg.split("=", 1)
    d = json.load(open(path))
    days = d["perDay"][1:8]
    f = lambda k: sum(x[k] for x in days) / len(days)
    total = f("listBackground") + f("listDemand") + f("search") + f("fetch")
    cold = d.get("coldTier") or {}
    print(
        f"{name:<10} background {f('listBackground'):7.1f}  on demand {f('listDemand'):6.1f}  (delta reads "
        f"{f('delta'):6.1f})  searches {f('search'):6.1f}  re-reads {f('fetch'):5.1f}  ALL {total:7.1f}  events "
        f"{f('events'):6.1f}  items listed {f('itemsListed'):7.0f}  card calls {f('cardCalls'):6.1f}  cold "
        f"{cold.get('items', 0)} items / {cold.get('bytes', 0) / 1e6:.2f} MB; cold start {d['cold']['listBackground']} calls"
    )
