# Assemble fixture/cues.jsonl and fixture/memories.jsonl; group split dev/test by gold memory (no memory's cues straddle splits).
import json, hashlib
def rows(p): return [l.rstrip("\n").split("|") for l in open(p) if l.strip() and not l.startswith("#")]
mems = [dict(id=r[0], scope=r[1], kind=r[2], subject=r[3], text=r[4], superseded_by=r[5] or None) for r in rows("fixture/memories.psv")]
json.dump(mems, open("fixture/memories.json", "w"), indent=0)
mid = {m["id"]: m for m in mems}
cues = []
for path, author in [("fixture/cues-hand.psv", "hand"), ("fixture/cues-llm.psv", "qwen2.5-3b")]:
    for r in rows(path):
        cat, scope, gold, cue, lp, prev = (r + ["", ""])[:6]
        cat = {"llm-natural": "natural"}.get(cat, cat)
        g = [x for x in gold.split(",") if x]
        for x in g:
            assert x in mid and not mid[x]["superseded_by"], x
            assert mid[x]["scope"] in ("", scope), (x, scope, cue)
        cues.append(dict(cat=cat, scope=scope, gold=g, cue=cue.strip(), last_paths=[p for p in lp.split(",") if p], prev_turn=prev.strip(), author=author))
def h(s): return int(hashlib.md5(s.encode()).hexdigest(), 16) % 2
# union-find over co-gold memories so no memory's cues straddle dev/test
par = {}
def find(x):
    par.setdefault(x, x)
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
for c in cues:
    for g in c["gold"][1:]: par[find(g)] = find(c["gold"][0])
for i, c in enumerate(cues):
    c["id"] = f"q{i:03d}"
    c["split"] = "dev" if h(find(c["gold"][0]) if c["gold"] else c["cue"]) == 0 else "test"
json.dump(cues, open("fixture/cues.json", "w"), indent=0)
from collections import Counter
print(len(mems), "memories;", sum(1 for m in mems if not m["superseded_by"]), "live")
print(len(cues), "cues", Counter((c["cat"], c["split"]) for c in cues))
print(Counter(c["author"] for c in cues))
