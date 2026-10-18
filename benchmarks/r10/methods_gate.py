"""F5 — a need-existence gate: P(the situation needs anything from this store), a model of its own.

Which memory and whether any memory are different questions. A hard negative ("what's the capital of Portugal?" with
a Lisbon trip stored) shares words with one memory, so a per-memory score is high; but it reads like a generic
question, unlike every situation in which the store is needed. The gate is a binary classifier trained on self-play:
positives = every memory's compiled `needs`; negatives = the store's compiled `background`. It wraps any base scorer:
score'(m) = score(m) * g(P) where g passes scores when P >= gamma (hard) or scales them by P**beta (soft).
"""
import numpy as np
from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from compiled import load_compiled
from methods_lex import cue_text


class NeedGate:
    def __init__(self, fx, C=2.0):
        user, mem = load_compiled(fx.name)
        pos = [t for m in fx.memories for t in mem.get(m["id"], {}).get("needs", [])]
        neg = list(user.get("background", []))
        X, y = pos + neg, np.array([1] * len(pos) + [0] * len(neg))
        self.wv = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)
        self.cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2, sublinear_tf=True)
        F = hstack([self.wv.fit_transform(X), self.cv.fit_transform(X)]).tocsr()
        self.clf = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(F, y)

    def p(self, c):
        t = cue_text(c)
        F = hstack([self.wv.transform([t]), self.cv.transform([t])]).tocsr()
        return float(self.clf.predict_proba(F)[0, 1])


class Gated:
    def __init__(self, base, gate, gamma=None, beta=None):
        self.base, self.gate, self.gamma, self.beta = base, gate, gamma, beta
        self.fx = base.fx

    def scores(self, c):
        s = self.base.scores(c)
        p = self.gate.p(c)
        if self.gamma is not None and p < self.gamma:
            return {}
        if self.beta is not None:
            return {i: v * p ** self.beta for i, v in s.items()}
        return s
