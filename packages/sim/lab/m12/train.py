"""M12 (D1000-D1009): query-side expansion distilled from M1's 8B teacher, with an offline pool screen.

A request's expansion e_q (item-vocabulary weights, non-negative) is searched beside its own terms; trained listwise
over each request's teacher-scored group (ten items) plus in-world and cross-world negatives, against a mix of the
teacher's softmax and the planted fact. Models (`--model`):
  lowrank  e_q[w] = sum over request terms t of g_t * relu(u_t . v_w + b_w)  (decomposable: exported as a sparse
           request-term -> item-term table, top `--topk` a term; no vectors at serving)
  qnet     e_q = relu(W2 h), h = sign(W1 grams(q))  (contextual; hashed request grams, binary hidden, M3's kernel)
Offline screen (`--eval`): M2 v2 val worlds planted among a sim base world's items; the lexical pool is BM25's first
15; an arm keeps the first 15 - S and fills S seats from the expansion's own search. Facts and decoys (the decoy's
world has the fact removed, as the funnel's control) reported, with the facts that share no term with the request.

  python3 -I train.py --train .local/m12/data/strain.terms.jsonl --teacher .local/m12/data/train.t8b.jsonl.gz \
     --val .local/m12/data/sval.terms.jsonl --distract .local/m12/data/fit.terms.jsonl --model lowrank --out W
"""
import argparse
import json
import math
import os
import random
import sys
import time
import zlib

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--train", required=True)
ap.add_argument("--teacher", default="")
ap.add_argument("--val", required=True)
ap.add_argument("--val-teacher", default="")
ap.add_argument("--distract", required=True)
ap.add_argument("--model", default="lowrank", choices=["lowrank", "qnet"])
ap.add_argument("--rank", type=int, default=64)
ap.add_argument("--hidden", type=int, default=256)
ap.add_argument("--buckets", type=int, default=1 << 18)
ap.add_argument("--bin", action="store_true", help="qnet: binary hidden (straight-through)")
ap.add_argument("--teacher-mix", type=float, default=0.5, help="weight of the teacher's softmax in the target")
ap.add_argument("--tau", type=float, default=1.5)
ap.add_argument("--l1", type=float, default=1e-3)
ap.add_argument("--neg-world", type=int, default=30)
ap.add_argument("--neg-other", type=int, default=400)
ap.add_argument("--lex", type=float, default=0.0, help="weight of the request's own BM25 in the training score")
ap.add_argument("--no-self", action="store_true", help="the expansion never weights the request's own terms")
ap.add_argument("--epochs", type=int, default=1)
ap.add_argument("--worlds", type=int, default=0, help="train on the first N worlds (0: all)")
ap.add_argument("--batch", type=int, default=64)
ap.add_argument("--lr", type=float, default=3e-3)
ap.add_argument("--topk", type=int, default=32)
ap.add_argument("--seats", type=str, default="3,5")
ap.add_argument("--eval-every", type=int, default=0)
ap.add_argument("--out", default="")
ap.add_argument("--fit-terms", default="", help="sim fit worlds (m12-export --corpus) for the funnel-shaped screen")
ap.add_argument("--fit-pool", default="", help="the funnel pool dump of those worlds (main's pool)")
ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--threads", type=int, default=0)
args = ap.parse_args()
if args.threads:
    torch.set_num_threads(args.threads)
random.seed(args.seed)
torch.manual_seed(args.seed)
t0 = time.time()

teacher = D.load_teacher(args.teacher) if args.teacher else {}
train = D.load_synth(args.train, teacher)
if args.worlds:
    train = train[: args.worlds]
val = D.load_synth(args.val, D.load_teacher(args.val_teacher) if args.val_teacher else {})
dist = D.load_fit(args.distract)[0]["items"]
IV = D.item_vocab(train)
RV = D.req_vocab(train)
print(f"loaded {len(train)} train worlds, {len(val)} val, vocab items {len(IV)} requests {len(RV)}, "
      f"teacher groups {len(teacher)} ({time.time() - t0:.0f}s)", flush=True)

# Global idf over the training items, as the item side's fixed weights in training.
allitems = [it for w in train for it in w["items"]]
Xall, IDF = D.bm25_matrix(allitems, IV)
offs = np.cumsum([0] + [len(w["items"]) for w in train])


