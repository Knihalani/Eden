"""Resolve contradictory live rows written by different memory authors: the older row becomes superseded by the newer.

Cue labels are remapped mechanically: a superseded id in `gold` moves to `forbidden` and its replacement joins `gold`
(if not there); in `allowed` it is dropped (replacement added to allowed unless gold). The sealed holdout is
decoded, remapped and re-sealed in memory: its text is never printed.

Usage (repo root): python3 benchmarks/memory-life/tools/resolve_conflicts.py
"""
import base64, gzip, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.join(HERE, "../fixture")
# old -> new (found by cue author H, 2026-10-18; decided by date, R10 cycle 0)
PAIRS = {"a013": "c006", "c010": "a040", "c036": "a023", "c035": "a053", "a007": "c067", "a020": "c022",
         "a082": "b066", "c048": "b044", "c045": "b105"}


def remap(cues):
    n = 0
    for c in cues:
        for old, new in PAIRS.items():
            if old in c["gold"]:
                c["gold"] = [x for x in c["gold"] if x != old] + ([new] if new not in c["gold"] else [])
                c.setdefault("forbidden", [])
                c["forbidden"] += [old] if old not in c["forbidden"] else []
                n += 1
            if old in c.get("allowed", []):
                c["allowed"] = [x for x in c["allowed"] if x != old]
                if new not in c["gold"] and new not in c["allowed"]:
                    c["allowed"].append(new)
                n += 1
    return n


if __name__ == "__main__":
    mp = os.path.join(FX, "memories.json")
    mems = json.load(open(mp))
    for m in mems:
        if m["id"] in PAIRS and not m["superseded_by"]:
            m["superseded_by"] = PAIRS[m["id"]]
    json.dump(mems, open(mp, "w"), indent=1, ensure_ascii=False)
    for split in ("dev", "test"):
        p = os.path.join(FX, f"cues-{split}.json")
        if os.path.exists(p):
            cues = json.load(open(p))
            print(split, "labels remapped:", remap(cues))
            json.dump(cues, open(p, "w"), indent=1, ensure_ascii=False)
    p = os.path.join(FX, "holdout.sealed")
    if os.path.exists(p):
        cues = json.loads(gzip.decompress(base64.b64decode(open(p).read())))
        print("holdout labels remapped:", remap(cues))
        open(p, "w").write(base64.b64encode(gzip.compress(json.dumps(cues, ensure_ascii=False).encode())).decode())
