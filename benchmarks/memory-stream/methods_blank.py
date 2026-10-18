"""Blank-slate retrieval (C3): "situation memory". See BLANK-C3.md.

Sleep time (constructor, pure Python + numpy, reads only rows and raw stream text):
  1. compile rows into statement units: split rows into sentences, trace each row to the event type it was copied
     from, keep memory-like statements (source prior x statement cues x specificity), drop template boilerplate;
  2. build an episode space: every past turn (a prompt plus everything the agent then did: tool calls, outputs,
     replies) is a document; a randomized SVD gives term vectors where terms that occur in the same situations sit
     close ("bearer token" near the auth library the agent read while handling it). Rebuilt at sleep checkpoints
     (every N sessions) from turns that ended before the checkpoint, so no query sees the future;
  3. index units by token, by frame (generic activity domains) and by vector.
Hot path (packet, a few ms):
  class gate (non-human events are silent) -> prompt gate (acks, small talk, general-knowledge questions, pastes,
  fact-stating turns) -> candidate scoring: lexical idf overlap + latent similarity + episode feedback + frame
  bridge -> x novelty (share of the unit not already in the context window or the prompt) x unit worth x gate ->
  supersession (newest of near-duplicates) -> threshold tau -> at most k bullets.
"""
import math, re
from text import content, stems

NONHUMAN = ("notification", "peer")


def params(spec):
    name, _, rest = spec.partition(":")
    kv = {}
    for part in filter(None, rest.split(",")):
        k, _, v = part.partition("=")
        kv[k] = float(v) if re.fullmatch(r"-?[0-9.]+", v) else v
    return name, kv


SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Za-z0-9\"'(])|\n+|\s+/\s+|;\s+|\s+[-*\u2022]\s+|\s+\u2014\s+|\s+--\s+|"
                  r"(?<=[a-z0-9)]):\s+(?=[a-z])|,?\s+\b(?=(?:also|btw|oh and|and also|plus|separately|anyway)\b)")
CLAUSE = re.compile(r",\s+(?=(?:and|but|so|which|since|because|then)\b)|,\s+")
CODE = set("{}();=<>[]`|$\\")

# Statement cues: language that marks a durable fact, rule, preference or past decision.
RULE = re.compile(r"\b(always|never|don'?t|do not|must|only|prefer\w*|from now on|rule|instead of|not allowed|"
                  r"banned|avoid|make sure|has to|have to|needs? to be|should|hate\w*|love\w*|allergic|can'?t)\b", re.I)
FACT = re.compile(r"\b(we use|we're on|we are on|uses|is on|lives?|works? (at|as|on)|birthday|is (a|an|the|our|my)|"
                  r"our|my|his|her|their|moved|switched|now|decided|chose|ended up|went with|because|called|named|"
                  r"runs? on|lives? in|is in|are in|every|weekly|monthly|due|expires?)\b", re.I)
ASK = re.compile(r"^\s*(can|could|would|will|pls|please|how|what|why|where|which|who|when|is|are|does|do|should|"
                 r"fix|add|make|write|draft|book|order|send|show|find|check|look|run|start|help|give|tell|put|set)\b",
                 re.I)
# Prompt gate cues (generic conversational acts, not world vocabulary).
GENERAL = re.compile(r"\b(difference between|how does|how do .* work|what is an? |what's an? |explain|eli5|random q|"
                     r"unrelated|tl;?dr|in general|generally|trivia|history of)\b", re.I)
SOCIAL = re.compile(r"^\s*(ok+|k|kk|thanks?|thank you|ty|lol|haha|nice|cool|great|perfect|yes|yep|yeah|no|nope|sure|"
                    r"continue|go ahead|do it|ship it|lgtm|sounds good|got it|done|awesome|ugh|wow|hmm+)\b", re.I)
STATE = re.compile(r"\b(for the record|fyi|btw|heads up|context:|for context|for notes|put this in|note that|noting|"
                   r"remember (that|this)|from now on|new rule|going forward|i decided|we decided|decided|"
                   r"we're switching|we switched|switched to|moved to|is now|are now|now it's|turns \d+|i booked|"
                   r"i chose|ended up|for future reference|just so you know|so you know|also,? my|my \w+ is|"
                   r"our \w+ is|is allergic|always|never)\b", re.I)

