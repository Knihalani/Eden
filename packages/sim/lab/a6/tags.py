"""A6 (docs/research/a6-moonshots.md): the card tags in funnel packets (`--packets`), D286's $0 screen.
python3 -I packages/sim/lab/a6/tags.py OFF.packets.jsonl ON.packets.jsonl"""
import json, sys, collections

def load(path):
    return [json.loads(l) for l in open(path)]

def line_of(text, iid, ids):
    # Lines after the header and lead, in citation order.
    body = [l for l in text.split("\n") if l.startswith("- [")]
    return body[ids.index(iid)] if iid in ids and ids.index(iid) < len(body) else None

off, on = load(sys.argv[1]), load(sys.argv[2])
c = collections.Counter()
for a, b in zip(off, on):
    assert (a["suite"], a["seed"], a["variant"], a["template"]) == (b["suite"], b["seed"], b["variant"], b["template"])
    v = b["variant"]
    for pa, pb in zip(a["packets"], b["packets"]):
        if pb["reason"] != "candidates":
            continue
        c[v, "packets"] += 1
        c[v, "bytes_off"] += len(pa["text"].encode())
        c[v, "bytes_on"] += len(pb["text"].encode())
        lines = [l for l in pb["text"].split("\n") if l.startswith("- [")]
        c[v, "items"] += len(lines)
        c[v, "tagged"] += sum("Eden's card: " in l for l in lines)
        p = b.get("planted")
        if p and p in pb["ids"]:
            c[v, "planted_in"] += 1
            l = line_of(pb["text"], p, pb["ids"])
            c[v, "planted_tagged"] += bool(l and "Eden's card: " in l)
for v in ["hidden", "control", "neutral"]:
    n = c[v, "packets"] or 1
    print(f"{v:8} packets {c[v,'packets']:4}  items/packet {c[v,'items']/n:.2f}  tagged/packet {c[v,'tagged']/n:.2f}"
          f"  bytes/packet {c[v,'bytes_off']/n:.0f} -> {c[v,'bytes_on']/n:.0f}"
          f"  planted in packet {c[v,'planted_in']}, tagged {c[v,'planted_tagged']}")
