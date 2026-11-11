"""M6 (D920-D929): the trimmer candidates H1-H9 (docs/research/m6-trimmer.md §3), one trainer, CPU torch.

    python packages/sim/lab/m6/cands.py --items DIR/items.jsonl --arch h1 [--train-limit N] [--epochs 3]
        [--buckets 262144] [--bits 128] [--seed 1] [--out RUN_DIR]

Every candidate scores each part of a delivered item (a sentence or line as the engine splits it) and is trained
on the labelled planted items' parts (key parts 1, the rest 0) and every other delivered item's parts (0). Text is
hashed n-grams (CRC-32, M3's `grams`), never pretrained weights or a pretrained embedding table. After each epoch
it reports, on `val`: the AUC of key parts against the others, and the screen at the threshold that holds 97% of
val facts (fact keep, look-alike keep, item-line bytes against shipped); then the held-out sets at that threshold.

Archs: h1 PartLR, h2 PartXor (binarised), h3 ThreadTagger, h4 ClauseLR (parts split at clauses), h5 Ingest mask
(h1 without the request), h6 mass decoding (h1's scores), h7 StumpForest (LightGBM on dense features), h8
CharBilinear, h9 ItemGate (h1 + an item head).
"""

import argparse
import json
import math
import os
import random
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m6lib as L  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--items", required=True)
ap.add_argument("--arch", default="h1")
ap.add_argument("--train-limit", type=int, default=0, help="rows of the train set used (0 = all)")
ap.add_argument("--epochs", type=int, default=3)
ap.add_argument("--buckets", type=int, default=1 << 18)
ap.add_argument("--bits", type=int, default=128)
ap.add_argument("--lr", type=float, default=0.02)
ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--target", type=float, default=0.97)
ap.add_argument("--out", default="")
ap.add_argument("--eval-sets", default="test,sim")
A = ap.parse_args()
random.seed(A.seed)
np.random.seed(A.seed)

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

torch.manual_seed(A.seed)
torch.set_num_threads(max(1, os.cpu_count() or 1))
B = A.buckets

# ---------------------------------------------------------------------------------------------------------------
# Units: parts, or (h4) clauses inside parts.

CLAUSE = re.compile(r"(?<=[,;:])\s+|\s+(?=(?:but|and then|so|because|which|although|unless)\s)|\s[–—-]\s")


def units_of(row):
    """[(text, flags, part index)] and the unit-level key mask; h4 splits each part into clauses."""
    out = []
    for k, (t, f) in enumerate(row["parts"]):
        if A.arch == "h4" and not (f & 2):
            for c in CLAUSE.split(t):
                if c and c.strip():
                    out.append((c.strip(), f, k))
        else:
            out.append((t, f, k))
    key = set(row["key"] or [])
    return out, [1.0 if u[2] in key else 0.0 for u in out]


# ---------------------------------------------------------------------------------------------------------------
# Features.

STATUS = re.compile(
    r"\b(already|cancel+ed|called off|no longer|not|n't|never|postponed|moved|resched\w*|instead|closed|suspended|"
    r"paid|refund\w*|done|submitted|expired|blocked|on hold|replaced|changed|withdrawn|declined|full|until|only|"
    r"must|need|before|deadline|don't|do not|please|warning|important|urgent)\b",
    re.I,
)
DATE = re.compile(
    r"\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", re.I
)
TIME = re.compile(r"\b\d{1,2}[:.]\d{2}\b|\b\d{1,2} ?(am|pm)\b", re.I)
AMOUNT = re.compile(r"[£$€]\s?\d|\d+(\.\d+)? ?(gbp|usd|eur|pounds)\b", re.I)
HEADER_KIND = re.compile(r"^(from|date|subject|to):", re.I)
N_DENSE = 27


def item_stats(us, focus):
    """Per unit, numbers relative to the item's other units: overlap, status words, digits, first body unit."""
    ov = [sum(1 for w in set(L.toks(u[0])) if w in focus) for u in us]
    st = [len(STATUS.findall(u[0])) for u in us]
    dg = [len(L.DIGIT.findall(u[0])) for u in us]
    body = [k for k, u in enumerate(us) if not (u[1] & 2)]
    first = body[0] if body else -1
    return {"ov": ov, "st": st, "dg": dg, "first": first}


