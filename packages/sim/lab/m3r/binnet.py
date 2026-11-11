"""M3 binarised networks (D907): small local test runs on CPU, one architecture per Eden spot, each with a float twin.

No tokenizer, no pretrained weights, no vector retrieval: text enters as hashed word and character n-gram ids; the
first layer is ternary (weights -1/0/+1) into a sign code; later layers are binary (weights ±1, XNOR-popcount at
inference); straight-through estimators train them. `--float` runs the same network unquantised.

Architectures (`--arch`), on export_groups.py's files:
  pair     request x candidate x the candidate's corpus twin -> score, with a NULL ("nothing here") head; listwise.
           Spot: ranking the handed five, twin rejection, silence (the NULL margin).
  notwin   the same without the twin pathway (its ablation).
  tagger   the item alone -> "constraint (a fact) or not (its all-clear twin, anything else)". Spot: ingest-time
           understanding (one stored bit an item).
  silence  the request and its first five candidates as a set -> push or stay silent. Spot: the push decision.
  keys     items and requests -> K learned discrete keys from a codebook (argmax, straight-through); candidates are
           the items sharing a key, an exact lookup. Spot: recall for facts that share no word with the request.

  .venv-m3/bin/python packages/sim/lab/m3r/binnet.py --arch pair --train groups-A.jsonl.gz --eval evalA.jsonl.gz \
      [--float] [--worlds 40] [--epochs 3] [--bits 128] [--held train5,train6] [--out RESULT.json]
Prints a learning curve (loss each 20 steps, held-out metrics each epoch) and writes the final metrics as JSON.
"""
import argparse, gzip, json, os, random, re, sys, time, zlib

import torch
import torch.nn as nn

torch.set_num_threads(int(os.environ.get("BINNET_THREADS", "1")))
BUCKETS = 1 << 16


def grams(text, cap=300):
    words = re.findall(r"[a-z0-9£$€]+", text.lower())[:150]
    out = set()
    for w in words:
        out.add(zlib.crc32(b"w" + w.encode()) % BUCKETS)
        p = f"<{w}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                out.add(zlib.crc32(b"c" + p[k : k + n].encode()) % BUCKETS)
    for a, b in zip(words, words[1:]):
        out.add(zlib.crc32(f"b{a} {b}".encode()) % BUCKETS)
    return sorted(out)[:cap]


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


class Q:
    """Quantisation switches shared by a network's layers."""

    def __init__(self, real):
        self.real = real
        self.act = torch.tanh if real else Sign.apply


class Enc(nn.Module):
    def __init__(self, q, bits):
        super().__init__()
        self.q = q
        self.w = nn.Parameter(torch.randn(BUCKETS, bits) * 0.01)
        self.norm = nn.BatchNorm1d(bits)

    def forward(self, texts):
        ids, offs = [], []
        for t in texts:
            offs.append(len(ids))
            ids += grams(t) or [0]
        W = self.w if self.q.real else ternary(self.w)
        h = nn.functional.embedding_bag(torch.tensor(ids), W, torch.tensor(offs), mode="sum")
        return self.q.act(self.norm(h))


class BinLin(nn.Module):
    def __init__(self, q, i, o):
        super().__init__()
        self.q = q
        self.w = nn.Parameter(torch.randn(o, i) * (1 / i) ** 0.5)
        self.norm = nn.BatchNorm1d(o)

    def forward(self, x):
        W = self.w if self.q.real else binary(self.w)
        return self.norm(x @ W.T)


class Pair(nn.Module):
    def __init__(self, q, bits, twin=True):
        super().__init__()
        self.q, self.twin = q, twin
        self.ienc, self.qenc = Enc(q, bits), Enc(q, bits)
        self.l1 = BinLin(q, (5 if twin else 3) * bits, 128)
        self.l2 = BinLin(q, 128, 32)
        self.head = nn.Linear(32, 1)
        self.n1 = BinLin(q, bits, 32)
        self.nhead = nn.Linear(32, 1)

    def forward(self, qc, ic, tc):
        R, K, B = ic.shape
        qq = qc.unsqueeze(1).expand(R, K, B)
        parts = [qq * ic, qq, ic] + ([ic * tc, tc] if self.twin else [])
        h = self.q.act(self.l1(torch.cat(parts, -1).reshape(R * K, -1)))
        h = self.q.act(self.l2(h))
        return self.head(h).view(R, K), self.nhead(self.q.act(self.n1(qc))).squeeze(-1)


class Tagger(nn.Module):
    def __init__(self, q, bits):
        super().__init__()
        self.q = q
        self.enc = Enc(q, bits)
        self.l1 = BinLin(q, bits, 64)
        self.head = nn.Linear(64, 1)

    def forward(self, texts):
        return self.head(self.q.act(self.l1(self.enc(texts)))).squeeze(-1)


