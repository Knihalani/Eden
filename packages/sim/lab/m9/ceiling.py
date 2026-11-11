"""M9: how many missed facts have per-user evidence at all? For a missed fact F and request Q: a 2-hop path through
another item X of the same user that shares a rare word with Q and a rare word with F (neither in both Q and F)."""
import sys
from collections import Counter, defaultdict
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import data, links
W, R = data.load(sys.argv[1], sys.argv[2])
fold_ = sys.argv[3] if len(sys.argv) > 3 else "fit"
cache = {}
agg = defaultdict(Counter)
for r in R:
    if r["fold"] != fold_ or r["kind"] not in ("hidden", "control") or r["planted"] in r["pool"][:5]:
        continue
    if r["w"] not in cache:
        u = links.User.__new__(links.User)
        items = W[r["w"]]
        tf = {i: set(links.content(it["title"] + " " + it["text"])) for i, it in items.items()}
        df = Counter(w for s in tf.values() for w in s)
        inv = defaultdict(set)
        for i, s in tf.items():
            for w in s:
                inv[w].add(i)
        cache[r["w"]] = (tf, df, inv, len(items))
    tf, df, inv, n = cache[r["w"]]
    q = set(links.content(r["request"]))
    f = tf.get(r["planted"], set())
    g = agg[r["kind"]]
    g["miss"] += 1
    for lim, name in ((15, "rare15"), (40, "rare40")):
        qr = {w for w in q if df[w] <= lim}
        fr = {w for w in f - q if df[w] <= lim}
        shared = q & f
        g[f"direct_{name}"] += bool({w for w in shared if df[w] <= lim})
        hop = any(fr & tf[x] for w in qr for x in inv[w] if x != r["planted"])
        g[f"hop_{name}"] += hop
for k, g in agg.items():
    print(fold_, k, dict(g))
