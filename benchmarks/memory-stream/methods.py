"""Offline retrieval methods for StreamBench. Each one sees, per scored event, only what a hook could see then:
the event's text and type, the session so far (its window), the time, and the store rows visible at that time.

    make("lex:tau=6,k=4,admit=1,ctx=1,gate=1", rows, stream, items, cov) -> .packet(event, now) -> [row ids]

Options of `lex` (each one is a hypothesis family, so they combine):
  tau, k     BM25 score threshold, and the packet cap (F1)
  prev=1     add the previous assistant message to the query
  admit=1    write-side admission (F7): at sleep, rows are cut into sentences, and only declarative sentences with
             a fact signal are kept. Code, tool boilerplate, requests and questions are dropped
  ctx=1      context model (F10): drop a row whose content is ≥ 0.6 inside the window already
  when=1     index the sleep compiler's `when` cues with the row text (F3/F11: compiled need predicates)
  neghist=f  negative-history pruning (F14): drop query tokens found in more than f of the user's earlier human turns
  hab=z      habituation (F12): fire only z standard deviations above the row's own score history
  gate=1     need-existence gate (F5): silent on non-human events (task notifications, peer messages, which a hook
             recognises by their wrapper) and on acknowledgements with no content

Methods never read labels except `oracle-need`, which is a ceiling, not a candidate.
"""
import math, re
from text import content, stems

FACT = re.compile(
    r"\b(is|are|was|were|uses?|using|runs?|lives?|prefers?|likes?|loves?|hates?|dislikes?|must|never|always|should|"
    r"shouldn't|don't|doesn't|do not|only|allergic|birthday|works?|moved|switched|pinned|stored|deploys?|owns?|"
    r"pays?|costs?|starts?|ends?|due|every|weekly|daily|instead|rule|policy|wants?|needs?|requires?|keeps?|"
    r"called|named|lives|based|located|scheduled|booked|confirmed|decided|agreed)\b", re.I)
REQUEST = re.compile(
    r"^\s*(can|could|would|will) you\b|^\s*(please|pls|let's|lets|ok|okay|hey|hi|morning|thanks|nice|cool)\b|"
    r"^\s*(fix|add|make|write|check|run|look|find|show|create|update|remove|delete|rename|move|draft|book|send|"
    r"set|help|try|give|tell|explain|summari[sz]e|review|open|go|start|stop|do|plan|remind)\b", re.I)
BOILER = re.compile(
    r"has been updated successfully|created successfully|Async agent launched|Switched to a new branch|"
    r"^\(no output\)|^\[[\w/.-]+ [0-9a-f]{6,}\]|Test Files|passed \(\d+\)|^\s*\d+\s+(import|export|const)", re.I)


def params(spec):
    name, _, rest = spec.partition(":")
    kv = {}
    for part in filter(None, rest.split(",")):
        k, _, v = part.partition("=")
        kv[k] = float(v) if re.fullmatch(r"-?[0-9.]+", v) else v
    return name, kv


ASK = re.compile(r"\?|\b(can|could|would|will) you\b|\b(please|pls)\b|^\s*(how|what|why|where|which|who|when|is|are|does|do|should)\b",
                 re.I | re.M)


def strip_paste(text):
    """The user's own words: code fences, log-like lines (mostly non-letters) and quoted lines removed, and at most
    the first 60 words kept (F5: a long paste is not a request)."""
    text = re.sub(r"```.*?(```|$)", " ", text or "", flags=re.S)
    keep = []
    for line in text.splitlines():
        letters = sum(c.isalpha() or c.isspace() for c in line) / max(1, len(line))
        if line.strip().startswith(">") or (len(line) > 20 and letters < 0.7):
            continue
        keep.append(line)
    return " ".join(" ".join(keep).split()[:60])


def informing(text):
    """F5: a turn that only informs (a declarative fact signal, no question, no request verb)."""
    t = strip_paste(text)
    return bool(FACT.search(t)) and not ASK.search(t) and not REQUEST.search(t) and not re.search(
        r"\b(fix|add|make|write|check|run|update|remove|create|refactor|implement|draft|book|send|plan)\b", t, re.I)