def dense(u, k, n, focus, row, rel):
    t, f, _ = u
    ws = L.toks(t)
    ov = rel["ov"][k]
    hk = HEADER_KIND.match(t)
    hkind = hk.group(1).lower() if hk else ""
    return [
        1.0,
        k / max(n - 1, 1),
        1.0 if k == 0 else 0.0,
        1.0 if k == n - 1 else 0.0,
        1.0 if f & 1 else 0.0,
        1.0 if f & 2 else 0.0,
        1.0 if hkind == "from" else 0.0,
        1.0 if hkind == "date" else 0.0,
        1.0 if hkind in ("subject", "to") else 0.0,
        math.log1p(len(t.encode())) / 6,
        min(len(L.DIGIT.findall(t)), 10) / 10,
        min(ov, 5) / 5,
        ov / max(len(set(ws)), 1),
        1.0 if ov else 0.0,
        1.0 if DATE.search(t) else 0.0,
        1.0 if TIME.search(t) else 0.0,
        1.0 if AMOUNT.search(t) else 0.0,
        min(len(STATUS.findall(t)), 3) / 3,
        math.log1p(n) / 3,
        1.0 if any(w in focus for w in L.toks(row["title"])) else 0.0,
        1.0 if "!" in t or t.isupper() else 0.0,
        1.0 if "?" in t else 0.0,
        1.0 if ov and ov == max(rel["ov"]) else 0.0,
        sum(1 for x in rel["ov"] if x > ov) / max(n, 1),
        1.0 if rel["st"][k] and rel["st"][k] == max(rel["st"]) else 0.0,
        1.0 if rel["dg"][k] and rel["dg"][k] == max(rel["dg"]) else 0.0,
        1.0 if k == rel["first"] else 0.0,
    ]


def sparse(u, focus, use_request, req_grams):
    t, f, _ = u
    ids = L.grams(t, B, "p")
    if use_request:
        # Interaction without a vector space: each shared word and the request's words crossed with the part's
        # status words, hashed.
        pw = set(L.toks(t))
        ids += [L.h("s" + w, B) for w in pw if w in focus]
        st = [m.group(0).lower() for m in STATUS.finditer(t)][:4]
        rq = sorted(focus)[:12]
        ids += [L.h("x" + a + "|" + b, B) for a in rq for b in st]
    return ids


def featurize(rows, use_request=True):
    """Flat arrays over units: ids (concatenated), offsets, dense, label, unit -> (row, unit idx), request grams."""
    ids, offs, dn, ys, where, rq_ids, rq_offs = [], [], [], [], [], [], []
    for ri, r in enumerate(rows):
        us, ks = units_of(r)
        focus = L.focus_of(r["request"])
        rg = L.grams(r["request"], B, "q")
        rel = item_stats(us, focus if use_request else set())
        for k, u in enumerate(us):
            offs.append(len(ids))
            ids.extend(sparse(u, focus, use_request, rg))
            dn.append(dense(u, k, len(us), focus if use_request else set(), r, rel))
            ys.append(ks[k] if r["key"] is not None else 0.0)
            where.append((ri, k))
            rq_offs.append(len(rq_ids))
            rq_ids.extend(rg if use_request else [])
    return {
        "ids": torch.tensor(ids, dtype=torch.long),
        "offs": torch.tensor(offs, dtype=torch.long),
        "dense": torch.tensor(dn, dtype=torch.float32),
        "y": torch.tensor(ys, dtype=torch.float32),
        "where": where,
        "rq_ids": torch.tensor(rq_ids, dtype=torch.long),
        "rq_offs": torch.tensor(rq_offs, dtype=torch.long),
    }


def usable(r):
    # Planted items without a label are left out of training (their key parts are unknown).
    return r["role"] == "other" or r["key"] is not None


# ---------------------------------------------------------------------------------------------------------------
# Models.


class Ternary(torch.autograd.Function):
    @staticmethod
    def forward(ctx, w):
        a = w.abs().mean()
        return torch.where(w > 0.5 * a, a, torch.where(w < -0.5 * a, -a, torch.zeros_like(w)))

    @staticmethod
    def backward(ctx, g):
        return g


