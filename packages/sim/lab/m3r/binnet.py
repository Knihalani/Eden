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


RANK_CUTS = (1, 3, 5, 10, 20, 40)
PRIOR = {"cuts": None}


def fit_prior(worlds):
    """Quantile cut points (4 a feature) of the export's 48 pair features, from training rows."""
    import numpy as np

    rows = [f for w in worlds[:60] for r in w["reqs"] for f in r["feats"]]
    a = np.array(rows, dtype=np.float64)
    PRIOR["cuts"] = [np.quantile(a[:, j], [0.2, 0.4, 0.6, 0.8]).tolist() for j in range(a.shape[1])]


def prior_bits(r, K):
    """(K, P) ±1 bits a candidate: its lexical position (rank buckets) and each pair feature against its 4 cuts."""
    cuts = PRIOR["cuts"]
    P = len(RANK_CUTS) + 4 * len(cuts)
    out = -torch.ones(K, P)
    for k, f in enumerate(r["feats"][:K]):
        for b, c in enumerate(RANK_CUTS):
            if k < c:
                out[k, b] = 1.0
        for j, v in enumerate(f):
            for q_, c in enumerate(cuts[j]):
                if v > c:
                    out[k, len(RANK_CUTS) + 4 * j + q_] = 1.0
    return out


def prior_size():
    return len(RANK_CUTS) + 4 * len(PRIOR["cuts"]) if PRIOR["cuts"] else 0


class Pair(nn.Module):
    def __init__(self, q, bits, twin=True, prior=0, aux=False, width=128):
        super().__init__()
        self.q, self.twin, self.prior, self.aux = q, twin, prior, aux
        self.ienc, self.qenc = Enc(q, bits), Enc(q, bits)
        # `aux` (multi-task): a constraint head on the item's own code (fact against its all-clear twin), trained on
        # every request's planted item; its sign is one more input bit a candidate, beside the lexical prior.
        self.tag = BinLin(q, bits, 32) if aux else None
        self.tag_head = nn.Linear(32, 1) if aux else None
        self.l1 = BinLin(q, (5 if twin else 3) * bits + prior + (8 if aux else 0), width)
        self.l2 = BinLin(q, width, 32)
        self.head = nn.Linear(32, 1)
        self.n1 = BinLin(q, bits, 32)
        self.nhead = nn.Linear(32, 1)

    def constraint(self, codes):
        """The aux head's logit for item codes (N, B) -> (N,)."""
        return self.tag_head(self.q.act(self.tag(codes))).squeeze(-1)

    def forward(self, qc, ic, tc, pb=None):
        R, K, B = ic.shape
        qq = qc.unsqueeze(1).expand(R, K, B)
        parts = [qq * ic, qq, ic] + ([ic * tc, tc] if self.twin else []) + ([pb] if self.prior else [])
        if self.aux:
            t = self.q.act(self.constraint(ic.reshape(R * K, B))).view(R, K, 1)
            parts.append(t.expand(R, K, 8))  # the tag bit, repeated so a binary layer can weigh it
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


BLOOM = 2048
MBUCKETS = 256


def bloom_of(text):
    """An item's 2,048-bit Bloom filter of its hashed n-grams (two hash positions a gram), as a set of bit indices."""
    out = set()
    for g in grams(text):
        out.add(g % BLOOM)
        out.add((g * 2_654_435_761 >> 7) % BLOOM)
    return out


def match_bits(qgrams, bloom):
    """(request, item) -> 256 match bits: bucket b is on when a request gram hashed to b is in the item's filter."""
    m = torch.zeros(MBUCKETS)
    for g in qgrams:
        if g % BLOOM in bloom and (g * 2_654_435_761 >> 7) % BLOOM in bloom:
            m[g % MBUCKETS] = 1.0
    return m


class Bloom(nn.Module):
    """BloomMatch (H7): only bit tests per candidate. Inputs (±1): the item's match bits, the request's own bucket
    bits, and the match bits XOR its twin's; two binary layers and a head; a NULL head on the request bits."""

    def __init__(self, q, twin=True, prior=0):
        super().__init__()
        self.q, self.twin, self.prior = q, twin, prior
        self.l1 = BinLin(q, (3 if twin else 2) * MBUCKETS + prior, 128)
        self.l2 = BinLin(q, 128, 32)
        self.head = nn.Linear(32, 1)
        self.n1 = BinLin(q, MBUCKETS, 32)
        self.nhead = nn.Linear(32, 1)

    def forward(self, qbits, mbits, tbits, pb=None):
        R, K, M = mbits.shape
        qq = qbits.unsqueeze(1).expand(R, K, M)
        parts = [mbits * 2 - 1, qq * 2 - 1] + ([(mbits != tbits).float() * 2 - 1] if self.twin else [])
        parts += [pb] if self.prior else []
        h = self.q.act(self.l1(torch.cat(parts, -1).reshape(R * K, -1)))
        h = self.q.act(self.l2(h))
        return self.head(h).view(R, K), self.nhead(self.q.act(self.n1(qbits * 2 - 1))).squeeze(-1)


