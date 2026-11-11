"""M8 router candidates (round 1). Each is trained on M2 v2 train worlds and scored by harness.main_eval.

  python3 -I packages/sim/lab/m8/routers.py CANDIDATE DATA_DIR [--noise 20] [--train-limit N] [--epochs E]
     [--out results.jsonl] [--save weights.npz]

CANDIDATE: uniform, c1 (type naive Bayes), c2 (hashed bag, learned source vectors), c3 (source as document:
description and held content, no source identity; --binary for 1-bit codes), c4 (per-user source language model),
c6 (names), c7 (learned combiner over c2, c4, c6 and engine-like evidence).
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

DIM = H.DIM


def type_key(sid: str) -> int:
    """A source's identity without a trailing number ("jira-3" -> "jira"): shared across a tenant's connectors."""
    return H.mix32(H.fnv(re.sub(r"[-_]?\d+$", "", sid))) % 4096


class Cache:
    """Per-view precomputation: item feature buckets, an inverted index of unigram buckets, per-item names."""

    def __init__(self, view):
        self.view = view
        self.post: dict[int, list[int]] = {}
        self.names: dict[int, list[int]] = {}
        self.uni: list[np.ndarray] = []
        for k, it in enumerate(view.items):
            u = np.unique(np.asarray([H.mix32(x) % DIM for x in it["h"]], dtype=np.int64))
            self.uni.append(u)
            for t in u.tolist():
                self.post.setdefault(t, []).append(k)
            for nm in it.get("n", []):
                self.names.setdefault(nm, []).append(k)
        self.nsrc = len(view.sources)
        self.len = np.asarray([len(u) for u in self.uni], dtype=np.float64)
        self.desc = [np.asarray([H.mix32(x) % DIM for x in s["d"]], dtype=np.int64) for s in view.sources]
        self.types = np.asarray([type_key(s["id"]) for s in view.sources], dtype=np.int64)


def cache_of(view) -> Cache:
    c = getattr(view, "_m8cache", None)
    if c is None:
        c = Cache(view)
        view._m8cache = c
    return c


def held_mask(view, held: np.ndarray) -> np.ndarray:
    m = np.zeros(len(view.items), dtype=bool)
    m[held] = True
    return m


def lm_scores(c: Cache, req_uni: np.ndarray, mask: np.ndarray, alpha: float = 2.0):
    """c4: per source, sum over request terms of idf-weighted smoothed log-odds of the term in the source's items."""
    ns = c.nsrc
    src = c.view.item_src
    n_s = np.bincount(src[mask], weights=c.len[mask], minlength=ns) + 1.0
    total = n_s.sum()
    out = np.zeros(ns)
    hits = np.zeros(ns)
    for t in np.unique(req_uni).tolist():
        p = c.post.get(t)
        if not p:
            continue
        ids = np.asarray(p, dtype=np.int64)
        ids = ids[mask[ids]]
        if len(ids) == 0:
            continue
        cnt = np.bincount(src[ids], minlength=ns).astype(np.float64)
        holders = (cnt > 0).sum()
        idf = math.log(1 + ns / holders)
        pu = cnt.sum() / total
        # Items of the source holding the term against its share of the user's held items (smoothed log-odds).
        exp = cnt.sum() * n_s / total
        out += idf * np.log((cnt + alpha * exp / max(1e-9, exp.mean())) / (exp + alpha) + 1e-9)
        hits += cnt > 0
    return out, hits


def local_hits(c: Cache, req_uni: np.ndarray, mask: np.ndarray, top: int = 40, k1: float = 1.2, b: float = 0.75):
    """c5 (the engine's `routeLocalHits`, D265, learned): BM25 over the held items; per source, how many of the
    request's `top` best matches it holds and its best match's score (as a share of the best of all)."""
    ns = c.nsrc
    N = int(mask.sum())
    score = np.zeros(len(c.view.items))
    if N == 0:
        return np.zeros(ns), np.zeros(ns)
    avg = c.len[mask].mean()
    for t in np.unique(req_uni).tolist():
        p = c.post.get(t)
        if not p:
            continue
        ids = np.asarray(p, dtype=np.int64)
        ids = ids[mask[ids]]
        if len(ids) == 0:
            continue
        idf = math.log(1 + (N - len(ids) + 0.5) / (len(ids) + 0.5))
        score[ids] += idf * (k1 + 1) / (1 + k1 * (1 - b + b * c.len[ids] / avg))
    cand = np.nonzero(score > 0)[0]
    if len(cand) == 0:
        return np.zeros(ns), np.zeros(ns)
    best = cand[np.argsort(-score[cand], kind="stable")[:top]]
    hits = np.bincount(c.view.item_src[best], minlength=ns).astype(np.float64)
    bs = np.zeros(ns)
    np.maximum.at(bs, c.view.item_src[best], score[best])
    return hits, bs / max(1e-9, score[best[0]])