# Frames: generic activity domains. A prompt that triggers a frame is bridged to memories whose text carries one of
# the frame's markers ("order dinner" -> diet/allergy memories, "add a dep" -> package-manager rules). In a product
# this table would be written by a model at sleep time; here it is a small fixed ontology.
FRAMES = {
    "food": ("dinner lunch breakfast brunch snack snacks food meal meals restaurant cook cooking recipe menu "
             "bake cake party picnic potluck groceries grocery takeout cafe eat",
             "vegetarian vegan allergic allergy allergies lactose dairy gluten nut nuts peanut fish seafood diet "
             "spicy halal kosher intolerant celiac shellfish"),
    "schedule": ("meeting meetings sync calendar schedule slot invite 1:1 appointment availability reschedule",
                 "standup focus no-meeting 1:1 mondays tuesdays wednesdays thursdays fridays"),
    "travel": ("trip travel flight flights hotel hotels fly vacation airport passport luggage airbnb train",
               "hotel refundable flight seat aisle airline aeroplan passport transit loyalty layover"),
    "gift": ("gift gifts present birthday anniversary surprise", "birthday gift gifts collects wishlist"),
    "message": ("email reply draft message text letter memo post announce note",
                "tone sign-off formal casual emoji exclamation dashes greeting"),
    "kids": ("school class teacher homework camp lessons pickup playdate daycare sleepover",
             "school teacher grade pickup bedtime"),
    "health": ("doctor dentist sick medication pharmacy prescription clinic checkup symptoms",
               "allergic medication doctor dentist prescription migraine"),
    "deps": ("install dependency dependencies package library upgrade bump", "pnpm npm yarn lockfile banned"),
    "test": ("test tests testing spec coverage e2e", "vitest jest playwright mock"),
    "git": ("pr commit push merge branch rebase release changelog", "commit commits conventional gh squash merge"),
    "style": ("formatting lint indent semicolons quotes prettier cleanup", "biome eslint prettier lint"),
    "deploy": ("deploy deployment prod production staging terraform infra rollout helm",
               "terraform deploy workflow helm"),
    "db": ("database db migration migrations schema column query sql", "postgres mysql migrate migration drizzle"),
    "dates": ("date dates timezone", "date-fns moment dayjs timezone utc"),
    "vent": ("stressed stress spiralling anxious upset frustrated overwhelmed vent", "listen reflect vent stress"),
}
FRAME_SETS = {f: (set(a.split()), set(b.split())) for f, (a, b) in FRAMES.items()}


def words(text):
    return set(re.findall(r"[a-z0-9][a-z0-9:+'-]*", (text or "").lower()))


def frames_of(ws, side):
    k = 0 if side == "q" else 1
    return {f for f, s in FRAME_SETS.items() if ws & s[k]}


def split_units(text):
    parts = []
    for p in SENT.split(text or ""):
        p = (p or "").strip()
        if not p:
            continue
        if len(content(p)) > 24:  # still long: fall back to clauses
            parts.extend(x.strip() for x in CLAUSE.split(p) if x and x.strip())
        else:
            parts.append(p)
    out, buf = [], ""
    for p in parts:
        buf = (buf + " " + p).strip() if buf else p
        if len(content(buf)) >= 3:
            out.append(buf)
            buf = ""
    if buf and out:
        out[-1] = out[-1] + " " + buf
    elif buf:
        out.append(buf)
    return out


def codey(s):
    return sum(1 for c in s if c in CODE) / max(1, len(s))


SRC_PRIOR = {"human": 1.0, "tool": 0.55, "assistant": 0.5, "compact": 0.6}
_SPACE_CACHE = {}  # (stream, checkpoint, dim) -> fitted episode space; the fit depends only on the past stream


