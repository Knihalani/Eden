"""M13 gate harness: train one architecture on .local/m13/sets/train.jsonl, select its threshold on dev.jsonl, and
report dev by source and language against the shipped rule (the `rule` field). Held-out sets are scored only by
score.py, on a frozen model.

    .venv-m3/bin/python -I packages/sim/lab/m13/gate.py --arch bag --groups chewp --bits 16 --dim 32 \
        [--hidden 0] [--quant none|int8|tern|bin] [--epochs 4] [--out RUN]   # writes RUN.pt and RUN.json

Architectures: bag (hashed n-grams, mean-pooled embedding, optional hidden layer), mil (the same encoder over each
clause; needs = max over clauses), cnn (code points hashed to 4,096, embedding, two convolutions, max-pool).
Heads: needs (sigmoid) and kind (act, qact, ask, chatter, statement; softmax). Rows are weighted so every
(language, needs) cell carries the same total weight, and M2's rows half that (they are all acting).
"""
import argparse, json, os, random, re, sys, time
from collections import Counter, defaultdict

import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import feats  # noqa: E402

torch.set_num_threads(int(os.environ.get("GATE_THREADS", "4")))
KINDS = ["act", "qact", "ask", "chatter", "statement"]
KIX = {k: i for i, k in enumerate(KINDS)}
SETS = os.environ.get("M13_SETS", ".local/m13/sets")
CLAUSE = re.compile(r"(?<=[,;:.!?¿¡—–])\s+|\s+(?=(?:but|so|and then|anyway|also)\s)", re.I)


def load(name):
    import gzip
    path = f"{SETS}/{name}.jsonl"
    f = open(path) if os.path.exists(path) else gzip.open(path + ".gz", "rt")
    return [json.loads(l) for l in f]


def kind_of(r):
    k = r.get("kind") or ""
    return KIX.get("statement" if k == "intent" else k, -1)


