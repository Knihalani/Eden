"""M1 micro track (D980-D989): micro CPU checkers distilled from the 8B teacher's scores. Lab only; CPU torch.

Every candidate reads a (request, item) pair through the same features, built with no tokenizer and no pretrained
weights:
  - hashed word 1- and 2-grams of the item (title and its first 700 characters) and of the request (`BUCKETS` ids);
  - cross features: shared content words, shared capitalised names, shared numbers, a binding-cue and an all-clear-cue
    lexicon hit in the item, the item's length bucket (so a probe can test that length is not what it reads);
  - for the pool model, the other items of the same pool.

Candidates (`--arch`):
  pairhash  a learned table of hashed (request word, item word) pairs, summed, beside an item bag and a request bag
            (EmbeddingBag) and the cross features, into a 2-layer MLP. int8-quantised for the size and latency read.
  binpair   item and request bags into a ternary layer and a sign code (straight-through), their agreement (XNOR as a
            product of signs) and the cross features into a binary-weight MLP: M3's recipe.
  poolset   pairhash's per-item vector, then one attention layer over the pool's items (with the request) and a per-item
            head: the item is judged beside the others (a fact beside its all-clear, a newer item over an older one).

Training: knowledge distillation on the teacher's log-odds (BCE against sigmoid(t8b / T)) plus the construction label
(planted 1, else 0) at weight `--truth-weight`.

  .venv-cpu/bin/python -I packages/sim/lab/m1-student/micro.py --arch pairhash --train .local/m1/micro/slice-val.jsonl \
      --eval .local/m1/micro/eval-m7.jsonl --fixtures .local/m1/micro/fixtures-g1.jsonl --groups 4000 --epochs 3 \
      --out RESULT.json
"""
import argparse
import json
import math
import os
import random
import re
import sys
import time
import zlib

import torch
import torch.nn as nn
import torch.nn.functional as F

torch.set_num_threads(int(os.environ.get("MICRO_THREADS", "1")))
BUCKETS = 1 << 16
PAIR_BUCKETS = 1 << 18
ITEM_CHARS = 700
WORD = re.compile(r"<[a-z:-]+[a-z0-9-]*>|[a-z0-9£$€%]+")
NAME = re.compile(r"\b[A-Z][a-z]{2,}\b")
NUM = re.compile(r"\d[\d,.:/]*")
STOP = set("the a an and or of to in on for with is are be was this that it as at by from your you i we our me my "
           "please can could would will have has had do does did not no if so but just".split())
BINDING = ["on hold", "until", "do not", "don't", "cannot", "can't", "must", "only", "limit", "cap", "maximum",
           "deadline", "by ", "before", "already", "suspended", "cancelled", "closed", "frozen", "expired", "lapsed",
           "refused", "banned", "not allowed", "requires", "needs", "approval", "exceed", "over ", "shortage",
           "pause", "freeze", "conflict", "clash", "instead", "changed", "moved", "retimed", "away"]
ALLCLEAR = ["approved", "lifted", "resolved", "no longer", "fine to", "go ahead", "cleared", "reopened", "back on",
            "confirmed", "restored", "renewed", "settled", "unfrozen", "available again", "all clear"]
N_CROSS = 8
N_ROUND2 = 10
MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DATE_DMY = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?",
                      re.I)
DATE_MDY = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?",
                      re.I)
DATE_ISO = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)")
DATE_NUM = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")
PERIOD = re.compile(r"\b(20\d\d)\s*/\s*(\d\d)\b")
SENT = re.compile(r"(?<=[.!?])\s+|\n+")
ROUND2 = os.environ.get("MICRO_ROUND2", "0") == "1"
NX = N_CROSS + (N_ROUND2 if ROUND2 else 0)


def days(y, m, d):
    try:
        import datetime
        return datetime.date(int(y), int(m), int(d)).toordinal()
    except Exception:
        return None


