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

    def packet(self, e, now):
        if self.silent(e):
            return []
        sc = self.scores(e, now)
        ranked = [i for i in sorted(sc, key=lambda i: -sc[i]) if sc[i] >= self.tau]
        if self.kw.get("ctx"):
            ranked = [i for i in ranked if not self.in_window(self.by_id[i], e)]
        return ranked[: self.k]


REGISTRY = {"oracle-need": OracleNeed, "lex": Lex, "bm25": Lex}


def make(spec, rows, stream, items, cov):
    name, kw = params(spec)
    return REGISTRY[name]([dict(r) for r in rows], stream, items, cov, **kw)
