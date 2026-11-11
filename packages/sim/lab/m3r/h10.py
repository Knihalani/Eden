"""M3b (D907 follow-on): make H10, the supersession pair network, small and fast without losing the float net's
quality. Shared pieces for every variant: the pair sets (binnet.m2_items on M2 v2's raw worlds), the metrics (AUC,
recall at precision 0.95 and 0.90), the teacher's soft scores and codes, and the students.

  python -I h10.py score --model NET.pt --pairs worlds-val.jsonl            # a binnet checkpoint's metrics
  python -I h10.py teach --model NET.pt --pairs worlds-train.jsonl --out T.pt  # teacher logits over every pair

The students (route A, a better binary; route B, a compressed float; a hybrid) live in `train`, one `--variant` each.
"""
import argparse, json, os, random, sys, time

import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import binnet as B  # noqa: E402

torch.set_num_threads(int(os.environ.get("BINNET_THREADS", "4")))


def metrics(p, y):
    """AUC (rank-sum, ties halved) and the best recall at precision >= 0.95 / 0.90 over thresholds, O(n log n)."""
    n1 = sum(y)
    n0 = len(y) - n1
    order = sorted(range(len(p)), key=lambda i: -p[i])
    out = {}
    for prec in (0.95, 0.90):
        tp = fp = 0
        best = 0.0
        i = 0
        while i < len(order):
            j = i
            # Ties move together: a threshold cannot split equal scores.
            while j < len(order) and p[order[j]] == p[order[i]]:
                tp += y[order[j]]
                fp += 1 - y[order[j]]
                j += 1
            if tp and tp / (tp + fp) >= prec:
                best = max(best, tp / max(1, n1))
            i = j
        out[f"recall@p{prec:.2f}"] = round(best, 3)
    # AUC by average ranks.
    asc = sorted(range(len(p)), key=lambda i: p[i])
    ranks = [0.0] * len(p)
    i = 0
    while i < len(asc):
        j = i
        while j < len(asc) and p[asc[j]] == p[asc[i]]:
            j += 1
        for k in range(i, j):
            ranks[asc[k]] = (i + j + 1) / 2
        i = j
    rs = sum(r for r, t in zip(ranks, y) if t)
    out["auc"] = round((rs - n1 * (n1 + 1) / 2) / max(1, n1 * n0), 4)
    out["pairs"] = len(y)
    out["positives"] = n1
    return out


def pairs_of(path, every=1):
    _, P = B.m2_items(path, every)
    return P


def read_pairs(path):
    return [(x["a"], x["b"], x["y"]) for x in map(json.loads, open(path))]


