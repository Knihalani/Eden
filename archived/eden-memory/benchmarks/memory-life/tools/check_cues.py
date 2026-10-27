"""Validate a LifeBench cue file. Cue authors run it before they hand a file in.

Usage: python3 benchmarks/memory-life/tools/check_cues.py FILE

Checks every cue's schema, that gold/allowed ids are live memories, that forbidden ids exist, that `para` cues share
no content word with any gold row (R8's strict rule: lex.ts tokens, a light stemmer, a shared 4-char prefix), and
that negatives have no gold. Prints each problem; exits 1 if any.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../../memory-cues/nim"))
from overlap import shared  # noqa: E402

CATS = {"direct", "para", "proactive", "event", "multi", "stale", "neg-hard", "neg-general"}
MEMS = json.load(open(os.path.join(HERE, "../fixture/memories.json")))
BY = {m["id"]: m for m in MEMS}


def problems(c):
    out = []
    for k in ("id", "cat", "cue", "gold", "author"):
        if k not in c:
            out.append(f"missing {k}")
    if out:
        return out
    if c["cat"] not in CATS:
        out.append(f"bad cat {c['cat']}")
    for i in c["gold"] + c.get("allowed", []):
        if i not in BY:
            out.append(f"unknown id {i}")
        elif BY[i]["superseded_by"]:
            out.append(f"{i} is superseded (gold/allowed must be live)")
    for i in c.get("forbidden", []):
        if i not in BY:
            out.append(f"unknown forbidden id {i}")
    neg = c["cat"].startswith("neg")
    if neg and c["gold"]:
        out.append("negative with gold")
    if not neg and not c["gold"]:
        out.append("positive without gold")
    if c["cat"] == "multi" and len(c["gold"]) < 2:
        out.append("multi needs >= 2 gold")
    if c["cat"] == "stale" and not c.get("forbidden"):
        out.append("stale needs forbidden")
    if c["cat"] == "para":
        for g in c["gold"]:
            if g in BY:
                s = shared(c["cue"] + " " + c.get("prev_turn", ""), f"{BY[g]['subject']} {BY[g]['text']}")
                if s:
                    out.append(f"para shares words with {g}: {s}")
    return out


if __name__ == "__main__":
    cues = json.load(open(sys.argv[1]))
    bad = 0
    seen = set()
    for c in cues:
        p = problems(c)
        if c.get("id") in seen:
            p.append("duplicate id")
        seen.add(c.get("id"))
        if p:
            bad += 1
            print(c.get("id"), "|", c.get("cue", "")[:70], "|", "; ".join(p))
    print(f"{len(cues)} cues, {bad} with problems")
    sys.exit(1 if bad else 0)
