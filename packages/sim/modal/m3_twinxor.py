"""M3 TwinXor (D907, docs/research/m3-arch.md §6): a binarised cross-scoring network, trained end to end from
hashed character and word n-grams, with no tokenizer, no pretrained weights and no vector retrieval.

- Encoder (items at ingest, requests at request time, separate weights): hashed n-grams (word 1-2, character 3-5
  within words; 2^18 buckets) summed through a **ternary** layer (weights in {-1, 0, +1}) into a **256-bit binary
  code** (sign). Inference: integer adds, one comparison a bit.
- Cross scorer (request, candidate, the candidate's corpus twin): reads the bit patterns q·i (XNOR), q, i, i·t
  (XNOR with the twin) and t, plus optional pair-feature bits (FrameRank's comparators bucketed), through two
  **binary** layers (weights ±1; XNOR-popcount at inference) and a small linear head; a request-only NULL head scores
  "nothing here".
- Straight-through estimators train the ternary, binary and sign steps; the loss is listwise over the candidates and
  NULL, every request with either its fact or its all-clear twin in the world (never both), as over a user's days.

    modal run packages/sim/modal/m3_twinxor.py --run tx-a1 --train groups-A.jsonl.gz \
        --evals groups-evalA.jsonl.gz,groups-m2A.jsonl.gz [--ablate twin,feats,binary,cross]
"""
import json
import os
import time
import zlib

import modal

image = modal.Image.debian_slim(python_version="3.12").pip_install("torch==2.8.0", "numpy==2.3.3")
vol = modal.Volume.from_name("eden-retriever", create_if_missing=True)
app = modal.App("eden-m3-twinxor", image=image)
BUCKETS = 1 << 18
BITS = 256
FEAT_CUTS = 4  # each pair feature becomes 4 threshold bits (cut points from the training data's quantiles)


def grams(text, cap=400):
    """Hashed n-gram ids of a text: words, word bigrams and character 3-5-grams inside words (crc32, deterministic)."""
    import re

    words = re.findall(r"[a-z0-9£$€]+", text.lower())[:200]
    out = set()
    for w in words:
        out.add(zlib.crc32(b"w" + w.encode()) % BUCKETS)
        p = f"<{w}>"
        for n in (3, 4, 5):
            for k in range(len(p) - n + 1):
                out.add(zlib.crc32(b"c" + p[k : k + n].encode()) % BUCKETS)
    for a, b in zip(words, words[1:]):
        out.add(zlib.crc32(f"b{a} {b}".encode()) % BUCKETS)
    return sorted(out)[:cap] if len(out) > cap else sorted(out)