def dates_in(text, year):
    out = []
    for d, mo, y in DATE_DMY.findall(text):
        out.append(days(y or year, MONTHS[mo[:3].lower()], d))
    for mo, d, y in DATE_MDY.findall(text):
        out.append(days(y or year, MONTHS[mo[:3].lower()], d))
    for y, m, d in DATE_ISO.findall(text):
        out.append(days(y, m, d))
    for d, m, y in DATE_NUM.findall(text):
        if 1 <= int(m) <= 12:
            yy = int(y) + 2000 if y and len(y) == 2 else (int(y) if y else year)
            out.append(days(yy, m, d))
    return [x for x in out if x]


def round2(request, item, today):
    """Date relations and cues near the request's own words (round 2)."""
    year = int(today[:4]) if today[:4].isdigit() else 2026
    t = days(today[:4], today[5:7], today[8:10]) if len(today) >= 10 else None
    rd, idt = dates_in(request, year), dates_in(item, year)
    near = lambda a, b, k: any(abs(x - y) <= k for x in a for y in b)  # noqa: E731
    rc = {w for w in words(request) if w not in STOP and len(w) > 2} | {n.lower() for n in NAME.findall(request)}
    bind_near = clear_near = 0
    for sent in SENT.split(item):
        low = sent.lower()
        if any(w in low for w in rc):
            bind_near += sum(c in low for c in BINDING)
            clear_near += sum(c in low for c in ALLCLEAR)
    periods = PERIOD.findall(item)
    in_period = any(t and days(int(a), 4, 6) <= t < days(int(a) + 1, 4, 6) for a, _ in periods)
    return [
        1.0 if near(rd, idt, 0) else 0.0,
        1.0 if near(rd, idt, 3) else 0.0,
        1.0 if t and any(x >= t for x in idt) else 0.0,
        1.0 if t and idt and max(idt) < t - 60 else 0.0,
        1.0 if t and any(t - 7 <= x <= t for x in idt) else 0.0,
        1.0 if periods and in_period else 0.0,
        1.0 if periods and not in_period else 0.0,
        min(bind_near, 4) / 4,
        min(clear_near, 3) / 3,
        1.0 if bind_near and not clear_near else 0.0,
    ]


def h(s, n):
    return zlib.crc32(s.encode()) % n


def words(s):
    return [w for w in WORD.findall(s.lower())]


def grams(ws, cap=160):
    out = [h("w:" + w, BUCKETS) for w in ws[:cap]]
    out += [h("b:" + a + " " + b, BUCKETS) for a, b in zip(ws[: cap - 1], ws[1:cap])]
    return out or [0]


TYPED = os.environ.get("MICRO_TYPED", "0") == "1"
AMOUNT = re.compile(r"[£$€]\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?", re.I)


def typed(text, request, today):
    """Round 3 (the parent's transfer lever): surface forms to typed tokens, so a model cannot latch onto one
    generator's wording. Dates -> relative-day buckets against today (and "the request's day"); tax periods ->
    current, past or future; money -> a magnitude bucket (and "the request's amount", "above it"); capitalised names ->
    "named in the request" or "another name"; other numbers -> <num>."""
    year = int(today[:4]) if today[:4].isdigit() else 2026
    t = days(today[:4], today[5:7], today[8:10]) if len(today) >= 10 else None
    req_days = set(dates_in(request, year))
    req_amt = {float(a.replace(",", "")) for a, _ in AMOUNT.findall(request)}
    req_names = set(NAME.findall(request))

    def day_tok(x):
        if x is None or t is None:
            return " <date> "
        if x in req_days:
            return " <d:reqday> "
        dlt = x - t
        b = ("past-long" if dlt < -60 else "past-month" if dlt < -7 else "past-week" if dlt < 0 else "today"
             if dlt == 0 else "next-week" if dlt <= 7 else "next-month" if dlt <= 60 else "future-long")
        return f" <d:{b}> "

    def sub_dates(rx, conv):
        def f(m):
            try:
                return day_tok(conv(m))
            except Exception:
                return " <date> "
        return f
    s = text
    s = PERIOD.sub(lambda m: " <period:current> " if t and days(int(m.group(1)), 4, 6) <= t < days(int(m.group(1)) + 1, 4, 6)
                   else (" <period:past> " if t and days(int(m.group(1)) + 1, 4, 6) <= t else " <period:future> "), s)
    s = DATE_ISO.sub(sub_dates(DATE_ISO, lambda m: days(m.group(1), m.group(2), m.group(3))), s)
    s = DATE_DMY.sub(sub_dates(DATE_DMY, lambda m: days(m.group(3) or year, MONTHS[m.group(2)[:3].lower()],
                                                         m.group(1))), s)
    s = DATE_MDY.sub(sub_dates(DATE_MDY, lambda m: days(m.group(3) or year, MONTHS[m.group(1)[:3].lower()],
                                                         m.group(2))), s)

    def amt(m):
        try:
            v = float(m.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6, "bn": 1e9}.get((m.group(2) or "").lower(), 1)
        except ValueError:
            return " <amt> "
        rel = (" <amt:req> " if v in req_amt else " <amt:above-req> " if req_amt and v > max(req_amt)
               else " <amt:below-req> " if req_amt else "")
        return f" <amt:e{int(math.log10(v)) if v >= 1 else 0}>{rel}"
    s = AMOUNT.sub(amt, s)
    s = re.sub(r"\b\d[\d,.:]*\b", " <num> ", s)
    s = NAME.sub(lambda m: " <name:req> " if m.group(0) in req_names else " <name> ", s)
    return s


