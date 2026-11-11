"""H2 (D1050-D1059): the card-call screen's read (`h2-cards-screen.ts` output), $0.

    python3 -I w2.py RUN.jsonl [--ref B20]

Per arm: calls, $ a item over every batch and over the batches whose reply listed requests (a reply with no requests
list leaves its whole batch uncovered and is cheaper, so it flatters the first figure), batches with no requests
list, items carded, items given requests, requests a item. Against the reference arm, on the same items: card kind
agreement (every item) and request-word Jaccard (content words of four letters or more), over every item (an item
one arm left uncovered counts as no words) and over the items both arms gave requests.
"""
import json
import re
import statistics
import sys
from collections import defaultdict

W = re.compile(r"[a-z]{4,}")


def words(r):
    return set(W.findall(" ".join(r or []).lower()))


def jac(a, b):
    a, b = words(a), words(b)
    return len(a & b) / len(a | b) if a | b else 1.0


def listed(row):
    if "requestsListed" in row:
        return row["requestsListed"]
    return any(i["r"] is not None for i in row["items"])


def main():
    path = sys.argv[1]
    ref = sys.argv[sys.argv.index("--ref") + 1] if "--ref" in sys.argv else "B20"
    by = defaultdict(list)
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            by[r["arm"]].append(r)
    items = {}
    for arm, rows in sorted(by.items()):
        n = sum(r["n"] for r in rows)
        ok = [r for r in rows if listed(r)]
        its = {i["h"]: i for r in rows for i in r["items"]}
        items[arm] = its
        carded = sum(1 for i in its.values() if i["kind"] not in (None, "none"))
        req = sum(1 for i in its.values() if i["r"])
        ok_n = sum(r["n"] for r in ok)
        print(
            f"{arm:5} calls {len(rows):3} $/item {sum(r['usd'] for r in rows) / n:.7f}"
            f" listed-only {sum(r['usd'] for r in ok) / max(ok_n, 1):.7f}"
            f" no-requests batches {len(rows) - len(ok)} ({n - ok_n} items)"
            f" in {sum(r['in'] for r in rows) / n:.0f} cached {sum(r['cached'] for r in rows) / n:.0f}"
            f" out {sum(r['out'] for r in rows) / n:.1f} p50 {statistics.median(r['ms'] for r in rows) / 1000:.1f}s"
            f" carded {carded} requested {req} reqs/item {sum(len(i['r'] or []) for i in its.values()) / len(its):.2f}"
        )
    base = items.get(ref, {})
    for arm, its in sorted(items.items()):
        if arm == ref or not base:
            continue
        common = [h for h in base if h in its]
        both = [h for h in common if base[h]["r"] and its[h]["r"]]
        kind = sum(base[h]["kind"] == its[h]["kind"] for h in common) / len(common)
        print(
            f"{arm} vs {ref} on {len(common)}: card kind {kind:.3f}; request words, every item"
            f" {statistics.mean(jac(base[h]['r'], its[h]['r']) for h in common):.3f},"
            f" both requested ({len(both)}) {statistics.mean(jac(base[h]['r'], its[h]['r']) for h in both):.3f}"
        )


main()
