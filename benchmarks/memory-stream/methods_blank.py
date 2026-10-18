"""Blank-slate retrieval (C3): compiled statements + frame bridges + novelty-gated scoring. See BLANK-C3.md.

Sleep time (constructor): rows -> sentence units -> keep memory-like statements (source event type, statement cues,
specificity) -> per-unit tokens, entities, frames. Hot path (packet): class gate -> prompt gate -> candidate scoring
(lexical idf overlap + frame bridges + entity anchors) x novelty (share of the unit not already in the context window)
-> supersession (newest of near-duplicates) -> threshold -> at most k bullets. Pure Python, no model calls.
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


SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Za-z0-9\"'(])|\n+|\s+/\s+")
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
GENERAL = re.compile(r"\b(difference between|how does|how do .* work|what is an? |what's an? |explain|eli5|random q|"
                     r"unrelated|tl;?dr|in general|generally|trivia|history of)\b", re.I)
SOCIAL = re.compile(r"^\s*(ok+|k|kk|thanks?|thank you|ty|lol|haha|nice|cool|great|perfect|yes|yep|yeah|no|nope|sure|"
                    r"continue|go ahead|do it|ship it|lgtm|sounds good|got it|done|awesome|ugh|wow|hmm+)\b", re.I)

# Frames: generic activity domains (not world-specific). A prompt that triggers a frame is bridged to memories
# whose text carries one of the frame's markers: "order dinner" -> diet/allergy memories, "add a dep" -> package
# manager rules. In the product this table would be written by a model at sleep time; here it is a fixed ontology.
FRAMES = {
    "food": ("dinner lunch breakfast brunch snack snacks food meal meals order restaurant cook cooking recipe menu "
             "bake cake party picnic potluck groceries grocery takeout delivery cafe eat",
             "vegetarian vegan allergic allergy allergies lactose dairy gluten nut nuts peanut fish seafood diet eat "
             "eats spicy halal kosher intolerant celiac shellfish"),
    "schedule": ("meeting meetings sync call calendar schedule book slot invite 1:1 time week tomorrow morning "
                 "afternoon appointment availability reschedule session",
                 "standup focus calendar meetings before after mornings afternoons mondays tuesdays wednesdays thursdays "
                 "fridays weekly 1:1 block no-meeting book"),
    "travel": ("trip travel flight flights hotel hotels fly book vacation weekend visit drive airport passport "
               "luggage airbnb stay train",
               "hotel refundable flight seat aisle window airline aeroplan passport transit points loyalty layover"),
    "gift": ("gift gifts present birthday buy shop anniversary card surprise",
             "birthday gift likes loves collects favourite favorite size wishlist"),
    "message": ("email mail reply draft message text write send letter note memo post slack announce",
                "tone sign signs sign-off formal casual emoji exclamation brief style greeting draft"),
    "format": ("list table summary summarize rundown recap bullets overview format report notes",
               "table bullets format dates celsius fahrenheit short concise length iso units"),
    "money": ("pay payment bill budget cost price expense invoice transfer spend buy order purchase",
              "budget card account limit split etransfer bank credit"),
    "kids": ("school kid kids class teacher homework camp lessons pickup playdate daycare son daughter",
             "school teacher grade class allergic pickup bedtime screen"),
    "health": ("doctor dentist appointment sick medication pharmacy prescription clinic checkup symptoms",
               "allergic medication doctor dr dentist prescription condition migraine"),
    "home": ("house home repair cleaning chores maintenance garden furnace contractor reno renovation",
             "furnace filter door contractor reno landlord"),
    "deps": ("install dependency dependencies package add library lib upgrade bump npm add-on",
             "pnpm npm yarn package manager banned instead library lockfile"),
    "test": ("test tests testing spec coverage e2e unit vitest jest failing",
             "test tests vitest jest playwright mock filter run"),
    "git": ("pr commit push merge branch rebase review release changelog wrap ship tag",
            "commit commits conventional branch pr merge gh squash rebase push main"),
    "style": ("format formatting lint indent semicolons quotes prettier style cleanup clean",
              "biome eslint prettier lint format formatting"),
    "deploy": ("deploy deployment prod production staging terraform infra release rollout helm k8s probe",
               "terraform apply deploy staging prod ci workflow helm aws"),
    "db": ("database db migration migrations schema table column query sql index",
           "postgres mysql migrate migration drizzle prisma schema db"),
    "ui": ("button component page form modal dark mode color colour css styling icon layout font",
           "aria-label tailwind font css component design tokens theme"),
    "api": ("endpoint route api request response error status handler webhook",
            "problem+json rfc error header signature hmac fastify express route"),
    "env": ("setup install local locally run start spin env environment laptop clone docker",
            "port docker compose env node version nvmrc pnpm dev"),
    "dates": ("date dates time timezone format calendar",
              "date-fns moment dayjs timezone utc format iso"),
    "vent": ("stressed stress spiralling anxious upset frustrated tired vent overwhelmed sad angry",
             "listen reflect fixes vent stress"),
}


def _frame_sets():
    out = {}
    for f, (trig, mark) in FRAMES.items():
        out[f] = ({w for w in trig.split()}, {w for w in mark.split()})
    return out


FRAME_SETS = _frame_sets()


def words(text):
    return set(re.findall(r"[a-z0-9][a-z0-9:+'-]*", (text or "").lower()))


def frames_of(ws, side):
    k = 0 if side == "q" else 1
    return {f for f, s in FRAME_SETS.items() if ws & s[k]}


def split_units(text):
    parts = [p.strip() for p in SENT.split(text or "") if p and p.strip()]
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


class Blank:
    def __init__(self, rows, stream, items, cov, **kw):
        self.kw = kw
        self.k = int(kw.get("k", 4))
        self.tau = kw.get("tau", 6.0)
        self.nov = kw.get("nov", 0.35)
        self.fw = kw.get("fw", 2.5)
        self.minw = kw.get("minw", 0.3)
        self.cov = cov
        # --- stream: flat events and window boundaries (only earlier events are ever read) ---
        flat, start = [], {}
        ws = 0
        for s in stream["sessions"]:
            if s["kind"] != "resume":
                ws = len(flat)
            for e in s["events"]:
                if e["t"] == "compact":
                    ws = len(flat)
                start[e["_order"]] = ws
                flat.append(e)
        self.flat = flat
        self.pos = {e["_order"]: i for i, e in enumerate(flat)}
        self.start = start
        self._stems = {}
        # source event type of a row: the event whose content tokens hold most of the row's (the row is a copy)
        eidx, etype = {}, {}
        for e in flat:
            etype[e["id"]] = e["t"]
            for t in content(e["text_all"]):
                eidx.setdefault(t, set()).add(e["id"])
        self.oracle = all("item" in r for r in rows) and bool(rows)
        units = []
        for r in rows:
            src = "human" if self.oracle else self.trace(r["text"], eidx, etype)
            if src not in SRC_PRIOR:
                continue
            parts = [r["text"]] if self.oracle else split_units(r["text"])
            for j, u in enumerate(parts):
                if codey(u) > 0.04:
                    continue
                c = content(u)
                if len(c) < 3:
                    continue
                units.append({"id": f"{r['id']}#{j}", "text": u, "t": r["t"], "invalid_at": r.get("invalid_at"),
                              "c": c, "src": src, "row": r})
        tmpl = {}
        for u in units:
            key = re.sub(r"[0-9a-f]{6,}|\d+", "#", u["text"].lower())
            u["key"] = key
            tmpl[key] = tmpl.get(key, 0) + 1
        units = [u for u in units if tmpl[u["key"]] < 4]
        df = {}
        for u in units:
            for t in u["c"]:
                df[t] = df.get(t, 0) + 1
        n = len(units)
        self.idf = {t: math.log(1 + n / d) for t, d in df.items()}
        self.inv = {}
        keep = []
        for u in units:
            u["worth"] = 1.0 if self.oracle else self.worth(u)
            if u["worth"] < self.minw:
                continue
            u["w"] = sum(self.idf[t] for t in u["c"])
            ws_ = words(u["text"])
            u["frames"] = frames_of(ws_, "m")
            u["rule"] = bool(RULE.search(u["text"]))
            for t in u["c"]:
                self.inv.setdefault(t, []).append(u)
            u["covers"] = set(r["covers"]) if self.oracle and "covers" in r else cov.covers(u["text"])
            keep.append(u)
        self.units = keep
        self.by_frame = {}
        for u in keep:
            for f in u["frames"]:
                self.by_frame.setdefault(f, []).append(u)
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
        return etype[best] if hits[best] / len(c) >= 0.7 else None

    def worth(self, u):
        s = u["text"]
        w = SRC_PRIOR[u["src"]]
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
        return w * max(0.0, min(1.2, 0.3 + cue))

    def ev_stems(self, e):
        s = self._stems.get(e["_order"])
        if s is None:
            s = self._stems[e["_order"]] = stems(e["text_all"])
        return s

    def window(self, e):
        i = self.pos[e["_order"]]
        w = set()
        for x in self.flat[self.start[e["_order"]]:i]:
            w |= self.ev_stems(x)
        return w

    def query_text(self, e):
        txt = e["text_all"]
        lines = txt.splitlines()
        if len(lines) > 12:  # a paste: keep the ask around it
            txt = "\n".join(lines[:3] + lines[-3:])
        return txt

    def gate(self, e, q, qc):
        """Prompt-level prior in [0, 1]: how likely this turn is to need memory at all."""
        cls = e["labels"]["class"]
        if cls in NONHUMAN:
            return 0.0
        if len(qc) < 2:
            return 0.0
        g = 1.0
        if SOCIAL.match(q) and len(qc) < 5:
            g *= 0.3
        if GENERAL.search(q):
            g *= 0.4
        if len(e["text_all"].splitlines()) > 12:
            g *= 0.6
        return g

    def packet(self, e, now):
        q = self.query_text(e)
        qc = content(q)
        g = self.gate(e, q, qc)
        if g <= 0:
            return []
        qs = stems(q)
        qf = frames_of(words(q), "q")
        win = self.window(e) | qs
        vis = lambda u: u["t"] < now and (u["invalid_at"] is None or u["invalid_at"] > now)
        cand = {}
        for t in qc:
            for u in self.inv.get(t, ()):
                if vis(u):
                    cand[u["id"]] = u
        for f in qf:
            for u in self.by_frame.get(f, ()):
                if vis(u):
                    cand[u["id"]] = u
        scored = []
        for u in cand.values():
            m = sum(self.idf[t] for t in u["c"] if t in qc)
            m = m / (1 + 0.02 * max(0, len(u["c"]) - 12))
            fb = len(qf & u["frames"]) * self.fw * (1.5 if u["rule"] else 1.0)
            novel = sum(self.idf[t] for t in u["c"] if t not in win) / u["w"]
            if novel < self.nov:
                continue
            s = (m + fb) * novel * u["worth"] * g
            scored.append((s, u))
        scored.sort(key=lambda x: (-x[0], -x[1]["t"]))
        top = scored[: 30]
        # supersession: of near-duplicate candidates, keep the newest
        alive = []
        for s, u in top:
            if s < self.tau:
                break
            if any(v["t"] > u["t"] and self.jac(u, v) > 0.35 for _, v in top if _ >= 0.5 * s):
                continue
            if any(self.jac(u, v) > 0.5 for v in alive):
                continue
            alive.append(u)
            if len(alive) >= self.k:
                break
        return [u["id"] for u in alive]

    @staticmethod
    def jac(u, v):
        return len(u["c"] & v["c"]) / len(u["c"] | v["c"])


REGISTRY = {"blank": Blank}