def bloom_batch(w, rs, cache):
    """Match bits for each request's candidates and their twins (item filters cached per world)."""
    if "blooms" not in cache:
        cache["blooms"] = [bloom_of(t) for t in w["texts"]]
    bl = cache["blooms"]
    K = max(len(r["cands"]) for r in rs)
    M = torch.zeros(len(rs), K, MBUCKETS)
    T = torch.zeros(len(rs), K, MBUCKETS)
    Qb = torch.zeros(len(rs), MBUCKETS)
    mask = torch.ones(len(rs), K, dtype=torch.bool)
    for a, r in enumerate(rs):
        qg = grams(r["request"])
        for g in qg:
            Qb[a, g % MBUCKETS] = 1.0
        for k, c in enumerate(r["cands"]):
            M[a, k] = match_bits(qg, bl[c])
            tw = w["twin"][c]
            T[a, k] = match_bits(qg, bl[tw]) if tw >= 0 else M[a, k]
            mask[a, k] = False
    return Qb, M, T, mask


class Intent(nn.Module):
    """H8: a request alone -> one of M2's 16 archetypes (binary char-n-gram encoder and one binary layer)."""

    def __init__(self, q, bits, n):
        super().__init__()
        self.q = q
        self.enc = Enc(q, bits)
        self.l1 = BinLin(q, bits, 64)
        self.head = nn.Linear(64, n)

    def forward(self, texts):
        return self.head(self.q.act(self.l1(self.enc(texts))))


class PairTag(nn.Module):
    """H10: two item texts (older, newer) -> "the newer replaces the older". Both through one binary encoder; the
    head reads a, b, a XNOR b and their difference bits through binary layers (order matters: a then b)."""

    def __init__(self, q, bits):
        super().__init__()
        self.q = q
        self.enc = Enc(q, bits)
        self.l1 = BinLin(q, 3 * bits, 64)
        self.head = nn.Linear(64, 1)

    def forward(self, a_texts, b_texts):
        a, b = self.enc(a_texts), self.enc(b_texts)
        return self.head(self.q.act(self.l1(torch.cat([a, b, a * b], -1)))).squeeze(-1)


TAGS = ["fact", "superseded", "other-entity", "resolved", "other-period", "already-met", "neutral", "other"]