def features(request, title, text, today=""):
    """The pair's ids and cross features (shared by every candidate)."""
    item = f"{title}\n{text[:ITEM_CHARS]}"
    if TYPED:
        item = typed(item, request, today)
        request = typed(request, request, today)
    iw, rw = words(item), words(request[:400])
    rc = {w for w in rw if w not in STOP and len(w) > 2}
    ic = {w for w in iw if w not in STOP and len(w) > 2}
    low = item.lower()
    shared = rc & ic
    names_r, names_i = set(NAME.findall(request)), set(NAME.findall(item))
    nums_r, nums_i = set(NUM.findall(request)), set(NUM.findall(item))
    cross = [
        len(shared) / (1 + len(rc)),
        min(len(shared), 6) / 6,
        len(names_r & names_i) / (1 + len(names_r)),
        len(nums_r & nums_i) / (1 + len(nums_r)),
        sum(c in low for c in BINDING) / 4,
        sum(c in low for c in ALLCLEAR) / 2,
        min(len(item), 700) / 700,
        1.0 if len(item) < 160 else 0.0,
    ] + (round2(request, item, today) if ROUND2 else [])
    rcs = sorted(rc)[:24]
    ics = sorted(ic)[:48]
    pairs = [h(a + "|" + b, PAIR_BUCKETS) for a in rcs for b in ics] or [0]
    return {"i": grams(iw), "r": grams(rw), "p": pairs, "x": cross}


class PairHash(nn.Module):
    def __init__(self, dim=16, hidden=64):
        super().__init__()
        self.item = nn.EmbeddingBag(BUCKETS, dim, mode="mean")
        self.req = nn.EmbeddingBag(BUCKETS, dim, mode="mean")
        self.pair = nn.EmbeddingBag(PAIR_BUCKETS, 1, mode="sum")
        self.mlp = nn.Sequential(nn.Linear(3 * dim + NX + 1, hidden), nn.ReLU(), nn.Linear(hidden, 1))
        self.dim = dim

    def vec(self, b):
        i, r = self.item(*b["i"]), self.req(*b["r"])
        p = self.pair(*b["p"])
        return torch.cat([i, r, i * r, b["x"], p], -1)

    def forward(self, b, pools=None):
        return self.mlp(self.vec(b)).squeeze(-1)


