"""G3: how many of the push pool's items are constraint-like, and whether the planted item is, at $0.

    python3 -I packages/sim/lab/g3/pool-like.py POOLS.jsonl

POOLS is the funnel's `--pool-dump` (`bun run funnel --suite dev20 --seeds 41,42 --jobs 1 --no-ask -- --neutral
--pool-dump POOLS`). Per variant, over the tasks whose pool's first 15 hold a constraint-like item (the push check's
gate): the count of constraint-like items, and for the planted item (the fact, or the control's look-alike) whether
it is in those 15, constraint-like, and names one of the request's anchors.
"""
import collections
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1])]
for v in ("hidden", "control", "neutral"):
    rs = [r for r in rows if r["variant"] == v]
    chk = [r for r in rs if any(p["cl"] for p in r["pool"][:15])]
    like = [sum(p["cl"] for p in r["pool"][:15]) for r in chk]
    print(f"{v}: {len(rs)} tasks, {len(chk)} with a constraint-like item in the pool's first 15; "
          f"mean pool {sum(len(r['pool'][:15]) for r in chk) / max(1, len(chk)):.1f}, "
          f"mean constraint-like {sum(like) / max(1, len(like)):.1f}")
    print("  constraint-like items (9 = 9 or more):", sorted(collections.Counter(min(n, 9) for n in like).items()))
    if v == "neutral":
        continue
    c = collections.Counter()
    for r in chk:
        ids = [p["id"] for p in r["pool"][:15]]
        if r["planted"] not in ids:
            c["absent"] += 1
            continue
        p = r["pool"][ids.index(r["planted"])]
        c["constraint-like" if p["cl"] else "not constraint-like"] += 1
        c["anchored" if p.get("anchored") else "not anchored"] += 1
    print("  planted item:", dict(c))