def name_hits(c: Cache, names: list[int], mask: np.ndarray) -> np.ndarray:
    out = np.zeros(c.nsrc)
    for nm in names:
        p = c.names.get(nm)
        if not p:
            continue
        ids = np.asarray(p, dtype=np.int64)
        ids = ids[mask[ids]]
        out += np.bincount(c.view.item_src[ids], minlength=c.nsrc) > 0
    return out


class Uniform:
    def fit(self, worlds, **kw):
        pass

    def user(self, view):
        return {}

    def score(self, st, req, view, held):
        return np.zeros(len(view.sources))

    def used(self, st, view, src):
        pass


class UsedPrior(Uniform):
    """Only the per-user history: how often each source held a needed item before (plus its held size)."""

    def user(self, view):
        return {"used": np.zeros(len(view.sources))}

    def score(self, st, req, view, held):
        c = cache_of(view)
        n = np.bincount(view.item_src[held], minlength=c.nsrc)
        return np.log1p(st["used"]) * 2 + 0.3 * np.log1p(n)

    def used(self, st, view, src):
        st["used"][src] += 1


class C1(Uniform):
    """Naive Bayes over source type with hashed request unigrams+bigrams."""

    def __init__(self, buckets=1 << 16):
        self.B = buckets

    def fit(self, worlds, **kw):
        T = 4096
        self.cnt = np.ones((T, self.B), dtype=np.float32) * 0.1
        self.prior = np.ones(T)
        for w in worlds:
            for kind, *rest in H.replay(w, 0):
                if kind != "req":
                    continue
                ex = rest[0]
                t = type_key(ex.view.sources[ex.label]["id"])
                f = H.feats(ex.req["h"]) % self.B
                np.add.at(self.cnt[t], f, 1.0)
                self.prior[t] += 1
        self.logp = np.log(self.cnt / self.cnt.sum(1, keepdims=True))
        self.lprior = np.log(self.prior / self.prior.sum())

    def score(self, st, req, view, held):
        c = cache_of(view)
        f = H.feats(req["h"]) % self.B
        return self.lprior[c.types] + self.logp[c.types][:, f].sum(1) / max(1, len(f)) * 8


class C4(UsedPrior):
    """Per-user source language model over the held items (no global training)."""

    def score(self, st, req, view, held):
        c = cache_of(view)
        mask = held_mask(view, held)
        uni = np.asarray([H.mix32(x) % DIM for x in req["h"]], dtype=np.int64)
        s, _ = lm_scores(c, uni, mask)
        return s + super().score(st, req, view, held)


class C6(UsedPrior):
    def score(self, st, req, view, held):
        c = cache_of(view)
        return 2 * name_hits(c, req.get("n", []), held_mask(view, held)) + super().score(st, req, view, held)


class C5(UsedPrior):
    """Local evidence alone: the request's best matches among the held items, per source."""

    def score(self, st, req, view, held):
        c = cache_of(view)
        uni = np.asarray([H.mix32(x) % DIM for x in req["h"]], dtype=np.int64)
        h, bs = local_hits(c, uni, held_mask(view, held))
        return 3 * bs + np.log2(1 + h) + 0.3 * np.log1p(st["used"])