def grams(q, buckets):
    out = set()
    for t in q:
        out.add(zlib.crc32(b"w" + t.encode()) % buckets)
        p = f"<{t}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                out.add(zlib.crc32(b"c" + p[k: k + n].encode()) % buckets)
    for a, b in zip(q, q[1:]):
        out.add(zlib.crc32(f"b{a} {b}".encode()) % buckets)
    return sorted(out)


class LowRank(torch.nn.Module):
    def __init__(self, nq, nv, r):
        super().__init__()
        self.u = torch.nn.Embedding(nq, r)
        self.g = torch.nn.Embedding(nq, 1)
        self.v = torch.nn.Parameter(torch.randn(nv, r) * 0.1)
        self.b = torch.nn.Parameter(torch.full((nv,), -0.05))
        torch.nn.init.normal_(self.u.weight, std=0.1)
        torch.nn.init.constant_(self.g.weight, 1.0)

    def expand(self, qids, qoff):
        # qids: flat request-term ids, qoff: per request start; returns (R x V) expansion.
        u = self.u(qids)  # (T, r)
        per = F.relu(u @ self.v.T + self.b) * F.softplus(self.g(qids))  # (T, V)
        R = len(qoff)
        seg = torch.repeat_interleave(torch.arange(R), torch.diff(torch.cat([qoff, torch.tensor([len(qids)])])))
        out = torch.zeros(R, per.shape[1])
        out.index_add_(0, seg, per)
        return out


