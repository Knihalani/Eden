"""R10 harness: one loader, one metric set and one tuning protocol for every retrieval method and every fixture.

Fixtures
  code   R1's CueBench-code (benchmarks/memory-cues/fixture: memories.json, cues.json dev/test) plus R8's test_nim
         (cues-nim.json). R8's negatives were tuned on in P4.3, so they are reported, never treated as held out.
  life   LifeBench (benchmarks/memory-life/fixture): one user's memories; dev, test, and a sealed holdout that only
         `load(..., audit=True)` opens, which appends a line to docs/memory-ship/research/R10/LOOKS.md first.

A method is any object with `.packet(cue) -> [memory ids, best first]` (at most KMAX) built for one fixture. Methods
that gate on a score expose `.scores(cue) -> {id: score}`; `tune()` then picks the threshold on dev only.

Metrics (per cue set)
  r4        mean over positives of |gold ∩ packet[:4]| / |gold|
  full      share of positives whose every gold id is in packet[:4]  (multi-need coverage)
  prec      bullet precision: share of injected bullets (whole packet) in gold ∪ allowed, over all cues
  fir       share of negatives with a non-empty packet
  stale     share of cues with a `forbidden` id (superseded or past-dated row) in the packet
  bullets   mean bullets per cue (all cues)
"""
import base64, datetime, gzip, json, math, os, re, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
K, KMAX = 4, 6
LOOKS = os.path.join(ROOT, "docs/memory-ship/research/R10/LOOKS.md")


def _j(p):
    return json.load(open(os.path.join(ROOT, p)))


class Fixture:
    def __init__(self, name, memories, cues, visible=None):
        self.name = name
        self.all_memories = memories
        self.memories = [m for m in memories if not m.get("superseded_by")]
        self.by_id = {m["id"]: m for m in memories}
        self.cues = cues
        self.C = {c["id"]: c for c in cues}
        self._visible = visible

    def visible(self, cue):
        """Live rows a method may return for this cue (the coding fixture's scope cascade; all live rows otherwise)."""
        if self._visible:
            return self._visible(cue, self.memories)
        return self.memories

    def split(self, name):
        return [c for c in self.cues if c["split"] == name]


def log_look(fixture, split, what):
    os.makedirs(os.path.dirname(LOOKS), exist_ok=True)
    new = not os.path.exists(LOOKS)
    with open(LOOKS, "a") as f:
        if new:
            f.write("# R10 — every look at a test or holdout set\n\nAppend-only. One line per scoring run.\n\n")
        f.write(f"- {datetime.datetime.now().isoformat(timespec='seconds')} · {fixture} · {split} · {what}\n")


def load(name, audit=False):
    if name == "code":
        mems = _j("benchmarks/memory-cues/fixture/memories.json")
        r1 = _j("benchmarks/memory-cues/fixture/cues.json")
        nim = _j("benchmarks/memory-cues/fixture/cues-nim.json")
        cues = []
        for c in r1 + nim:
            c = dict(c)
            c.setdefault("allowed", [])
            c.setdefault("forbidden", [])
            c["neg"] = not c["gold"]
            cues.append(c)
        vis = lambda c, live: [m for m in live if m["scope"] in ("", c.get("scope", ""))]
        return Fixture("code", mems, cues, vis)
    if name == "life":
        base = "benchmarks/memory-life/fixture"
        mems = _j(f"{base}/memories.json")
        cues = []
        for split in ("dev", "test"):
            p = os.path.join(ROOT, f"{base}/cues-{split}.json")
            if os.path.exists(p):
                cues += json.load(open(p))
        extra = os.path.join(ROOT, f"{base}/cues-redteam.json")
        if os.path.exists(extra):
            cues += json.load(open(extra))
        if audit:
            p = os.path.join(ROOT, f"{base}/holdout.sealed")
            if os.path.exists(p):
                log_look("life", "holdout", "opened by load(audit=True)")
                cues += json.loads(gzip.decompress(base64.b64decode(open(p).read())))
        for c in cues:
            c.setdefault("allowed", [])
            c.setdefault("forbidden", [])
            c["neg"] = not c["gold"]
        return Fixture("life", mems, cues)
    raise ValueError(name)


def metrics(fx, packets, cues):
    pos = [c for c in cues if c["gold"]]
    neg = [c for c in cues if not c["gold"]]
    r4, full = [], []
    for c in pos:
        top = set(packets[c["id"]][:K])
        g = set(c["gold"])
        r4.append(len(g & top) / len(g))
        full.append(g <= top)
    inj = [(d in c["gold"] or d in c["allowed"]) for c in cues for d in packets[c["id"]]]
    stale_c = [c for c in cues if c["forbidden"]]
    out = dict(n=len(cues), n_pos=len(pos), n_neg=len(neg),
               r4=_r(sum(r4) / len(r4)) if r4 else None,
               full=_r(sum(full) / len(full)) if full else None,
               prec=_r(sum(inj) / len(inj)) if inj else None,
               fir=_r(sum(bool(packets[c["id"]]) for c in neg) / len(neg)) if neg else None,
               stale=_r(sum(any(f in packets[c["id"]] for f in c["forbidden"]) for c in stale_c) / len(stale_c))
               if stale_c else None,
               bullets=_r(sum(len(packets[c["id"]]) for c in cues) / len(cues)) if cues else None)
    return out


def _r(x):
    return round(float(x), 4)


def by_cat(fx, packets, cues):
    cats = sorted({c["cat"] for c in cues})
    return {k: metrics(fx, packets, [c for c in cues if c["cat"] == k]) for k in cats}


def gate(scores, theta, rel=0.0, kmax=KMAX):
    """Admit ids with score >= theta, keep those >= rel * top, best first."""
    items = sorted(((s, i) for i, s in scores.items() if s >= theta), key=lambda x: (-x[0], x[1]))
    if not items:
        return []
    top = items[0][0]
    return [i for s, i in items if s >= rel * top][:kmax]


def tune(fx, score_fn, dev, fir_cap=0.05, rels=(0.0, 0.5, 0.7, 0.85), utility=None):
    """Pick (theta, rel) on dev: maximise r4 + 0.1*prec subject to FIR <= fir_cap. score_fn(cue) -> {id: s}."""
    S = {c["id"]: score_fn(c) for c in dev}
    neg_tops = sorted(max(S[c["id"]].values(), default=0.0) for c in dev if not c["gold"])
    pos_tops = sorted(max(S[c["id"]].values(), default=0.0) for c in dev if c["gold"])
    cands = sorted(set([0.0] + [x + 1e-9 for x in neg_tops] + pos_tops[:: max(1, len(pos_tops) // 40)]))
    utility = utility or (lambda m: (m["r4"] or 0) + 0.1 * (m["prec"] or 0))
    best = None
    for th in cands:
        for rel in rels:
            pk = {q: gate(s, th, rel) for q, s in S.items()}
            m = metrics(fx, pk, dev)
            if m["fir"] is not None and m["fir"] > fir_cap + 1e-12:
                continue
            u = utility(m)
            if best is None or u > best[0] + 1e-12:
                best = (u, th, rel, m)
    return best


def timed(fn, cues, reps=1):
    t = []
    out = {}
    for _ in range(reps):
        for c in cues:
            t0 = time.perf_counter()
            out[c["id"]] = fn(c)
            t.append((time.perf_counter() - t0) * 1000)
    t.sort()
    return out, dict(p50_ms=_r(t[len(t) // 2]), p99_ms=_r(t[min(len(t) - 1, int(len(t) * 0.99))]))
