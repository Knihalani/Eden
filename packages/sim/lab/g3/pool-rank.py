"""G3: where the planted fact sits in the push check's pool, and how much of the pool repeats, at $0.

    python3 -I packages/sim/lab/g3/pool-rank.py DUMP.jsonl [...]

DUMP is the funnel's `--check-dump` (check-dump.ts), e.g. on an empty replay cache (every check fails open, no call):
`bun run funnel --suite dev20 --seeds 41,42 --jobs 1 --allow-misses -- --neutral --check replay --check-cache EMPTY
--check-dump DUMP`. Prints, over the hidden rows, the planted item's rank in the items the check reads, and over all
rows the share of items that repeat an earlier item's source and title, or its shown text too.
"""
import collections
import json
import sys

for f in sys.argv[1:]:
    rows = [json.loads(line) for line in open(f)]
    print(f, len(rows), dict(collections.Counter(r.get("variant") for r in rows)))
    hidden = [r for r in rows if r.get("variant") == "hidden"]
    ranks = collections.Counter()
    for r in hidden:
        ids = [it["id"] for it in r["items"]]
        ranks[ids.index(r["planted"]) + 1 if r.get("planted") in ids else 0] += 1
    inpool = sum(v for k, v in ranks.items() if k)
    print(f"  hidden checks {len(hidden)}: planted in the pool {inpool}, absent {ranks[0]}")
    seen = 0
    for k in range(1, 16):
        seen += ranks[k]
        print(f"    rank <= {k}: {seen} ({100 * seen / max(1, inpool):.1f}%)")
    items = titled = same = planted_titled = 0
    for r in rows:
        st, sx = set(), set()
        for it in r["items"]:
            items += 1
            k, x = (it["source"], it["title"]), (it["source"], it["title"], it["text"])
            if k in st:
                titled += 1
                planted_titled += it["id"] == r.get("planted")
            same += x in sx
            st.add(k)
            sx.add(x)
    print(f"  items read {items}: {titled} ({100 * titled / max(1, items):.1f}%) repeat an earlier source and title "
          f"({planted_titled} of them the planted item), {same} ({100 * same / max(1, items):.1f}%) its shown text too")
    print(f"  mean items a check {items / max(1, len(rows)):.1f}")