class Sign(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        ctx.save_for_backward(x)
        return torch.where(x >= 0, torch.ones_like(x), -torch.ones_like(x))

    @staticmethod
    def backward(ctx, g):
        (x,) = ctx.saved_tensors
        return g * (x.abs() <= 1).float()


def ternary_bag(weight, ids, offs):
    """Sum over each bag of ternary weights {-a, 0, +a} (a = mean |w| of the whole table, a constant), quantising
    only the rows the batch uses; straight-through to the float latent."""
    a = weight.detach().abs().mean()
    uniq, inv = torch.unique(ids, return_inverse=True)
    rows = weight[uniq]
    q = torch.where(rows > 0.5 * a, a, torch.where(rows < -0.5 * a, -a, torch.zeros_like(rows)))
    rows = rows + (q - rows).detach()
    return nn.functional.embedding_bag(inv, rows, offs, mode="sum")


class LR(nn.Module):
    """h1/h5/h6/h9: a weight per hashed feature plus a dense head (int8 at export)."""

    def __init__(self):
        super().__init__()
        self.emb = nn.EmbeddingBag(B, 1, mode="sum")
        nn.init.zeros_(self.emb.weight)
        self.dense = nn.Linear(N_DENSE, 1)

    def forward(self, d):
        return (self.emb(d["ids"], d["offs"]) + self.dense(d["dense"])).squeeze(-1)


class Xor(nn.Module):
    """h2: ternary hashed encoders for part and request into sign codes, a binary pair layer, a prior head."""

    def __init__(self, bits):
        super().__init__()
        self.ep = nn.EmbeddingBag(B, bits, mode="sum")
        self.eq = nn.EmbeddingBag(B, bits, mode="sum")
        for e in (self.ep, self.eq):
            nn.init.normal_(e.weight, 0, 0.1)
        self.bnp = nn.BatchNorm1d(bits)
        self.bnq = nn.BatchNorm1d(bits)
        self.l1 = nn.Linear(3 * bits + N_DENSE, 64)
        self.bn1 = nn.BatchNorm1d(64)
        self.head = nn.Linear(64 + N_DENSE, 1)

    def code(self, emb, bn, ids, offs):
        return Sign.apply(bn(ternary_bag(emb.weight, ids, offs)))

    def forward(self, d):
        p = self.code(self.ep, self.bnp, d["ids"], d["offs"])
        q = self.code(self.eq, self.bnq, d["rq_ids"], d["rq_offs"])
        x = torch.cat([p, q, p * q, d["dense"]], -1)
        hdn = Sign.apply(self.bn1(self.l1(x)))
        return self.head(torch.cat([hdn, d["dense"]], -1)).squeeze(-1)


class Thread(nn.Module):
    """h3: each part a sign code (+ dense), a small bidirectional GRU over the item's parts."""

    def __init__(self, bits):
        super().__init__()
        self.ep = nn.EmbeddingBag(B, bits, mode="sum")
        nn.init.normal_(self.ep.weight, 0, 0.1)
        self.bn = nn.BatchNorm1d(bits)
        self.gru = nn.GRU(bits + N_DENSE, 32, batch_first=True, bidirectional=True)
        self.head = nn.Linear(64 + N_DENSE, 1)
        self.lr = LR()

    def forward(self, d):
        p = Sign.apply(self.bn(ternary_bag(self.ep.weight, d["ids"], d["offs"])))
        x = torch.cat([p, d["dense"]], -1)
        # Group units by item (consecutive runs of the same row), pad, run the GRU.
        seg = d["seg"]
        lens = torch.tensor([b - a for a, b in seg])
        pad = torch.zeros(len(seg), int(lens.max()), x.shape[1])
        for i, (a, b) in enumerate(seg):
            pad[i, : b - a] = x[a:b]
        packed = nn.utils.rnn.pack_padded_sequence(pad, lens, batch_first=True, enforce_sorted=False)
        o, _ = self.gru(packed)
        o, _ = nn.utils.rnn.pad_packed_sequence(o, batch_first=True)
        out = torch.cat([o[i, : b - a] for i, (a, b) in enumerate(seg)])
        return self.head(torch.cat([out, d["dense"]], -1)).squeeze(-1) + self.lr(d)


class Bilinear(nn.Module):
    """h8: request and part char-3-gram bags, a low-rank (rank r) bilinear score, plus h1's linear terms."""

    def __init__(self, rank=16):
        super().__init__()
        self.u = nn.EmbeddingBag(B, rank, mode="mean")
        self.v = nn.EmbeddingBag(B, rank, mode="mean")
        nn.init.normal_(self.u.weight, 0, 0.1)
        nn.init.normal_(self.v.weight, 0, 0.1)
        self.lr = LR()

    def forward(self, d):
        q = self.u(d["rq_ids"], d["rq_offs"])
        p = self.v(d["ids"], d["offs"])
        return (q * p).sum(-1) + self.lr(d)


def subset(d, idx):
    """A batch of units (idx sorted) with their bags re-offset."""
    out = {}
    for name, offs in (("ids", "offs"), ("rq_ids", "rq_offs")):
        o = d[offs]
        ends = torch.cat([o[1:], torch.tensor([len(d[name])])])
        parts = [d[name][o[i] : ends[i]] for i in idx.tolist()]
        lens = torch.tensor([len(p) for p in parts], dtype=torch.long)
        out[name] = torch.cat(parts) if parts else torch.zeros(0, dtype=torch.long)
        out[offs] = torch.cat([torch.zeros(1, dtype=torch.long), lens.cumsum(0)[:-1]])
    out["dense"] = d["dense"][idx]
    out["y"] = d["y"][idx]
    return out


def segments(where, idx):
    seg, a = [], 0
    rows = [where[i][0] for i in idx.tolist()]
    for k in range(1, len(rows) + 1):
        if k == len(rows) or rows[k] != rows[a]:
            seg.append((a, k))
            a = k
    return seg


def item_batches(where, n_units, size=2048):
    """Batches of whole items (h3 needs an item's parts together), shuffled by item."""
    starts = [0] + [i for i in range(1, n_units) if where[i][0] != where[i - 1][0]] + [n_units]
    items = list(zip(starts, starts[1:]))
    random.shuffle(items)
    batch, cur = [], 0
    for a, b in items:
        batch.extend(range(a, b))
        cur += b - a
        if cur >= size:
            yield torch.tensor(batch)
            batch, cur = [], 0
    if batch:
        yield torch.tensor(batch)


def scores_of(model, d):
    model.eval()
    out = []
    with torch.no_grad():
        n, a = len(d["y"]), 0
        while a < n:
            e = min(a + 8192, n)
            # Keep whole items in a batch for h3.
            while e < n and d["where"][e][0] == d["where"][e - 1][0]:
                e += 1
            idx = torch.arange(a, e)
            b = subset(d, idx)
            b["seg"] = segments(d["where"], idx)
            out.append(torch.sigmoid(model(b)))
            a = e
    model.train()
    s = torch.cat(out).numpy()
    return s[: len(d["y"])]


# ---------------------------------------------------------------------------------------------------------------
# Decoding and the screen.


def masks(rows, d, s, tau, mode="thr", gate=None):
    """Per row, a keep mask over its parts (a unit kept keeps its part, or for h4 its clause text)."""
    per = {}
    for i, (ri, k) in enumerate(d["where"]):
        per.setdefault(ri, []).append(s[i])
    out = {}
    for ri, r in enumerate(rows):
        sc = per.get(ri, [])
        us, _ = units_of(r)
        if mode == "mass":
            order = np.argsort(sc)[::-1]
            tot, acc, keep = sum(sc) or 1.0, 0.0, [False] * len(sc)
            for j in order:
                if acc / tot >= tau:
                    break
                keep[j] = True
                acc += sc[j]
        else:
            t = tau if gate is None or gate[ri] else 2.0
            keep = [x >= t for x in sc]
        keep = fit([u[0] for u in us], keep, sc)
        if A.arch == "h4":
            out[ri] = " ".join(u[0] for u, kk in zip(us, keep) if kk)
        else:
            out[ri] = keep
    return out


def fit(texts, keep, sc, budget=L.ITEM_BYTES):
    """Kept units past the item's byte budget: the best-scored that fit (as `pick` does), in their own order."""
    if sum(len(t.encode()) + 3 for t, k in zip(texts, keep) if k) <= budget:
        return keep
    out, room = [False] * len(keep), budget
    for j in sorted([j for j, k in enumerate(keep) if k], key=lambda j: -sc[j]):
        b = len(texts[j].encode()) + 3
        if b <= room:
            out[j] = True
            room -= b
    return out


def run_screen(rows, d, s, tau, name, mode="thr", gate=None):
    m = masks(rows, d, s, tau, mode, gate)
    idx = {id(r): i for i, r in enumerate(rows)}
    return L.screen(rows, lambda r: m[idx[id(r)]] if isinstance(m[idx[id(r)]], str) else m[idx[id(r)]], name)


def tune(rows, d, s, mode="thr", gate=None):
    """The loosest threshold (fewest bytes) whose val fact keep is at least the target."""
    grid = np.linspace(0.0, 1.0, 101) if mode == "mass" else np.concatenate([[0.0], np.logspace(-4, 0, 60)])
    best = None
    for t in grid:
        m = run_screen(rows, d, s, t, "", mode, gate)
        if m["fact_keep"] >= A.target and (best is None or m["bytes"] < best[1]["bytes"]):
            best = (t, m)
    return best


def auc(y, s):
    pos, neg = s[y > 0.5], s[y <= 0.5]
    if not len(pos) or not len(neg):
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]))
    ranks = np.empty(len(order))
    ranks[order] = np.arange(1, len(order) + 1)
    return (ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


# ---------------------------------------------------------------------------------------------------------------

t0 = time.time()
all_rows = L.load(A.items)
train = [r for r in all_rows if r["set"] == "train" and usable(r)]
random.shuffle(train)
if A.train_limit:
    train = train[: A.train_limit]
val = [r for r in all_rows if r["set"] == "val"]
evals = {s: [r for r in all_rows if r["set"] == s] for s in A.eval_sets.split(",")}
use_req = A.arch not in ("h5",)
print(f"rows train {len(train)} val {len(val)} " + " ".join(f"{k} {len(v)}" for k, v in evals.items()), flush=True)
dt = featurize(train, use_req)
dv = featurize(val, use_req)
de = {k: featurize(v, use_req) for k, v in evals.items()}
print(f"units train {len(dt['y'])} (pos {int(dt['y'].sum())}) val {len(dv['y'])}; {time.time()-t0:.0f}s", flush=True)

report = {"arch": A.arch, "epochs": []}

if A.arch == "h7":
    import lightgbm as lgb

    m = lgb.train(
        {"objective": "binary", "num_leaves": 31, "learning_rate": 0.05, "verbose": -1},
        lgb.Dataset(dt["dense"].numpy(), dt["y"].numpy()),
        num_boost_round=300,
    )
    m.predict_proba = lambda x: np.stack([1 - m.predict(x), m.predict(x)], 1)
    sv = m.predict_proba(dv["dense"].numpy())[:, 1]
    best = tune(val, dv, sv)
    ep = {"epoch": 0, "auc_val": auc(dv["y"].numpy(), sv)}
    if best:
        ep["tau"] = float(best[0])
        ep["val"] = best[1]
        for k, v in evals.items():
            ep[k] = run_screen(v, de[k], m.predict_proba(de[k]["dense"].numpy())[:, 1], best[0], k)
    report["epochs"].append(ep)
    print(json.dumps(ep), flush=True)
else:
    model = {"h2": lambda: Xor(A.bits), "h3": lambda: Thread(A.bits), "h8": lambda: Bilinear()}.get(
        A.arch, lambda: LR()
    )()
    opt = torch.optim.Adam(model.parameters(), lr=A.lr)
    pos_w = torch.tensor(4.0)
    for epoch in range(A.epochs):
        tl, nb = 0.0, 0
        for idx in item_batches(dt["where"], len(dt["y"])):
            b = subset(dt, idx)
            b["seg"] = segments(dt["where"], idx)
            loss = nn.functional.binary_cross_entropy_with_logits(model(b), b["y"], pos_weight=pos_w)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tl += loss.item()
            nb += 1
        sv = scores_of(model, dv)
        mode = "mass" if A.arch == "h6" else "thr"
        gate = None
        if A.arch == "h9":
            # The item gate: an item is "worth a part" if its best part scores above the 3rd percentile of the
            # val facts' best key part; other items keep their title only.
            best_part = {}
            for i, (ri, _) in enumerate(dv["where"]):
                best_part[ri] = max(best_part.get(ri, 0.0), sv[i])
            facts = [best_part.get(ri, 0.0) for ri, r in enumerate(val) if r["role"] == "fact" and r["key"]]
            gcut = float(np.percentile(facts, 2)) if facts else 0.0
            gate = {ri: best_part.get(ri, 0.0) >= gcut for ri in range(len(val))}
        best = tune(val, dv, sv, mode, gate)
        ep = {"epoch": epoch, "loss": tl / max(nb, 1), "auc_val": auc(dv["y"].numpy(), sv), "s": time.time() - t0}
        if best:
            ep["tau"] = float(best[0])
            ep["val"] = best[1]
            for k, v in evals.items():
                se = scores_of(model, de[k])
                g = None
                if A.arch == "h9":
                    bp = {}
                    for i, (ri, _) in enumerate(de[k]["where"]):
                        bp[ri] = max(bp.get(ri, 0.0), se[i])
                    g = {ri: bp.get(ri, 0.0) >= gcut for ri in range(len(v))}
                ep[k] = run_screen(v, de[k], se, best[0], k, mode, g)
        report["epochs"].append(ep)
        print(json.dumps(ep), flush=True)
    if A.out:
        os.makedirs(A.out, exist_ok=True)
        torch.save(model.state_dict(), os.path.join(A.out, "model.pt"))
if A.out:
    os.makedirs(A.out, exist_ok=True)
    json.dump(report, open(os.path.join(A.out, "report.json"), "w"), indent=1)
print(f"done {time.time()-t0:.0f}s", flush=True)