class Blank:
    def __init__(self, rows, stream, items, cov, **kw):
        self.kw = kw
        self.k = int(kw.get("k", 4))
        self.tau = kw.get("tau", 6.0)
        self.ttau = kw.get("ttau", self.tau)  # threshold for host triggers
        self.nov = kw.get("nov", 0.35)
        self.fw = kw.get("fw", 0.0)
        self.minw = kw.get("minw", 0.3)
        self.beta = kw.get("beta", 0.0)
        self.kprf = int(kw.get("kprf", 5))
        self.gamma = kw.get("gamma", 0.0)
        self.c0 = kw.get("c0", 0.3)
        self.dim = int(kw.get("dim", 128))
        self.every = int(kw.get("every", 10))
        self.pst = kw.get("pst", 0.35)  # gate factor for fact-stating turns
        self.pnov = kw.get("pnov", 0.6)  # gate factor for prompts with 3+ never-seen tokens
        self.kappa = kw.get("kappa", 0.0)
        self.lam = kw.get("lam", 0.0)
        self.humanonly = bool(kw.get("humanonly", 0))
        self.disp = int(kw.get("disp", 0))  # bullet shown: 0 the unit, 1 the unit and its neighbours, 2 short row
        self.maxrow = kw.get("maxrow", 300)
        self.cov = cov
        # --- stream: flat events and context-window boundaries ---
        flat, start, sess_first = [], {}, []
        ws = 0
        for s in stream["sessions"]:
            if s["kind"] != "resume":
                ws = len(flat)
            sess_first.append(s["events"][0]["_order"] if s["events"] else None)
            for e in s["events"]:
                if e["t"] == "compact":
                    ws = len(flat)
                start[e["_order"]] = ws
                flat.append(e)
        self.flat = flat
        self.pos = {e["_order"]: i for i, e in enumerate(flat)}
        self.start = start
        self._stems = {}
        self.oracle = bool(rows) and all("item" in r for r in rows)
        self.eorder = {e["id"]: e["_order"] for e in flat}
        self.build_turns()
        self.compile_units(rows, cov)
        self.attach_context()
        if self.lam:
            self.attach_echoes()
        self.cps, self.spaces = [], []
        if self.gamma:
            self.cps = [o for i, o in enumerate(sess_first) if o is not None and i % self.every == 0 and i > 0]
            self.spaces = [self.build_lsa(o) for o in self.cps]

    # ---------------- sleep: compile ----------------
    def compile_units(self, rows, cov):
        eidx, etype = {}, {}
        for e in self.flat:
            etype[e["id"]] = e["t"]
            for t in content(e["text_all"]):
                eidx.setdefault(t, set()).add(e["id"])
        units = []
        for r in rows:
            if self.oracle:
                src, so = "human", r["t"]
            else:
                tr = self.trace(r["text"], eidx, etype)
                if not tr:
                    continue
                src, so = tr[0], self.eorder[tr[1]]
            if src not in SRC_PRIOR or (self.humanonly and src != "human"):
                continue
            parts = [r["text"]] if self.oracle else split_units(r["text"])
            for j, u in enumerate(parts):
                if codey(u) > 0.04:
                    continue
                c = content(u)
                if len(c) < 3:
                    continue
                if self.disp == 2 and len(r["text"]) <= self.maxrow:
                    shown = r["text"]
                elif self.disp >= 1:
                    shown = " ".join(parts[max(0, j - 1): j + 2])
                else:
                    shown = u
                units.append({"id": f"{r['id']}#{j}", "text": shown, "core": u, "t": r["t"],
                              "invalid_at": r.get("invalid_at"), "c": c, "src": src, "row": r, "so": so})
        tmpl = {}
        for u in units:
            u["key"] = re.sub(r"[0-9a-f]{6,}|\d+", "#", u["core"].lower())
            tmpl[u["key"]] = tmpl.get(u["key"], 0) + 1
        units = [u for u in units if tmpl[u["key"]] < 4]
        df = {}
        for u in units:
            for t in u["c"]:
                df[t] = df.get(t, 0) + 1
        n = max(1, len(units))
        self.idf = {t: math.log(1 + n / d) for t, d in df.items()}
        self.inv, self.by_frame, keep = {}, {}, []
        for u in units:
            u["worth"] = 1.0 if self.oracle else self.worth(u)
            if u["worth"] < self.minw:
                continue
            u["w"] = sum(self.idf[t] for t in u["c"])
            u["frames"] = frames_of(words(u["core"]), "m")
            u["rule"] = bool(RULE.search(u["core"]))
            u["covers"] = set(u["row"]["covers"]) if self.oracle and "covers" in u["row"] else cov.covers(u["text"])
            u["ix"] = len(keep)
            keep.append(u)
            for t in u["c"]:
                self.inv.setdefault(t, []).append(u)
            for f in u["frames"]:
                self.by_frame.setdefault(f, []).append(u)
        self.units = keep
        self.by_id = {u["id"]: u for u in keep}

    @staticmethod
    def trace(text, eidx, etype):
        c = content(text)
        if not c:
            return None
        hits = {}
        for t in c:
            for ev in eidx.get(t, ()):
                hits[ev] = hits.get(ev, 0) + 1
        if not hits:
            return None
        best = max(sorted(hits), key=hits.get)
        return (etype[best], best) if hits[best] / len(c) >= 0.7 else None

    def worth(self, u):
        s = u["core"]
        cue = 0.0
        if RULE.search(s):
            cue += 0.6
        if FACT.search(s):
            cue += 0.4
        if re.search(r"\d", s):
            cue += 0.2
        if re.search(r"(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}", s):
            cue += 0.15
        if s.rstrip().endswith("?"):
            cue -= 0.5
        if ASK.match(s) and not RULE.search(s):
            cue -= 0.3
        if len(s) > 400:
            cue -= 0.3
        return SRC_PRIOR[u["src"]] * max(0.0, min(1.2, 0.3 + cue))

    # ---------------- sleep: episodes ----------------
    def build_turns(self):
        self.turn_of = {}
        turns, cur = [], None
        for e in self.flat:
            if e["t"] in ("human", "trigger"):
                cur = {"order": e["_order"], "end": e["_order"], "q": content(e["text_all"]), "rest": {},
                       "asst": set()}
                turns.append(cur)
                self.turn_of[e["_order"]] = len(turns) - 1
            elif e["t"] in ("tool", "assistant") and cur is not None:
                cur["end"] = e["_order"]
                self.turn_of[e["_order"]] = len(turns) - 1
                if e["t"] == "assistant":
                    cur["asst"] |= content(e["text_all"])
                for t in content(e["text_all"]):
                    cur["rest"][t] = cur["rest"].get(t, 0) + 1
            else:
                cur = None
        self.turns = turns
        n = max(1, len(turns))
        df, rdf = {}, {}
        for tu in turns:
            for t in tu["q"]:
                df[t] = df.get(t, 0) + 1
            for t in tu["rest"]:
                rdf[t] = rdf.get(t, 0) + 1
        self.tidf = {t: math.log(1 + n / d) for t, d in df.items()}
        self.ridf = {t: math.log(1 + n / d) for t, d in rdf.items()}
        self.tinv = {}
        for k, tu in enumerate(turns):
            for t in tu["q"]:
                self.tinv.setdefault(t, []).append(k)

    def attach_echoes(self):
        """Salience by recurrence: the orders of later events, in other sessions, that restate the unit (>= 0.6 of
        its idf weight). Facts that matter come back (restated, echoed by the agent, kept by compaction); one-off
        task descriptions do not. Only echoes before `now` count at query time."""
        sess = {}
        eix = {}
        for e in self.flat:
            sess[e["_order"]] = e.get("session")
            for t in content(e["text_all"]):
                eix.setdefault(t, []).append(e["_order"])
        cstem = {}
        for u in self.units:
            u["echo"] = []
            if not u["c"]:
                continue
            rare = sorted(u["c"], key=lambda t: len(eix.get(t, ())))[:2]
            cands = None
            for t in rare:
                ps = set(o for o in eix.get(t, ()) if o > u["so"])
                cands = ps if cands is None else cands & ps
            for o in sorted(cands or ()):
                if sess.get(o) == sess.get(u["so"]):
                    continue
                st = cstem.get(o)
                if st is None:
                    st = cstem[o] = content(self.flat[self.pos[o]]["text_all"])
                if sum(self.idf[t] for t in u["c"] if t in st) / u["w"] >= 0.6:
                    u["echo"].append(o)

    def attach_context(self):
        """Encoding context: the situation a memory was stated in (its turn's prompt and the agent's replies).
        Retrieval cues that match the encoding situation recall the memory even when they share no words with it."""
        for u in self.units:
            k = self.turn_of.get(u["so"])
            if k is None:
                u["ctx"], u["ctx_end"] = {}, 0
                continue
            tu = self.turns[k]
            ctx = {t: 0.5 for t in tu["asst"]}
            ctx.update({t: 1.0 for t in tu["q"]})
            for t in u["c"]:
                ctx.pop(t, None)
            u["ctx"], u["ctx_end"] = ctx, tu["end"]
            u["ctxw"] = sum(self.tidf.get(t, 1.0) * w for t, w in ctx.items()) or 1.0
        self.ctx_inv = {}
        for u in self.units:
            for t in u["ctx"]:
                self.ctx_inv.setdefault(t, []).append(u)

    def build_lsa(self, upto):
        """Episode space from turns that ended before `upto`: randomized SVD of the turn x term tf-idf matrix."""
        import numpy as np
        key = (id(self.flat[0]), upto, self.dim)
        if key not in _SPACE_CACHE:
            _SPACE_CACHE[key] = self._fit_space(upto)
        fit = _SPACE_CACHE[key]
        if fit is None:
            return None
        vid, T = fit
        U = np.zeros((len(self.units), T.shape[1]), dtype=np.float32)
        for u in self.units:
            v = self._embed(u["c"], vid, T)
            if v is not None:
                U[u["ix"]] = v
        return vid, T, U

    def _fit_space(self, upto):
        import numpy as np
        turns = [tu for tu in self.turns if tu["end"] < upto]
        docs = []
        for tu in turns:
            d = dict(tu["rest"])
            for t in tu["q"]:
                d[t] = d.get(t, 0) + 2
            docs.append(d)
        n = len(docs)
        if n < 20:
            return None
        df = {}
        for d in docs:
            for t in d:
                df[t] = df.get(t, 0) + 1
        vocab = sorted((t for t, c in df.items() if 2 <= c <= 0.3 * n), key=lambda t: -df[t])[:9000]
        vid = {t: i for i, t in enumerate(vocab)}
        X = np.zeros((n, len(vocab)), dtype=np.float32)
        for i, d in enumerate(docs):
            for t, f in d.items():
                j = vid.get(t)
                if j is not None:
                    X[i, j] = (1 + math.log(f)) * math.log(n / df[t])
        X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
        k = min(self.dim, n - 1)
        Om = np.random.default_rng(0).standard_normal((len(vocab), k + 20)).astype(np.float32)
        Y = X @ Om
        for _ in range(2):
            Y = X @ (X.T @ Y)
        Q, _ = np.linalg.qr(Y)
        _, S, Vt = np.linalg.svd(Q.T @ X, full_matrices=False)
        T = (Vt[:k].T * S[:k]).astype(np.float32)
        T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-9
        return vid, T

    def _embed(self, toks, vid, T):
        import numpy as np
        ids = [vid[t] for t in toks if t in vid]
        if not ids:
            return None
        w = np.array([self.idf.get(t, 2.0) for t in toks if t in vid], dtype=np.float32)
        v = (T[ids] * w[:, None]).sum(axis=0)
        nv = float(np.linalg.norm(v))
        return v / nv if nv else None

    def space(self, order):
        best = None
        for o, sp in zip(self.cps, self.spaces):
            if o <= order:
                best = sp
        return best

    def expand(self, qc, order):
        """Episode feedback: the vocabulary of what was done after similar earlier prompts (turns that ended)."""
        sim = {}
        for t in qc:
            for k in self.tinv.get(t, ()):
                if self.turns[k]["end"] < order:
                    sim[k] = sim.get(k, 0.0) + self.tidf[t]
        top = sorted(sim, key=lambda k: -sim[k])[: self.kprf]
        exp = {}
        for k in top:
            tu = self.turns[k]
            w = sim[k] / (sum(self.tidf.get(t, 0) for t in tu["q"]) or 1)
            for t, f in tu["rest"].items():
                exp[t] = exp.get(t, 0.0) + w * self.ridf[t] * min(f, 3) / 3
        best = sorted(exp, key=lambda t: -exp[t])[:40]
        mx = max((exp[t] for t in best), default=1) or 1
        return {t: exp[t] / mx for t in best}

    # ---------------- hot path ----------------
    def ev_stems(self, e):
        s = self._stems.get(e["_order"])
        if s is None:
            s = self._stems[e["_order"]] = stems(e["text_all"])
        return s

    def window(self, e):
        w = set()
        for x in self.flat[self.start[e["_order"]]:self.pos[e["_order"]]]:
            w |= self.ev_stems(x)
        return w

    def first_seen(self):
        """Order of the first event that contains each content token (prompt-novelty gate; reads only the past)."""
        if not hasattr(self, "_first"):
            self._first = {}
            for x in self.flat:
                for t in content(x["text_all"]):
                    self._first.setdefault(t, x["_order"])
        return self._first

    def gate(self, e, raw, qc):
        cls = e["labels"]["class"]
        if cls in NONHUMAN or len(qc) < 2:
            return 0.0
        if cls == "trigger":
            return 1.0
        if SOCIAL.match(raw) and len(qc) < 5:
            return 0.0
        if GENERAL.search(raw):
            return 0.0
        if len(raw.splitlines()) > 12:
            return 0.0
        g = 1.0
        if STATE.search(raw):
            g *= self.pst
        first = self.first_seen()
        new = sum(1 for t in qc if first.get(t, 0) >= e["_order"])
        if new >= 3:
            g *= self.pnov
        return g

    def packet(self, e, now):
        scored = self.rank(e, now)
        tau = self.ttau if e["labels"]["class"] == "trigger" else self.tau
        return self.select(scored, tau)

    def rank(self, e, now, gate=True):
        """(score, unit) candidates, best first; [] when the prompt gate says the turn needs nothing."""
        raw = e["text_all"]
        qc = content(raw)
        g = self.gate(e, raw, qc) if gate else 1.0
        if g <= 0:
            return []
        qs = stems(raw)
        qf = frames_of(words(raw), "q") if self.fw else set()
        win = self.window(e) | qs
        vis = lambda u: u["t"] < now and (u["invalid_at"] is None or u["invalid_at"] > now)
        exp = self.expand(qc, e["_order"]) if self.beta else {}
        cand = {}
        for t in list(qc) + list(exp):
            for u in self.inv.get(t, ()):
                cand[u["id"]] = u
        for f in qf:
            for u in self.by_frame.get(f, ()):
                cand[u["id"]] = u
        if self.kappa:
            for t in qc:
                for u in self.ctx_inv.get(t, ()):
                    cand[u["id"]] = u
        sims = None
        if self.gamma:
            sp = self.space(e["_order"])
            if sp is not None:
                qv = self._embed(qc, sp[0], sp[1])
                if qv is not None:
                    sims = sp[2] @ qv
                    for ix in (sims > self.c0).nonzero()[0]:
                        u = self.units[ix]
                        cand[u["id"]] = u
        scored = []
        for u in cand.values():
            if not vis(u):
                continue
            novel = sum(self.idf[t] for t in u["c"] if t not in win) / u["w"]
            if novel < self.nov:
                continue
            m = sum(self.idf[t] for t in u["c"] if t in qc)
            if exp:
                m += self.beta * sum(exp[t] * self.idf[t] for t in u["c"] if t in exp and t not in qc)
            m = m / (1 + 0.02 * max(0, len(u["c"]) - 12))
            if self.kappa and u["ctx"] and u["ctx_end"] < e["_order"]:
                cx = sum(self.tidf.get(t, 1.0) * u["ctx"][t] for t in qc if t in u["ctx"])
                m += self.kappa * cx / (1 + 0.01 * len(u["ctx"]))
            if sims is not None:
                m += self.gamma * max(0.0, float(sims[u["ix"]]) - self.c0)
            if qf:
                m += len(qf & u["frames"]) * self.fw * (1.5 if u["rule"] else 1.0)
            sal = 1.0
            if self.lam:
                ne = sum(1 for o in u["echo"] if o < e["_order"])
                sal = 1.0 + self.lam * math.log(1 + ne)
            scored.append((m * novel * u["worth"] * g * sal, u))
        scored.sort(key=lambda x: (-x[0], -x[1]["t"]))
        return scored

    def select(self, scored, tau):
        top = scored[:30]
        alive = []
        for s, u in top:
            if s < tau:
                break
            if any(v["t"] > u["t"] and self.jac(u, v) > 0.35 for s2, v in top if s2 >= 0.5 * s):
                continue
            if any(self.jac(u, v) > 0.5 or (self.disp and u["row"] is v["row"]) for v in alive):
                continue
            alive.append(u)
            if len(alive) >= self.k:
                break
        return [u["id"] for u in alive]

    @staticmethod
    def jac(u, v):
        return len(u["c"] & v["c"]) / len(u["c"] | v["c"])


REGISTRY = {"blank": Blank}
