"""M9: ceiling of SHARED bridges (not per-user): a term-pair table learned on fit templates only (request word ->
fact words, M3's qexpand recipe) and plain BM25 depth, measured as oracle reach of misses at K new items."""
import argparse, sys, math
from collections import Counter, defaultdict
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import data, links
a = argparse.ArgumentParser()
a.add_argument("--corpus"); a.add_argument("--pool"); a.add_argument("--only", default="held")
a.add_argument("--lift", type=float, default=5); a.add_argument("--minT", type=int, default=3)
a.add_argument("--w", type=float, default=0.5)
o = a.parse_args()
W, R = data.load(o.corpus, o.pool)
# Learn the table on fit hidden requests (each template once per suite: originals and reworded).
pair = defaultdict(Counter); qcount = Counter(); seen = set(); itemdf = Counter(); nitems = 0
for w, items in W.items():
    if w[2] != "hidden": continue
    for it in items.values():
        nitems += 1
        for t in set(links.content(it["title"] + " " + it["text"])): itemdf[t] += 1
for r in R:
    if r["fold"] != "fit" or r["kind"] != "hidden": continue
    key = (r["w"][0], r["template"])
    if key in seen: continue
    seen.add(key)
    f = W[r["w"]][r["planted"]]
    fw = set(links.content(f["title"] + " " + f["text"]))
    q = set(links.content(r["request"]))
    for qw in q:
        qcount[qw] += 1
        for t in fw - q: pair[qw][t] += 1
table = {}
for qw, c in pair.items():
    if qcount[qw] < o.minT: continue
    ex = []
    for t, n in c.items():
        share = n / qcount[qw]; lift = share / (itemdf[t] / nitems + 1e-9)
        if n >= o.minT and share >= 0.2 and lift >= o.lift: ex.append((share, t))
    if ex: table[qw] = [t for _, t in sorted(ex, reverse=True)[:5]]
print("table entries", len(table))
users = {}; agg = defaultdict(Counter)
for r in R:
    if r["fold"] != o.only or r["kind"] not in ("hidden", "control"): continue
    if r["w"] not in users: users[r["w"]] = links.User(W[r["w"]])
    u = users[r["w"]]
    q = Counter(links.content(r["request"]))
    plain = [i for i, _ in sorted(u.bm25(q).items(), key=lambda x: -x[1]) if i not in r["pool"][:5]]
    qe = Counter(q)
    for qw in list(q):
        for t in table.get(qw, []): qe[t] += o.w
    exp = [i for i, _ in sorted(u.bm25(qe).items(), key=lambda x: -x[1]) if i not in r["pool"][:5]]
    g = agg[r["kind"]]; g["n"] += 1
    miss = r["planted"] not in r["pool"][:5]; g["miss"] += miss
    for k in (10, 30):
        g[f"bm25@{k}"] += miss and r["planted"] in plain[:k]
        g[f"exp@{k}"] += miss and r["planted"] in exp[:k]
for k, g in sorted(agg.items()): print(o.only, k, dict(g))