class Sign(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        ctx.save_for_backward(x)
        return torch.where(x >= 0, torch.ones_like(x), -torch.ones_like(x))

    @staticmethod
    def backward(ctx, g):
        (x,) = ctx.saved_tensors
        return g * (x.abs() <= 1).float()


class QNet(torch.nn.Module):
    def __init__(self, nb, h, nv, binary):
        super().__init__()
        self.e = torch.nn.EmbeddingBag(nb, h, mode="sum")
        torch.nn.init.normal_(self.e.weight, std=0.05)
        self.w2 = torch.nn.Linear(h, nv)
        torch.nn.init.constant_(self.w2.bias, -0.05)
        self.binary = binary
        self.ln = torch.nn.LayerNorm(h)

    def expand(self, gids, goff):
        h = self.ln(self.e(gids, goff))
        h = Sign.apply(h) if self.binary else torch.tanh(h)
        return F.relu(self.w2(h))


NV = len(IV)
DIST_X, _ = D.bm25_matrix(D.load_fit(args.distract)[2]["items"], IV, IDF)  # another sim world: negatives
model = LowRank(len(RV), NV, args.rank) if args.model == "lowrank" else QNet(args.buckets, args.hidden, NV, args.bin)
opt = torch.optim.Adam(model.parameters(), lr=args.lr)


def encode(reqs):
    if args.model == "lowrank":
        ids, off = [], []
        for r in reqs:
            off.append(len(ids))
            ids += [RV.id[t] for t in dict.fromkeys(r["q"]) if t in RV.id]
        return torch.tensor(ids, dtype=torch.long), torch.tensor(off, dtype=torch.long)
    ids, off = [], []
    for r in reqs:
        off.append(len(ids))
        ids += grams(r["q"], args.buckets)
    return torch.tensor(ids, dtype=torch.long), torch.tensor(off, dtype=torch.long)


def qvec(r):
    """The request's own terms as a 0/1 vector over the item vocabulary (the lexical side)."""
    v = np.zeros(NV, np.float32)
    for t in set(r["q"]):
        j = IV.id.get(t)
        if j is not None:
            v[j] = 1.0
    return v


def batches(worlds):
    reqs = [(wi, r) for wi, w in enumerate(worlds) for r in w["reqs"] if r["teacher"] or True]
    random.shuffle(reqs)
    for i in range(0, len(reqs), args.batch):
        yield reqs[i: i + args.batch]


def train_step(batch):
    """In-batch listwise: every request scores the union of the batch's worlds' items and a sample of sim base
    items (the funnel's real competitors); its target is the teacher's softmax over its own group (mixed with the
    planted fact), zero elsewhere."""
    wis = sorted({wi for wi, _ in batch})
    cols = []
    for wi in wis:
        cols += list(range(offs[wi], offs[wi + 1]))
    base = len(cols)
    dsel = random.sample(range(DIST_X.shape[0]), min(args.neg_other, DIST_X.shape[0]))
    colpos = {c: i for i, c in enumerate(cols)}
    Xc = D.sp.vstack([Xall[cols], DIST_X[dsel]]).tocoo()
    Xt = torch.sparse_coo_tensor(np.vstack([Xc.row, Xc.col]), Xc.data, (Xc.shape[0], NV)).coalesce()
    reqs = [r for _, r in batch]
    T = torch.zeros(len(batch), Xc.shape[0])
    Q = np.zeros((len(batch), NV), np.float32)
    for i, (wi, r) in enumerate(batch):
        w = train[wi]
        keys = {it["id"]: offs[wi] + k for k, it in enumerate(w["items"])}
        tch = r["teacher"] or {}
        idx, lg = [], []
        for key, sc in tch.items():
            if key in keys:
                idx.append(colpos[keys[key]])
                lg.append(sc)
        if r["fact"] in keys and colpos[keys[r["fact"]]] not in idx:
            idx.append(colpos[keys[r["fact"]]])
            lg.append(max(lg) if lg else 0.0)
        if lg:
            p = torch.softmax(torch.tensor(lg) / args.tau, 0) * args.teacher_mix
            T[i, idx] += p
        if r["fact"] in keys:
            T[i, colpos[keys[r["fact"]]]] += 1 - args.teacher_mix if lg else 1.0
        for t in set(r["q"]):
            j = IV.id.get(t)
            if j is not None:
                Q[i, j] = 1.0
    ids, off = encode(reqs)
    e = model.expand(ids, off)  # (R, V)
    if args.no_self:
        e = e * torch.tensor(1 - Q)
    S = torch.sparse.mm(Xt, e.T).T  # (R, C)
    if args.lex:
        S = S + args.lex * torch.sparse.mm(Xt, torch.tensor(Q).T).T
    loss = -(T * F.log_softmax(S, 1)).sum(1).mean() + args.l1 * e.sum(1).mean()
    opt.zero_grad()
    loss.backward()
    opt.step()
    return float(loss), float((e > 0).float().sum(1).mean())


# ---- export: a sparse table (lowrank) or the net itself ----
def expansion_fn():
    """request terms -> {item term id: weight}, as served (lowrank: summed per-term top-k rows)."""
    model.eval()
    if args.model == "lowrank":
        with torch.no_grad():
            table = {}
            V = model.v
            for t0 in range(0, len(RV), 2048):
                ids = torch.arange(t0, min(len(RV), t0 + 2048))
                per = F.relu(model.u(ids) @ V.T + model.b) * F.softplus(model.g(ids))
                vals, idx = per.topk(args.topk, 1)
                for k, t in enumerate(ids.tolist()):
                    keep = vals[k] > 0
                    table[t] = (idx[k][keep].numpy(), vals[k][keep].numpy())
        def fn(q):
            out = {}
            for t in dict.fromkeys(q):
                j = RV.id.get(t)
                if j is None:
                    continue
                ii, vv = table[j]
                for a, b in zip(ii, vv):
                    out[a] = out.get(a, 0.0) + float(b)
            return out
        fn.table = table
        return fn

    def fn(q):
        with torch.no_grad():
            ids, off = encode([{"q": q}])
            e = model.expand(ids, off)[0]
            vals, idx = e.topk(args.topk)
            return {int(i): float(v) for i, v in zip(idx, vals) if v > 0}
    return fn


def evaluate(tag):
    fn = expansion_fn()
    seats = [int(s) for s in args.seats.split(",")]
    tot = {"h": 0, "c": 0, "h0": 0, "c0": 0, "zero": 0, "zero0": 0}
    for S in seats:
        tot[f"h{S}"] = tot[f"c{S}"] = tot[f"zero{S}"] = 0
    expn = []
    for w in val:
        items = w["items"] + dist
        X, _ = D.bm25_matrix(items, IV)
        ids = [it["id"] for it in w["items"]] + ["d"] * len(dist)
        pos = {k: i for i, k in enumerate(ids) if k != "d"}
        for r in w["reqs"]:
            ex = fn(r["q"])
            expn.append(len(ex))
            qv = qvec(r)
            lex = X @ qv
            ev = np.zeros(NV, np.float32)
            for j, v in ex.items():
                ev[j] = v
            exs = X @ ev
            for var, keep, drop in (("h", r["fact"], r["decoy"]), ("c", r["decoy"], r["fact"])):
                if keep not in pos:
                    continue
                k = pos[keep]
                dmask = pos.get(drop)
                l2 = lex.copy()
                e2 = exs.copy()
                if dmask is not None:
                    l2[dmask] = -1
                    e2[dmask] = -1
                tot[var] += 1
                order = np.argsort(-l2, kind="stable")
                order = order[l2[order] > 0]
                base = set(order[:15].tolist())
                zero = lex[k] <= 0
                if var == "h" and zero:
                    tot["zero"] += 1
                if k in base:
                    tot[var + "0"] += 1
                    if var == "h" and zero:
                        tot["zero0"] += 1
                eo = np.argsort(-e2, kind="stable")
                eo = eo[e2[eo] > 0][:60].tolist()
                for S in seats:
                    head = order[: 15 - S].tolist()
                    hs = set(head)
                    fill = [x for x in eo if x not in hs][:S]
                    if len(fill) < S:  # unused seats go back to the lexical order
                        fill += [x for x in order[15 - S:].tolist() if x not in hs and x not in fill][: S - len(fill)]
                    if k in hs or k in fill:
                        tot[f"{var}{S}"] += 1
                        if var == "h" and zero:
                            tot[f"zero{S}"] += 1
    n = tot["h"]
    line = (f"[{tag}] val requests {n}: lexical@15 facts {tot['h0']} decoys {tot['c0']} (no shared term: "
            f"{tot['zero']}, {tot['zero0']} in)")
    for S in seats:
        line += (f" | S={S}: facts {tot[f'h{S}']} ({100 * (tot[f'h{S}'] - tot['h0']) / n:+.1f} pts) decoys "
                 f"{tot[f'c{S}']} ({100 * (tot[f'c{S}'] - tot['c0']) / max(tot['c'], 1):+.1f}) zero {tot[f'zero{S}']}")
    line += f" | expansion terms {np.mean(expn):.1f}"
    print(line, flush=True)
    model.train()
    return tot


def evaluate_fit(tag):
    """The funnel's own pools on the sim's fit suites: S tail seats from the expansion's search over each world."""
    if not args.fit_terms:
        return
    fn = expansion_fn()
    pools = {}
    for p in D.read_jsonl(args.fit_pool):
        pools[(p["suite"], p["seed"], p["variant"], p["template"])] = [x["id"] for x in p["pool"]]
    seats = [int(x) for x in args.seats.split(",")]
    tot = {}
    for w in D.load_fit(args.fit_terms):
        if w["key"][2] not in ("hidden", "control"):
            continue
        var = w["key"][2][0]
        X, _ = D.bm25_matrix(w["items"], IV)
        ids = [it["id"] for it in w["items"]]
        for t in w["tasks"]:
            pool = pools.get(w["key"] + (t["template"],))
            if pool is None:
                continue
            ex = fn(t["q"])
            ev = np.zeros(NV, np.float32)
            for j, v in ex.items():
                ev[j] = v
            sc = X @ ev
            eo = [ids[i] for i in np.argsort(-sc) if sc[i] > 0][:60]
            tot[var] = tot.get(var, 0) + 1
            tot[var + "0"] = tot.get(var + "0", 0) + (t["planted"] in pool)
            for S in seats:
                head = pool[: 15 - S] if len(pool) >= 15 - S else pool
                fill = [x for x in eo if x not in head][:S]
                rest = [x for x in pool[len(head):] if x not in fill][: max(0, S - len(fill))]
                new = set(head) | set(fill) | set(rest)
                tot[f"{var}{S}"] = tot.get(f"{var}{S}", 0) + (t["planted"] in new)
    line = f"[{tag} fit] hidden {tot.get('h0')}/{tot.get('h')} decoys {tot.get('c0')}/{tot.get('c')}"
    for S in seats:
        line += f" | S={S}: hidden {tot.get(f'h{S}')} decoys {tot.get(f'c{S}')}"
    print(line, flush=True)


step = 0
for ep in range(args.epochs):
    tl = 0.0
    for b in batches(train):
        l, nz = train_step(b)
        tl += l
        step += 1
        if step % 50 == 0:
            print(f"ep {ep} step {step} loss {tl / 50:.3f} active terms {nz:.0f} ({time.time() - t0:.0f}s)", flush=True)
            tl = 0.0
        if args.eval_every and step % args.eval_every == 0:
            evaluate(f"step {step}")
    evaluate(f"epoch {ep}")
    evaluate_fit(f"epoch {ep}")
if args.out:
    os.makedirs(args.out, exist_ok=True)
    torch.save({"state": model.state_dict(), "args": vars(args), "iv": IV.terms, "rv": RV.terms,
                "idf": IDF}, os.path.join(args.out, "model.pt"))
    print("saved", args.out)
