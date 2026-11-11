"""M7 (D930): the pre-screen's neural candidates (round 1/2), on m7.py's rows, thresholds and settle rule.

  --arch xnorpair  H2: hashed request and item n-grams, ternary encoder to sign codes, (r*c, r, c, prior) binary MLP
  --arch hitbloom  H3: which request n-grams occur in the item (match bits, miss bits, bucketed) + item code, binary MLP
  --arch poolset   H4: per-item binary code (H1's quantised features + match bits) pooled over the pool (max, mean),
                   a per-item head and a pool head P(any yes); silence reads the pool head
  --arch heads     H5: hitbloom with three heads trained on the reply's structure (listed, hits not none, act)
  --arch prior     H6: the request alone -> P(any yes) (pool head), items from H1's quantised features
Every arch reads H1's features quantised to bits (`--no-prior` drops them). `--float` trains unquantised.

  python3 -I packages/sim/lab/m7/nets.py --dumps '.local/m7/dump-train-*.jsonl' --arch hitbloom [--epochs 6]
"""

import argparse
import json
import os
import re
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

import m7  # noqa: E402

torch.set_num_threads(int(os.environ.get("M7_THREADS", "2")))


def grams(text, buckets, cap=300):
    ws = re.findall(r"[a-z0-9£$€]+", text.lower())[:150]
    out = set()
    for w in ws:
        out.add(zlib.crc32(b"w" + w.encode()) % buckets)
        p = f"<{w}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                out.add(zlib.crc32(b"c" + p[k : k + n].encode()) % buckets)
    for a, b in zip(ws, ws[1:]):
        out.add(zlib.crc32(f"b{a} {b}".encode()) % buckets)
    return sorted(out)[:cap]


def word_grams(text):
    """Content words of the text, hashed (32-bit): the match test's units."""
    return set(zlib.crc32(w.encode()) for w in m7.content(text))


