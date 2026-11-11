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
WORD = re.compile(r"[a-z0-9£$€%]+")
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


def h(s, n):
    return zlib.crc32(s.encode()) % n


def words(s):
    return [w for w in WORD.findall(s.lower())]


def grams(ws, cap=160):
    out = [h("w:" + w, BUCKETS) for w in ws[:cap]]
    out += [h("b:" + a + " " + b, BUCKETS) for a, b in zip(ws[: cap - 1], ws[1:cap])]
    return out or [0]


def features(request, title, text):
    """The pair's ids and cross features (shared by every candidate)."""
    item = f"{title}\n{text[:ITEM_CHARS]}"
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
    ]
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
        self.mlp = nn.Sequential(nn.Linear(3 * dim + N_CROSS + 1, hidden), nn.ReLU(), nn.Linear(hidden, 1))
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
        self.l1 = nn.Linear(3 * bits + N_CROSS, hidden)
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
        width = 3 * dim + N_CROSS + 1
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
            feats.append(features(g["request"], it["title"], it["text"]))
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


def evaluate(model, evalrows, fixtures):
    """Against the sim's truth and Haiku on M7's calls (the 8B's 40 held-out templates), and the G1 fixtures."""
    held = [r for r in evalrows if r["heldout8b"] and r["haiku"] is not None]
    fit = [r for r in evalrows if r["suite"] in ("train1", "train2", "train3", "train4") and r["haiku"] is not None
           and not r["heldout8b"]]
    sh, sf = score_groups(model, held), score_groups(model, fit)
    planted = [v for r, s in zip(held, sh) if r["variant"] == "hidden" for it, v in zip(r["items"], s)
               if it["id"] == r["planted"]]
    decoy = [v for r, s in zip(held, sh) if r["variant"] == "control" for it, v in zip(r["items"], s)
             if it["id"] == r["planted"]]

    def verdict(rows, scores, m):
        return [{it["id"] for it, v in zip(r["items"], s) if v >= m} for r, s in zip(rows, scores)]

    def agree(rows, scores, m):
        vs = verdict(rows, scores, m)
        ex = sum(v == set(r["haiku"]) for r, v in zip(rows, vs)) / len(rows)
        sp = sum((not v) == (not r["haiku"]) for r, v in zip(rows, vs)) / len(rows)
        return ex, sp

    marks = sorted({round(x, 2) for s in sf for x in s})
    marks = marks[:: max(1, len(marks) // 200)]
    best = max(marks, key=lambda m: agree(fit, sf, m)[0]) if marks else 0.0

    def quality(rows, scores, m):
        vs = verdict(rows, scores, m)
        c = {"hidden": [0, 0], "control": [0, 0], "neutral": [0, 0]}
        for r, v in zip(rows, vs):
            c[r["variant"]][1] += 1
            c[r["variant"]][0] += (r["planted"] in v) if r["variant"] != "neutral" else bool(v)
        return {k: f"{a}/{n}" for k, (a, n) in c.items()}

    fx = score_groups(model, [{"request": f["request"], "items": [{"title": f["title"], "text": f["text"]}]}
                              for f in fixtures])
    m7 = [s[0] >= best for f, s in zip(fixtures, fx) if f["src"].startswith("m7/")]
    m3 = [s[0] >= best for f, s in zip(fixtures, fx) if f["src"].startswith("m3r/")]
    ex, sp = agree(held, sh, best)
    return {"heldout_calls": len(held), "planted_vs_decoy": auc(planted, decoy), "mark": best,
            "agree_exact": round(ex, 3), "agree_speak": round(sp, 3), "quality": quality(held, sh, best),
            "haiku_quality": {k: f"{sum((r['planted'] in r['haiku']) if k != 'neutral' else bool(r['haiku']) for r in held if r['variant'] == k)}/{sum(r['variant'] == k for r in held)}" for k in ("hidden", "control", "neutral")},
            "fixtures_m7": f"{sum(m7)}/{len(m7)}", "fixtures_m3r": f"{sum(m3)}/{len(m3)}"}


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
    ap.add_argument("--eval", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--groups", type=int, default=4000)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--temp", type=float, default=2.0)
    ap.add_argument("--truth-weight", type=float, default=0.5)
    ap.add_argument("--batch-groups", type=int, default=16)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    groups = [json.loads(l) for l in open(a.train)]
    random.shuffle(groups)
    groups = groups[: a.groups]
    for g in groups:
        g["items"] = [it for it in g["items"] if it.get("visible", True)][:15]
    groups = [g for g in groups if g["items"]]
    evalrows = [json.loads(l) for l in open(a.eval)]
    fixtures = [json.loads(l) for l in open(a.fixtures)]
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
            loss = F.binary_cross_entropy_with_logits(s / a.temp, soft) + a.truth_weight * \
                F.binary_cross_entropy_with_logits(s, truth)
            opt.zero_grad()
            loss.backward()
            opt.step()
            losses.append(loss.item())
        ev = evaluate(model, evalrows, fixtures)
        curve.append({"epoch": ep, "loss": round(sum(losses) / len(losses), 4), **ev})
        print(json.dumps(curve[-1]), flush=True)
    res = {"arch": a.arch, "groups": len(groups), "epochs": a.epochs, "seconds": round(time.time() - t0),
           "final": curve[-1], "curve": curve, **size_and_latency(model, groups)}
    print(json.dumps({k: v for k, v in res.items() if k != "curve"}))
    if a.out:
        with open(a.out, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