class Emb(Uniform):
    """c2 / c3: request bag q = mean E[f]; source vector from its identity (c2) and/or description and held content
    (c3); score = q.v + b. Listwise softmax over the user's sources, Adagrad."""

    def __init__(self, d=48, ident=True, content=True, binary=False, lr=0.08, epochs=2, noise=20, seed=0):
        self.d, self.ident, self.content, self.binary = d, ident, content, binary
        self.lr, self.epochs, self.noise = lr, epochs, noise
        rng = np.random.default_rng(seed)
        self.E = (rng.standard_normal((DIM, d)) * 0.05).astype(np.float32)  # request terms
        self.D = (rng.standard_normal((DIM, d)) * 0.05).astype(np.float32)  # description + content terms
        self.T = (rng.standard_normal((4096, d)) * 0.05).astype(np.float32)  # source identity
        self.b = np.zeros(4096, dtype=np.float32)
        self.G = {k: np.full(v.shape[0], 1e-3, dtype=np.float32) for k, v in (("E", self.E), ("D", self.D), ("T", self.T))}
        self.Gb = np.full(4096, 1e-3, dtype=np.float32)

    def src_parts(self, c: Cache, mask: np.ndarray):
        """Per source: the term ids its vector averages (description, then the top content terms it holds)."""
        parts = []
        for s in range(c.nsrc):
            ids = [c.desc[s]]
            if self.content:
                its = np.nonzero(mask & (c.view.item_src == s))[0]
                if len(its):
                    allt = np.concatenate([c.uni[k] for k in its[-24:]])
                    u, n = np.unique(allt, return_counts=True)
                    top = u[np.argsort(-n, kind="stable")[:48]]
                    ids.append(top)
            parts.append(np.concatenate(ids) if ids else np.zeros(0, dtype=np.int64))
        return parts

    def vecs(self, c: Cache, parts):
        V = np.zeros((c.nsrc, self.d), dtype=np.float32)
        for s, ids in enumerate(parts):
            if len(ids):
                V[s] += self.D[ids].mean(0)
            if self.ident:
                V[s] += self.T[c.types[s]]
        return V

    def fwd(self, req, view, held):
        c = cache_of(view)
        f = H.feats(req["h"])
        q = self.E[f].mean(0) if len(f) else np.zeros(self.d, dtype=np.float32)
        parts = self.src_parts(c, held_mask(view, held)) if self.content else [c.desc[s] for s in range(c.nsrc)]
        V = self.vecs(c, parts)
        if self.binary:
            qb, Vb = np.sign(q), np.sign(V)
            s = (Vb @ qb) * (np.abs(q).mean() * np.abs(V).mean(1)) + (self.b[c.types] if self.ident else 0)
        else:
            s = V @ q + (self.b[c.types] if self.ident else 0)
        return s, q, V, f, parts, c

    def fit(self, worlds, **kw):
        for ep in range(self.epochs):
            order = np.random.default_rng(ep).permutation(len(worlds))
            n = 0
            loss = 0.0
            for wi in order:
                for kind, *rest in H.replay(worlds[wi], self.noise, ep):
                    if kind != "req":
                        continue
                    ex = rest[0]
                    s, q, V, f, parts, c = self.fwd(ex.req, ex.view, ex.held)
                    p = H.to_probs(s.astype(np.float64)).astype(np.float32)
                    loss -= math.log(max(1e-9, p[ex.label]))
                    g = p.copy()
                    g[ex.label] -= 1  # dL/ds
                    gq = V.T @ g  # d
                    gV = np.outer(g, q)  # S x d
                    self._upd("E", f, np.broadcast_to(gq / max(1, len(f)), (len(f), self.d)))
                    for si, ids in enumerate(parts):
                        if len(ids) and abs(g[si]) > 1e-4:
                            self._upd("D", ids, np.broadcast_to(gV[si] / len(ids), (len(ids), self.d)))
                    if self.ident:
                        self._upd("T", c.types, gV)
                        np.add.at(self.Gb, c.types, g * g)
                        np.add.at(self.b, c.types, -self.lr * g / np.sqrt(self.Gb[c.types]))
                    n += 1
            print(f"  epoch {ep}: loss {loss / max(1, n):.4f} over {n}", file=sys.stderr, flush=True)

    def _upd(self, name, ids, grad):
        M = getattr(self, name)
        G = self.G[name]
        g2 = (grad * grad).mean(1)
        np.add.at(G, ids, g2)
        np.add.at(M, ids, -self.lr * grad / np.sqrt(G[ids])[:, None])

    def score(self, st, req, view, held):
        return self.fwd(req, view, held)[0]