def sentences(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    parts = re.split(r"(?<=[.!?;])\s+|\n+|\s+-\s+|\s+\d+\.\s+", text)
    return [p.strip() for p in parts if p.strip()]


def admitted(sentence):
    words = sentence.split()
    if not 4 <= len(words) <= 45 or sentence.rstrip().endswith("?"):
        return False
    alpha = sum(c.isalpha() or c.isspace() for c in sentence) / max(1, len(sentence))
    if alpha < 0.75 or BOILER.search(sentence) or REQUEST.search(sentence):
        return False
    return bool(FACT.search(sentence))


class Base:
    def __init__(self, rows, stream, items, cov, **kw):
        self.stream, self.items, self.cov, self.kw = stream, items, cov, kw
        self.k = int(kw.get("k", 4))
        if kw.get("admit"):
            rows = self._admit(rows)
        for r in rows:
            if "covers" not in r:
                r["covers"] = cov.covers(r["text"])
        self.rows = rows
        self.by_id = {r["id"]: r for r in rows}
        self._windows()

    def _admit(self, rows):
        out = []
        for r in rows:
            if "item" in r:  # oracle rows are already clean
                out.append(r)
                continue
            for n, s in enumerate(sentences(r["text"])):
                if admitted(s):
                    out.append({"id": f"{r['id']}#{n}", "text": s, "kind": r.get("kind"), "t": r["t"],
                                "invalid_at": r.get("invalid_at")})
        return out

    def _history(self):
        """F14: per token, the stream orders of earlier human turns containing it (no labels: a user's past turns)."""
        import bisect
        self._hum_orders, self._tok_orders = [], {}
        order = 0
        for s in self.stream["sessions"]:
            for ev in s["events"]:
                order += 1
                if ev["t"] == "human":
                    self._hum_orders.append(order)
                    for t in content(ev["text_all"]):
                        self._tok_orders.setdefault(t, []).append(order)
        self._bisect = bisect.bisect_left

    def generic(self, tokens, now_order):
        """Tokens found in more than `neghist` of the human turns before `now_order` (needs ≥ 20 of them)."""
        thr = self.kw.get("neghist")
        if thr is None:
            return set()
        if not hasattr(self, "_hum_orders"):
            self._history()
        n = self._bisect(self._hum_orders, now_order)
        if n < 20:
            return set()
        return {t for t in tokens if self._bisect(self._tok_orders.get(t, []), now_order) / n > thr}

    def _windows(self):
        """Per event: stems of the window (the session so far, since the last compaction) and the last reply."""
        self.window, self.prev = {}, {}
        win, last = set(), ""
        for s in self.stream["sessions"]:
            if s["kind"] != "resume":
                win, last = set(), ""
            for ev in s["events"]:
                self.window[ev["id"]] = win
                self.prev[ev["id"]] = last
                if ev["t"] == "compact":
                    win = stems(ev["text_all"])
                    continue
                win = win | stems(ev["text_all"])
                if ev["t"] == "assistant":
                    last = ev.get("text") or ""

    def visible(self, now):
        return [r for r in self.rows if r["t"] < now and (r.get("invalid_at") in (None, 0) or r["invalid_at"] > now)]


class OracleNeed(Base):
    """Ceiling: for every need, the newest visible row covering it. Nothing on no-need events."""

    def packet(self, e, now):
        lab = e["labels"]
        needs = set(lab["needs"]) - set(lab.get("in_context", []))
        out = []
        vis = sorted(self.visible(now), key=lambda r: -r["t"])
        for i in needs:
            for r in vis:
                if i in r["covers"]:
                    if r["id"] not in out:
                        out.append(r["id"])
                    break
        return out


class Lex(Base):
    """BM25 over row content tokens; query = the event text; τ gate; and the options above."""

    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        self.tau = kw.get("tau", 6.0)
        self.docs = {r["id"]: self._tf(self._doc(r)) for r in self.rows}
        n = len(self.rows)
        df = {}
        for tf in self.docs.values():
            for t in tf:
                df[t] = df.get(t, 0) + 1
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}
        self.len = {i: sum(tf.values()) for i, tf in self.docs.items()}
        self.avg = sum(self.len.values()) / max(1, n)

    def _doc(self, r):
        """Row text; with `when=1` also the sleep compiler's cue fields (F3/F11 need predicates)."""
        if not self.kw.get("when"):
            return r["text"]
        w = r.get("when") or {}
        extra = (r.get("entities") or []) + (w.get("entities") or []) + (w.get("activities") or [])
        return r["text"] + " " + " ".join(extra)

    @staticmethod
    def _tf(text):
        tf = {}
        for t in content(text):
            tf[t] = tf.get(t, 0) + 1
        return tf

    def silent(self, e):
        if not self.kw.get("gate"):
            return False
        if e["t"] in ("notification", "peer"):
            return True
        return len(content(e["text_all"])) < 3

    def scores(self, e, now):
        q = content(e["text_all"])
        if self.kw.get("prev"):
            q |= content(self.prev.get(e["id"], ""))
        q -= self.generic(q, e.get("_order", 0))
        out = {}
        k1, b = 1.2, 0.75
        for r in self.visible(now):
            tf = self.docs[r["id"]]
            s = 0.0
            for t in q:
                f = tf.get(t)
                if f:
                    s += self.idf[t] * f * (k1 + 1) / (f + k1 * (1 - b + b * self.len[r["id"]] / self.avg))
            if s > 0:
                out[r["id"]] = s
        return out

    def in_window(self, r, e):
        c = content(r["text"])
        win = self.window.get(e["id"], set())
        return bool(c) and sum(1 for t in c if t in win) / len(c) >= 0.6

    def habituate(self, sc, e):
        """F12: a row fires only when its score is z standard deviations above its own causal history of scores
        on earlier events (rows that match every prompt habituate). The history includes zeros."""
        z = self.kw.get("hab")
        if z is None:
            return sc
        if not hasattr(self, "_hist"):
            self._hist, self._n = {}, 0
        out = {}
        n = self._n
        for i, v in sc.items():
            s1, s2 = self._hist.get(i, (0.0, 0.0))
            mean = s1 / n if n else 0.0
            sd = math.sqrt(max(0.0, s2 / n - mean * mean)) if n else 0.0
            if n < 5 or v >= mean + z * max(sd, 1e-6):
                out[i] = v
            self._hist[i] = (s1 + v, s2 + v * v)
        self._n += 1
        return out

    def packet(self, e, now):
        if self.silent(e):
            return []
        sc = self.habituate(self.scores(e, now), e)
        ranked = [i for i in sorted(sc, key=lambda i: -sc[i]) if sc[i] >= self.tau]
        if self.kw.get("ctx"):
            ranked = [i for i in ranked if not self.in_window(self.by_id[i], e)]
        return ranked[: self.k]


