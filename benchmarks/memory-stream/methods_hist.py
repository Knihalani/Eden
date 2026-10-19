"""F20: a per-user need model learned from the user's own history (no model on the hot path).

After each session (sleep time), a model reviews the user's past turns and marks which memories would have helped
(here: the independent labeler's output, `worlds/<world>/labels.json`, written by a different model from the
authors). At hook time, a new turn is compared with the past turns that needed each memory. A memory fires when the
turn is close enough to its own needing turns, and closer to them than to the user's turns that needed nothing.

Causal: a turn only uses labels of sessions that ended before its own session began (sleep runs between
sessions). Scored against the *plan's* labels, which the labeler never saw. Runs on the oracle store (row id =
item id), so it tests the decision, not extraction.

    score.py --world code --store oracle --systems "hist:tau=0.35"
    score.py --world code --store oracle --systems "hist:tau=0.35,margin=0.05,synth=1"   (+ self-play prior)
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from text import content


class Hist(M.Base):
    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        world = stream["world"]
        labels = json.load(open(os.path.join(HERE, "worlds", world, "labels.json")))
        # session start order for every event; each labelled turn becomes usable after its session ends
        self.sess_start, self.sess_end, self.sess_of = {}, {}, {}
        order = 0
        for s in stream["sessions"]:
            first = None
            for ev in s["events"]:
                order += 1
                first = first or order
                self.sess_of[ev["id"]] = s["id"]
            self.sess_start[s["id"]], self.sess_end[s["id"]] = first, order
        self.turns = []  # (usable_from_order, token set, needed items)
        df = {}
        n = 0
        for s in stream["sessions"]:
            for ev in s["events"]:
                if ev["id"] not in labels:
                    continue
                toks = content(M.strip_paste(ev["text_all"]))
                self.turns.append((self.sess_end[s["id"]], toks, set(labels[ev["id"]])))
                n += 1
                for t in toks:
                    df[t] = df.get(t, 0) + 1
        self.idf = {t: math.log((n + 1) / (d + 0.5)) for t, d in df.items()}
        self.vecs = [(u, self._vec(t), need) for u, t, need in self.turns]

    def _vec(self, toks):
        v = {t: self.idf.get(t, 1.0) for t in toks}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {t: x / norm for t, x in v.items()}

    @staticmethod
    def _cos(a, b):
        if len(a) > len(b):
            a, b = b, a
        return sum(x * b.get(t, 0.0) for t, x in a.items())

    def scores(self, e, now):
        start = self.sess_start.get(self.sess_of.get(e["id"]), 0)
        q = self._vec(content(M.strip_paste(e["text_all"])))
        pos, neg = {}, 0.0
        for usable, v, need in self.vecs:
            if usable >= start:
                continue
            c = self._cos(q, v)
            if need:
                for i in need:
                    if c > pos.get(i, 0.0):
                        pos[i] = c
            elif c > neg:
                neg = c
        vis = {r["id"] for r in self.visible(now)}
        margin = self.kw.get("margin")
        out = {}
        for i, c in pos.items():
            if i in vis and (margin is None or c - neg >= margin):
                out[i] = c
        return out

    def packet(self, e, now):
        if e["t"] in ("notification", "peer") or len(content(e["text_all"])) < 3:
            return []
        sc = self.scores(e, now)
        tau = self.kw.get("tau", 0.35)
        return [i for i in sorted(sc, key=lambda i: (-sc[i], i)) if sc[i] >= tau][: self.k]


REGISTRY = {"hist": Hist}
