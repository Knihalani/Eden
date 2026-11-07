# A15 $0 screen (docs/research/a15-retrieval.md): offline retrievers over each world's items (hidden-funnel
# --corpus-dump), scored against the default funnel (--json): how many hidden tasks the default never surfaced would a
# retriever's top k reach, and how many decoys (control) the default never surfaced would it bring.
# usage: python3 -I screen.py CORPUS.jsonl FUNNEL.json [--emb EMB.npz] [--k 1,2]
import json, math, re, sys, collections, datetime

NOW = datetime.date(2026, 10, 27)
MONTHS = {m: i + 1 for i, m in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split())}
MON = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
ORD = r"(\d{1,2})(?:st|nd|rd|th)?"
DAYS = "monday tuesday wednesday thursday friday saturday sunday".split()
STOP = set("""a an the and or of to in on at for from by with my me i we our us you your it its is are be this that
these those as so if not no do does did will would can could should have has had was were am pm please just get
some any all about up out into over than then there their they them he she his her what when where who which how""".split())


def day(d, m):
    """A day-month read as the nearest year to NOW within about a year."""
    try:
        x = datetime.date(NOW.year, m, d)
    except ValueError:
        return None
    if (x - NOW).days < -120:
        x = x.replace(year=x.year + 1)
    return x


def spans(text):
    """Day spans an item or request names: explicit dates, ranges, and until/from bounds."""
    t = text.lower()
    out = []
    used = []
    # Full ranges: "14 to 22 November", "28 Oct – 3 Nov", "Saturday 14 to Sunday 22 November", "19th to Christmas Eve".
    for m in re.finditer(ORD + r"\s+" + MON + r"\s*(?:–|-|to|until|till|through)\s*(?:[a-z]+day\s+)?" + ORD +
                         r"\s+" + MON, t):
        a, b = day(int(m.group(1)), MONTHS[m.group(2)]), day(int(m.group(3)), MONTHS[m.group(4)])
        if a and b and a <= b:
            out.append((a, b)); used.append(m.span())
    for m in re.finditer(ORD + r"\s*(?:–|-|to|until|till|through)\s*(?:[a-z]+day\s+)?" + ORD + r"\s+" + MON, t):
        if any(s <= m.start() < e for s, e in used):
            continue
        mo = MONTHS[m.group(3)]
        a, b = day(int(m.group(1)), mo), day(int(m.group(2)), mo)
        if a and b and a <= b:
            out.append((a, b)); used.append(m.span())
    singles = []
    for m in re.finditer(ORD + r"\s+" + MON + r"\b", t):
        if any(s <= m.start() < e for s, e in used):
            continue
        singles.append((m.start(), day(int(m.group(1)), MONTHS[m.group(2)])))
    for m in re.finditer(MON + r"\s+" + ORD + r"\b", t):
        if any(s <= m.start() < e for s, e in used):
            continue
        singles.append((m.start(), day(int(m.group(2)), MONTHS[m.group(1)])))
    for pos, d in singles:
        if not d:
            continue
        before = t[max(0, pos - 25):pos]
        if re.search(r"\b(until|till|through|before|by|to|ends?|expires?)\s+(?:[a-z]+day\s+)?(the\s+)?$", before):
            out.append((min(NOW, d), d))
        elif re.search(r"\b(from|after|starting|effective|since)\s+(?:[a-z]+day\s+)?(the\s+)?$", before):
            out.append((d, d + datetime.timedelta(days=60)))
        else:
            out.append((d, d))
    return out


def request_days(text):
    """The days a request is about: its dates, else relative words (tomorrow, this week, a weekday)."""
    s = spans(text)
    if s:
        return s
    t = text.lower()
    if "tomorrow" in t:
        d = NOW + datetime.timedelta(days=1)
        return [(d, d)]
    if re.search(r"\b(today|this afternoon|this morning|tonight)\b", t):
        return [(NOW, NOW)]
    if "next week" in t:
        a = NOW + datetime.timedelta(days=7 - NOW.weekday())
        return [(a, a + datetime.timedelta(days=6))]
    if "this week" in t:
        return [(NOW, NOW + datetime.timedelta(days=6 - NOW.weekday()))]
    for i, w in enumerate(DAYS):
        if re.search(r"\b" + w + r"\b", t):
            ahead = (i - NOW.weekday()) % 7 or 7
            d = NOW + datetime.timedelta(days=ahead)
            return [(d, d)]
    return []


def overlaps(a, b):
    return any(x0 <= y1 and y0 <= x1 for x0, x1 in a for y0, y1 in b)


def terms(text):
    return [w for w in re.findall(r"[a-z0-9£$€]+", text.lower()) if w not in STOP and len(w) > 1]


class BM25:
    def __init__(self, docs, k1=1.2, b=0.75):
        self.docs = [collections.Counter(d) for d in docs]
        self.len = [sum(d.values()) for d in self.docs]
        self.avg = sum(self.len) / max(1, len(self.len))
        df = collections.Counter(w for d in self.docs for w in d)
        n = len(docs)
        self.idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}
        self.k1, self.b = k1, b

    def scores(self, q):
        out = []
        for d, L in zip(self.docs, self.len):
            s = 0.0
            for w in set(q):
                f = d.get(w)
                if f:
                    s += self.idf[w] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * L / self.avg))
            out.append(s)
        return out


def load(corpus, funnel):
    pt = {(t['suite'], t['seed'], t['variant'], t['template']): t for t in json.load(open(funnel))['perTask']}
    worlds = [json.loads(l) for l in open(corpus)]
    return pt, worlds


def surfaced(t):
    return bool(t['delivered'] or t.get('askCited'))


def evaluate(name, pt, worlds, retrieve, ks=(1, 2)):
    """retrieve(world, task, ctx) -> ranked item ids. Counts new reach on the default's never-surfaced tasks."""
    res = {k: collections.Counter() for k in ks}
    for w in worlds:
        if w['variant'] not in ('hidden', 'control'):
            continue
        ctx = {}
        for task in w['tasks']:
            f = pt.get((w['suite'], w['seed'], w['variant'], task['template']))
            if not f or not task['planted']:
                continue
            ids = retrieve(w, task, ctx)
            for k in ks:
                hit = task['planted'] in ids[:k]
                res[k][w['variant'] + ' in top'] += hit
                if not surfaced(f):
                    res[k][w['variant'] + ' new'] += hit
                    res[k][w['variant'] + ' missed'] += 1
                res[k]['items ' + w['variant']] += min(k, len(ids))
    for k in ks:
        r = res[k]
        print(f"{name:42s} k={k}: hidden new {r['hidden new']:3d}/{r['hidden missed']}  decoys new "
              f"{r['control new']:3d}/{r['control missed']}  (planted in top {r['hidden in top']}, decoy "
              f"{r['control in top']}; items added hidden {r['items hidden']}, control {r['items control']})")
    return res
