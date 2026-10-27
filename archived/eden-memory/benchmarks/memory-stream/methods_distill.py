"""C7-E2: the calibrated verifier distilled into a model-free row scorer. Unlike F16 (a turn-level need gate, dead
in C3-E2), it scores each (turn, candidate row) pair. Its teacher is the verifier's calibrated p for that row
(`verify/<world>-cal*`); its weights are learned offline (`distill.py train`), so the hook runs no model.

    score.py --world code-rt1 --store sleep --strict --split fresh --systems "distill:train=code+life,k=2"

Candidates are the verifier's own shortlist (lex top 7 + bank top 15, first 15 unique; `verify.py prep`). A row
fires when its predicted p reaches the threshold stored with the weights (set on the training events).
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from text import content

KINDS = ["fact", "rule", "plan", "procedure", "episode", "preference", "decision", "person"]
FEATURES = (["lex", "bank", "situ", "votes", "lex_rank", "bank_rank", "lex_gap", "bank_gap", "age", "in_window",
             "q_len", "row_cov", "q_cov", "trigger", "n_cand"] + [f"kind_{k}" for k in KINDS])


def weights_path(train):
    return os.path.join(HERE, "distill", f"weights-{train}.json")


class Distill(M.Base):
    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        self.lex = M.Lex(self.rows, stream, items, cov, when=1)
        self.bank = M.Bank(self.rows, stream, items, cov, tau=0.0, when=1)
        self.situ = M.Situation(self.rows, stream, items, cov, tau=0.0, k=999)
        self.k = int(kw.get("k", 2))
        self.model = json.load(open(weights_path(kw["train"]))) if kw.get("train") else None

    def candidates(self, e, now, n=15):
        """The verifier's shortlist (verify.py prep) and each candidate's features."""
        q = dict(e, text_all=M.strip_paste(e["text_all"]))
        a = self.lex.scores(q, now)
        b = self.bank.scores(q, now)
        cand = M.shortlist(a, b, n)
        la = sorted(a, key=lambda i: (-a[i], i))
        lb = sorted(b, key=lambda i: (-b[i], i))
        new = self.situ.phrases(e["text_all"]) - self.situ._seen.get(e["id"], set())
        qt = content(q["text_all"])
        win = self.window.get(e["id"], set())
        top_a, top_b = max(a.values(), default=0.0), max(b.values(), default=0.0)
        rank_a, rank_b = {i: r for r, i in enumerate(la)}, {i: r for r, i in enumerate(lb)}
        X = []
        for i in cand:
            r = self.by_id[i]
            s = sum(self.situ.kw_w[k] for k in new & self.situ.keys.get(i, set()))
            votes = (b.get(i, 0.0) >= 0.25) + (a.get(i, 0.0) >= 6) + (s >= 4)
            rt = content(r["text"])
            x = [math.log1p(a.get(i, 0.0)), b.get(i, 0.0), s, float(votes),
                 1.0 / (1 + rank_a.get(i, 99)), 1.0 / (1 + rank_b.get(i, 99)),
                 top_a - a.get(i, 0.0), top_b - b.get(i, 0.0), math.log1p(max(0.0, now - r["t"])),
                 1.0 if rt and sum(t in win for t in rt) / len(rt) >= 0.6 else 0.0,
                 math.log1p(len(qt)), len(rt & qt) / max(1, len(rt)), len(rt & qt) / max(1, len(qt)),
                 1.0 if e["t"] == "trigger" else 0.0, float(len(cand))]
            X.append(x + [1.0 if r.get("kind") == k else 0.0 for k in KINDS])
        return cand, X

    def predict(self, X):
        m = self.model
        z = (np.array(X) - np.array(m["mean"])) / np.array(m["sd"])
        return 1 / (1 + np.exp(-(z @ np.array(m["w"]) + m["b"])))

    def packet(self, e, now):
        if e["t"] in ("notification", "peer") or len(content(e["text_all"])) < 3:
            return []
        cand, X = self.candidates(e, now)
        if not cand:
            return []
        p = self.predict(X)
        ranked = sorted(range(len(cand)), key=lambda j: (-p[j], cand[j]))
        return [cand[j] for j in ranked if p[j] >= self.model["thr"]][: self.k]


REGISTRY = {"distill": Distill}