class Silence(nn.Module):
    def __init__(self, q, bits, k=5):
        super().__init__()
        self.q, self.k = q, k
        self.ienc, self.qenc = Enc(q, bits), Enc(q, bits)
        self.l1 = BinLin(q, 2 * bits, 64)
        self.l2 = BinLin(q, 64 + bits, 32)
        self.head = nn.Linear(32, 1)

    def forward(self, qc, ic):
        R, K, B = ic.shape
        qq = qc.unsqueeze(1).expand(R, K, B)
        h = self.q.act(self.l1(torch.cat([qq * ic, ic], -1).reshape(R * K, -1))).view(R, K, -1)
        pooled = self.q.act(h.sum(1))  # a majority vote over the set (sign of the sum)
        return self.head(self.q.act(self.l2(torch.cat([pooled, qc], -1)))).squeeze(-1)


class Keys(nn.Module):
    """K discrete keys from a codebook of C: each key is the argmax of a binary layer's C logits (straight-through
    softmax in training); a request and an item match on a shared key."""

    def __init__(self, q, bits, K=4, C=256):
        super().__init__()
        self.q, self.K, self.C = q, K, C
        self.ienc, self.qenc = Enc(q, bits), Enc(q, bits)
        self.ik = BinLin(q, bits, K * C)
        self.qk = BinLin(q, bits, K * C)

    def codes(self, x, layer):
        logits = layer(x).view(-1, self.K, self.C)
        soft = torch.softmax(logits, -1)
        hard = nn.functional.one_hot(soft.argmax(-1), self.C).float()
        return hard + soft - soft.detach()  # straight-through: exact keys forward, soft gradients back

    def match(self, qtexts, itexts):
        qk = self.codes(self.qenc(qtexts), self.qk)  # (R, K, C)
        ik = self.codes(self.ienc(itexts), self.ik)  # (N, K, C)
        return torch.einsum("rkc,nkc->rn", qk, ik), qk, ik  # number of shared keys (same slot, same code)


def load(path, n=None, every=1):
    out = []
    with gzip.open(path, "rt") as f:
        for i, line in enumerate(f):
            if i % every == 0:
                out.append(json.loads(line))
            if n and len(out) >= n:
                break
    return out


def held(r, heldout):
    return r["template"].split("/")[0] in heldout


def write_ranks(net, worlds, path):
    """Every eval request's candidates in the scorer's order (world ids), and the NULL margin of each: the file
    score.py reads (`top`: above NULL, `all`: the whole order)."""
    net.eval()
    with torch.no_grad(), open(path, "w") as f:
        for w in worlds:
            rs = [r for r in w["reqs"] if r["cands"]]
            if not rs:
                continue
            codes = net.ienc(w["texts"])
            for r in rs:
                c = torch.tensor(r["cands"])
                t = torch.tensor([w["twin"][k] if w["twin"][k] >= 0 else k for k in r["cands"]])
                s, nl = net(net.qenc([r["request"]]), codes[c].unsqueeze(0), codes[t].unsqueeze(0))
                order = torch.argsort(-s[0]).tolist()
                ids = [w["ids"][r["cands"][k]] for k in order]
                f.write(json.dumps({"rid": r["rid"], "all": ids,
                                    "top": [x for x, k in zip(ids, order) if float(s[0][k]) > float(nl[0])]}) + "\n")
    net.train()


def eval_pair(net, worlds, heldout):
    """Held-out requests: fact in the scorer's first 5 / first 1 (hidden, fact among candidates), twin in its first 5
    (control), and silence: share of control requests whose best candidate scores below NULL, of hidden ones above."""
    net.eval()
    m = {"hidden": 0, "fact@1": 0, "fact@5": 0, "control": 0, "twin@5": 0, "silent_ctl": 0, "spoke_hid": 0}
    with torch.no_grad():
        for w in worlds:
            rs = [r for r in w["reqs"] if r["cands"] and held(r, heldout)]
            if not rs:
                continue
            codes = net.ienc(w["texts"])
            for r in rs:
                c = torch.tensor(r["cands"])
                t = torch.tensor([w["twin"][k] if w["twin"][k] >= 0 else k for k in r["cands"]])
                s, nl = net(net.qenc([r["request"]]), codes[c].unsqueeze(0), codes[t].unsqueeze(0))
                order = torch.argsort(-s[0]).tolist()
                ranked = [r["cands"][k] for k in order]
                top = float(s[0].max())
                if r["kind"] == "hidden":
                    if r["target"] < 0:
                        continue
                    m["hidden"] += 1
                    m["fact@1"] += ranked[0] == r["cands"][r["target"]]
                    m["fact@5"] += r["cands"][r["target"]] in ranked[:5]
                    m["spoke_hid"] += top > float(nl[0])
                else:
                    m["control"] += 1
                    m["twin@5"] += r["planted"] in ranked[:5]
                    m["silent_ctl"] += top <= float(nl[0])
    net.train()
    return m