class C7(UsedPrior):
    """Learned combiner: a 2-layer MLP (16 hidden) over per-(request, source) evidence, trained listwise."""

    NF = 13

    def __init__(self, base: Emb, lr=0.01, epochs=2, noise=20, hidden=16):
        self.base, self.lr, self.epochs, self.noise = base, lr, epochs, noise
        rng = np.random.default_rng(7)
        self.W1 = (rng.standard_normal((self.NF, hidden)) * 0.3).astype(np.float64)
        self.b1 = np.zeros(hidden)
        self.W2 = (rng.standard_normal(hidden) * 0.3).astype(np.float64)
        self.mu = np.zeros(self.NF)
        self.sd = np.ones(self.NF)

    def x(self, st, req, view, held):
        c = cache_of(view)
        mask = held_mask(view, held)
        uni = np.asarray([H.mix32(x) % DIM for x in req["h"]], dtype=np.int64)
        lm, hits = lm_scores(c, uni, mask)
        lh, lb = local_hits(c, uni, mask)
        nm = name_hits(c, req.get("n", []), mask)
        emb = self.base.score(None, req, view, held)
        n = np.bincount(view.item_src[held], minlength=c.nsrc).astype(np.float64)
        at = req["at"]
        newest = np.full(c.nsrc, 365.0)
        if len(held):
            for s in range(c.nsrc):
                m = view.item_at[held][view.item_src[held] == s]
                if len(m):
                    newest[s] = max(0.0, (at - m.max()) / 86_400_000)
        rq = set(np.unique(uni).tolist())
        desc = np.asarray([len(rq & set(d.tolist())) for d in c.desc], dtype=np.float64)
        # Rare-term evidence: request terms that at most two sources hold.
        rare = np.zeros(c.nsrc)
        for t in rq:
            p = c.post.get(t)
            if not p:
                continue
            ids = np.asarray(p, dtype=np.int64)
            ids = ids[mask[ids]]
            hs = np.unique(view.item_src[ids])
            if 0 < len(hs) <= 2:
                rare[hs] += 1
        X = np.stack(
            [
                emb,
                lm,
                np.log1p(hits),
                nm,
                np.log1p(n),
                np.log1p(newest),
                np.log1p(st["used"]),
                desc,
                rare,
                (n == 0).astype(np.float64),
                np.full(c.nsrc, math.log(c.nsrc)),
                np.log2(1 + lh),
                lb,
            ],
            1,
        )
        return X

    def fit(self, worlds, **kw):
        # Normalisation from a first pass.
        xs = []
        for w in worlds[:60]:
            st = None
            for kind, *rest in H.replay(w, self.noise, 9):
                if kind == "used":
                    if st is not None:
                        st["used"][rest[1]] += 1
                    continue
                ex = rest[0]
                st = st or self.user(ex.view)
                xs.append(self.x(st, ex.req, ex.view, ex.held))
        A = np.concatenate(xs)
        self.mu, self.sd = A.mean(0), A.std(0) + 1e-6
        for ep in range(self.epochs):
            loss, n = 0.0, 0
            for wi in np.random.default_rng(ep).permutation(len(worlds)):
                st = None
                for kind, *rest in H.replay(worlds[wi], self.noise, 10 + ep):
                    if kind == "used":
                        if st is not None:
                            st["used"][rest[1]] += 1
                        continue
                    ex = rest[0]
                    st = st or self.user(ex.view)
                    X = (self.x(st, ex.req, ex.view, ex.held) - self.mu) / self.sd
                    Hh = np.maximum(0, X @ self.W1 + self.b1)
                    s = Hh @ self.W2
                    p = H.to_probs(s)
                    loss -= math.log(max(1e-12, p[ex.label]))
                    g = p.copy()
                    g[ex.label] -= 1
                    gW2 = Hh.T @ g
                    gH = np.outer(g, self.W2) * (Hh > 0)
                    self.W2 -= self.lr * gW2
                    self.W1 -= self.lr * (X.T @ gH)
                    self.b1 -= self.lr * gH.sum(0)
                    n += 1
            print(f"  c7 epoch {ep}: loss {loss / max(1, n):.4f} over {n}", file=sys.stderr, flush=True)

    def score(self, st, req, view, held):
        X = (self.x(st, req, view, held) - self.mu) / self.sd
        return np.maximum(0, X @ self.W1 + self.b1) @ self.W2


