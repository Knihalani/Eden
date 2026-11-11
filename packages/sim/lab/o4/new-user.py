#!/usr/bin/env python3
"""O4 (docs/research/o4-new-user.md): a new user's hidden facts by seconds since connect.
   python3 -I packages/sim/lab/o4/new-user.py LABEL=funnel.json ...   (funnel --json files made with -- --connect-at)
Surfaced = delivered or cited by the ask, as the funnel scores it."""
import collections, json, sys

for arg in sys.argv[1:]:
    label, path = arg.split("=", 1)
    rows = json.load(open(path))["perTask"]
    by = collections.defaultdict(list)
    for r in rows:
        by[(r["variant"], r["connectS"])].append(r)
    print(f"== {label}: {len(rows)} rows")
    print("  at s (sent, mean) |  n | hidden surfaced | by push | warm at request | items held | decoys surfaced")
    for at in sorted({k[1] for k in by}):
        h, c = by[("hidden", at)], by[("control", at)]
        surf = lambda xs: sum(1 for r in xs if r["delivered"] or r.get("askCited"))
        sent = sum(r["sinceConnectMs"] for r in h) / max(1, len(h)) / 1000
        print(
            f"  {at:5.0f} ({sent:6.1f})    | {len(h):3d} | {surf(h):3d} {100 * surf(h) / max(1, len(h)):5.1f}%"
            f"     | {sum(1 for r in h if r['delivered']):3d}     | {sum(1 for r in h if r['warmAtRequest']):3d}"
            f"             | {sum(r['syncedAtRequest'] for r in h) / max(1, len(h)):7.0f}"
            f"    | {surf(c):3d} of {len(c)}"
        )
