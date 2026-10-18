"""F2 — the cue bank (R10's known-method baseline): nearest compiled exemplar, prompt to prompt.

Each live memory owns its compiled `needs` (and its own text) as positive exemplars and its `near` as negatives; the
store shares the compiled `background`. TF-IDF cosine over words and character 4-grams. Score of memory m:
pos(m) - lam * max(0, max(neg(m), bg) - pos(m) + margin) collapses to the r10_eval rule when tuned; here we expose
pos(m) gated by a margin test so `tune()` can pick theta. No dev-cue text enters the bank (unlike r10_eval.py's devneg).
"""
import collections, math, re
import numpy as np
from compiled import load_compiled
from methods_lex import cue_text, toks


def words(t):
    return [w for w in toks(t) if re.fullmatch(r"[a-z0-9]+", w)]


def grams(t):
    out = []
    for w in words(t):
        w = f" {w} "
        out += [w[i:i + 4] for i in range(max(1, len(w) - 3))]
    return out


class Space:
    def __init__(self, docs, feats):
        self.feats = feats
        bags = [collections.Counter(feats(d)) for d in docs]
        df = collections.Counter(t for b in bags for t in b)
        n = len(docs)
        self.idf = {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}
        post = collections.defaultdict(list)
        for i, b in enumerate(bags):
            v = {t: (1 + math.log(c)) * self.idf[t] for t, c in b.items()}
            nm = math.sqrt(sum(x * x for x in v.values())) or 1.0
            for t, x in v.items():
                post[t].append((i, x / nm))
        self.post = {t: (np.array([i for i, _ in p]), np.array([x for _, x in p])) for t, p in post.items()}
        self.n = n

    def cos(self, text):
        b = collections.Counter(self.feats(text))
        v = {t: (1 + math.log(c)) * self.idf[t] for t, c in b.items() if t in self.idf}
        nm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        acc = np.zeros(self.n)
        for t, x in v.items():
            idx, w = self.post[t]
            np.add.at(acc, idx, w * x / nm)
        return acc


class Bank:
    def __init__(self, fx, alpha=0.5, delta=0.0, use_near=True, use_bg=True):
        user, mem = load_compiled(fx.name)
        self.fx, self.alpha, self.delta = fx, alpha, delta
        docs, owner, kind = [], [], []
        for m in fx.memories:
            e = mem.get(m["id"], {})
            for t in e.get("needs", []):
                docs.append(t); owner.append(m["id"]); kind.append(1)
            docs.append(f"{m.get('subject', '')} {m['text']}"); owner.append(m["id"]); kind.append(1)
            if use_near:
                for t in e.get("near", []):
                    docs.append(t); owner.append(m["id"]); kind.append(-1)
        if use_bg:
            for t in user.get("background", []):
                docs.append(t); owner.append(None); kind.append(0)
        self.owner, self.kind = owner, np.array(kind)
        self.W, self.C = Space(docs, words), Space(docs, grams)

    def scores(self, c):
        text = cue_text(c)
        s = self.alpha * self.W.cos(text) + (1 - self.alpha) * self.C.cos(text)
        bg = float(s[self.kind == 0].max()) if (self.kind == 0).any() else 0.0
        pos, neg = {}, {}
        for d in np.nonzero(s > 0)[0]:
            o = self.owner[d]
            if o is None:
                continue
            tgt = pos if self.kind[d] == 1 else neg
            if s[d] > tgt.get(o, 0):
                tgt[o] = float(s[d])
        vis = {m["id"] for m in self.fx.visible(c)}
        return {i: p for i, p in pos.items() if i in vis and p - max(neg.get(i, 0), bg) >= self.delta}