def build(ablate, n_feats):
    import torch
    import torch.nn as nn

    class Sign(torch.autograd.Function):
        @staticmethod
        def forward(ctx, x):
            ctx.save_for_backward(x)
            return torch.where(x >= 0, 1.0, -1.0).to(x.dtype)

        @staticmethod
        def backward(ctx, g):
            (x,) = ctx.saved_tensors
            return g * (x.abs() <= 1).to(g.dtype)  # straight-through, clipped

    def ternary(w):
        # weights in {-a, 0, +a}: a = mean |w|, threshold 0.7 a (TWN); straight-through to the float latent.
        a = w.abs().mean()
        q = torch.where(w > 0.7 * a, a, torch.where(w < -0.7 * a, -a, torch.zeros_like(w)))
        return w + (q - w).detach()

    def binary(w):
        a = w.abs().mean(dim=1, keepdim=True)
        return w + (a * torch.sign(w) - w).detach()

    real = "binary" in ablate  # `-binary`: float weights and tanh codes (the same network, not quantised)
    act = torch.tanh if real else Sign.apply

    class Enc(nn.Module):
        def __init__(s):
            super().__init__()
            s.w = nn.Parameter(torch.randn(BUCKETS, BITS) * 0.01)
            s.norm = nn.BatchNorm1d(BITS, affine=True)

        def forward(s, ids, offs):
            W = s.w if real else ternary(s.w)
            h = nn.functional.embedding_bag(ids, W, offs, mode="sum")
            return act(s.norm(h))

    class BinLin(nn.Module):
        def __init__(s, i, o):
            super().__init__()
            s.w = nn.Parameter(torch.randn(o, i) * (1 / i) ** 0.5)
            s.norm = nn.BatchNorm1d(o)

        def forward(s, x):
            W = s.w if real else binary(s.w)
            return s.norm(x @ W.T)

    class Net(nn.Module):
        def __init__(s):
            super().__init__()
            s.ienc, s.qenc = Enc(), Enc()
            parts = 2 if "cross" in ablate else 5
            fbits = 0 if "feats" in ablate else n_feats * FEAT_CUTS
            s.l1 = BinLin(parts * BITS + fbits, 256)
            s.l2 = BinLin(256, 64)
            s.head = nn.Linear(64, 1)
            s.n1 = BinLin(BITS, 64)
            s.nhead = nn.Linear(64, 1)
            s.ablate = ablate

        def score(s, q, i, t, f):
            """q (R, B) request codes; i, t (R, K, B) candidate and twin codes; f (R, K, F) feature bits -> (R, K)."""
            R, K, B = i.shape
            qq = q.unsqueeze(1).expand(R, K, B)
            if "cross" in s.ablate:  # `-cross`: no interaction terms, only the codes side by side (a bi-encoder-like head)
                x = torch.cat([qq * i, i], -1)
            else:
                if "twin" in s.ablate:
                    t = torch.zeros_like(t)
                x = torch.cat([qq * i, qq, i, i * t, t], -1)
            if f is not None and "feats" not in s.ablate:
                x = torch.cat([x, f], -1)
            h = act(s.l1(x.reshape(R * K, -1)))
            h = act(s.l2(h))
            return s.head(h).view(R, K)

        def null(s, q):
            return s.nhead(act(s.n1(q))).squeeze(-1)

    return Net()


def load(path):
    import gzip

    with gzip.open(path, "rt") as f:
        return [json.loads(l) for l in f]


