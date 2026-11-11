"""M3 FrameRank (D906, docs/research/m3-arch.md §5): no embeddings anywhere. Each item becomes a frame of symbols at
ingest (terms, normalised dates and amounts, people, a thread key, status and obligation flags, kind, a stamp); a
request becomes a frame too. Candidates come from inverted indexes over those symbols; a small learned ranker over
integer and binary pair features (frame.py's `pair_features`) orders them, and a threshold keeps it silent.

This file is the extraction, the candidate generator and the pair features, shared by training and eval.
"""
import math
import re
from collections import Counter, defaultdict

STOP = set("""a an the and or of to in on at for from by with is are was were be been it its this that these those
i me my we our you your he she they them their his her as if but so do does did done have has had will would can
could should may might must please just also about into than then there here what when where which who whom why how
all any some each other more most such only own same too very up out over under again further once am get got make
made let new today tomorrow week next last re fw fwd hi dear thanks regards best kind cheers sent from to cc date
subject mon tue wed thu fri sat sun monday tuesday wednesday thursday friday saturday sunday""".split())
TOKEN = re.compile(r"[a-z0-9][a-z0-9'£$.-]*")
MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DATE_RE = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*", re.I)
DATE2_RE = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b", re.I)
SLASH_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})\b")
AMOUNT_RE = re.compile(r"[£$€]\s?([\d,]+(?:\.\d+)?)")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
NAME_RE = re.compile(r"\b([A-Z][a-z]{2,})\b")
HEADER_DATE_RE = re.compile(r"Date:\s*\w+,\s*(\d{1,2})\s+(\w{3})\s+(\d{4})")
NOW_DAY = 9 * 31 + 27  # Tuesday 27 October 2026, as day-of-year in days_of's scale

# Status and obligation lexicons: closed lists, each a bit. Order is the bit order.
STATUS = [
    ("cancel", r"\b(cancel+ed|cancel+ation|called off|scrapped|withdrawn|dropped)\b"),
    ("done", r"\b(paid|settled|already|completed|done|sent|submitted|booked|confirmed|received|renewed|processed)\b"),
    ("moved", r"\b(moved|postponed|rescheduled|delayed|pushed back|brought forward|changed to|now on|instead)\b"),
    ("hold", r"\b(on hold|suspended|frozen|paused|blocked|pending|under review|dispute|disputed|investigation)\b"),
    ("neg", r"\b(not|no longer|never|isn't|aren't|won't|can't|cannot|don't|doesn't|unable|unavailable)\b"),
    ("clear", r"\b(resolved|fixed|lifted|back to normal|cleared|reinstated|reopened|called off|all clear|approved)\b"),
    ("away", r"\b(leave|away|holiday|off sick|out of office|ooo|vacation|parental|sabbatical|unwell)\b"),
    ("closed", r"\b(closed|shut|full|sold out|fully booked|expired|lapsed|ended|terminated|discontinued)\b"),
]
OBLIG = [
    ("must", r"\b(must|required|requires|mandatory|need to|needs to|have to|has to)\b"),
    ("approve", r"\b(approval|approve|sign[- ]off|authori[sz]|consent|permission)\b"),
    ("deadline", r"\b(deadline|by the|before|until|no later than|due|cut-?off|expires?)\b"),
    ("limit", r"\b(limit|cap|maximum|max|allowance|budget|threshold|at most|no more than|exceed)\b"),
    ("policy", r"\b(policy|rule|rules|regulation|terms|contract|clause|freeze|embargo|ban)\b"),
    ("ask", r"\b(please|ask|asked|request|requested|remind|reminder|don't|do not)\b"),
]
STATUS_RE = [(n, re.compile(p, re.I)) for n, p in STATUS]
OBLIG_RE = [(n, re.compile(p, re.I)) for n, p in OBLIG]
VERBS = {
    "pay": "pay transfer refund invoice settle top reimburse send money".split(),
    "book": "book reserve schedule arrange set organise organize plan rebook".split(),
    "send": "send email reply forward share post message tell notify invite announce".split(),
    "buy": "buy order purchase renew subscribe upgrade get".split(),
    "approve": "approve sign accept confirm agree grant authorise authorize".split(),
    "change": "cancel change move update delete remove deploy merge release migrate rotate".split(),
}
VERB_OF = {w: k for k, ws in VERBS.items() for w in ws}
KINDS = ["gmail", "calendar", "drive", "slack", "crm", "other"]


def terms(text):
    return [t.strip(".'-") for t in TOKEN.findall(text.lower()) if t.strip(".'-") and t.strip(".'-") not in STOP]


def days_of(text):
    out = set()
    for d, m in DATE_RE.findall(text):
        if 1 <= int(d) <= 31:
            out.add((MONTHS[m[:3].lower()] - 1) * 31 + int(d))
    for m, d in DATE2_RE.findall(text):
        if 1 <= int(d) <= 31:
            out.add((MONTHS[m[:3].lower()] - 1) * 31 + int(d))
    for d, m in SLASH_RE.findall(text):
        if 1 <= int(d) <= 31 and 1 <= int(m) <= 12:
            out.add((int(m) - 1) * 31 + int(d))
    return out


def amounts_of(text):
    out = set()
    for a in AMOUNT_RE.findall(text):
        try:
            out.add(round(float(a.replace(",", "")), 2))
        except ValueError:
            pass
    return out


def bits(text, table):
    b = 0
    for k, (_, rx) in enumerate(table):
        if rx.search(text):
            b |= 1 << k
    return b