class Bank(Lex):
    """F4: prompt-to-exemplar matching. Each row carries sleep-time self-play exemplars (selfplay.py): situations
    that need it (`pos`) and near misses (`neg`). A row fires when the turn's tf-idf cosine to its best `pos` is
    ≥ tau and beats its best `neg` by `margin`. Rows without exemplars never fire. With `ltau`, the row's lexical score
    (with `when=1`, the compiled cues) must also reach `ltau`: two kinds of evidence must agree."""

    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        import selfplay
        ex = selfplay.exemplars(kw.get("world", stream["world"]))
        self.ex = {}
        df, n = {}, 0
        for r in self.rows:
            e = ex.get(r["id"])
            if not e:
                continue
            self.ex[r["id"]] = ([content(t) for t in e.get("pos", [])], [content(t) for t in e.get("neg", [])])
            for group in self.ex[r["id"]]:
                for c in group:
                    n += 1
                    for t in c:
                        df[t] = df.get(t, 0) + 1
        self.eidf = {t: math.log((n + 1) / (d + 0.5)) for t, d in df.items()}
        self.vecs = {i: ([self._vec(c) for c in pos], [self._vec(c) for c in neg]) for i, (pos, neg) in self.ex.items()}

    def _vec(self, toks):
        v = {t: self.eidf.get(t, math.log(2)) for t in toks}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {t: x / norm for t, x in v.items()}

    @staticmethod
    def _cos(a, b):
        if len(a) > len(b):
            a, b = b, a
        return sum(x * b.get(t, 0.0) for t, x in a.items())

    def scores(self, e, now):
        qt = content(e["text_all"])
        q = self._vec(qt - self.generic(qt, e.get("_order", 0)))
        tau, margin = self.kw.get("tau", 0.3), self.kw.get("margin", 0.0)
        out = {}
        for r in self.visible(now):
            v = self.vecs.get(r["id"])
            if not v or not v[0]:
                continue
            sp = max(self._cos(q, x) for x in v[0])
            sn = max((self._cos(q, x) for x in v[1]), default=0.0)
            if sp >= tau and sp - sn >= margin:
                out[r["id"]] = sp
        ltau = self.kw.get("ltau")
        if ltau is not None and out:
            lex = Lex.scores(self, e, now)
            out = {i: v for i, v in out.items() if lex.get(i, 0.0) >= ltau}
        return out

    def packet(self, e, now):
        if self.silent(e):
            return []
        sc = self.scores(e, now)
        ranked = sorted(sc, key=lambda i: -sc[i])
        if self.kw.get("ctx"):
            ranked = [i for i in ranked if not self.in_window(self.by_id[i], e)]
        return ranked[: self.k]


