"""M11's offline screen (lab only): how an expansion changes which items a request reaches, on the screen seeds.

For every hidden and control world of the named suites (seeds 41-42), each task's request (engine-stemmed terms) is
ranked against the world's items three ways: lexical BM25 over the item's own terms; BM25 over the item's intent
text (its expansion); and the two fused by reciprocal rank (c 60). Reported: the planted fact (hidden) and the
look-alike (control) at @5 and @15, the intent-only reach (top 12 with idf coverage >= 0.2, the engine's cut), the
twin gate, the short-item gate and index growth. Arms:

  lexical        no intent text
  haiku-full     every item's Haiku requests (intent-v2)
  haiku-shipped  the shipped enricher's requests only (cards-shipped)
  micro          the expansion on every item (from --exp FILE: {h: {term: tf}})
  micro+shipped  Haiku's shipped requests where they exist, the expansion elsewhere

  python3 -I packages/sim/lab/m11/screen.py --exp .local/m11/exp/NAME.json [--suites held|train|all] [--json OUT]
"""
import argparse, json, math, os, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D  # noqa: E402

K1, B = 1.2, 0.75


class BM25:
    def __init__(self, docs):
        self.docs = docs  # list of Counter
        self.n = len(docs)
        self.avg = sum(sum(d.values()) for d in docs) / max(1, self.n) or 1.0
        df = Counter()
        for d in docs:
            df.update(d.keys())
        self.idf = {t: math.log(1 + (self.n - v + 0.5) / (v + 0.5)) for t, v in df.items()}
        self.post = defaultdict(list)
        for i, d in enumerate(docs):
            for t, tf in d.items():
                self.post[t].append((i, tf))
        self.len = [sum(d.values()) for d in docs]

    def search(self, q):
        qs = [t for t in dict.fromkeys(q) if t in self.idf]
        tot = sum(self.idf[t] for t in qs) or 1.0
        sc, cov = defaultdict(float), defaultdict(float)
        for t in qs:
            idf = self.idf[t]
            for i, tf in self.post[t]:
                sc[i] += idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * self.len[i] / self.avg))
                cov[i] += idf / tot
        order = sorted(sc, key=lambda i: -sc[i])
        return order, cov


def rank_of(order, i):
    try:
        return order.index(i)
    except ValueError:
        return 10**9


def rrf(a, b, c=60):
    s = defaultdict(float)
    for r, i in enumerate(a):
        s[i] += 1 / (c + r + 1)
    for r, i in enumerate(b):
        s[i] += 1 / (c + r + 1)
    return sorted(s, key=lambda i: -s[i])


def intent_text(arm, it, exp):
    """The item's intent terms under an arm, as a Counter (term -> tf), or None."""
    def reqs(rs):
        c = Counter()
        for r in rs:
            c.update(r)
        return c
    if arm == "haiku-full":
        return reqs(it["fullTerms"]) if it.get("fullTerms") else None
    if arm == "haiku-shipped":
        return reqs(it["shippedTerms"]) if it.get("shippedTerms") else None
    if arm == "micro":
        e = exp.get(it["h"])
        return Counter(e) if e else None
    if arm == "micro+shipped":
        if it.get("shippedTerms"):
            return reqs(it["shippedTerms"])
        e = exp.get(it["h"])
        return Counter(e) if e else None
    return None