def lexical5(r):
    """The candidates' lexical order is the export's insertion order (BM25's first 40 come first)."""
    return r["cands"][:5]


def run(o):
    random.seed(7)
    torch.manual_seed(7)
    heldout = set(o.held.split(","))
    train = load(o.train, o.worlds, o.every)
    ev = load(o.eval)
    q = Q(o.float)
    t0 = time.time()
    curve = []
    if o.arch in ("pair", "notwin"):
        net = Pair(q, o.bits, twin=o.arch == "pair")
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        base = {"fact@5_lexical": sum(1 for w in ev for r in w["reqs"] if held(r, heldout) and r["kind"] == "hidden"
                                      and r["target"] >= 0 and r["target"] < 5)}
        step = 0
        for ep in range(o.epochs):
            for w in random.sample(train, len(train)):
                rs = [r for r in w["reqs"] if r["cands"] and not (r["kind"] == "hidden" and r["target"] < 0)][:48]
                if not rs:
                    continue
                codes = net.ienc(w["texts"])
                K = max(len(r["cands"]) for r in rs)
                c = torch.zeros(len(rs), K, dtype=torch.long)
                mask = torch.ones(len(rs), K, dtype=torch.bool)
                for a, r in enumerate(rs):
                    c[a, : len(r["cands"])] = torch.tensor(r["cands"])
                    mask[a, : len(r["cands"])] = False
                tw = torch.tensor(w["twin"])
                t = torch.where(tw[c] >= 0, tw[c], c)
                s, nl = net(net.qenc([r["request"] for r in rs]), codes[c], codes[t])
                logits = torch.cat([nl.unsqueeze(1), s.masked_fill(mask, -1e4)], 1)
                y = torch.tensor([r["target"] + 1 if r["target"] >= 0 else 0 for r in rs])
                loss = nn.functional.cross_entropy(logits, y)
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
            m = eval_pair(net, ev, heldout)
            print({"epoch": ep, **m, **base, "s": round(time.time() - t0)}, flush=True)
        result = {**m, **base}
        for path, ws in ((o.ranks, ev), (o.ranks2, load(o.eval2) if o.eval2 else [])):
            if path:
                write_ranks(net, ws, path)
    elif o.arch == "tagger":
        net = Tagger(q, o.bits)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)

        def rows(ws, only_held=None):
            xs, ys = [], []
            for w in ws:
                for r in w["reqs"]:
                    if only_held is not None and held(r, heldout) != only_held:
                        continue
                    if r["planted"] < 0:
                        continue
                    xs.append(w["texts"][r["planted"]])
                    ys.append(1.0 if r["kind"] == "hidden" else 0.0)
                    other = random.randrange(len(w["texts"]))
                    if other != r["planted"]:
                        xs.append(w["texts"][other])
                        ys.append(0.0)
            return xs, ys

        X, Y = rows(train)
        Xe, Ye = rows(ev, True)
        step = 0
        for ep in range(o.epochs):
            idx = list(range(len(X)))
            random.shuffle(idx)
            for a in range(0, len(idx), 64):
                b = idx[a : a + 64]
                loss = nn.functional.binary_cross_entropy_with_logits(net([X[k] for k in b]), torch.tensor([Y[k] for k in b]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
            net.eval()
            with torch.no_grad():
                p = torch.cat([net(Xe[a : a + 256]) for a in range(0, len(Xe), 256)]).tolist()
            net.train()
            result = auc_split(p, Ye, Xe, ev, heldout)
            print({"epoch": ep, **result, "s": round(time.time() - t0)}, flush=True)
    elif o.arch == "silence":
        net = Silence(q, o.bits)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        step = 0
        for ep in range(o.epochs):
            for w in random.sample(train, len(train)):
                rs = [r for r in w["reqs"] if len(r["cands"]) >= 5][:48]
                if not rs:
                    continue
                codes = net.ienc(w["texts"])
                c = torch.tensor([lexical5(r) for r in rs])
                y = torch.tensor([1.0 if r["kind"] == "hidden" else 0.0 for r in rs])
                loss = nn.functional.binary_cross_entropy_with_logits(net(net.qenc([r["request"] for r in rs]), codes[c]), y)
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
            net.eval()
            ps, ys = [], []
            with torch.no_grad():
                for w in ev:
                    rs = [r for r in w["reqs"] if len(r["cands"]) >= 5 and held(r, heldout)]
                    if not rs:
                        continue
                    codes = net.ienc(w["texts"])
                    c = torch.tensor([lexical5(r) for r in rs])
                    ps += net(net.qenc([r["request"] for r in rs]), codes[c]).tolist()
                    ys += [1.0 if r["kind"] == "hidden" else 0.0 for r in rs]
            net.train()
            result = {"auc_hidden_vs_control": round(auc(ps, ys), 3), "n": len(ys)}
            print({"epoch": ep, **result, "s": round(time.time() - t0)}, flush=True)
    elif o.arch == "keys":
        net = Keys(q, o.bits)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        step = 0
        for ep in range(o.epochs):
            for w in random.sample(train, len(train)):
                rs = [r for r in w["reqs"] if r["kind"] == "hidden" and r["planted"] >= 0][:32]
                if not rs:
                    continue
                pos = [r["planted"] for r in rs]
                neg = random.sample(range(len(w["texts"])), min(256, len(w["texts"])))
                items = pos + neg
                M, qk, ik = net.match([r["request"] for r in rs], [w["texts"][k] for k in items])
                # Listwise over the request's fact against the other facts and sampled items; a balance term keeps
                # every code in use (no code holding every item).
                logits = 3.0 * M
                loss = nn.functional.cross_entropy(logits, torch.arange(len(rs)))
                use = ik.mean(0)  # (K, C)
                loss = loss + 0.5 * (use * torch.log(use + 1e-9)).sum(-1).mean() + 0.5 * torch.log(torch.tensor(float(net.C)))
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
            result = eval_keys(net, ev, heldout)
            print({"epoch": ep, **result, "s": round(time.time() - t0)}, flush=True)
    else:
        raise SystemExit(f"unknown arch {o.arch}")
    out = {"arch": o.arch, "float": o.float, "bits": o.bits, "worlds": len(train), "epochs": o.epochs,
           "seconds": round(time.time() - t0), "curve": curve[-10:], "result": result}
    if o.out:
        json.dump(out, open(o.out, "w"), indent=1)
    print("RESULT", json.dumps(out))


def auc(p, y):
    pos = [a for a, b in zip(p, y) if b == 1]
    neg = [a for a, b in zip(p, y) if b == 0]
    if not pos or not neg:
        return float("nan")
    wins = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg)
    return wins / (len(pos) * len(neg))


def auc_split(p, y, X, ev, heldout):
    """Tagger: AUC fact vs its twin (the planted items of control requests) and fact vs random items."""
    fact = [a for a, b in zip(p, y) if b == 1]
    rest = [a for a, b in zip(p, y) if b == 0]
    return {"auc_fact_vs_rest": round(auc(fact + rest, [1] * len(fact) + [0] * len(rest)), 3), "facts": len(fact)}


def eval_keys(net, ev, heldout):
    """Held-out hidden requests: is the fact among the items sharing a key with the request, how many items share
    one (the candidate set's size), and whether the fact shares a key while sharing no word with the request."""
    net.eval()
    m = {"hidden": 0, "fact_keyed": 0, "keyed_items": 0, "fact_keyed_not_lexical": 0, "not_lexical": 0}
    with torch.no_grad():
        for w in ev:
            rs = [r for r in w["reqs"] if r["kind"] == "hidden" and r["planted"] >= 0 and held(r, heldout)]
            if not rs:
                continue
            ik = net.codes(net.ienc(w["texts"]), net.ik).argmax(-1)  # (N, K)
            for r in rs:
                qk = net.codes(net.qenc([r["request"]]), net.qk).argmax(-1)[0]
                hit = (ik == qk).any(-1)
                m["hidden"] += 1
                m["keyed_items"] += int(hit.sum())
                m["fact_keyed"] += bool(hit[r["planted"]])
                if r["planted"] not in r["cands"]:
                    m["not_lexical"] += 1
                    m["fact_keyed_not_lexical"] += bool(hit[r["planted"]])
    net.train()
    m["keyed_items_mean"] = round(m["keyed_items"] / max(1, m["hidden"]), 1)
    return m


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--arch", required=True)
    a.add_argument("--train", required=True)
    a.add_argument("--eval", required=True)
    a.add_argument("--float", action="store_true")
    a.add_argument("--worlds", type=int, default=40)
    a.add_argument("--every", type=int, default=10)
    a.add_argument("--epochs", type=int, default=3)
    a.add_argument("--bits", type=int, default=128)
    a.add_argument("--lr", type=float, default=2e-3)
    a.add_argument("--held", default="train5,train6")
    a.add_argument("--out", default="")
    a.add_argument("--ranks", default="", help="pair/notwin: write the eval's ranks (score.py's format) here")
    a.add_argument("--eval2", default="", help="a second eval file to rank (M2's test split)")
    a.add_argument("--ranks2", default="")
    run(a.parse_args())