class C10(Uniform):
    """Wide conjunctions: a weight per (request term, source identity) and per (request term, description term),
    hashed into 2^20 buckets; listwise softmax with Adagrad. The description half reaches connectors never seen."""

    B = 1 << 20

    def __init__(self, lr=0.1, epochs=2, noise=20, ident=True):
        self.lr, self.epochs, self.noise, self.ident = lr, epochs, noise, ident
        self.W = np.zeros(self.B, dtype=np.float32)
        self.G = np.full(self.B, 1e-2, dtype=np.float32)

    def conj(self, req, view):
        c = cache_of(view)
        f = np.unique(H.feats(req["h"]) % DIM).astype(np.uint64)
        rows = []
        for s in range(c.nsrc):
            keys = list(c.desc[s][:12].astype(np.uint64))
            if self.ident:
                keys.append(np.uint64(c.types[s] + DIM))
            k = np.asarray(keys, dtype=np.uint64)
            ids = ((f[:, None] * np.uint64(0x9E3779B1) + k[None, :]) * np.uint64(0x85EBCA6B)) >> np.uint64(7)
            rows.append((ids.ravel() % np.uint64(self.B)).astype(np.int64))
        return rows

    def fwd(self, req, view):
        rows = self.conj(req, view)
        return np.asarray([self.W[r].sum() / math.sqrt(max(1, len(r))) for r in rows]), rows

    def fit(self, worlds, **kw):
        for ep in range(self.epochs):
            loss, n = 0.0, 0
            for wi in np.random.default_rng(ep).permutation(len(worlds)):
                for kind, *rest in H.replay(worlds[wi], self.noise, ep):
                    if kind != "req":
                        continue
                    ex = rest[0]
                    s, rows = self.fwd(ex.req, ex.view)
                    p = H.to_probs(s)
                    loss -= math.log(max(1e-12, p[ex.label]))
                    g = p.copy()
                    g[ex.label] -= 1
                    for si, r in enumerate(rows):
                        if abs(g[si]) < 1e-4:
                            continue
                        gr = np.float32(g[si] / math.sqrt(max(1, len(r))))
                        np.add.at(self.G, r, gr * gr)
                        np.add.at(self.W, r, -self.lr * gr / np.sqrt(self.G[r]))
                    n += 1
            print(f"  c10 epoch {ep}: loss {loss / max(1, n):.4f} over {n}", file=sys.stderr, flush=True)

    def score(self, st, req, view, held):
        return self.fwd(req, view)[0]