class Ste(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        return torch.where(x >= 0, 1.0, -1.0)

    @staticmethod
    def backward(ctx, g):
        return g


def quantise(w, mode):
    if mode == "tern":
        a = w.abs().mean()
        q = torch.where(w > 0.7 * a, a, torch.where(w < -0.7 * a, -a, torch.zeros_like(w)))
        return w + (q - w).detach()
    if mode == "bin":
        a = w.abs().mean(dim=0, keepdim=True)
        return w + (torch.sign(w) * a - w).detach()
    if mode == "int8":
        s = w.abs().amax(dim=0, keepdim=True).clamp_min(1e-8) / 127
        return w + ((w / s).round() * s - w).detach()
    return w


class Bag(nn.Module):
    def __init__(self, a):
        super().__init__()
        self.emb = nn.Parameter(torch.randn(1 << a.bits, a.dim) * 0.1)
        self.quant = a.quant
        self.rule2 = getattr(a, "rule2", False)
        d = a.dim + (4 if self.rule2 else 0)
        self.hid = nn.Linear(d, a.hidden) if a.hidden else None
        d = a.hidden or d
        self.needs = nn.Linear(d, 1)
        self.kind = nn.Linear(d, len(KINDS))

    def encode(self, ids, offsets, rule=None):
        w = quantise(self.emb, self.quant)
        x = F.embedding_bag(ids, w, offsets, mode="mean")
        if self.rule2:  # H7': the shipped rule's reading beside the pooled code, not pooled with it
            x = torch.cat([x, rule if rule is not None else torch.zeros(x.shape[0], 4)], -1)
        if self.hid is not None:
            x = F.relu(self.hid(x))
        return x

    def forward(self, batch):
        x = self.encode(*batch["bag"], batch.get("rule"))
        return self.needs(x).squeeze(-1), self.kind(x)


class Mil(Bag):
    def forward(self, batch):
        xw = self.encode(*batch["bag"], batch.get("rule"))
        xc = self.encode(*batch["clauses"])
        lc = self.needs(xc).squeeze(-1)
        owner = batch["owner"]
        top = torch.full((xw.shape[0],), -1e9).scatter_reduce(0, owner, lc, reduce="amax")
        return torch.maximum(self.needs(xw).squeeze(-1), top), self.kind(xw)


class Sign(Bag):
    """H3: a ternary table mean-pooled into a sign code, then binary (±1, per-row scale) layers: XNOR-popcount at
    inference (M3's kernel, D907)."""

    def __init__(self, a):
        super().__init__(a)
        self.quant = "tern"
        self.bn0 = nn.BatchNorm1d(a.dim)
        self.bin = nn.Linear(a.dim, a.hidden or a.dim, bias=False)
        self.bn1 = nn.BatchNorm1d(a.hidden or a.dim)
        self.hid = None
        self.needs = nn.Linear(a.hidden or a.dim, 1)
        self.kind = nn.Linear(a.hidden or a.dim, len(KINDS))

    def forward(self, batch):
        x = Ste.apply(self.bn0(self.encode(*batch["bag"])))
        x = Ste.apply(self.bn1(F.linear(x, quantise(self.bin.weight.t(), "bin").t())))
        return self.needs(x).squeeze(-1), self.kind(x)


class Gru(nn.Module):
    """H6: a minGRU (z = σ(Wz x), h~ = Wh x, h = (1 − z) h + z h~) over the first 96 code points, hashed to 4,096."""

    def __init__(self, a):
        super().__init__()
        self.emb = nn.Embedding(4096, a.dim)
        self.wz = nn.Linear(a.dim, a.hidden or 48)
        self.wh = nn.Linear(a.dim, a.hidden or 48)
        d = 2 * (a.hidden or 48)
        self.needs = nn.Linear(d, 1)
        self.kind = nn.Linear(d, len(KINDS))

    def forward(self, batch):
        x = self.emb(batch["cps"][:, :96])
        m = batch["mask"][:, :96].unsqueeze(-1).float()
        z, ht = torch.sigmoid(self.wz(x)) * m, self.wh(x)
        h = torch.zeros(x.shape[0], ht.shape[-1])
        best = torch.full_like(h, -1e9)
        for t in range(x.shape[1]):
            h = (1 - z[:, t]) * h + z[:, t] * ht[:, t]
            best = torch.where(m[:, t] > 0, torch.maximum(best, h), best)
        y = torch.cat([h, best], -1)
        return self.needs(y).squeeze(-1), self.kind(y)


class Cnn(nn.Module):
    def __init__(self, a):
        super().__init__()
        self.emb = nn.Embedding(4096, a.dim)
        self.c3 = nn.Conv1d(a.dim, a.hidden or 64, 3, padding=1)
        self.c5 = nn.Conv1d(a.dim, a.hidden or 64, 5, padding=2)
        d = 2 * (a.hidden or 64)
        self.needs = nn.Linear(d, 1)
        self.kind = nn.Linear(d, len(KINDS))

    def forward(self, batch):
        x = self.emb(batch["cps"]).transpose(1, 2)
        m = batch["mask"].unsqueeze(1)
        y = torch.cat([F.relu(self.c3(x)), F.relu(self.c5(x))], 1).masked_fill(~m, 0).amax(-1)
        return self.needs(y).squeeze(-1), self.kind(y)


def clauses(text):
    parts = [p for p in CLAUSE.split(text) if p and p.strip()]
    return parts[:6] if len(parts) > 1 else []


RULE_IDS = {"listed": 1, "opened": 2, "none": 3}


def prep(rows, a, skel=None):
    mask = (1 << a.bits) - 1
    for r in rows:
        r["_f"] = feats.featurise(r["text"], a.groups, a.bits)
        if a.rule:  # H7: the shipped rule's reading as two more features
            r["_f"] = sorted(set(r["_f"]) | {feats.h(600, [RULE_IDS[r["rule"]]]) & mask,
                                              feats.h(601, [1 + int(r["rest"])]) & mask})
        if skel is not None:  # H8: skeleton n-grams
            r["_f"] = sorted(set(r["_f"]) | set(feats.skeleton_feats(r["text"], skel, a.bits)))
        if a.arch == "mil":
            r["_c"] = [feats.featurise(c, a.groups, a.bits) for c in clauses(r["text"])]
        if a.arch in ("cnn", "gru"):
            r["_p"] = [(ord(c) * 2654435761 & 0xFFFFFFFF) % 4095 + 1 for c in feats.norm(r["text"])][:160] or [0]


def batchify(rows, a):
    b = {}
    ids, offs = [], []
    for r in rows:
        offs.append(len(ids))
        ids.extend(r["_f"] or [0])
    b["bag"] = (torch.tensor(ids), torch.tensor(offs))
    if getattr(a, "rule2", False):
        b["rule"] = torch.tensor([[float(r["rule"] == "listed"), float(r["rule"] == "opened"),
                                   float(r["rule"] == "none"), float(bool(r["rest"]))] for r in rows])
    if a.arch == "mil":
        ids, offs, owner = [], [], []
        for i, r in enumerate(rows):
            for c in r["_c"]:
                offs.append(len(ids))
                ids.extend(c or [0])
                owner.append(i)
        if not offs:
            offs, ids, owner = [0], [0], [0]
        b["clauses"] = (torch.tensor(ids), torch.tensor(offs))
        b["owner"] = torch.tensor(owner)
    if a.arch in ("cnn", "gru"):
        n = max(len(r["_p"]) for r in rows)
        b["cps"] = torch.tensor([r["_p"] + [0] * (n - len(r["_p"])) for r in rows])
        b["mask"] = b["cps"] > 0
    return b


def weights(rows):
    cell = Counter((r["lang"].split("-")[0], r["needs"]) for r in rows)
    w = []
    for r in rows:
        x = 1.0 / cell[(r["lang"].split("-")[0], r["needs"])]
        w.append(x * (0.5 if r["src"].startswith("m2:") else 1.0))
    s = sum(w) / len(w)
    return [x / s for x in w]


def predict(model, rows, a, bs=1024):
    model.eval()
    out_n, out_k = [], []
    with torch.no_grad():
        for i in range(0, len(rows), bs):
            n, k = model(batchify(rows[i:i + bs], a))
            out_n += torch.sigmoid(n).tolist()
            out_k += k.argmax(-1).tolist()
    return out_n, out_k


NEG_KINDS = {"chatter", "statement", "intent", "log", "foreign-neg"}


def neg_class(r):
    return r["src"].split(":")[-1]


def report(rows, p, thr):
    """Start rates by source group, for the gate and the shipped rule."""
    by = defaultdict(lambda: [0, 0, 0])
    for r, x in zip(rows, p):
        key = r["src"] if not r["src"].startswith("m2:") else ("m2:" + r["lang"] if r["lang"] != "en" else r["src"])
        if r["src"].startswith("gen") or r["src"] == "genlog":
            key = f"gen:{r['kind']}:{r['lang'] if r['lang'] in ('en', 'xx') else 'other'}"
        c = by[key]
        c[0] += 1
        c[1] += x >= thr
        c[2] += r["rule"] != "none"
    return {k: {"n": v[0], "gate": round(v[1] / v[0], 3), "rule": round(v[2] / v[0], 3)} for k, v in sorted(by.items())}


def summary(rows, p, thr):
    acting = [(x >= thr, r["rule"] != "none") for r, x in zip(rows, p) if r["needs"]]
    neg = [(x >= thr, r["rule"] != "none") for r, x in zip(rows, p) if not r["needs"] and r["kind"] != "ask"]
    ask = [(x >= thr, r["rule"] != "none") for r, x in zip(rows, p) if r["kind"] == "ask"]
    f = lambda xs, i: round(sum(t[i] for t in xs) / max(1, len(xs)), 4)
    return {"acting": [f(acting, 0), f(acting, 1), len(acting)], "false": [f(neg, 0), f(neg, 1), len(neg)],
            "ask": [f(ask, 0), f(ask, 1), len(ask)]}


def family(r):
    s = r["src"]
    fam = ("sim" if s.startswith("suite") else "p2" if s.startswith("p2") else "gen" if s.startswith("gen")
           else "m2" if s.startswith("m2") else "other")
    if fam == "gen" and r["lang"] not in ("en", "xx"):
        fam = "gen-other-lang"
    if fam == "m2" and r["lang"] != "en":
        fam = "m2-other-lang"
    return fam + (":act" if r["needs"] else ":ask" if r["kind"] == "ask" else ":neg")


def grouped(rows, dec):
    """Start rates by family (generated, sim hand-written, P2 hand-written, M2; other languages apart) and class."""
    g = defaultdict(lambda: [0, 0, 0])
    for r, d in zip(rows, dec):
        c = g[family(r)]
        c[0] += 1
        c[1] += d
        c[2] += r["rule"] != "none"
    return {k: {"n": v[0], "gate": round(v[1] / v[0], 3), "rule": round(v[2] / v[0], 3)} for k, v in sorted(g.items())}


def macro(rows, dec):
    """Mean acting recall over the acting families minus 2 × mean false starts over the negative families (asks out),
    so the sim's and P2's hand-written families weigh as much as the generated rows (addendum A)."""
    g = grouped(rows, dec)
    act = [v["gate"] for k, v in g.items() if k.endswith(":act")]
    neg = [v["gate"] for k, v in g.items() if k.endswith(":neg")]
    return sum(act) / len(act) - 2 * sum(neg) / len(neg)


def pick(rows, p):
    """The threshold that maximises `macro` on dev (fixed before any held-out read)."""
    return max((macro(rows, [x >= t for x in p]), t) for t in [i / 100 for i in range(5, 96)])[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="bag", choices=["bag", "mil", "cnn", "sign", "gru"])
    ap.add_argument("--groups", default="chewp")
    ap.add_argument("--bits", type=int, default=16)
    ap.add_argument("--dim", type=int, default=32)
    ap.add_argument("--hidden", type=int, default=0)
    ap.add_argument("--quant", default="none", choices=["none", "int8", "tern", "bin"])
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--kind-weight", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--rule", action="store_true", help="H7: the shipped rule's reading as features")
    ap.add_argument("--rule2", action="store_true", help="H7': the rule's reading concatenated after pooling")
    ap.add_argument("--skel", type=int, default=0, help="H8: keep the K commonest words, the rest as shapes")
    ap.add_argument("--out", default=".local/m13/runs/run")
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    random.seed(a.seed)
    train, dev = load("train"), load("dev")
    t0 = time.time()
    skel = feats.skeleton_vocab([r["text"] for r in train], a.skel) if a.skel else None
    prep(train, a, skel)
    prep(dev, a, skel)
    w = weights(train)
    model = {"bag": Bag, "mil": Mil, "cnn": Cnn, "sign": Sign, "gru": Gru}[a.arch](a)
    opt = torch.optim.Adam(model.parameters(), lr=a.lr)
    idx = list(range(len(train)))
    for ep in range(a.epochs):
        model.train()
        random.shuffle(idx)
        tot = 0.0
        for i in range(0, len(idx), 256):
            rows = [train[j] for j in idx[i:i + 256]]
            n, k = model(batchify(rows, a))
            y = torch.tensor([float(r["needs"]) for r in rows])
            ww = torch.tensor([w[j] for j in idx[i:i + 256]])
            ky = torch.tensor([kind_of(r) for r in rows])
            loss = (F.binary_cross_entropy_with_logits(n, y, reduction="none") * ww).mean()
            if (ky >= 0).any():
                loss = loss + a.kind_weight * (F.cross_entropy(k, ky.clamp_min(0), reduction="none") * ww
                                               * (ky >= 0)).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item()
        p, _ = predict(model, dev, a)
        print(f"epoch {ep + 1} loss {tot / (len(idx) / 256):.4f} dev {summary(dev, p, 0.5)}", flush=True)
    p, kp = predict(model, dev, a)
    thr = pick(dev, p)
    kacc = [kp[i] == kind_of(r) for i, r in enumerate(dev) if kind_of(r) >= 0]
    params = sum(x.numel() for x in model.parameters())
    union = [x >= thr or (r["rule"] != "none" and x >= 0.05) for r, x in zip(dev, p)]
    res = {"args": vars(a), "threshold": thr, "macro": round(macro(dev, [x >= thr for x in p]), 4),
           "macro_union_veto05": round(macro(dev, union), 4), "dev": summary(dev, p, thr),
           "families": grouped(dev, [x >= thr for x in p]), "families_union_veto05": grouped(dev, union), "dev_kind_acc": round(sum(kacc) / len(kacc), 4),
           "by": report(dev, p, thr), "params": params, "train_s": round(time.time() - t0, 1)}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    torch.save({"args": vars(a), "state": model.state_dict(), "threshold": thr, "skel": skel}, a.out + ".pt")
    json.dump(res, open(a.out + ".json", "w"), indent=1)
    print(json.dumps({k: res[k] for k in ("threshold", "macro", "macro_union_veto05", "dev", "dev_kind_acc", "params", "train_s")}))
    print(json.dumps({"families": {k: (v["gate"], v["rule"], v["n"]) for k, v in res["families"].items()}}))


if __name__ == "__main__":
    main()
