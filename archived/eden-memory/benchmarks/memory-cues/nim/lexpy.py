"""Python port of lex.ts (tokenizer, BM25F, ctxCue). Verified against out/features-ts.json by verify_lexpy.py."""
import math, re

STOP = set(("a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how i if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such than that that's the their theirs them themselves then there there's these they this those through to too under until up very was wasn't we were weren't what what's when where which while who whom why with won't would wouldn't you your yours yourself yourselves "
            "ok okay yes yeah yep sure thanks thank please just also get got getting need needs want wants like use used using uses make makes way thing things something anything one two again still really now know tell show let lets go going do done does doing did can could should would will may might im ive youre whats hows wheres whos isnt dont doesnt cant here there than then us we our ours my me i you it its hey hi hello").split())


def stem(w):
    if len(w) <= 3 or re.search(r"\d", w):
        return w
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if re.search(r"(ss|us|is)$", w):
        return w
    if w.endswith("es") and re.search(r"(ches|shes|xes|zes|sses)$", w):
        return w[:-2]
    if w.endswith("s"):
        return w[:-1]
    return w


TOK = re.compile(r"[a-z0-9@~][a-z0-9_.\-/@:~*]*[a-z0-9*]|[a-z0-9]")


def toks(s):
    t = re.sub(r"[’']", "", s.lower())
    out = []
    for m in TOK.findall(t):
        parts = [p for p in re.split(r"[^a-z0-9]+", m) if p]
        if len(parts) > 1:
            out.append(re.sub(r"[.:\-/]+$", "", m))
        for p in parts:
            if len(p) >= 2 and p not in STOP and not re.fullmatch(r"\d{1,2}", p):
                out.append(stem(p))
    return out


def content_set(s):
    """Atomic content tokens (split parts only, stemmed) used for the zero-overlap filter."""
    return {t for t in toks(s) if not re.search(r"[^a-z0-9]", t)}


class BM25F:
    def __init__(self, docs, fields=(("subject", 2.0), ("text", 1.0)), aliases_w=None, k1=1.2, b=0.75):
        self.docs = docs; self.k1 = k1; self.b = b
        self.fields = list(fields)
        if aliases_w:
            self.fields.append(("aliases", aliases_w))
        self.N = len(docs); self.df = {}; self.avg = [0.0] * len(self.fields); self.dtf = []; self.dlen = []
        for d in docs:
            seen = set(); tfs = []; lens = []
            for fi, (name, _) in enumerate(self.fields):
                v = d.get(name) or ""
                if isinstance(v, list):
                    v = " ; ".join(v)
                ts = toks(v); m = {}
                for t in ts:
                    m[t] = m.get(t, 0) + 1; seen.add(t)
                tfs.append(m); lens.append(len(ts)); self.avg[fi] += len(ts)
            self.dtf.append(tfs); self.dlen.append(lens)
            for t in seen:
                self.df[t] = self.df.get(t, 0) + 1
        self.avg = [max(1.0, a / max(1, self.N)) for a in self.avg]

    def idf(self, t):
        df = self.df.get(t, 0)
        return math.log(1 + (self.N - df + 0.5) / (df + 0.5)) if df else 0.0

    def score(self, q, i):
        s = 0.0
        for t in set(q):
            tf = 0.0
            for fi, (_, w) in enumerate(self.fields):
                c = self.dtf[i][fi].get(t)
                if c:
                    tf += w * c / (1 - self.b + self.b * self.dlen[i][fi] / self.avg[fi])
            if tf > 0:
                s += self.idf(t) * tf / (self.k1 + tf)
        return s


GENERIC_SEG = set("apps packages services infra src lib app components index page ts tsx js json yaml tf test spec e2e routes jobs commands ui plugins helm terraform db".split())


def ctx_cue(cue, last_paths, prev):
    segs = []
    for p in last_paths:
        for s in re.split(r"[\\/]", p):
            base = re.sub(r"[()]", "", re.sub(r"\.[a-z0-9]+$", "", s, flags=re.I))
            for w in re.split(r"[-_.]", base):
                if w and w.lower() not in GENERIC_SEG and w.lower() not in segs:
                    segs.append(w.lower())
    return " \n ".join(x for x in [cue, prev, " ".join(segs)] if x)
