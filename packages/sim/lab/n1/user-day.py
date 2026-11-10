#!/usr/bin/env python3
"""N1: source-days.bench.ts JSONs, connector calls a user a day over days 2-8.

    python3 -I packages/sim/lab/n1/user-day.py name=run.json [...]
"""
import json
import sys

for arg in sys.argv[1:]:
    name, path = arg.split("=", 1)
    d = json.load(open(path))
    days = d["perDay"][1:8]
    f = lambda k: sum(x.get(k, 0) for x in days) / len(days)
    total = f("listBackground") + f("listDemand") + f("search") + f("fetch")
    print(
        f"{name:<8} background {f('listBackground'):7.1f}  on demand {f('listDemand'):6.1f}  searches "
        f"{f('search'):6.1f}  re-reads {f('fetch'):5.1f}  ALL {total:7.1f}  card calls {f('cardCalls'):6.1f}"
    )
