"""M9: the ceiling of a candidate generator. Of the facts outside the shipped pool's first five, how many does the
generator put in its first K new items (an oracle scorer would front exactly those)? Same for twins in control."""
import argparse, sys
from collections import Counter, defaultdict
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import data, links, screen
a = argparse.ArgumentParser()
a.add_argument("--corpus"); a.add_argument("--pool"); a.add_argument("--only", default="fit")
a.add_argument("--hyp", default="hop"); a.add_argument("--rare", type=int, default=15)
a.add_argument("--seeds", type=int, default=5); a.add_argument("--bridges", type=int, default=8)
a.add_argument("--per-link", type=int, default=50); a.add_argument("--bias", type=float, default=0.0)
o = a.parse_args()
W, R = data.load(o.corpus, o.pool)
hyps = set(o.hyp.split(","))
users = {}
agg = defaultdict(Counter)
for r in R:
    if r["fold"] != o.only or r["kind"] not in ("hidden", "control"):
        continue
    if r["w"] not in users:
        u = links.User(W[r["w"]]); u.link_domains(); users[r["w"]] = u
    u = users[r["w"]]
    c = [i for i, _ in screen.candidates(u, r["request"], hyps, o) if i not in r["pool"][:5]]
    g = agg[r["kind"]]
    g["n"] += 1
    miss = r["planted"] not in r["pool"][:5]
    g["miss"] += miss
    for k in (1, 3, 10, 30, 100):
        g[f"@{k}"] += miss and r["planted"] in c[:k]
for k, g in sorted(agg.items()):
    print(o.only, k, dict(g), f"oracle +{100 * g['@10'] / g['n']:.1f} pts at K=10")