class C9(Emb):
    """Item-level learned routing: each held item gets a vector from its terms; a source scores the log-sum-exp of
    its items' match with the request, plus its description vector. Learns which items point to the needed one."""

    def __init__(self, **kw):
        super().__init__(ident=False, content=False, **kw)

    def item_ids(self, c, k):
        u = c.uni[k]
        return u[:64]

    def fwd(self, req, view, held):
        c = cache_of(view)
        f = H.feats(req["h"])
        q = self.E[f].mean(0) if len(f) else np.zeros(self.d, dtype=np.float32)
        Vd = np.stack([self.D[c.desc[s]].mean(0) if len(c.desc[s]) else np.zeros(self.d, np.float32) for s in range(c.nsrc)])
        sd = Vd @ q
        if not hasattr(c, "_ivec_ver") or c._ivec_ver is not self._ver:
            c._ivec = None
        U = np.stack([self.D[self.item_ids(c, k)].mean(0) for k in held]) if len(held) else np.zeros((0, self.d), np.float32)
        a = U @ q if len(held) else np.zeros(0)
        si = np.full(c.nsrc, -4.0)
        src = view.item_src[held]
        for s in np.unique(src):
            m = a[src == s]
            mx = m.max()
            si[s] = mx + math.log(np.exp(m - mx).sum())
        return sd + si, q, Vd, U, a, src, f, c

    _ver = object()

    def fit(self, worlds, **kw):
        for ep in range(self.epochs):
            loss, n = 0.0, 0
            for wi in np.random.default_rng(ep).permutation(len(worlds)):
                for kind, *rest in H.replay(worlds[wi], self.noise, ep):
                    if kind != "req":
                        continue
                    ex = rest[0]
                    s, q, Vd, U, a, src, f, c = self.fwd(ex.req, ex.view, ex.held)
                    p = H.to_probs(s)
                    loss -= math.log(max(1e-12, p[ex.label]))
                    g = p.copy()
                    g[ex.label] -= 1
                    gq = Vd.T @ g
                    for si_ in range(c.nsrc):
                        if abs(g[si_]) > 1e-4 and len(c.desc[si_]):
                            ids = c.desc[si_]
                            self._upd("D", ids, np.broadcast_to((g[si_] * q / len(ids)).astype(np.float32), (len(ids), self.d)))
                    if len(ex.held):
                        # d s_src / d a_k = softmax of a within the source.
                        w = np.zeros(len(a))
                        for s_ in np.unique(src):
                            m = src == s_
                            e = np.exp(a[m] - a[m].max())
                            w[m] = e / e.sum() * g[s_]
                        gq = gq + U.T @ w
                        for j, k in enumerate(ex.held):
                            if abs(w[j]) > 1e-4:
                                ids = self.item_ids(c, k)
                                self._upd("D", ids, np.broadcast_to((w[j] * q / len(ids)).astype(np.float32), (len(ids), self.d)))
                    self._upd("E", f, np.broadcast_to((gq / max(1, len(f))).astype(np.float32), (len(f), self.d)))
                    n += 1
            print(f"  c9 epoch {ep}: loss {loss / max(1, n):.4f} over {n}", file=sys.stderr, flush=True)

    def score(self, st, req, view, held):
        return self.fwd(req, view, held)[0]


def build(name, a):
    if name == "uniform":
        return Uniform()
    if name == "used":
        return UsedPrior()
    if name == "c1":
        return C1()
    if name == "c4":
        return C4()
    if name == "c6":
        return C6()
    if name == "c5":
        return C5()
    if name == "c10":
        return C10(epochs=a.epochs, noise=a.noise)
    if name == "c10d":
        return C10(epochs=a.epochs, noise=a.noise, ident=False)
    if name == "c9":
        return C9(epochs=a.epochs, noise=a.noise, d=a.dim)
    if name == "c2":
        return Emb(ident=True, content=False, epochs=a.epochs, noise=a.noise, d=a.dim)
    if name == "c3":
        return Emb(ident=False, content=True, binary=a.binary, epochs=a.epochs, noise=a.noise, d=a.dim)
    if name == "c23":
        return Emb(ident=True, content=True, binary=a.binary, epochs=a.epochs, noise=a.noise, d=a.dim)
    if name == "c7":
        return C7(Emb(ident=True, content=True, epochs=a.epochs, noise=a.noise, d=a.dim), epochs=a.epochs, noise=a.noise)
    raise SystemExit(f"unknown candidate {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("candidate")
    ap.add_argument("data")
    ap.add_argument("--noise", type=int, default=20)
    ap.add_argument("--train-limit", type=int, default=None)
    ap.add_argument("--eval-limit", type=int, default=None)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--dim", type=int, default=48)
    ap.add_argument("--binary", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--exclude", default="fact", choices=["fact", "task"])
    a = ap.parse_args()
    H.EXCLUDE = a.exclude
    r = build(a.candidate, a)
    train = H.load(f"{a.data}/x-train.jsonl", a.train_limit)
    import time

    t0 = time.time()
    if isinstance(r, C7):
        cut = int(len(train) * 0.8)
        r.base.fit(train[:cut])
        r.fit(train[cut:])
    else:
        r.fit(train)
    print(f"  trained in {time.time() - t0:.0f}s", file=sys.stderr)
    name = a.candidate + ("-bin" if a.binary else "") + ("-strict" if a.exclude == "task" else "")
    H.main_eval(r, name, a.data, a.noise, a.eval_limit, a.eval_limit, a.out)


if __name__ == "__main__":
    main()
