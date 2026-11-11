"""M10 field agreement between two card sets on the same items (lab only).

    python3 -I packages/sim/lab/m10/score.py --ref REF.jsonl --out OUT.jsonl [--items items.jsonl --split heldout]

REF and OUT are `{h, c}` lines (cards-disk format; the last line of an h wins). Items scored: those in both, or with
`--items`/`--split` only the item rows whose `split` field matches. Fields, over every scored item (none included):
flag (kind not none) and kind accuracy; over items the reference flags: actions Jaccard, span exact (start and end),
limit exact (value; both absent agree), entities token Jaccard. Prints one JSON object.
"""
import argparse, json, re


def load(path):
    out = {}
    for line in open(path):
        if line.strip():
            d = json.loads(line)
            if "c" in d:
                out[d["h"]] = d["c"] or {"kind": "none", "actions": [], "entities": []}
    return out


def toks(ents):
    return {w for e in ents for w in re.findall(r"[a-z0-9]+", e.lower()) if len(w) > 1}


def jac(a, b):
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def flagged(c):
    return c.get("kind", "none") != "none"


def score(ref, out, keys):
    n = len(keys)
    flag = kind = 0
    fl = []
    for h in keys:
        r, o = ref[h], out[h]
        flag += flagged(r) == flagged(o)
        kind += r.get("kind") == o.get("kind")
        if flagged(r):
            fl.append(h)
    act = sum(jac(set(ref[h]["actions"]), set(out[h]["actions"]) if flagged(out[h]) else set()) for h in fl)
    span = sum((ref[h].get("start"), ref[h].get("end")) == ((out[h].get("start"), out[h].get("end")) if flagged(out[h]) else (None, None)) for h in fl)
    lim = sum(ref[h].get("limit") == (out[h].get("limit") if flagged(out[h]) else None) for h in fl)
    ent = sum(jac(toks(ref[h]["entities"]), toks(out[h]["entities"]) if flagged(out[h]) else set()) for h in fl)
    tp = sum(flagged(ref[h]) and flagged(out[h]) for h in keys)
    po = sum(flagged(out[h]) for h in keys)
    m = max(1, len(fl))
    return {
        "items": n,
        "refFlagged": len(fl),
        "outFlagged": po,
        "flagPrecision": round(tp / max(1, po), 4),
        "flagRecall": round(tp / m, 4),
        "flag": round(flag / max(1, n), 4),
        "kind": round(kind / max(1, n), 4),
        "actions": round(act / m, 4),
        "span": round(span / m, 4),
        "limit": round(lim / m, 4),
        "entities": round(ent / m, 4),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--items")
    ap.add_argument("--split")
    a = ap.parse_args()
    ref, out = load(a.ref), load(a.out)
    keys = sorted(set(ref) & set(out))
    if a.items and a.split:
        allowed = {json.loads(l)["h"] for l in open(a.items) if l.strip() and json.loads(l).get("split") == a.split}
        keys = [h for h in keys if h in allowed]
    print(json.dumps(score(ref, out, keys)))
