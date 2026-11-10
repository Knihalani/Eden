#!/usr/bin/env python3
"""F1 (D475-D478): one line per quality-cli JSON: stale and deleted deliveries, re-reads and sync calls.

    python3 -I packages/sim/lab/f1/fresh.py name=run.json [name=run.json ...]
"""
import json
import sys


def main():
    print(
        f"{'run':<34} {'stale/upd':>10} {'del dlv/cited':>13} {'re-reads':>8} {'bg calls':>8} {'demand':>7} "
        f"{'calls/lookup':>12} {'precision':>9} {'recall':>7}"
    )
    for arg in sys.argv[1:]:
        name, path = arg.split("=", 1)
        d = json.load(open(path))
        u, x, f, s = d["updates"], d["deletes"], d["freshness"], d.get("sync", {})
        print(
            f"{name:<34} {u['staleDelivered']:>4}/{u['updatedDelivered']:<5} "
            f"{x['deletedDelivered']:>6}/{x['deletedCited']:<6} {f['calls']:>8} {s.get('background', 0):>8} "
            f"{s.get('demand', 0):>7} {d['sources']['callsPerLookup']:>12} {d['overall']['precision']:>9} "
            f"{d['overall']['recall']:>7}"
        )


main()