class Sign(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        ctx.save_for_backward(x)
        return torch.where(x >= 0, 1.0, -1.0)

    @staticmethod
    def backward(ctx, g):
        (x,) = ctx.saved_tensors
        return g * (x.abs() <= 1).float()


def ternary(w):
    a = w.abs().mean()
    q = torch.where(w > 0.7 * a, a, torch.where(w < -0.7 * a, -a, torch.zeros_like(w)))
    return w + (q - w).detach()


def binary(w):
    a = w.abs().mean(dim=1, keepdim=True)
    return w + (a * torch.sign(w) - w).detach()


class Enc(nn.Module):
    def __init__(self, real, buckets, bits):
        super().__init__()
        self.real = real
        self.w = nn.Parameter(torch.randn(buckets, bits) * 0.01)
        self.norm = nn.BatchNorm1d(bits)

    def forward(self, ids, offs):
        W = self.w if self.real else ternary(self.w)
        h = nn.functional.embedding_bag(ids, W, offs, mode="sum")
        h = self.norm(h)
        return torch.tanh(h) if self.real else Sign.apply(h)


class BinLin(nn.Module):
    def __init__(self, real, i, o):
        super().__init__()
        self.real = real
        self.w = nn.Parameter(torch.randn(o, i) * (1 / i) ** 0.5)
        self.norm = nn.BatchNorm1d(o)

    def forward(self, x):
        W = self.w if self.real else binary(self.w)
        return self.norm(x @ W.T)


def act(real, x):
    return torch.tanh(x) if real else Sign.apply(x)


MATCH = 128


def match_bits(req, item_text):
    """+-1 bits: which of the request's content words occur in the item (bucket = word hash), and which do not."""
    r = word_grams(req)
    it = word_grams(item_text)
    m = -np.ones(2 * MATCH, dtype=np.float32)
    for g in r:
        m[(g % MATCH) + (0 if g in it else MATCH)] = 1.0
    return m


def reply_labels(r):
    """Per item: listed, hits not none, act (the check's yes). From the reply's JSON; None when unreadable."""
    n = len(r["items"])
    yes = set(r["yes"])
    out = [[0, 0, 1 if it["id"] in yes else 0] for it in r["items"]]
    try:
        t = r.get("reply") or ""
        ents = json.loads(t[t.index("{") : t.rindex("}") + 1]).get("items", [])
        for e in ents:
            i = int(e.get("i")) - 1
            if 0 <= i < n:
                out[i][0] = 1
                h = str(e.get("hits", "")).strip().lower()
                out[i][1] = 0 if (not h or h.startswith("none") or h in ("no", "nothing", "n/a")) else 1
    except Exception:
        pass
    return out


class Data:
    def __init__(self, rows, args, cuts=None):
        self.rows = rows
        X, Y, G = m7.matrix(rows)
        if args.no_tags:
            for n in ["cprob", "maxclike"]:
                X[:, m7.FEATURE_NAMES.index(n)] = 0
        self.cuts = cuts if cuts is not None else np.quantile(X, [0.2, 0.4, 0.6, 0.8], axis=0).T
        bits = np.concatenate([np.where(X[:, j : j + 1] > self.cuts[j][None, :], 1.0, -1.0) for j in range(X.shape[1])], 1)
        self.prior = torch.tensor(bits if not args.no_prior else np.zeros((len(X), 0)), dtype=torch.float32)
        self.Y = torch.tensor(Y, dtype=torch.float32)
        self.G = G
        self.req_ids, self.req_offs, self.it_ids, self.it_offs, self.match, self.heads = [], [], [], [], [], []
        k = 0
        for gi, r in enumerate(rows):
            rg = grams(r["request"], args.buckets)
            for it, h in zip(r["items"], reply_labels(r)):
                t = f"{it['title']}\n{it['text']}"
                self.req_offs.append(len(self.req_ids))
                self.req_ids += rg or [0]
                self.it_offs.append(len(self.it_ids))
                self.it_ids += grams(t, args.buckets) or [0]
                self.match.append(match_bits(r["request"], t))
                self.heads.append(h)
                k += 1
        self.match = torch.tensor(np.array(self.match))
        self.heads = torch.tensor(np.array(self.heads), dtype=torch.float32)
        self.pool_y = torch.tensor([1.0 if r["yes"] else 0.0 for r in rows])

    def batch(self, pools):
        idx = np.concatenate([np.where(self.G == p)[0] for p in pools])
        seg = np.concatenate([np.full((self.G == p).sum(), k) for k, p in enumerate(pools)])

        def bag(ids, offs, sel):
            out, o = [], []
            for i in sel:
                o.append(len(out))
                end = offs[i + 1] if i + 1 < len(offs) else len(ids)
                out += ids[offs[i] : end]
            return torch.tensor(out), torch.tensor(o)

        r = bag(self.req_ids, self.req_offs, idx)
        c = bag(self.it_ids, self.it_offs, idx)
        return idx, torch.tensor(seg), r, c


class Net(nn.Module):
    def __init__(self, arch, args, prior_dim):
        super().__init__()
        real, B = args.float, args.bits
        self.arch, self.real = arch, real
        self.renc = Enc(real, args.buckets, B) if arch in ("xnorpair", "prior") else None
        self.ienc = Enc(real, args.buckets, B) if arch in ("xnorpair", "hitbloom", "heads", "poolset") else None
        dim = prior_dim
        if arch == "xnorpair":
            dim += 3 * B
        if arch in ("hitbloom", "heads", "poolset"):
            dim += 2 * MATCH + B
        self.l1 = BinLin(real, dim, args.width)
        self.l2 = BinLin(real, args.width, args.width // 2)
        self.head = nn.Linear(args.width // 2, 3 if arch == "heads" else 1)
        if arch == "poolset":
            self.pool = nn.Linear(args.width, 1)
        if arch == "prior":
            self.rl = BinLin(real, B, args.width)
            self.pool = nn.Linear(args.width, 1)

    def forward(self, data, idx, seg, r, c, npools):
        parts = [data.prior[idx]]
        if self.arch == "xnorpair":
            rc, cc = self.renc(*r), self.ienc(*c)
            parts += [rc * cc, rc, cc]
        if self.arch in ("hitbloom", "heads", "poolset"):
            parts += [data.match[idx], self.ienc(*c)]
        x = torch.cat(parts, 1)
        h1 = act(self.real, self.l1(x))
        h2 = act(self.real, self.l2(h1))
        out = self.head(h2)
        pool = None
        if self.arch == "poolset":
            mx = torch.full((npools, h1.shape[1]), -1.0).scatter_reduce(0, seg[:, None].expand_as(h1), h1, "amax")
            pool = self.pool(mx).squeeze(1)
        if self.arch == "prior":
            rc = self.renc(*r)
            # One request a pool: its first item's row stands for it.
            first = torch.zeros(npools, dtype=torch.long).scatter_reduce(
                0, seg, torch.arange(len(seg)), "amin", include_self=False
            )
            pool = self.pool(act(self.real, self.rl(rc[first]))).squeeze(1)
        return out, pool


def train(data, pools, args, val=None):
    net = Net(args.arch, args, data.prior.shape[1])
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    bce = nn.BCEWithLogitsLoss()
    rng = np.random.default_rng(args.seed)
    for ep in range(args.epochs):
        net.train()
        order = rng.permutation(pools)
        tot = 0.0
        for k in range(0, len(order), args.batch):
            ps = order[k : k + args.batch]
            idx, seg, r, c = data.batch(ps)
            out, pool = net(data, idx, seg, r, c, len(ps))
            if args.arch == "heads":
                loss = bce(out, data.heads[idx])
            else:
                loss = bce(out[:, 0], data.Y[idx])
            if pool is not None:
                loss = loss + bce(pool, data.pool_y[ps])
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item()
        print(f"  epoch {ep} loss {tot / max(1, len(order) // args.batch):.4f}", flush=True)
    return net


@torch.no_grad()
def predict(net, data, pools):
    net.eval()
    probs = np.zeros(len(data.Y), dtype=np.float32)
    pool_p = {}
    for k in range(0, len(pools), 256):
        ps = pools[k : k + 256]
        idx, seg, r, c = data.batch(ps)
        out, pool = net(data, idx, seg, r, c, len(ps))
        p = torch.sigmoid(out[:, 2] if net.arch == "heads" else out[:, 0]).numpy()
        probs[idx] = p
        if pool is not None:
            for j, pp in enumerate(torch.sigmoid(pool).numpy()):
                pool_p[ps[j]] = float(pp)
    return probs, pool_p


def as_pools(data, probs, pool_p, pools):
    """(item probs, yes set) per pool; with a pool head, silence reads it: every item's prob is capped by it."""
    out = []
    for p in pools:
        idx = np.where(data.G == p)[0]
        r = data.rows[p]
        yes = set(k for k, it in enumerate(r["items"]) if it["id"] in set(r["yes"]))
        pr = [float(x) for x in probs[idx]]
        if p in pool_p:
            # The pool head decides silence: a pool it reads as silent has every item under it.
            pr = [min(x, pool_p[p]) if pool_p[p] < max(pr) else x for x in pr]
        out.append((pr, yes))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dumps", nargs="+", required=True)
    ap.add_argument("--heldout", default="train5,train6")
    ap.add_argument("--arch", default="hitbloom")
    ap.add_argument("--target", type=float, default=0.006)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--bits", type=int, default=128)
    ap.add_argument("--width", type=int, default=128)
    ap.add_argument("--buckets", type=int, default=1 << 14)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--folds", type=int, default=3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--float", action="store_true")
    ap.add_argument("--no-prior", action="store_true")
    ap.add_argument("--no-tags", action="store_true")
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    rows = m7.load(args.dumps, need_tags=not args.no_tags)
    held = set(args.heldout.split(","))
    base = lambda r: re.sub(r"(rw|r)$", "", m7.suite_of(r))
    tr = [r for r in rows if base(r) not in held]
    te = [r for r in rows if base(r) in held]
    print(f"{args.arch}{' float' if args.float else ''}: train {len(tr)} pools, held-out {len(te)}", flush=True)
    dtr = Data(tr, args)
    dte = Data(te, args, cuts=dtr.cuts)
    fams = sorted(set(m7.family(r) for r in tr))
    rng = np.random.default_rng(0)
    rng.shuffle(fams)
    fold_of = {f: k % args.folds for k, f in enumerate(fams)}
    pf = np.array([fold_of[m7.family(r)] for r in tr])
    oof_pools = []
    for k in range(args.folds):
        trp = np.where(pf != k)[0]
        vap = list(np.where(pf == k)[0])
        net = train(dtr, trp, args)
        probs, pool_p = predict(net, dtr, vap)
        oof_pools += as_pools(dtr, probs, pool_p, vap)
    ts, tp, tl = m7.pick(oof_pools, args.target)
    n, s, b, sil, pas = m7.score_rule(oof_pools, ts, tp, tl)
    print(f"thresholds silent<{ts:.4f} pass>={tp} low<{tl}; out-of-fold settled {s}/{n} ({s/n:.1%}), "
          f"disagree {b} ({b/max(1,s):.2%})", flush=True)
    net = train(dtr, np.arange(len(tr)), args)
    probs, pool_p = predict(net, dte, list(range(len(te))))
    hp = as_pools(dte, probs, pool_p, list(range(len(te))))
    n, s, b, sil, pas = m7.score_rule(hp, ts, tp, tl)
    from sklearn.metrics import roc_auc_score

    auc = roc_auc_score(dte.Y.numpy(), probs)
    print(f"HELD-OUT {args.heldout}: settled {s}/{n} ({s/max(1,n):.1%}), disagree {b} ({b/max(1,s):.2%}), "
          f"silent {sil}, pass {pas}; item AUC {auc:.3f}")
    print("HELD-OUT " + m7.curve_line(hp))
    if args.json:
        json.dump({"arch": args.arch, "curve": m7.curve(hp), "float": args.float, "heldout_calls": n, "settled": s, "disagree": b,
                   "silent": sil, "pass": pas, "item_auc": auc, "thresholds": [ts, tp, tl],
                   "oof": [len(oof_pools), *m7.score_rule(oof_pools, ts, tp, tl)[1:3]]}, open(args.json, "w"))


if __name__ == "__main__":
    main()
