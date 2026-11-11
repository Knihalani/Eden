"""M10: a cards-and-requests replay file (cards-disk `{h, c, r}` lines) with the cards swapped (lab only).

    python3 -I packages/sim/lab/m10/make_replay.py --out F.jsonl [--cards MICRO.jsonl] [--ablate none|noactions|nodates|...]

The base is the shipped-coverage file (cards-shipped.jsonl.gz): its requests (`r`) stand in every arm. `--cards`: a
`{h, c}` file whose cards replace the shipped ones for those items (an item it lacks keeps no card: `c` null).
`--ablate`: a field removed from every card, to see what the engine consumes.
"""
import argparse, gzip, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "..", "distilled", "cards-shipped.jsonl.gz")
NONE = {"kind": "none", "actions": [], "entities": [], "statement": ""}

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--cards")
ap.add_argument("--ablate", default="")
a = ap.parse_args()
micro = {}
if a.cards:
    for l in open(a.cards):
        if l.strip():
            d = json.loads(l)
            micro[d["h"]] = d["c"]
n = 0
with open(a.out, "w") as f:
    for l in gzip.open(BASE, "rt"):
        if not l.strip():
            continue
        d = json.loads(l)
        if "c" in d:
            c = micro.get(d["h"], d["c"])
            if c is not None and a.ablate:
                c = dict(c)
                for ab in a.ablate.split(","):
                    if ab == "none":
                        c = dict(NONE)
                    elif ab == "noactions" and c.get("kind") != "none":
                        c["actions"] = []
                    elif ab == "nodates":
                        c.pop("start", None); c.pop("end", None)
                    elif ab == "nolimit":
                        c.pop("limit", None); c.pop("unit", None)
                    elif ab == "noentities":
                        c["entities"] = []
                    elif ab == "nostatement":
                        c["statement"] = ""
                    elif ab.startswith("kind="):
                        if c.get("kind") != "none":
                            c["kind"] = ab[5:]
            d["c"] = c
            if c is None:
                del d["c"]
        f.write(json.dumps(d) + "\n")
        n += 1
        micro.pop(d["h"], None) if a.cards else None
    # Items the micro tagger carded that the shipped enricher recorded nothing for (no requests either).
    for h, c in micro.items():
        f.write(json.dumps({"h": h, "c": c}) + "\n")
        n += 1
print(n)