def thread_key(title):
    return re.sub(r"^((re|fwd?|fw)\s*:\s*)+", "", title.strip().lower())[:60]


def item_frame(iid, title, text):
    full = f"{title}\n{text}"
    body = text.split("\n\n", 1)[-1] if text.startswith("From:") else text
    m = HEADER_DATE_RE.search(text)
    stamp = (MONTHS.get(m.group(2)[:3].lower(), 0) - 1) * 31 + int(m.group(1)) if m else None
    src = iid.split(":", 1)[0] if ":" in iid else "other"
    sender = EMAIL_RE.search(text[:200])
    return {
        "id": iid,
        "terms": Counter(terms(full)),
        "title": set(terms(title)),
        "days": days_of(full),
        "amts": amounts_of(full),
        "emails": set(e.lower() for e in EMAIL_RE.findall(full)),
        "names": set(NAME_RE.findall(body)),
        "status": bits(body, STATUS_RE),
        "oblig": bits(body, OBLIG_RE),
        "thread": thread_key(title),
        "sender": sender.group(0).lower() if sender else "",
        "stamp": stamp,
        "kind": src if src in KINDS else "other",
        "auto": int(bool(re.search(r"no-?reply|notifications?@|alerts?@|unsubscribe|newsletter", text[:400], re.I))),
        "len": len(full),
    }


def request_frame(text):
    t = terms(text)
    words = re.findall(r"[a-z]+", text.lower())
    verb = next((VERB_OF[w] for w in words[:6] if w in VERB_OF), next((VERB_OF[w] for w in words if w in VERB_OF), ""))
    return {"terms": Counter(t), "days": days_of(text), "amts": amounts_of(text), "names": set(NAME_RE.findall(text)),
            "verb": verb, "status": bits(text, STATUS_RE), "oblig": bits(text, OBLIG_RE)}


class World:
    """One user's items: frames and inverted indexes (term, day, name, email, thread, sender), BM25 statistics, each
    item's nearest neighbour by term overlap (the twin-contrast partner) and its supersession facts."""

    def __init__(self, items):
        self.items = items
        self.N = len(items)
        self.df = Counter()
        self.by_term, self.by_day, self.by_name, self.by_thread, self.by_sender = (defaultdict(list) for _ in range(5))
        for k, f in enumerate(items):
            for t in f["terms"]:
                self.df[t] += 1
                self.by_term[t].append(k)
            for d in f["days"]:
                self.by_day[d].append(k)
            for n in f["names"]:
                self.by_name[n.lower()].append(k)
            self.by_thread[f["thread"]].append(k)
            if f["sender"]:
                self.by_sender[f["sender"]].append(k)
        self.avg = sum(sum(f["terms"].values()) for f in items) / max(1, self.N)
        self._nbr = None

    def idf(self, t):
        n = self.df.get(t, 0)
        return math.log(1 + (self.N - n + 0.5) / (n + 0.5))

    def bm25(self, q, k1=1.2, b=0.75):
        sc = defaultdict(float)
        for t in q:
            ps = self.by_term.get(t)
            if not ps or len(ps) > self.N * 0.3:
                continue
            w = self.idf(t)
            for k in ps:
                tf = self.items[k]["terms"][t]
                ln = sum(self.items[k]["terms"].values())
                sc[k] += w * tf * (k1 + 1) / (tf + k1 * (1 - b + b * ln / self.avg))
        return sc

    def neighbours(self):
        """Each item's most term-similar other item (Jaccard over its 40 rarest terms) and the overlap."""
        if self._nbr is not None:
            return self._nbr
        sig = []
        for f in self.items:
            ts = sorted(f["terms"], key=lambda t: self.df[t])[:40]
            sig.append(set(ts))
        post = defaultdict(list)
        for k, s in enumerate(sig):
            for t in s:
                post[t].append(k)
        out = []
        for k, s in enumerate(sig):
            c = Counter()
            for t in s:
                ps = post[t]
                if len(ps) > 60:
                    continue
                for j in ps:
                    if j != k:
                        c[j] += 1
            if c:
                j, n = c.most_common(1)[0]
                out.append((j, n / max(1, len(s | sig[j]))))
            else:
                out.append((-1, 0.0))
        self._nbr = out
        return out


CAND = {"bm25": 40, "day": 25, "name": 25, "graph": 20}


def candidates(w, rq, extra=()):
    """Candidate ids (into w.items) for a request frame, with which channels found each (bit per channel)."""
    found = defaultdict(int)
    lex = w.bm25(rq["terms"])
    order = sorted(lex, key=lambda k: -lex[k])
    for k in order[: CAND["bm25"]]:
        found[k] |= 1
    for d in rq["days"]:
        for k in sorted(w.by_day.get(d, []), key=lambda k: -lex.get(k, 0))[: CAND["day"]]:
            found[k] |= 2
    for n in rq["names"]:
        for k in sorted(w.by_name.get(n.lower(), []), key=lambda k: -lex.get(k, 0))[: CAND["name"]]:
            found[k] |= 4
    seeds = order[:5]
    g = []
    for k in seeds:
        f = w.items[k]
        g += [j for j in w.by_thread.get(f["thread"], []) if j != k]
        if f["sender"]:
            g += [j for j in w.by_sender[f["sender"]][:10] if j != k]
    for k in g[: CAND["graph"]]:
        found[k] |= 8
    for k in extra:
        found[k] |= 16
    return found, lex, order