class Sign(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        ctx.save_for_backward(x)
        return torch.where(x >= 0, 1.0, -1.0)

    @staticmethod
    def backward(ctx, g):
        (x,) = ctx.saved_tensors
        return g * (x.abs() <= 1).float()


class BinPair(nn.Module):
    """Ternary bag embeddings -> sign codes; agreement of the codes and the cross features -> binary-weight MLP."""

    def __init__(self, bits=48, hidden=64):
        super().__init__()
        self.item = nn.EmbeddingBag(BUCKETS, bits, mode="mean")
        self.req = nn.EmbeddingBag(BUCKETS, bits, mode="mean")
        self.l1 = nn.Linear(3 * bits + NX, hidden)
        self.out = nn.Linear(hidden, 1)

    def forward(self, b, pools=None):
        ci, cr = Sign.apply(self.item(*b["i"])), Sign.apply(self.req(*b["r"]))
        z = torch.cat([ci, cr, ci * cr, b["x"]], -1)
        w = Sign.apply(self.l1.weight) * self.l1.weight.abs().mean()
        return self.out(F.relu(F.linear(z, w, self.l1.bias))).squeeze(-1)


class PoolSet(nn.Module):
    """PairHash's pair vector, then one attention layer across a pool's items, then a per-item head."""

    def __init__(self, dim=16, hidden=64):
        super().__init__()
        self.base = PairHash(dim, hidden)
        width = 3 * dim + NX + 1
        self.proj = nn.Linear(width, hidden)
        self.att = nn.MultiheadAttention(hidden, 4, batch_first=True)
        self.head = nn.Sequential(nn.Linear(2 * hidden, hidden), nn.ReLU(), nn.Linear(hidden, 1))

    def forward(self, b, pools):
        v = F.relu(self.proj(self.base.vec(b)))
        out = torch.zeros(v.shape[0])
        for lo, hi in pools:
            x = v[lo:hi].unsqueeze(0)
            a, _ = self.att(x, x, x)
            out[lo:hi] = self.head(torch.cat([x, a], -1)).squeeze(0).squeeze(-1)
        return out


ARCHS = {"pairhash": PairHash, "binpair": BinPair, "poolset": PoolSet}


def bag(lists):
    flat, offs = [], []
    for l in lists:
        offs.append(len(flat))
        flat += l
    return torch.tensor(flat, dtype=torch.long), torch.tensor(offs, dtype=torch.long)


def batch(feats):
    return {"i": bag([f["i"] for f in feats]), "r": bag([f["r"] for f in feats]), "p": bag([f["p"] for f in feats]),
            "x": torch.tensor([f["x"] for f in feats], dtype=torch.float32)}


def pools_of(groups):
    """A batch of whole pools: its features, the (start, end) of each pool, and the rows in order."""
    feats, spans, rows = [], [], []
    for g in groups:
        lo = len(feats)
        for it in g["items"]:
            feats.append(features(g["request"], it["title"], it["text"], g.get("today", "")))
            rows.append(it)
        spans.append((lo, len(feats)))
    return batch(feats), spans, rows


def auc(pos, neg):
    if not pos or not neg:
        return None
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    rank, i = 0.0, 0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        rank += (i + j + 1) / 2 * sum(1 for k in range(i, j) if allv[k][1] == 1)
        i = j
    return (rank - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def score_groups(model, groups, chunk=64):
    model.eval()
    out = []
    with torch.no_grad():
        for k in range(0, len(groups), chunk):
            b, spans, _ = pools_of(groups[k : k + chunk])
            s = model(b, spans).tolist()
            for lo, hi in spans:
                out.append(s[lo:hi])
    return out


def fit_mark(rows, scores):
    """D981's one mark: the lowest at which the model names no more look-alikes than Haiku and speaks on at most half as
    many neutral pools, on the fitting calls (M7's recorded calls of train1-4's train-split templates)."""
    hk_dec = sum(r["planted"] in r["haiku"] for r in rows if r["variant"] == "control")
    hk_neu = sum(bool(r["haiku"]) for r in rows if r["variant"] == "neutral")
    cands = sorted({round(v, 2) for s in scores for v in s})
    for m in cands:
        vs = [{it["id"] for it, v in zip(r["items"], s) if v >= m} for r, s in zip(rows, scores)]
        dec = sum(r["planted"] in v for r, v in zip(rows, vs) if r["variant"] == "control")
        neu = sum(bool(v) for r, v in zip(rows, vs) if r["variant"] == "neutral")
        if dec <= hk_dec and neu <= 0.5 * hk_neu:
            return m
    return cands[-1] + 1 if cands else 0.0


def quality(rows, scores, m):
    """Facts named (hidden), look-alikes named (control), neutral pools spoken on, for the model at `m` and Haiku."""
    def tally(verdicts):
        c = {"hidden": [0, 0], "control": [0, 0], "neutral": [0, 0]}
        for r, v in zip(rows, verdicts):
            c[r["variant"]][1] += 1
            c[r["variant"]][0] += (r["planted"] in v) if r["variant"] != "neutral" else bool(v)
        return {k: f"{x}/{n}" for k, (x, n) in c.items()}
    mine = [{it["id"] for it, v in zip(r["items"], s) if v >= m} for r, s in zip(rows, scores)]
    return {"model": tally(mine), "haiku": tally([set(r["haiku"]) for r in rows])}


def pair_auc(groups, scores, key="model"):
    """Planted against its look-alike (role decoy, or the sim's decoy) and against same-subject neutral items."""
    pl, dc, ne = [], [], []
    for g, s in zip(groups, scores):
        for it, v in zip(g["items"], s):
            if it["truth"] == "planted":
                pl.append(v)
            elif it["truth"] == "decoy" and it.get("role", "decoy") == "decoy":
                dc.append(v)
            elif it.get("role") == "neutral":
                ne.append(v)
    return {"vs_decoy": auc(pl, dc), "vs_neutral": auc(pl, ne)}


def evaluate(model, sel, m7, fixtures, teacher_mark):
    """The selection read (D981): M2 val and the sim dev templates apart, the mark fitted on train calls, quality
    against Haiku on the dev templates' recorded calls, and G1. No held-out row is read here."""
    out = {}
    for name, groups in sel.items():
        sc = score_groups(model, groups)
        out[f"auc_{name}"] = pair_auc(groups, sc)
        out[f"auc_{name}_teacher"] = pair_auc(groups, [[it["t8b"] for it in g["items"]] for g in groups])
    fit = [r for r in m7 if r["split"] == "train" and r["suite"] in ("train1", "train2", "train3", "train4")
           and r["haiku"] is not None]
    dev = [r for r in m7 if r["split"] == "dev" and r["haiku"] is not None]
    m = fit_mark(fit, score_groups(model, fit))
    out["mark"] = m
    out["quality_dev"] = quality(dev, score_groups(model, dev), m)
    fx = score_groups(model, [{"request": f["request"], "today": f.get("today", ""),
                               "items": [{"title": f["title"], "text": f["text"]}]}
                              for f in fixtures])
    passed = [(f, s[0] >= m) for f, s in zip(fixtures, fx)]
    out["g1_m7"] = f"{sum(p for f, p in passed if f['src'].startswith('m7/'))}/16"
    out["g1_m3r_audited"] = f"{sum(p for f, p in passed if f['src'].startswith('m3r/') and f['audited'])}/43"
    out["g1_m3r_all"] = f"{sum(p for f, p in passed if f['src'].startswith('m3r/'))}/52"
    tf = [f["t8b"] >= teacher_mark for f in fixtures if f["src"].startswith("m3r/") and f["audited"]]
    out["g1_teacher_m3r_audited"] = f"{sum(tf)}/43"
    return out


def size_and_latency(model, groups):
    """int8 dynamic quantisation of the linear layers; the embedding tables counted at int8; one 15-item pool's time."""
    # BinPair's dense weights are already signs (one bit each at inference): it is timed as it is.
    q = model if isinstance(model, BinPair) else torch.ao.quantization.quantize_dynamic(model, {nn.Linear},
                                                                                         dtype=torch.qint8)
    emb = sum(m.weight.numel() for m in model.modules() if isinstance(m, nn.EmbeddingBag))
    lin = sum(p.numel() for n, p in model.named_parameters() if "item" not in n and "req" not in n and "pair" not in n)
    pool = [g for g in groups if len(g["items"]) >= 10][:30]
    ts = []
    with torch.no_grad():
        for g in pool:
            g = {"request": g["request"], "items": (g["items"] * 2)[:15]}
            t = time.perf_counter()
            b, spans, _ = pools_of([g])
            q(b, spans)
            ts.append((time.perf_counter() - t) * 1000)
    ts.sort()
    return {"embedding_params": emb, "dense_params": lin, "mb_int8": round((emb + lin) / 1e6, 2),
            "pool15_ms_p50": round(ts[len(ts) // 2], 3), "pool15_ms_p90": round(ts[int(len(ts) * 0.9)], 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", choices=sorted(ARCHS), required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--sel-synth", required=True)
    ap.add_argument("--sel-sim", required=True)
    ap.add_argument("--m7", required=True, help="M7's recorded calls with M1's split (m7-split.jsonl)")
    ap.add_argument("--fixtures", required=True, help="fixtures-g1.jsonl with the teacher's score as t8b")
    ap.add_argument("--groups", type=int, default=4000)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--temp", type=float, default=2.0)
    ap.add_argument("--truth-weight", type=float, default=0.5)
    ap.add_argument("--batch-groups", type=int, default=16)
    ap.add_argument("--contrast", type=float, default=0.0, help="round 2: fact-above-look-alike margin weight")
    ap.add_argument("--sim-weight", type=float, default=1.0, help="round 2: weight of the sim's own training rows")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    groups = []
    for p in a.train.split(","):
        for l in open(p):
            g = json.loads(l)
            if g.get("family", "").startswith("sim/"):
                for it in g["items"]:
                    it["_sim"] = True
            groups.append(g)
    random.shuffle(groups)
    groups = groups[: a.groups] if a.groups else groups
    for g in groups:
        g["items"] = [it for it in g["items"] if it.get("visible", True)][:15]
    groups = [g for g in groups if g["items"]]
    def load(p):
        gs = [json.loads(l) for l in open(p)]
        for g in gs:
            g["items"] = [it for it in g["items"] if it.get("visible", True)][:15]
        return [g for g in gs if g["items"]]
    sel = {"synth": load(a.sel_synth), "sim": load(a.sel_sim)}
    m7 = [r for r in (json.loads(l) for l in open(a.m7)) if r["split"] != "eval"]
    fixtures = [json.loads(l) for l in open(a.fixtures)]
    tfit = [r for r in m7 if r["split"] == "train" and r["suite"] in ("train1", "train2", "train3", "train4")
            and r["haiku"] is not None]
    teacher_mark = fit_mark(tfit, [r["t8b"] for r in tfit])
    model = ARCHS[a.arch]()
    opt = torch.optim.Adam(model.parameters(), lr=a.lr)
    t0 = time.time()
    curve = []
    for ep in range(a.epochs):
        model.train()
        random.shuffle(groups)
        losses = []
        for k in range(0, len(groups), a.batch_groups):
            chunk = groups[k : k + a.batch_groups]
            b, spans, rows = pools_of(chunk)
            s = model(b, spans)
            soft = torch.sigmoid(torch.tensor([it["t8b"] / a.temp for it in rows]))
            truth = torch.tensor([1.0 if it["truth"] == "planted" else 0.0 for it in rows])
            w = torch.tensor([a.sim_weight if it.get("_sim") else 1.0 for it in rows])
            loss = (F.binary_cross_entropy_with_logits(s / a.temp, soft, weight=w) + a.truth_weight *
                    F.binary_cross_entropy_with_logits(s, truth, weight=w))
            if a.contrast > 0:
                # Round 2: each fact above the look-alikes of its own pool (a pairwise margin).
                terms = []
                for lo, hi in spans:
                    pl = [k for k in range(lo, hi) if rows[k]["truth"] == "planted"]
                    dc = [k for k in range(lo, hi) if rows[k]["truth"] == "decoy"]
                    for i in pl:
                        for j in dc:
                            terms.append(F.softplus(1.0 - (s[i] - s[j])))
                if terms:
                    loss = loss + a.contrast * torch.stack(terms).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            losses.append(loss.item())
        ev = evaluate(model, sel, m7, fixtures, teacher_mark)
        curve.append({"epoch": ep, "loss": round(sum(losses) / len(losses), 4), **ev})
        print(json.dumps(curve[-1]), flush=True)
    res = {"arch": a.arch, "teacher_mark": teacher_mark, "groups": len(groups), "epochs": a.epochs, "seconds": round(time.time() - t0),
           "final": curve[-1], "curve": curve, **size_and_latency(model, groups)}
    print(json.dumps({k: v for k, v in res.items() if k != "curve"}))
    if a.out:
        with open(a.out, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
