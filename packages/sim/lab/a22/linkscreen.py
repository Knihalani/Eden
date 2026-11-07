"""A22 (D360; the switch is in commit 3a3e51b9 only, check it out to rerun): how often the planted item (hidden) or its look-alike (control) carries the link line in the push's
candidates packet, from `bun run funnel -- --packets FILE` with `linkLine` on. Usage: linkscreen.py packets.jsonl"""
import json, sys, collections

TAG = "Eden: links to the request: "
c = collections.Counter()
kinds = collections.Counter()
for line in open(sys.argv[1]):
    t = json.loads(line)
    v = t["variant"]
    cand = [p for p in t["packets"] if p["reason"].startswith("candidates")]
    if not cand:
        continue
    c[v, "packets"] += 1
    ids = [i for p in cand for i in p["ids"]]
    lines = [l for p in cand for l in p["text"].split("\n") if l.startswith("- [")]
    for i, l in enumerate(lines):
        c[v, "lines"] += 1
        if TAG in l:
            c[v, "linked"] += 1
            link = l.split(TAG, 1)[1].split(" | ", 1)[0]
            for part in link.split("; "):
                kinds[v, "day" if (part.startswith(("on ", "names ")) or "inside" in part) else "entity"] += 1
    planted = t["planted"]
    pos = [k for k, x in enumerate(ids) if (x if isinstance(x, str) else x.get("itemId")) == planted]
    if pos and pos[0] < len(lines):
        c[v, "planted in packet"] += 1
        if TAG in lines[pos[0]]:
            c[v, "planted linked"] += 1
for v in ("hidden", "control"):
    print(v, {k[1]: n for k, n in c.items() if k[0] == v}, {k[1]: n for k, n in kinds.items() if k[0] == v})
