"""F4 — a distilled per-user need model: one sparse linear classifier per memory, trained on self-play.

Training data comes only from the sleep compiler (never a benchmark cue):
  positives of m: m's compiled `needs` and m's own text;
  negatives of m: m's `near`, every other memory's `needs`, and the store's `background`.
Features: TF-IDF of word 1-2-grams and character 3-5-grams (within word boundaries). Logistic regression per memory
(one-vs-rest, class-balanced). The hot path is one sparse vectorize + one sparse mat-vec: sub-millisecond at 300 rows.
Score = the classifier's probability, so the gate's theta is a calibrated need probability.
"""
import numpy as np
from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from compiled import load_compiled
from methods_lex import cue_text


class Distill:
    def __init__(self, fx, C=4.0, other_neg=True, char=True, extra=None):
        user, mem = load_compiled(fx.name)
        self.fx = fx
        ids = [m["id"] for m in fx.memories]
        X, Y = [], []  # Y: owner id for positives, "" for near-of-nobody background, ("near", id) for hard negs
        for m in fx.memories:
            e = mem.get(m["id"], {})
            for t in e.get("needs", []) + [f"{m.get('subject', '')} {m['text']}"]:
                X.append(t); Y.append(("pos", m["id"]))
            for t in e.get("near", []):
                X.append(t); Y.append(("near", m["id"]))
        for t in user.get("background", []):
            X.append(t); Y.append(("bg", None))
        for t, owner in (extra or []):
            X.append(t); Y.append(("pos", owner) if owner else ("bg", None))
        self.wv = TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True, lowercase=True)
        self.cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2, sublinear_tf=True) if char else None
        F = self._fit(X)
        self.ids, self.models = [], []
        for i in ids:
            y = np.array([1 if (k == "pos" and o == i) else 0 for k, o in Y])
            if y.sum() == 0:
                continue
            w = np.ones(len(Y))
            if not other_neg:  # only near + background as negatives
                w = np.array([1.0 if (k != "pos" or o == i) else 0.0 for k, o in Y])
            clf = LogisticRegression(C=C, class_weight="balanced", max_iter=2000)
            clf.fit(F, y, sample_weight=w)
            self.ids.append(i); self.models.append(clf)
        self.Wm = np.vstack([m.coef_[0] for m in self.models])
        self.b = np.array([m.intercept_[0] for m in self.models])

    def _fit(self, X):
        A = self.wv.fit_transform(X)
        return hstack([A, self.cv.fit_transform(X)]).tocsr() if self.cv else A

    def _vec(self, t):
        A = self.wv.transform([t])
        return hstack([A, self.cv.transform([t])]).tocsr() if self.cv else A

    def probs(self, c):
        z = self._vec(cue_text(c)) @ self.Wm.T + self.b
        return 1 / (1 + np.exp(-np.asarray(z).ravel()))

    def scores(self, c):
        p = self.probs(c)
        vis = {m["id"] for m in self.fx.visible(c)}
        return {i: float(x) for i, x in zip(self.ids, p) if i in vis and x > 0.05}
