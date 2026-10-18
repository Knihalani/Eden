"""F19: static word-vector semantics on the hot path. A lookup table of 300-d word vectors (spaCy en_core_web_md: 20k
vectors; exported by external/export_vec.py to external/cache/vectors-md.npz, git-ignored) makes a turn vector and an
exemplar vector each the idf-weighted mean of their word vectors. There is no model inference: one table lookup per
word, so it is far under a millisecond for a prompt.

A row's score is its best cosine to its self-play `pos` exemplars, minus `m` × its best cosine to the `neg` ones. A row
fires at ≥ tau; the packet is the top k.

    score.py --world code --store sleep --strict --systems "vec:tau=0.8,m=0.5,gate=1"
"""
import math, os, re, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from text import STOP

_TOK = re.compile(r"[A-Za-z][A-Za-z'-]+")
_V = {}


def table():
    if not _V:
        d = np.load(os.path.join(HERE, "external", "cache", "vectors-md.npz"))
        _V["idx"] = {w: i for i, w in enumerate(d["words"].tolist())}
        v = d["vecs"]
        _V["vecs"] = v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)
    return _V


class Embed:
    """idf-weighted mean of word vectors; idf over a reference corpus (the exemplars and rows)."""

    def __init__(self, corpus):
        t = table()
        df = {}
        for text in corpus:
            for w in {w.lower() for w in _TOK.findall(text)}:
                df[w] = df.get(w, 0) + 1
        n = max(1, len(corpus))
        self.idf = {w: math.log((n + 1) / (c + 0.5)) for w, c in df.items()}
        self.default = math.log(n + 1)
        self.t = t

    def __call__(self, text):
        idx, vecs = self.t["idx"], self.t["vecs"]
        acc = np.zeros(vecs.shape[1], dtype=np.float32)
        tot = 0.0
        for w in _TOK.findall(text or ""):
            w = w.lower()
            if w in STOP or w not in idx:
                continue
            wt = self.idf.get(w, self.default)
            acc += wt * vecs[idx[w]]
            tot += wt
        if tot == 0:
            return None
        return acc / (np.linalg.norm(acc) + 1e-9)


class Vec(M.Base):
    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        import selfplay
        ex = selfplay.exemplars(stream["world"].replace("-short", ""))
        corpus = []
        for r in self.rows:
            e = ex.get(r["id"]) or {}
            corpus += e.get("pos", []) + e.get("neg", []) + [r["text"]]
        self.embed = Embed(corpus)
        self.pos, self.neg = {}, {}
        for r in self.rows:
            e = ex.get(r["id"]) or {}
            P = [v for v in (self.embed(t) for t in e.get("pos", [])) if v is not None]
            N = [v for v in (self.embed(t) for t in e.get("neg", [])) if v is not None]
            if P:
                self.pos[r["id"]] = np.stack(P)
                self.neg[r["id"]] = np.stack(N) if N else None

    def scores(self, e, now):
        q = self.embed(M.strip_paste(e["text_all"]))
        if q is None:
            return {}
        m = self.kw.get("m", 0.5)
        out = {}
        for r in self.visible(now):
            P = self.pos.get(r["id"])
            if P is None:
                continue
            sp = float((P @ q).max())
            N = self.neg.get(r["id"])
            sn = float((N @ q).max()) if N is not None else 0.0
            out[r["id"]] = sp - m * sn
        return out

    def packet(self, e, now):
        if self.kw.get("gate") and (e["t"] in ("notification", "peer") or len(M.content(e["text_all"])) < 3):
            return []
        sc = self.scores(e, now)
        tau = self.kw.get("tau", 0.4)
        return [i for i in sorted(sc, key=lambda i: (-sc[i], i)) if sc[i] >= tau][: self.k]


REGISTRY = {"vec": Vec}
