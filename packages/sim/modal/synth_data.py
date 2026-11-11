"""M2's synthetic worlds (D880-D884): loading, checks and labelled pairs, for M1 (the changes-what-to-do checker) and
M3 (the task retriever). Lab tooling, not product code; no Modal import, so it is unit-tested with the other modules.

A world (one JSON line) is a synthetic user's items and tasks; each task has requests (phrasings), a planted fact, its
decoy twin and neutral items. Labels come from construction, as in packages/sim/src/lab/synth/labels.ts:

    changes    the item is the request's own task's fact: it changes what the agent should do
    clear      the item is that task's decoy or a neutral item: relevant, all clear
    unrelated  any other item of the world

`visible` says whether the item existed when the request was made (a late or multi-day fact arrives after its first
request; a silent change's earlier revision is gone once the edit lands). A label describes the item read on its own:
a world holds both a fact and its decoy, as a lab world holds one or the other.

    import synth_data as sd
    worlds = sd.load_worlds(".local/m2/synth/worlds/train.jsonl")
    for p in sd.pairs(worlds[0]): ...                      # every (request, item) pair, with text
    rows = sd.sample_pairs(worlds, unrelated=8, seed=1)    # all changes/clear pairs + 8 unrelated per request
"""
import hashlib
import json
import random

LABELS = ("changes", "clear", "unrelated")
SPLITS = ("train", "val", "test")


def load_worlds(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def check_world(w):
    """The structural checks the TypeScript schema makes (schema.ts checkWorld), minus weekdays: problems, or []."""
    p = []
    items = {i["id"]: i for i in w["items"]}
    if len(items) != len(w["items"]):
        p.append("duplicate item ids")
    owner = {}
    req_ids = set()
    for t in w["tasks"]:
        for iid in [t["fact"], t["decoy"], *t["neutrals"]]:
            if iid not in items:
                p.append(f"{t['id']}: no item {iid}")
            if iid in owner:
                p.append(f"{t['id']}: item {iid} already belongs to {owner[iid]}")
            owner[iid] = t["id"]
        if not t["requests"]:
            p.append(f"{t['id']}: no requests")
        for r in t["requests"]:
            if r["id"] in req_ids:
                p.append(f"{t['id']}: duplicate request id {r['id']}")
            req_ids.add(r["id"])
        fact, decoy = items.get(t["fact"]), items.get(t["decoy"])
        if fact and decoy and t["timing"] == "silent" and fact.get("revisionOf") != decoy["id"]:
            p.append(f"{t['id']}: silent fact does not revise the decoy")
    if w.get("split") not in SPLITS:
        p.append(f"split {w.get('split')!r}")
    return p


def _replaced_at(w):
    return {i["revisionOf"]: i["at"] for i in w["items"] if i.get("revisionOf")}


def pairs(w, with_text=True):
    """Every (request, item) pair of a world with its label, role and visibility (labels.ts pairsOf)."""
    gone = _replaced_at(w)
    out = []
    for t in w["tasks"]:
        neutrals = set(t["neutrals"])
        for r in t["requests"]:
            for i in w["items"]:
                role = (
                    "fact"
                    if i["id"] == t["fact"]
                    else "decoy"
                    if i["id"] == t["decoy"]
                    else "neutral"
                    if i["id"] in neutrals
                    else "other"
                )
                label = "changes" if role == "fact" else "unrelated" if role == "other" else "clear"
                g = gone.get(i["id"])
                row = {
                    "world": w["id"],
                    "split": w["split"],
                    "task": t["id"],
                    "family": t["family"],
                    "area": t["area"],
                    "archetype": t["archetype"],
                    "timing": t["timing"],
                    "request": r["id"],
                    "style": r["style"],
                    "lang": r["lang"],
                    "item": i["id"],
                    "source": i["source"],
                    "label": label,
                    "role": role,
                    "visible": i["at"] <= r["at"] and (g is None or g > r["at"]),
                }
                if with_text:
                    row["request_text"] = r["text"]
                    row["item_title"] = i["title"]
                    row["item_text"] = i["text"]
                out.append(row)
    return out


def sample_pairs(worlds, unrelated=8, seed=1, with_text=True):
    """All `changes` and `clear` pairs and, per request, `unrelated` of its unrelated pairs drawn by a fixed seed."""
    rng = random.Random(seed)
    out = []
    for w in worlds:
        by_req = {}
        for p in pairs(w, with_text):
            by_req.setdefault(p["request"], []).append(p)
        for ps in by_req.values():
            keep = [p for p in ps if p["label"] != "unrelated"]
            other = [p for p in ps if p["label"] == "unrelated"]
            out += keep + rng.sample(other, min(unrelated, len(other)))
    return out


def summary(worlds):
    """Counts a datasheet reports: worlds, tasks, requests, items, pairs by label, by timing, area, style and language."""
    c = {"worlds": len(worlds), "tasks": 0, "requests": 0, "items": 0, "pairs": 0}
    c.update({k: 0 for k in LABELS})
    by = {"timing": {}, "area": {}, "archetype": {}, "style": {}, "lang": {}, "rare": {}}
    for w in worlds:
        n_items = len(w["items"])
        c["items"] += n_items
        for t in w["tasks"]:
            c["tasks"] += 1
            for k in ("timing", "area", "archetype"):
                by[k][t[k]] = by[k].get(t[k], 0) + 1
            by["rare"][str(t["rare"])] = by["rare"].get(str(t["rare"]), 0) + 1
            n_req = len(t["requests"])
            c["requests"] += n_req
            c["pairs"] += n_req * n_items
            c["changes"] += n_req
            c["clear"] += n_req * (1 + len(t["neutrals"]))
            for r in t["requests"]:
                by["style"][r["style"]] = by["style"].get(r["style"], 0) + 1
                by["lang"][r["lang"]] = by["lang"].get(r["lang"], 0) + 1
    c["unrelated"] = c["pairs"] - c["changes"] - c["clear"]
    c.update(by)
    return c


def split_leaks(worlds_by_split, families):
    """Families or clusters seen in more than one split (must be none: splits are by family cluster, D882)."""
    fam = {f["id"]: f for f in families}
    seen = {}
    for split, ws in worlds_by_split.items():
        for w in ws:
            for t in w["tasks"]:
                f = fam.get(t["family"])
                key = f["cluster"] if f else t["family"]
                seen.setdefault(key, set()).add(split)
    return sorted(k for k, s in seen.items() if len(s) > 1)


def duplicate_requests(worlds_by_split):
    """Request texts (normalised) that appear in two different splits: a near-copy leak a model could memorise."""
    where = {}
    for split, ws in worlds_by_split.items():
        for w in ws:
            for t in w["tasks"]:
                for r in t["requests"]:
                    h = hashlib.sha1(" ".join(r["text"].lower().split()).encode()).hexdigest()
                    where.setdefault(h, set()).add(split)
    return sum(1 for s in where.values() if len(s) > 1)