class Situation(Base):
    """F15: situation tracking. Each row is keyed by its compiled entity and cue phrases (sleep `entities`,
    `when.entities`, `when.activities`). The session's situation is the set of key phrases that have appeared in it so
    far: prompts, replies, tool calls and outputs. A row fires only when a key phrase it holds *enters* the situation
    at this event (it was absent from the session before). The weight of a phrase is log(rows / rows holding it),
    and a row needs a weight of at least `tau`. So it is silent by construction on acks and restatements."""

    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        self.keys = {}
        df = {}
        for r in self.rows:
            w = r.get("when") or {}
            ks = {k.lower().strip() for k in (r.get("entities") or []) + (w.get("entities") or [])
                  + (w.get("activities") or []) if k and len(k.strip()) >= 3}
            self.keys[r["id"]] = ks
            for k in ks:
                df[k] = df.get(k, 0) + 1
        n = max(1, len(self.rows))
        self.kw_w = {k: math.log(n / d) for k, d in df.items()}
        self.vocab = sorted(df, key=len, reverse=True)
        self._pat = {k: re.compile(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])") for k in self.vocab}
        self._seen = {}
        sess_of = {}
        for s in stream["sessions"]:
            prev = set()
            if s["kind"] != "resume":
                carry = set()
            else:
                carry = last
            prev = set(carry)
            for ev in s["events"]:
                self._seen[ev["id"]] = prev
                prev = prev | self.phrases(ev["text_all"])
                if ev["t"] == "compact":
                    prev = self.phrases(ev["text_all"])
            last = prev

    def phrases(self, text):
        t = (text or "").lower()
        return {k for k in self.vocab if k in t and self._pat[k].search(t)}

    def packet(self, e, now):
        if e["t"] in ("notification", "peer"):
            return []
        new = self.phrases(e["text_all"]) - self._seen.get(e["id"], set())
        if not new:
            return []
        sc = {}
        for r in self.visible(now):
            hit = new & self.keys.get(r["id"], set())
            if hit:
                sc[r["id"]] = sum(self.kw_w[k] for k in hit)
        tau = self.kw.get("tau", 3.0)
        return [i for i in sorted(sc, key=lambda i: -sc[i]) if sc[i] >= tau][: self.k]


class Vote(Base):
    """Evidence vote: a row fires when at least `need` of three independent detectors fire for it: the self-play bank
    (F4, tau=`bt`), lexical with compiled cues (F11, `lt`), and situation entry (F15, `st`). Ranked by the bank score,
    then by votes."""

    def __init__(self, rows, stream, items, cov, **kw):
        super().__init__(rows, stream, items, cov, **kw)
        self.bank = Bank(self.rows, stream, items, cov, tau=kw.get("bt", 0.2), when=1)
        self.lex = Lex(self.rows, stream, items, cov, when=1)
        self.situ = Situation(self.rows, stream, items, cov, tau=kw.get("st", 3.0), k=99)
        self.need = int(kw.get("need", 2))

    def packet(self, e, now):
        if e["t"] in ("notification", "peer") or len(content(e["text_all"])) < 3:
            return []
        if self.kw.get("stmt") and e["t"] == "human" and informing(e["text_all"]):
            return []
        if self.kw.get("strip"):
            e = dict(e, text_all=strip_paste(e["text_all"]))
        b = self.bank.scores(e, now)
        lt = self.kw.get("lt", 4.0)
        l = {i for i, v in self.lex.scores(e, now).items() if v >= lt}
        st = set(self.situ.packet(e, now))
        votes = {}
        for group in (set(b), l, st):
            for i in group:
                votes[i] = votes.get(i, 0) + 1
        ok = [i for i, v in votes.items() if v >= self.need]
        return sorted(ok, key=lambda i: (-votes[i], -b.get(i, 0.0)))[: self.k]


REGISTRY = {"oracle-need": OracleNeed, "lex": Lex, "bm25": Lex, "bank": Bank, "situ": Situation, "vote": Vote}


def make(spec, rows, stream, items, cov):
    name, kw = params(spec)
    return REGISTRY[name]([dict(r) for r in rows], stream, items, cov, **kw)