@app.function(gpu="A10G", volumes={"/vol": vol}, timeout=6 * 3600, memory=49152)
def train_remote(run: str, train_file: str, evals: list, ablate: list, epochs: int, lr: float) -> dict:
    import numpy as np
    import torch

    t0 = time.time()
    torch.manual_seed(7)
    rng = np.random.default_rng(7)
    dev = "cuda"
    data = load(f"/vol/data/{train_file}")
    nf = len(data[0]["reqs"][0]["feats"][0]) if data and data[0]["reqs"] and data[0]["reqs"][0]["feats"] else 0
    # Feature cut points: quantiles of each pair feature over a sample of training pairs.
    sample = np.array([f for w in data[:60] for r in w["reqs"] for f in r["feats"]], dtype=np.float32)
    cuts = np.stack([np.unique(np.quantile(sample[:, j], [0.2, 0.4, 0.6, 0.8]))[:FEAT_CUTS].tolist() +
                     [1e9] * (FEAT_CUTS - len(np.unique(np.quantile(sample[:, j], [0.2, 0.4, 0.6, 0.8])))) for j in range(nf)])
    cuts_t = torch.tensor(cuts, device=dev, dtype=torch.float32)
    net = build(set(ablate), nf).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    t_prep = time.time() - t0

    def world_codes(w, enc):
        ids, offs = [], []
        for t in w["texts"]:
            offs.append(len(ids))
            ids += grams(t) or [0]
        return enc(torch.tensor(ids, device=dev), torch.tensor(offs, device=dev))

    def req_codes(texts):
        ids, offs = [], []
        for t in texts:
            offs.append(len(ids))
            ids += grams(t) or [0]
        return net.qenc(torch.tensor(ids, device=dev), torch.tensor(offs, device=dev))

    def batch(w, reqs):
        K = max(len(r["cands"]) for r in reqs)
        cand = torch.full((len(reqs), K), -1, dtype=torch.long)
        F_ = torch.zeros(len(reqs), K, nf)
        for a, r in enumerate(reqs):
            cand[a, : len(r["cands"])] = torch.tensor(r["cands"])
            if nf:
                F_[a, : len(r["feats"])] = torch.tensor(r["feats"], dtype=torch.float32)
        cand = cand.to(dev)
        twin = torch.tensor(w["twin"], device=dev)
        fb = (F_.to(dev).unsqueeze(-1) > cuts_t).float().reshape(len(reqs), K, -1) * 2 - 1 if nf else None
        return cand, twin, fb

    log, step = [], 0
    for ep in range(epochs):
        net.train()
        for wi in rng.permutation(len(data)):
            w = data[wi]
            reqs = [r for r in w["reqs"] if r["cands"] and not (r["kind"] == "hidden" and r["target"] < 0)]
            if not reqs:
                continue
            codes = world_codes(w, net.ienc)
            cand, twin, fb = batch(w, reqs)
            mask = cand < 0
            c = cand.clamp(min=0)
            t = twin[c].clamp(min=0)
            q = req_codes([r["request"] for r in reqs])
            sc = net.score(q, codes[c], codes[t] * (twin[c] >= 0).unsqueeze(-1), fb).masked_fill(mask, -1e4)
            logits = torch.cat([net.null(q).unsqueeze(1), sc], 1)
            y = torch.tensor([r["target"] + 1 if r["target"] >= 0 else 0 for r in reqs], device=dev)
            loss = torch.nn.functional.cross_entropy(logits, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            if step % 50 == 0:
                log.append({"step": step, "ep": ep, "loss": round(float(loss), 4), "s": round(time.time() - t0)})
                print(log[-1], flush=True)
            step += 1
    net.eval()
    out = {}
    with torch.no_grad():
        for name in evals:
            rows = []
            for w in load(f"/vol/data/{name}"):
                reqs = [r for r in w["reqs"] if r["cands"]]
                if not reqs:
                    continue
                codes = world_codes(w, net.ienc)
                for a in range(0, len(reqs), 64):
                    rb = reqs[a : a + 64]
                    cand, twin, fb = batch(w, rb)
                    c = cand.clamp(min=0)
                    t = twin[c].clamp(min=0)
                    q = req_codes([r["request"] for r in rb])
                    sc = net.score(q, codes[c], codes[t] * (twin[c] >= 0).unsqueeze(-1), fb).masked_fill(cand < 0, -1e4)
                    nl = net.null(q)
                    for r, s_, n_ in zip(rb, sc.tolist(), nl.tolist()):
                        order = sorted(range(len(r["cands"])), key=lambda k: -s_[k])
                        rows.append({"rid": r["rid"], "all": [w["ids"][r["cands"][k]] for k in order],
                                     "top": [w["ids"][r["cands"][k]] for k in order if s_[k] > n_],
                                     "margin": [round(s_[k] - n_, 3) for k in order[:20]]})
            out[name] = rows
    meta = {"run": run, "train": train_file, "ablate": ablate, "epochs": epochs, "lr": lr, "steps": step,
            "n_feats": nf, "prep_s": round(t_prep), "total_s": round(time.time() - t0), "log": log,
            "params": sum(p.numel() for p in net.parameters())}
    os.makedirs(f"/vol/models/{run}", exist_ok=True)
    torch.save(net.state_dict(), f"/vol/models/{run}/twinxor.pt")
    json.dump(meta, open(f"/vol/models/{run}/meta.json", "w"), indent=1)
    vol.commit()
    return {"meta": meta, "ranks": out}


@app.local_entrypoint()
def main(run: str, train: str, evals: str, ablate: str = "", epochs: int = 4, lr: float = 2e-3):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    got = train_remote.remote(run, train, evals.split(","), [x for x in ablate.split(",") if x], epochs, lr)
    for name, rows in got["ranks"].items():
        out = os.path.join(root, ".local", "m3", "runs", f"{run}@{name.split('.')[0]}")
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "ranks.jsonl"), "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        json.dump(got["meta"], open(os.path.join(out, "meta.json"), "w"), indent=1)
        print(out)
    print(json.dumps({k: v for k, v in got["meta"].items() if k != "log"}))