def load_teacher(path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    if "cfg" in ck:
        # A full-width float Student (this file's own teacher run): the same network as binnet's PairTag, renamed.
        st = ck["state"]
        m = {"w": "enc.w", "l1": "l1.w", "out.weight": "head.weight", "out.bias": "head.bias"}
        ren = {}
        for k, v in st.items():
            k2 = m.get(k) or k.replace("norm.", "enc.norm.", 1).replace("n1.", "l1.norm.", 1)
            ren[k2 if not k.startswith(("norm.", "n1.")) else k2] = v
        ck = {"state": ren, "float": True, "bits": ck["cfg"]["d"]}
    net = B.PairTag(B.Q(ck["float"]), ck["bits"])
    net.load_state_dict(ck["state"])
    net.eval()
    return net, ck


@torch.no_grad()
def score_net(net, P, bs=512):
    return torch.cat([net([x[0] for x in P[a : a + bs]], [x[1] for x in P[a : a + bs]])
                      for a in range(0, len(P), bs)]).tolist()


# ---------------------------------------------------------------------------------------------------------------
# Training: texts hashed once (binnet.grams, 2^16 buckets; a smaller table takes the id modulo its size, the same as
# hashing into it), pairs as text indices, the teacher's codes and logits precomputed.


class Corpus:
    def __init__(self):
        self.index, self.texts, self.ids = {}, [], []

    def add(self, t):
        if t not in self.index:
            self.index[t] = len(self.texts)
            self.texts.append(t)
            self.ids.append(B.grams(t) or [0])
        return self.index[t]

    def pairs(self, P):
        return torch.tensor([[self.add(a), self.add(b), y] for a, b, y in P], dtype=torch.long)

    def bag(self, idx):
        """embedding_bag's (ids, offsets) for these texts."""
        ids, offs = [], []
        for i in idx.tolist():
            offs.append(len(ids))
            ids += self.ids[i]
        return torch.tensor(ids), torch.tensor(offs)


def fake_q(w, mode, dim=1):
    """Quantise-and-dequantise with a straight-through gradient: int8 / int4 with one scale a row, or ternary."""
    if mode == "float":
        return w
    if mode == "ternary":
        return B.ternary(w)
    lv = {"int8": 127, "int4": 7}[mode]
    s = w.detach().abs().amax(dim=dim, keepdim=True).clamp_min(1e-8) / lv
    return w + ((w / s).round().clamp(-lv, lv) * s - w).detach()


class StraightRound(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        return x.round()

    @staticmethod
    def backward(ctx, g):
        return g


class Student(nn.Module):
    """The family of H10 networks.

    Encoder (runs once an item, at ingest): a hashed n-gram table of `buckets` rows, either `d` wide or `r` wide then
    a dense r->d projection (low rank); table weights float, int8 or int4 (a scale a row) or ternary; batch norm; tanh
    (code stored as int8, `code` "int8") or sign (code stored as bits, `code` "bits").
    Head (runs a pair): [a, b, a*b] -> `h` units (float or binary weights) -> tanh or sign -> one logit."""

    def __init__(self, buckets=1 << 16, d=256, r=0, table="float", code="float", h=64, head="float", hact="tanh"):
        super().__init__()
        self.cfg = dict(buckets=buckets, d=d, r=r, table=table, code=code, h=h, head=head, hact=hact)
        self.buckets = buckets
        self.table = table
        self.code = code
        self.w = nn.Parameter(torch.randn(buckets, r or d) * 0.01)
        self.proj = nn.Linear(r, d, bias=False) if r else None
        self.norm = nn.BatchNorm1d(d)
        self.head_mode, self.hact = head, hact
        self.l1 = nn.Parameter(torch.randn(h, 3 * d) * (1 / (3 * d)) ** 0.5)
        self.n1 = nn.BatchNorm1d(h)
        self.out = nn.Linear(h, 1)

    def pre(self, ids, offs):
        W = fake_q(self.w, self.table)
        x = nn.functional.embedding_bag(ids % self.buckets, W, offs, mode="sum")
        if self.proj is not None:
            x = self.proj(x)
        return self.norm(x)

    def act(self, x):
        if self.code == "bits":
            return B.Sign.apply(x)
        t = torch.tanh(x)
        if self.code == "int8":
            t = StraightRound.apply(t * 127) / 127
        return t

    def pair(self, a, b):
        W = self.l1
        if self.head_mode == "binary":
            W = B.binary(W)
        elif self.head_mode == "int8":
            W = fake_q(W, "int8")
        z = self.n1(torch.cat([a, b, a * b], -1) @ W.T)
        z = B.Sign.apply(z) if self.hact == "sign" else torch.tanh(z)
        return self.out(z).squeeze(-1)

    def size_bytes(self):
        """The shared model as shipped: the table at its storage width (+ float32 row scales), the rest float32 except
        a binary head's signs (bits) or an int8 head (a byte each)."""
        rows, cols = self.w.shape
        width = {"float": 4, "int8": 1, "int4": 0.5, "ternary": 0.25}[self.table]
        n = rows * cols * width + (4 * rows if self.table in ("int8", "int4") else 0)
        if self.proj is not None:
            n += self.proj.weight.numel() * 4
        n += 2 * 4 * self.norm.num_features
        lw = {"float": 4, "int8": 1, "binary": 1 / 8}[self.head_mode]
        n += self.l1.numel() * lw + 4 * self.l1.shape[0] * 3 + 4 * (self.out.weight.numel() + 1)
        return int(n)

    def code_bytes(self):
        d = self.norm.num_features
        return {"bits": d // 8, "int8": d, "float": 4 * d}[self.code]


def teacher_codes(teacher, corpus, idx, bs=1024):
    """The float teacher's pre-activation (after its batch norm) for texts, for code distillation."""
    out = []
    with torch.no_grad():
        for a in range(0, len(idx), bs):
            ids, offs = corpus.bag(idx[a : a + bs])
            h = nn.functional.embedding_bag(ids, teacher.enc.w, offs, mode="sum")
            out.append(teacher.enc.norm(h))
    return torch.cat(out)


def teacher_logits(teacher, codes, P):
    with torch.no_grad():
        a, b = torch.tanh(codes[P[:, 0]]), torch.tanh(codes[P[:, 1]])
        z = teacher.l1(torch.cat([a, b, a * b], -1))
        return teacher.head(torch.tanh(z)).squeeze(-1)


@torch.no_grad()
def eval_student(net, corpus, P, bs=2048):
    net.eval()
    texts = torch.unique(P[:, :2])
    pos = torch.full((len(corpus.texts),), -1, dtype=torch.long)
    pos[texts] = torch.arange(len(texts))
    codes = []
    for a in range(0, len(texts), bs):
        codes.append(net.act(net.pre(*corpus.bag(texts[a : a + bs]))))
    codes = torch.cat(codes)
    p = net.pair(codes[pos[P[:, 0]]], codes[pos[P[:, 1]]]).tolist()
    net.train()
    return metrics(p, P[:, 2].tolist()), p


def train(o):
    random.seed(o.seed)
    torch.manual_seed(o.seed)
    t0 = time.time()
    corpus = Corpus()
    tr = corpus.pairs(pairs_of(o.train))
    weight = torch.ones(len(tr))
    if o.extra_pairs:
        # Engine-drawn pairs (h10_pool_pairs.py): the push pool's (handed, newer) pairs, which the M2 pairs alone
        # under-represent (many same-topic negatives a request).
        ex = corpus.pairs(read_pairs(o.extra_pairs))
        tr = torch.cat([tr, ex])
        weight = torch.cat([weight, torch.full((len(ex),), o.extra_weight)])
    dev = corpus.pairs(pairs_of(o.dev))
    pool_dev = corpus.pairs(read_pairs(o.extra_dev)) if o.extra_dev else None
    evs = {os.path.basename(p): corpus.pairs(pairs_of(p)) for p in o.eval}
    extra = torch.empty(0, dtype=torch.long)
    if o.extra_texts:
        # Unlabelled items of the training worlds, for code distillation only.
        for line in open(o.train):
            for i in json.loads(line)["items"]:
                corpus.add(f"{i['title']}\n{i['text']}")
        extra = torch.arange(len(corpus.texts))
    sizes = {"texts": len(corpus.texts), "train_pairs": len(tr), "dev_pairs": len(dev), "s": round(time.time() - t0)}
    print(json.dumps(sizes), flush=True)
    teacher = None
    if o.teacher:
        teacher, _ = load_teacher(o.teacher)
        tcodes = teacher_codes(teacher, corpus, torch.arange(len(corpus.texts)))
        tlog = teacher_logits(teacher, tcodes, tr)
        print(json.dumps({"teacher_dev": metrics(teacher_logits(teacher, tcodes, dev).tolist(), dev[:, 2].tolist())}),
              flush=True)
    net = Student(buckets=1 << o.log_buckets, d=o.d, r=o.r, table=o.table, code=o.code, h=o.h, head=o.head,
                  hact=o.hact)
    if o.init and teacher is not None:
        init_from_teacher(net, teacher, o)
    opt = torch.optim.Adam(net.parameters(), lr=o.lr)
    steps_per_epoch = (len(tr) + o.bs - 1) // o.bs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=o.lr, total_steps=o.epochs * steps_per_epoch, pct_start=0.1)
    best, best_state, log = None, None, []
    for ep in range(o.epochs):
        perm = torch.randperm(len(tr))
        if o.hard and teacher is not None:
            # Hard negatives: negatives the teacher scores high are drawn again (up to `hard` extra copies).
            w = torch.where(tr[:, 2] == 0, torch.sigmoid(tlog) * o.hard, torch.zeros(len(tr)))
            extra_draw = torch.nonzero(torch.rand(len(tr)) < w).squeeze(-1)
            perm = torch.cat([perm, extra_draw])[torch.randperm(len(perm) + len(extra_draw))]
        for s in range(0, len(perm), o.bs):
            bi = perm[s : s + o.bs]
            P = tr[bi]
            u, inv = torch.unique(P[:, :2], return_inverse=True)
            if o.code_kd and len(extra):
                ex = extra[torch.randint(len(extra), (o.bs,))]
                u2 = torch.cat([u, ex])
            else:
                u2 = u
            pre = net.pre(*corpus.bag(u2))
            c = net.act(pre[: len(u)])
            logit = net.pair(c[inv[:, 0]], c[inv[:, 1]])
            y = P[:, 2].float()
            wb = weight[bi]
            loss = (nn.functional.binary_cross_entropy_with_logits(logit, y, reduction="none") * wb).sum() / wb.sum()
            if teacher is not None and o.kd > 0:
                T = o.temp
                soft = torch.sigmoid(tlog[bi] / T)
                loss = loss + o.kd * nn.functional.binary_cross_entropy_with_logits(logit / T, soft) * T * T
            if teacher is not None and o.code_kd > 0:
                loss = loss + o.code_kd * nn.functional.mse_loss(pre, tcodes[u2])
            opt.zero_grad()
            loss.backward()
            opt.step()
            if sched.last_epoch < sched.total_steps - 1:
                sched.step()
        m, _ = eval_student(net, corpus, dev)
        key = m["recall@p0.95"] + m["auc"]
        row = {"epoch": ep, "dev": m, "loss": round(float(loss.detach()), 4), "s": round(time.time() - t0)}
        if pool_dev is not None:
            mp, _ = eval_student(net, corpus, pool_dev)
            key += mp["recall@p0.95"] + mp["auc"]
            row["pool_dev"] = mp
        if best is None or key > best:
            best = key
            best_state = {k: v.clone() for k, v in net.state_dict().items()}
            row["best"] = True
        log.append(row)
        print(json.dumps(row), flush=True)
    net.load_state_dict(best_state)
    res = {"variant": o.name, "cfg": net.cfg, "size_bytes": net.size_bytes(), "code_bytes": net.code_bytes(),
           "dev": next(r for r in reversed(log) if r.get("best"))["dev"]}
    if pool_dev is not None:
        res["pool_dev"] = next(r for r in reversed(log) if r.get("best"))["pool_dev"]
    for name, P in evs.items():
        res[name] = eval_student(net, corpus, P)[0]
    res["seconds"] = round(time.time() - t0)
    print("RESULT", json.dumps(res), flush=True)
    if o.save:
        torch.save({"state": net.state_dict(), "cfg": net.cfg, "args": vars(o), "result": res}, o.save)
    if o.out:
        json.dump({"result": res, "log": log}, open(o.out, "w"), indent=1)
    return res


def init_from_teacher(net, teacher, o):
    """Start a student from the teacher: the table by truncated SVD (low rank) or modulo-folding (fewer buckets), the
    batch norm and the head copied when shapes match."""
    W = teacher.enc.w.detach()
    nb = net.buckets
    if nb < W.shape[0]:
        W = W.view(-1, nb, W.shape[1]).sum(0)  # rows that share an id modulo nb add, as their sums would
    with torch.no_grad():
        if net.proj is not None:
            U, S, V = torch.linalg.svd(W, full_matrices=False)
            r = net.w.shape[1]
            net.w.copy_(U[:, :r] * S[:r])
            net.proj.weight.copy_(V[:r].T)
        elif net.w.shape == W.shape:
            net.w.copy_(W)
        if net.norm.num_features == teacher.enc.norm.num_features:
            net.norm.load_state_dict(teacher.enc.norm.state_dict())
            if net.l1.shape == teacher.l1.w.shape:
                net.l1.copy_(teacher.l1.w)
                net.n1.load_state_dict(teacher.l1.norm.state_dict())
                net.out.load_state_dict(teacher.head.state_dict())


def export(o):
    """A trained Student to flat files for the TypeScript forward (m3r/h10-forward.ts): the table as int8 with a float32
    scale a row (or float32), the encoder's batch norm folded into the projection, the head's batch norm folded to a
    scale and shift; plus PyTorch's logits on held-out pairs (half replacements) and the dev threshold at precision
    0.95, for an exactness check of decisions."""
    import numpy as np

    ck = torch.load(o.model, map_location="cpu", weights_only=False)
    net = Student(**ck["cfg"])
    net.load_state_dict(ck["state"])
    net.eval()
    cfg = ck["cfg"]
    os.makedirs(o.out, exist_ok=True)
    f32 = lambda t: t.detach().numpy().astype(np.float32)  # noqa: E731
    W = net.w.detach()
    arrays = {}
    if cfg["table"] in ("int8", "int4"):
        lv = {"int8": 127, "int4": 7}[cfg["table"]]
        sc = W.abs().amax(1, keepdim=True).clamp_min(1e-8) / lv
        arrays["table"] = (W / sc).round().clamp(-lv, lv).to(torch.int8).numpy()
        arrays["row_scale"] = f32(sc.squeeze(1))
    elif cfg["table"] == "ternary":
        a = W.abs().mean()
        arrays["table"] = torch.where(W > 0.7 * a, 1, torch.where(W < -0.7 * a, -1, 0)).to(torch.int8).numpy()
        arrays["row_scale"] = np.full(W.shape[0], float(a), dtype=np.float32)
    else:
        arrays["table"] = f32(W)
    bs = net.norm.weight / torch.sqrt(net.norm.running_var + net.norm.eps)
    bh = net.norm.bias - net.norm.running_mean * bs
    # Encoder: pre = bs * (P x) + bh, with P the projection (identity when the table is d wide).
    if net.proj is not None:
        arrays["proj"] = f32(net.proj.weight * bs[:, None])  # d x r
    else:
        arrays["enc_s"] = f32(bs)
    arrays["enc_h"] = f32(bh)
    L = net.l1.detach()
    if cfg["head"] == "binary":
        L = L.abs().mean(1, keepdim=True) * torch.sign(L)
    elif cfg["head"] == "int8":
        L = fake_q(L, "int8")
    s1 = net.n1.weight / torch.sqrt(net.n1.running_var + net.n1.eps)
    arrays["l1"] = f32(L)  # h x 3d, float32 (an int8 or binary head is stored at its width; see size_bytes)
    arrays["n1_s"] = f32(s1)
    arrays["n1_h"] = f32(net.n1.bias - net.n1.running_mean * s1)
    arrays["out_w"] = f32(net.out.weight.squeeze(0))
    arrays["out_b"] = f32(net.out.bias)
    meta = {"cfg": cfg, "size_bytes": net.size_bytes(), "code_bytes": net.code_bytes(), "arrays": {},
            "result": ck.get("result")}
    for name, arr in arrays.items():
        arr.tofile(os.path.join(o.out, f"{name}.bin"))
        meta["arrays"][name] = {"dtype": str(arr.dtype), "shape": list(arr.shape)}
    corpus = Corpus()
    dev = corpus.pairs(pairs_of(o.dev))
    _, pd = eval_student(net, corpus, dev)
    th = threshold_at(pd, dev[:, 2].tolist(), 0.95)
    P = pairs_of(o.pairs[0])
    pos = [x for x in P if x[2] == 1][: o.n // 2]
    neg = sorted([x for x in P if x[2] == 0], key=lambda x: B.jaccard(x[0], x[1]))[-(o.n - len(pos)) :]
    chk = pos + neg
    T = corpus.pairs(chk)
    _, pc = eval_student(net, corpus, T)
    meta["threshold_p95_dev"] = th
    meta["checks"] = [{"a": x[0], "b": x[1], "logit": round(v, 5), "label": x[2]} for x, v in zip(chk, pc)]
    json.dump(meta, open(os.path.join(o.out, "meta.json"), "w"))
    size = sum(os.path.getsize(os.path.join(o.out, f"{n}.bin")) for n in arrays)
    print(json.dumps({"out": o.out, "cfg": cfg, "file_bytes": size, "size_bytes": net.size_bytes(), "threshold": th,
                      "checks": len(chk)}))


def threshold_at(p, y, prec):
    """The lowest score threshold whose precision on (p, y) is at least `prec` (the operating point for recall)."""
    order = sorted(range(len(p)), key=lambda i: -p[i])
    tp = fp = 0
    best = float(max(p))
    for i in order:
        tp += y[i]
        fp += 1 - y[i]
        if tp / (tp + fp) >= prec:
            best = float(p[i])
    return best


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["score", "teach", "train", "export"])
    a.add_argument("--model", default="")
    a.add_argument("--pairs", nargs="+", default=[])
    a.add_argument("--out", default="")
    # train
    a.add_argument("--name", default="run")
    a.add_argument("--train", default="")
    a.add_argument("--dev", default="")
    a.add_argument("--eval", nargs="*", default=[])
    a.add_argument("--teacher", default="")
    a.add_argument("--init", action="store_true", help="start from the teacher (SVD / folding / copied head)")
    a.add_argument("--log-buckets", type=int, default=16)
    a.add_argument("--d", type=int, default=256)
    a.add_argument("--r", type=int, default=0)
    a.add_argument("--table", default="float", choices=["float", "int8", "int4", "ternary"])
    a.add_argument("--code", default="float", choices=["float", "int8", "bits"])
    a.add_argument("--h", type=int, default=64)
    a.add_argument("--head", default="float", choices=["float", "int8", "binary"])
    a.add_argument("--hact", default="tanh", choices=["tanh", "sign"])
    a.add_argument("--kd", type=float, default=0.0, help="weight of the teacher's soft scores")
    a.add_argument("--temp", type=float, default=2.0)
    a.add_argument("--code-kd", type=float, default=0.0, help="weight of matching the teacher's pre-activation codes")
    a.add_argument("--extra-texts", action="store_true", help="all training-world items for code distillation")
    a.add_argument("--hard", type=float, default=0.0, help="extra draws of teacher-hard negatives (expected copies)")
    a.add_argument("--epochs", type=int, default=4)
    a.add_argument("--bs", type=int, default=128)
    a.add_argument("--lr", type=float, default=2e-3)
    a.add_argument("--seed", type=int, default=7)
    a.add_argument("--extra-pairs", default="", help="engine-drawn pairs to train on (h10_pool_pairs.py's jsonl)")
    a.add_argument("--extra-weight", type=float, default=1.0)
    a.add_argument("--extra-dev", default="", help="engine-drawn pairs held out for selection")
    a.add_argument("--save", default="")
    a.add_argument("--n", type=int, default=64, help="export: held-out pairs checked against PyTorch")
    o = a.parse_args()
    if o.cmd == "export":
        export(o)
        sys.exit(0)
    if o.cmd == "train":
        train(o)
        sys.exit(0)
    net, ck = load_teacher(o.model)
    t0 = time.time()
    if o.cmd == "score":
        for path in o.pairs:
            P = pairs_of(path)
            p = score_net(net, P)
            print(json.dumps({"model": os.path.basename(o.model), "pairs_file": os.path.basename(path),
                              **metrics(p, [x[2] for x in P]), "s": round(time.time() - t0)}), flush=True)
    else:
        P = [x for path in o.pairs for x in pairs_of(path)]
        p = score_net(net, P)
        torch.save({"pairs": P, "logits": p}, o.out)
        print(json.dumps({"pairs": len(P), **metrics(p, [x[2] for x in P])}))
