"""F16: a distilled need gate (critic C2, D1). A small logistic model decides *whether* a turn needs memory. Its
features are cheap and observable at hook time. Its teacher is a strong model's decision: the agent-pull host's
`call`, or the judge's non-empty pick, on the *other* world's sample. So it never fits labels from the world it is
scored on. When the gate opens, a ranker (the self-play bank, with the compiled cues) fills the packet.

    score.py --world code --store sleep --strict --systems "gated:teacher=pull,from=life,theta=0.5"

Features: log stripped length, ask form, request verb, informing turn, event class (trigger), memory-index entity
hits, phrase novelty in the session, best bank score, best lexical score with cues. Standardized; plain L2 logistic
regression in numpy.
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from text import content

FEATURES = ["len", "ask", "request", "inform", "trigger", "index_hits", "novel", "bank", "lex"]


def featurize(e, now, bank, lex, situ):
    raw = M.strip_paste(e["text_all"])
    toks = content(raw)
    ev = dict(e, text_all=raw)
    b = bank.scores(ev, now)
    lx = lex.scores(ev, now)
    phrases = situ.phrases(raw)
    new = phrases - situ._seen.get(e["id"], set())
    return [
        math.log1p(len(toks)),
        1.0 if M.ASK.search(raw) else 0.0,
        1.0 if M.REQUEST.search(raw) else 0.0,
        1.0 if M.informing(e["text_all"]) else 0.0,
        1.0 if e["t"] == "trigger" else 0.0,
        float(len(phrases)),
        float(len(new)),
        max(b.values(), default=0.0),
        max(lx.values(), default=0.0),
    ]


def fit(X, y, l2=1.0, steps=3000, lr=0.1):
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    w = np.zeros(Z.shape[1])
    b = 0.0
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = p - y
        w -= lr * (Z.T @ g / len(y) + l2 * w / len(y))
        b -= lr * g.mean()
    return {"mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist(), "b": b}


def predict(model, x):
    z = (np.asarray(x) - np.asarray(model["mu"])) / np.asarray(model["sd"])
    return float(1 / (1 + math.exp(-(z @ np.asarray(model["w"]) + model["b"]))))


def teacher_data(world, teacher):
    """(event, label) pairs of `world`'s sample: pull call, or judge non-empty pick."""
    import glob
    out = {}
    sub = "agentpull" if teacher == "pull" else "judge"
    pat = os.path.join(HERE, sub, world if teacher == "pull" else f"{world}-sleep", "out", "*.json")
    for p in glob.glob(pat):
        for c in json.load(open(p))["cases"]:
            out[c["event"]] = bool(c.get("call")) if teacher == "pull" else bool(c.get("needed"))
    return out


def detectors(world, rows_kw):
    import score, sleep
    stream, items = score.load_stream(world)
    cov = score.Coverage(items)
    events = {e["id"]: e for e in score.scored_events(stream)}
    rows = sleep.rows(stream, world, strict=True)
    bank = M.Bank([dict(r) for r in rows], stream, items, cov, tau=0.0, when=1)
    lex = M.Lex([dict(r) for r in rows], stream, items, cov, when=1)
    situ = M.Situation([dict(r) for r in rows], stream, items, cov)
    return events, bank, lex, situ


class Gated(M.Base):
    """The gate decides; the bank (τ `bt`, AND lexical `lt` when given) fills at most k rows."""

    _cache = {}

    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        src, teacher = kw.get("from", "life"), kw.get("teacher", "pull")
        key = (src, teacher)
        if key not in Gated._cache:
            events, bank, lex, situ = detectors(src, {})
            data = teacher_data(src, teacher)
            X, y = [], []
            for eid, lab in sorted(data.items()):
                e = events.get(eid)
                if e is None:
                    continue
                X.append(featurize(e, e["_order"], bank, lex, situ))
                y.append(lab)
            Gated._cache[key] = fit(X, y)
        self.model = Gated._cache[key]
        self.bank = M.Bank(self.rows, stream, items, cov, tau=kw.get("bt", 0.15), when=1)
        self.lex = M.Lex(self.rows, stream, items, cov, when=1)
        self.situ = M.Situation(self.rows, stream, items, cov)
        self.theta = kw.get("theta", 0.5)

    def p_need(self, e, now):
        return predict(self.model, featurize(e, now, self.bank, self.lex, self.situ))

    def packet(self, e, now):
        if e["t"] in ("notification", "peer"):
            return []
        if self.p_need(e, now) < self.theta:
            return []
        ev = dict(e, text_all=M.strip_paste(e["text_all"]))
        sc = self.bank.scores(ev, now)
        lt = self.kw.get("lt")
        if lt is not None:
            lx = self.lex.scores(ev, now)
            sc = {i: v for i, v in sc.items() if lx.get(i, 0.0) >= lt}
        return sorted(sc, key=lambda i: (-sc[i], i))[: self.k]


REGISTRY = {"gated": Gated}