def m2_items(path, every=1):
    """M2 raw worlds -> tagged items and supersession pairs. Items: (text, tag) for each task's fact, its twin (the
    twin's kind), its neutrals and one other item; pairs: (older, newer, 1) for `revisionOf`, and as negatives the
    reversed pair, (fact, twin) and (fact, neutral) of a task."""
    items, pairs = [], []
    for n, line in enumerate(open(path)):
        if n % every:
            continue
        w = json.loads(line)
        by = {i["id"]: i for i in w["items"]}
        text = lambda i: f"{i['title']}\n{i['text']}"  # noqa: E731
        for t in w["tasks"]:
            if t["fact"] in by:
                items.append((text(by[t["fact"]]), "fact"))
            if t["decoy"] in by:
                items.append((text(by[t["decoy"]]), t["decoyKind"]))
            for x in t.get("neutrals", []):
                if x in by:
                    items.append((text(by[x]), "neutral"))
            if t["fact"] in by and t["decoy"] in by:
                pairs.append((text(by[t["fact"]]), text(by[t["decoy"]]), 0))
            for x in t.get("neutrals", [])[:1]:
                if t["fact"] in by and x in by:
                    pairs.append((text(by[t["fact"]]), text(by[x]), 0))
        planted = {x for t in w["tasks"] for x in [t["fact"], t["decoy"], *t.get("neutrals", [])]}
        rest = [i for i in w["items"] if i["id"] not in planted]
        for i in rest[:: max(1, len(rest) // 8)]:
            items.append((text(i), "other"))
        for i in w["items"]:
            old = by.get(i.get("revisionOf") or "")
            if old:
                pairs.append((text(old), text(i), 1))
                pairs.append((text(i), text(old), 0))
    return items, pairs


def jaccard(a, b):
    x, y = set(re.findall(r"[a-z0-9]+", a.lower())), set(re.findall(r"[a-z0-9]+", b.lower()))
    return len(x & y) / max(1, len(x | y))


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
                pb = prior_bits(r, len(r["cands"])).unsqueeze(0) if net.prior else None
                s, nl = net(net.qenc([r["request"]]), codes[c].unsqueeze(0), codes[t].unsqueeze(0), pb)
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
                pb = prior_bits(r, len(r["cands"])).unsqueeze(0) if net.prior else None
                s, nl = net(net.qenc([r["request"]]), codes[c].unsqueeze(0), codes[t].unsqueeze(0), pb)
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
    train = load(o.train, o.worlds, o.every) if o.train.endswith(".gz") else []
    ev = load(o.eval) if o.eval.endswith(".gz") else []
    q = Q(o.float)
    t0 = time.time()
    curve = []
    if o.prior:
        fit_prior(train)
    if o.arch in ("pair", "notwin"):
        net = Pair(q, o.bits, twin=o.arch == "pair", prior=prior_size() if o.prior else 0, aux=o.aux, width=o.width)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        best = None
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
                pb = torch.stack([prior_bits(r, K) for r in rs]) if net.prior else None
                s, nl = net(net.qenc([r["request"] for r in rs]), codes[c], codes[t], pb)
                logits = torch.cat([nl.unsqueeze(1), s.masked_fill(mask, -1e4)], 1)
                y = torch.tensor([r["target"] + 1 if r["target"] >= 0 else 0 for r in rs])
                loss = nn.functional.cross_entropy(logits, y)
                if net.aux:
                    # Multi-task: each request's planted item is a constraint (hidden) or its all-clear twin (control).
                    pl = [(r["planted"], 1.0 if r["kind"] == "hidden" else 0.0) for r in rs if r["planted"] >= 0]
                    if pl:
                        tl = net.constraint(codes[torch.tensor([k for k, _ in pl])])
                        loss = loss + o.aux_weight * nn.functional.binary_cross_entropy_with_logits(
                            tl, torch.tensor([v for _, v in pl]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
                if o.eval_steps and step % o.eval_steps == 0:
                    m = eval_pair(net, ev, heldout)
                    print({"step_eval": step, **m, **base, "s": round(time.time() - t0)}, flush=True)
                    if best is None or m["fact@5"] - m["twin@5"] > best["fact@5"] - best["twin@5"]:
                        best = {**m, "step": step}
            m = eval_pair(net, ev, heldout)
            print({"epoch": ep, **m, **base, "s": round(time.time() - t0)}, flush=True)
            if best is None or m["fact@5"] - m["twin@5"] > best["fact@5"] - best["twin@5"]:
                best = {**m, "step": step}
        result = {**m, **base, "best": best}
        for path, ws in ((o.ranks, ev), (o.ranks2, load(o.eval2) if o.eval2 else [])):
            if path:
                write_ranks(net, ws, path)
    elif o.arch == "tagger":
        net = Tagger(q, o.bits)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)

        kinds = []

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
                    kinds.append("fact" if r["kind"] == "hidden" else "twin")
                    other = random.randrange(len(w["texts"]))
                    if other != r["planted"]:
                        xs.append(w["texts"][other])
                        ys.append(0.0)
                        kinds.append("other")
            return xs, ys

        X, Y = rows(train)
        kinds.clear()
        Xe, Ye = rows(ev, True)
        Ke = list(kinds)
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
            pf = [a for a, k in zip(p, Ke) if k == "fact"]
            pt = [a for a, k in zip(p, Ke) if k == "twin"]
            po = [a for a, k in zip(p, Ke) if k == "other"]
            result = {"auc_fact_vs_twin": round(auc(pf + pt, [1] * len(pf) + [0] * len(pt)), 3),
                      "auc_fact_vs_other": round(auc(pf + po, [1] * len(pf) + [0] * len(po)), 3),
                      "facts": len(pf), "twins": len(pt)}
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
    elif o.arch in ("bloom", "bloom-notwin"):
        net = Bloom(q, twin=o.arch == "bloom", prior=prior_size() if o.prior else 0)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        caches = {}
        step = 0
        for ep in range(o.epochs):
            for wi in random.sample(range(len(train)), len(train)):
                w = train[wi]
                rs = [r for r in w["reqs"] if r["cands"] and not (r["kind"] == "hidden" and r["target"] < 0)][:32]
                if not rs:
                    continue
                Qb, M, T, mask = bloom_batch(w, rs, caches.setdefault(wi, {}))
                pb = torch.stack([prior_bits(r, M.shape[1]) for r in rs]) if net.prior else None
                s_, nl = net(Qb, M, T, pb)
                logits = torch.cat([nl.unsqueeze(1), s_.masked_fill(mask, -1e4)], 1)
                y = torch.tensor([r["target"] + 1 if r["target"] >= 0 else 0 for r in rs])
                loss = nn.functional.cross_entropy(logits, y)
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
            net.eval()
            m = {"hidden": 0, "fact@5": 0, "fact@5_lexical": 0, "control": 0, "twin@5": 0, "silent_ctl": 0, "spoke_hid": 0}
            with torch.no_grad():
                for w in ev:
                    rs = [r for r in w["reqs"] if r["cands"] and held(r, heldout)]
                    if not rs:
                        continue
                    cache = {}
                    for a in range(0, len(rs), 32):
                        rb = rs[a : a + 32]
                        Qb, M, T, mask = bloom_batch(w, rb, cache)
                        pb = torch.stack([prior_bits(r, M.shape[1]) for r in rb]) if net.prior else None
                        s_, nl = net(Qb, M, T, pb)
                        s_ = s_.masked_fill(mask, -1e4)
                        for r, row, n_ in zip(rb, s_.tolist(), nl.tolist()):
                            order = sorted(range(len(r["cands"])), key=lambda k: -row[k])
                            ranked = [r["cands"][k] for k in order]
                            if r["kind"] == "hidden":
                                if r["target"] < 0:
                                    continue
                                m["hidden"] += 1
                                m["fact@5"] += r["cands"][r["target"]] in ranked[:5]
                                m["fact@5_lexical"] += r["target"] < 5
                                m["spoke_hid"] += max(row[: len(r["cands"])]) > n_
                            else:
                                m["control"] += 1
                                m["twin@5"] += r["planted"] in ranked[:5]
                                m["silent_ctl"] += max(row[: len(r["cands"])]) <= n_
            net.train()
            result = m
            print({"epoch": ep, **m, "s": round(time.time() - t0)}, flush=True)
    elif o.arch == "intent":
        # M2's raw worlds: each request -> its task's archetype; held out: M2's val split (families never in train).
        def reqs(path):
            xs, ys = [], []
            for line in open(path):
                w = json.loads(line)
                for t in w["tasks"]:
                    for r in t["requests"]:
                        xs.append(r["text"])
                        ys.append(t["archetype"])
            return xs, ys

        X, Yn = reqs(o.train)
        Xe, Yen = reqs(o.eval)
        labels = sorted(set(Yn))
        Y = [labels.index(y) for y in Yn]
        Ye = [labels.index(y) if y in labels else -1 for y in Yen]
        net = Intent(q, o.bits, len(labels))
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        step = 0
        majority = max(Ye.count(k) for k in set(Ye)) / len(Ye)
        for ep in range(o.epochs):
            idx = list(range(len(X)))
            random.shuffle(idx)
            for a in range(0, len(idx), 128):
                b = idx[a : a + 128]
                loss = nn.functional.cross_entropy(net([X[k] for k in b]), torch.tensor([Y[k] for k in b]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                    print(curve[-1], flush=True)
                step += 1
            net.eval()
            with torch.no_grad():
                pred = torch.cat([net(Xe[a : a + 512]).argmax(-1) for a in range(0, len(Xe), 512)]).tolist()
            net.train()
            result = {"acc": round(sum(p == y for p, y in zip(pred, Ye)) / len(Ye), 3), "majority": round(majority, 3),
                      "n": len(Ye), "classes": len(labels)}
            print({"epoch": ep, **result, "s": round(time.time() - t0)}, flush=True)
    elif o.arch == "supersede":
        _, P = m2_items(o.train, o.every)
        _, Pe = m2_items(o.eval)
        net = PairTag(q, o.bits)
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        base = round(auc([jaccard(a, b) for a, b, _ in Pe], [y for _, _, y in Pe]), 3)
        step = 0
        for ep in range(o.epochs):
            random.shuffle(P)
            for a in range(0, len(P), 64):
                b = P[a : a + 64]
                loss = nn.functional.binary_cross_entropy_with_logits(
                    net([x[0] for x in b], [x[1] for x in b]), torch.tensor([float(x[2]) for x in b]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                step += 1
            net.eval()
            with torch.no_grad():
                p = torch.cat([net([x[0] for x in Pe[a : a + 256]], [x[1] for x in Pe[a : a + 256]])
                               for a in range(0, len(Pe), 256)]).tolist()
            net.train()
            y = [x[2] for x in Pe]
            tp = sum(1 for a, b in zip(p, y) if a > 0 and b == 1)
            fp = sum(1 for a, b in zip(p, y) if a > 0 and b == 0)
            result = {"auc_replaces": round(auc(p, y), 3), "auc_jaccard_baseline": base, "precision@0": round(tp / max(1, tp + fp), 3),
                      "recall@0": round(tp / max(1, sum(y)), 3), "pairs": len(Pe), "positives": sum(y), "train_pairs": len(P)}
            print({"epoch": ep, **result, "s": round(time.time() - t0)}, flush=True)
    elif o.arch == "tags":
        I, _ = m2_items(o.train, o.every)
        Ie, _ = m2_items(o.eval)
        net = Intent(q, o.bits, len(TAGS))
        opt = torch.optim.Adam(net.parameters(), lr=o.lr)
        step = 0
        for ep in range(o.epochs):
            random.shuffle(I)
            for a in range(0, len(I), 128):
                b = I[a : a + 128]
                loss = nn.functional.cross_entropy(net([x[0] for x in b]), torch.tensor([TAGS.index(x[1]) for x in b]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                if step % 20 == 0:
                    curve.append({"step": step, "loss": round(float(loss), 3)})
                step += 1
            net.eval()
            with torch.no_grad():
                lg = torch.cat([net([x[0] for x in Ie[a : a + 512]]) for a in range(0, len(Ie), 512)])
            net.train()
            pf = torch.softmax(lg, -1)[:, 0].tolist()
            tags = [x[1] for x in Ie]
            twin = [t for t in TAGS[1:6]]
            f = [a for a, t in zip(pf, tags) if t == "fact"]
            tw = [a for a, t in zip(pf, tags) if t in twin]
            ne = [a for a, t in zip(pf, tags) if t == "neutral"]
            ot = [a for a, t in zip(pf, tags) if t == "other"]
            pred = lg.argmax(-1).tolist()
            per = {t: round(sum(1 for p_, g in zip(pred, tags) if g == t and TAGS[p_] == t) / max(1, tags.count(t)), 3) for t in TAGS}
            if o.eval2:
                # Transfer: the sim's held-out families (an export_groups eval file): each request's planted item is
                # the fact (hidden) or its all-clear twin (control).
                xs, ys = [], []
                for w in load(o.eval2):
                    for r in w["reqs"]:
                        if r["planted"] >= 0 and held(r, heldout):
                            xs.append(w["texts"][r["planted"]])
                            ys.append(1 if r["kind"] == "hidden" else 0)
                with torch.no_grad():
                    net.eval()
                    pt = torch.softmax(torch.cat([net(xs[a : a + 512]) for a in range(0, len(xs), 512)]), -1)[:, 0].tolist()
                    net.train()
                transfer = {"sim_auc_fact_vs_twin": round(auc(pt, ys), 3), "sim_items": len(ys)}
            else:
                transfer = {}
            result = {**transfer, "auc_fact_vs_twin": round(auc(f + tw, [1] * len(f) + [0] * len(tw)), 3),
                      "auc_fact_vs_neutral": round(auc(f + ne, [1] * len(f) + [0] * len(ne)), 3),
                      "auc_fact_vs_other": round(auc(f + ot, [1] * len(f) + [0] * len(ot)), 3),
                      "acc_per_tag": per, "items": len(Ie)}
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
    a.add_argument("--prior", action="store_true", help="pair/bloom: lexical-rank and pair-feature bits as inputs")
    a.add_argument("--aux", action="store_true", help="pair: multi-task constraint head on item codes, its bit as input")
    a.add_argument("--aux-weight", type=float, default=1.0)
    a.add_argument("--width", type=int, default=128)
    a.add_argument("--worlds", type=int, default=40)
    a.add_argument("--every", type=int, default=10)
    a.add_argument("--epochs", type=int, default=3)
    a.add_argument("--bits", type=int, default=128)
    a.add_argument("--lr", type=float, default=2e-3)
    a.add_argument("--eval-steps", type=int, default=0, help="pair: a held-out check every N steps (best kept)")
    a.add_argument("--held", default="train5,train6")
    a.add_argument("--out", default="")
    a.add_argument("--ranks", default="", help="pair/notwin: write the eval's ranks (score.py's format) here")
    a.add_argument("--eval2", default="", help="a second eval file to rank (M2's test split)")
    a.add_argument("--ranks2", default="")
    run(a.parse_args())