def screen(items, worlds, exp, arms, suites):
    res = {a: Counter() for a in arms}
    for w in worlds:
        if w["seed"] not in D.SCREEN_SEEDS or w["suite"] not in suites or w["variant"] == "neutral":
            continue
        hs = w["hashes"]
        lex = BM25([Counter(items[h]["terms"]) for h in hs])
        pos = {h: i for i, h in enumerate(hs)}
        for arm in arms:
            texts = [intent_text(arm, items[h], exp) for h in hs]
            ix = BM25([t or Counter() for t in texts]) if arm != "lexical" else None
            for t in w["tasks"]:
                p = t["planted"]
                if p is None or p not in pos:
                    continue
                i = pos[p]
                lo, _ = lex.search(t["terms"])
                kind = "fact" if w["variant"] == "hidden" else "decoy"
                r = res[arm]
                r[f"{kind}_n"] += 1
                if ix is None:
                    fu = lo
                    reach = False
                else:
                    io, cov = ix.search(t["terms"])
                    fu = rrf(lo[:50], [j for j in io if cov[j] >= 0.2][:12])
                    reach = i in [j for j in io if cov[j] >= 0.2][:12]
                    r[f"{kind}_intent12"] += reach
                rk = rank_of(fu, i)
                r[f"{kind}@5"] += rk < 5
                r[f"{kind}@15"] += rk < 15
                r[f"{kind}_pool"] += rank_of(lo, i) < 15 or reach
    return res


def twin_gate(items, worlds, exp, suites, gained_only=True):
    """Pairs (held-out families, screen seeds) where the twin's expansion holds a request term its fact's expansion
    lacks. `gained_only` (the pre-registered gate, m11-intent.md §1): only terms the twin gained, not its own words
    (a term of the twin's own text is matched by the lexical index anyway)."""
    bad = n = 0
    for f, c, q, suite, seed, _ in D.twins(worlds):
        if suite not in suites or seed not in D.SCREEN_SEEDS:
            continue
        n += 1
        ef, ec = set(exp.get(f, {})), set(exp.get(c, {}))
        if gained_only:
            ec -= set(items[c]["terms"])
        if (ec - ef) & set(q):
            bad += 1
    return bad, n


def growth(items, exp, hs):
    a = [len(exp.get(h, {})) / max(1, len(set(items[h]["terms"]))) for h in hs]
    return sum(a) / max(1, len(a)), max(a) if a else 0, sum(len(exp.get(h, {})) for h in hs) / max(1, len(hs))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", default=None)
    ap.add_argument("--suites", default="held")
    ap.add_argument("--arms", default="lexical,haiku-full,haiku-shipped,micro,micro+shipped")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    items, worlds = D.load()
    exp = json.load(open(a.exp)) if a.exp else {}
    suites = D.HELD_SUITES if a.suites == "held" else (
        {"train1", "train2", "train3", "train4"} if a.suites == "train" else set(a.suites.split(",")))
    arms = [x for x in a.arms.split(",") if x.startswith("micro") is False or exp]
    res = screen(items, worlds, exp, arms, suites)
    out = {"suites": sorted(suites), "arms": {k: dict(v) for k, v in res.items()}}
    for arm, r in res.items():
        print(f"{arm:14s} fact@5 {r['fact@5']:4d} @15 {r['fact@15']:4d} pool {r['fact_pool']:4d} intent12 {r['fact_intent12']:4d} /{r['fact_n']}"
              f" | decoy@5 {r['decoy@5']:4d} @15 {r['decoy@15']:4d} pool {r['decoy_pool']:4d} intent12 {r['decoy_intent12']:4d} /{r['decoy_n']}")
    if exp:
        bad, n = twin_gate(items, worlds, exp, suites)
        bad_all, _ = twin_gate(items, worlds, exp, suites, gained_only=False)
        out.update(twin_bad_any=bad_all)
        print(f"twin gate (any term, reference): {bad_all}/{n}")
        held = [h for h, it in items.items() if it["split"] == "held"]
        g = growth(items, exp, held)
        out.update(twin_bad=bad, twin_n=n, growth_mean=g[0], growth_max=g[1], exp_terms=g[2])
        print(f"twin gate: {bad}/{n} pairs where the twin gains a request term its fact lacks; "
              f"growth: {g[0]:.2f}x mean, {g[1]:.2f}x max, {g[2]:.1f} terms/item")
    if a.json:
        json.dump(out, open(a.json, "w"), indent=1)
