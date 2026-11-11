"""M12 H4 screen: pseudo-relevance feedback from the push pool's own head, on the funnel's sim worlds ($0).

For each request: expansion terms = the rarest terms of the pool's first `--top` items not in the request; the
expansion's own BM25 search over the world fills the pool's last S seats. Counts facts (hidden) and decoys (control)
brought into the pool, against the shipped pool from the funnel's pool dump."""
import argparse, json, math, os, sys
from collections import Counter
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D

ap = argparse.ArgumentParser()
ap.add_argument("--terms", required=True)
ap.add_argument("--pool", required=True)
ap.add_argument("--top", type=int, default=3)
ap.add_argument("--nterms", type=int, default=8)
ap.add_argument("--seats", type=int, default=5)
ap.add_argument("--maxdf", type=float, default=0.02)
a = ap.parse_args()
pools = {}
for p in D.read_jsonl(a.pool):
    pools[(p["suite"], p["seed"], p["variant"], p["template"])] = [x["id"] if isinstance(x, dict) else x for x in p["pool"]]
res = Counter()
for w in D.load_fit(a.terms):
    items = w["items"]
    V = D.Vocab(sorted({t for it in items for t in it["tf"]}))
    X, idf = D.bm25_matrix(items, V)
    df = Counter(t for it in items for t in it["tf"])
    pos = {it["id"]: i for i, it in enumerate(items)}
    var = w["key"][2]
    if var not in ("hidden", "control"):
        continue
    for t in w["tasks"]:
        k = w["key"] + (t["template"],)
        if k not in pools:
            continue
        pool = pools[k]
        target = pos.get(t["planted"])
        if target is None:
            continue
        res[var] += 1
        inpool = t["planted"] in pool
        res[var + "_in"] += inpool
        q = set(t["q"])
        cand = Counter()
        for rank, pid in enumerate(pool[: a.top]):
            if pid not in pos:
                continue
            for term in items[pos[pid]]["tf"]:
                if term in q or df[term] > a.maxdf * len(items) or len(term) < 3:
                    continue
                cand[term] += idf.get(term, 0) / (1 + rank)
        exp = [x for x, _ in cand.most_common(a.nterms)]
        if not exp:
            res[var + "_kept"] += inpool
            continue
        qv = np.zeros(len(V), np.float32)
        for x in exp:
            qv[V.id[x]] = 1
        sc = X @ qv
        order = [i for i in np.argsort(-sc) if sc[i] > 0]
        head = pool[: 15 - a.seats]
        fill = [items[i]["id"] for i in order if items[i]["id"] not in head][: a.seats]
        newpool = set(head) | set(fill)
        if len(fill) < a.seats:
            newpool |= set(pool[15 - a.seats:][: a.seats - len(fill)])
        res[var + "_kept"] += t["planted"] in newpool
        if not inpool:
            r20 = [items[i]["id"] for i in order[:20]]
            res[var + "_miss_reach20"] += t["planted"] in r20
        if not inpool and t["planted"] in newpool:
            res[var + "_gain"] += 1
        if inpool and t["planted"] not in newpool:
            res[var + "_loss"] += 1
print(dict(res))
