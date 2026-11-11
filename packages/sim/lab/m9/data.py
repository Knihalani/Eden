"""M9 (D950-D959, docs/research/m9-alias.md): shared loaders for the alias resolver's offline screen.

Reads the funnel's or days-calls' corpus dump and pool dump (simulated data only) into worlds and requests."""
import json
from collections import defaultdict

HELD = {"train5", "train6", "train5r", "train6r", "longtail"}


def load_jsonl(paths):
    for p in paths.split(","):
        for line in open(p):
            if line.strip():
                yield json.loads(line)


def wkey(x):
    return (x.get("suite", "days"), str(x["seed"]), x.get("variant", "days"))


def load(corpus, pool):
    """worlds: key -> {id: item}; reqs: list of request rows with `pool` as ids and `fold` fit|held."""
    worlds = {}
    for w in load_jsonl(corpus):
        items = w["items"]
        worlds[wkey(w)] = {it["id"]: it for it in items}
    reqs = []
    for p in load_jsonl(pool):
        k = wkey(p)
        if k not in worlds:
            continue
        ids = p["pool"] if p["pool"] and isinstance(p["pool"][0], str) else [x["id"] for x in p["pool"]]
        handed = None if p["pool"] and isinstance(p["pool"][0], str) else [x["id"] for x in p["pool"] if x.get("handed")]
        tmpl = p["template"]
        suite = tmpl.split("/")[0] if "/" in tmpl else p.get("suite", "days")
        reqs.append({"w": k, "request": p["request"], "planted": p.get("planted") or "", "pool": ids,
                     "handed": handed, "kind": p.get("kind") or p.get("variant"), "template": tmpl,
                     "fold": "held" if suite in HELD else "fit", "detail": p.get("detail", "")})
    return worlds, reqs
