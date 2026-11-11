"""M8: trains the engine's connector router (packages/engine/src/router.ts) and writes its weights file.

  python3 -I train_router.py conj  M2DIR LOGDIR OUT.npz [--buckets 2^18] [--epochs 3]
  python3 -I train_router.py mlp   OUT.npz TRAIN_LOGS VAL_LOGS [--hidden 16] [--epochs 4] [--recall 0.98]
  python3 -I train_router.py eval  OUT.npz LOGS            # offline recall and reads on held-out route logs
  python3 -I train_router.py export OUT.npz router.bin

`conj` learns the conjunction table on M2's exported worlds (every request style and language; `m8-export.ts` writes
the exact request features and source keys the engine computes), with the lab's noise connectors' keys (read from a
route log) as extra negatives. `mlp` learns the per-source network and the "nothing needed" head on the engine's own
inputs (`days-calls.ts --route-log`, synth-train users), the conjunction column recomputed with the learned table,
and fits the temperature and the floor on validation logs (synth-val users) for the recall target. Numpy only.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import struct
import sys

import numpy as np

M32 = np.uint64(0xFFFFFFFF)
PHI = np.uint64(0x9E3779B1)
NF = 11
NULL_NF = 5


def mix32(h: np.ndarray) -> np.ndarray:
    h = h.astype(np.uint64) & M32
    h ^= h >> np.uint64(16)
    h = (h * np.uint64(0x85EBCA6B)) & M32
    h ^= h >> np.uint64(13)
    h = (h * np.uint64(0xC2B2AE35)) & M32
    h ^= h >> np.uint64(16)
    return h


def buckets_of(f: np.ndarray, k: np.ndarray, mask: int) -> np.ndarray:
    """`conjBucket` for every (feature, key) pair: mix32((f * phi + k) mod 2^32) & mask; rows are features."""
    v = (f.astype(np.uint64)[:, None] * PHI + k.astype(np.uint64)[None, :]) & M32
    return (mix32(v) & np.uint64(mask)).astype(np.int64)


def conj_scores(W: np.ndarray, f: np.ndarray, keys: list[np.ndarray]) -> np.ndarray:
    mask = len(W) - 1
    out = np.zeros(len(keys))
    if len(f) == 0:
        return out
    for i, k in enumerate(keys):
        if len(k):
            out[i] = W[buckets_of(f, k, mask)].sum() / math.sqrt(len(f) * len(k))
    return out


def to_probs(z: np.ndarray) -> np.ndarray:
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


# ---------------------------------------------------------------------------------------------------------------
# Route logs


def read_logs(pattern: str):
    """Yields (keys by source id, row) for every request row of the logs matching `pattern`."""
    for path in sorted(glob.glob(pattern)):
        keys = {}
        with open(path) as fh:
            for line in fh:
                d = json.loads(line)
                if "keys" in d:
                    keys = {k: np.asarray(v, dtype=np.uint64) for k, v in d["keys"].items()}
                    continue
                yield keys, d


def noise_keys(pattern: str) -> list[np.ndarray]:
    for keys, _ in read_logs(pattern):
        return [v for k, v in keys.items() if k[-1].isdigit()]
    return []


# ---------------------------------------------------------------------------------------------------------------


def train_conj(a):
    B = int(eval(a.buckets))
    W = np.zeros(B, dtype=np.float32)
    G = np.full(B, 1e-2, dtype=np.float32)
    noise = noise_keys(f"{a.logs}/*.jsonl")
    print(f"conj: {len(noise)} noise connectors' keys", file=sys.stderr)
    rng = np.random.default_rng(0)
    worlds = []
    with open(f"{a.m2}/x-train.jsonl") as fh:
        for line in fh:
            w = json.loads(line)
            worlds.append(
                {
                    "keys": [np.asarray(s["k"], dtype=np.uint64) for s in w["sources"]],
                    "ids": [s["id"] for s in w["sources"]],
                    "reqs": [
                        (np.asarray(r["f"], dtype=np.uint64), t["src"])
                        for t in w["tasks"]
                        for r in t["reqs"]
                        if t["src"]
                    ],
                }
            )
    mask = B - 1
    for ep in range(a.epochs):
        loss, n = 0.0, 0
        for wi in rng.permutation(len(worlds)):
            w = worlds[wi]
            nz = [noise[j] for j in rng.choice(len(noise), size=min(20, len(noise)), replace=False)] if noise else []
            keys = w["keys"] + nz
            for f, src in w["reqs"]:
                if src not in w["ids"] or len(f) == 0:
                    continue
                y = w["ids"].index(src)
                idx = [buckets_of(f, k, mask).ravel() for k in keys]
                norm = [math.sqrt(len(f) * len(k)) for k in keys]
                s = np.asarray([W[i].sum() / z for i, z in zip(idx, norm)])
                p = to_probs(s)
                loss -= math.log(max(1e-12, p[y]))
                g = p.copy()
                g[y] -= 1
                for si, (i, z) in enumerate(zip(idx, norm)):
                    if abs(g[si]) < 1e-4:
                        continue
                    gr = np.float32(g[si] / z)
                    np.add.at(G, i, gr * gr)
                    np.add.at(W, i, -a.lr * gr / np.sqrt(G[i]))
                n += 1
        print(f"conj epoch {ep}: loss {loss / max(1, n):.4f} over {n}", file=sys.stderr, flush=True)
    np.savez(a.out, conj=W)


# ---------------------------------------------------------------------------------------------------------------


def train_conj_logs(W: np.ndarray, pattern: str, epochs: int, lr: float):
    """Fine-tunes the conjunction table on route logs' hidden requests: listwise over the logged sources (sampled
    ones by their weight), the planted source the target. Starts from the M2-trained table."""
    G = np.full(len(W), 1e-2, dtype=np.float32)
    mask = len(W) - 1
    reqs = []
    for keys, d in read_logs(pattern):
        if d["kind"] != "hidden":
            continue
        ids = [r["id"] for r in d["rows"]]
        if d["planted"] not in ids:
            continue
        f = np.asarray(d["features"], dtype=np.uint64)
        ks = [keys.get(i, np.zeros(0, np.uint64)) for i in ids]
        lw = np.log(np.asarray([r["w"] for r in d["rows"]], dtype=np.float64))
        reqs.append((f, ks, lw, ids.index(d["planted"])))
    rng = np.random.default_rng(3)
    for ep in range(epochs):
        loss = 0.0
        for i in rng.permutation(len(reqs)):
            f, ks, lw, y = reqs[i]
            idx = [buckets_of(f, k, mask).ravel() if len(k) else np.zeros(0, np.int64) for k in ks]
            norm = [math.sqrt(len(f) * len(k)) if len(k) else 1.0 for k in ks]
            s = np.asarray([W[j].sum() / z for j, z in zip(idx, norm)]) + lw
            p = to_probs(s)
            loss -= math.log(max(1e-12, p[y]))
            g = p.copy()
            g[y] -= 1
            for si, (j, z) in enumerate(zip(idx, norm)):
                if abs(g[si]) < 1e-4 or len(j) == 0:
                    continue
                gr = np.float32(g[si] / z)
                np.add.at(G, j, gr * gr)
                np.add.at(W, j, -lr * gr / np.sqrt(G[j]))
        print(f"conjlogs epoch {ep}: loss {loss / max(1, len(reqs)):.4f} over {len(reqs)}", file=sys.stderr, flush=True)


DROP: list[int] = []  # input columns left out (`--drop`): zeroed in training, their first-layer rows zero at save


def examples(pattern: str, W: np.ndarray):
    """Per request: X (rows × NF, conj recomputed), log-weights, summary, label row (or -1 for nothing), meta."""
    out = []
    for keys, d in read_logs(pattern):
        rows = d["rows"]
        if not rows:
            continue
        f = np.asarray(d["features"], dtype=np.uint64)
        X = np.asarray([r["x"] for r in rows], dtype=np.float64)
        X[:, 0] = conj_scores(W, f, [keys.get(r["id"], np.zeros(0, np.uint64)) for r in rows])
        X[:, DROP] = 0.0
        lw = np.log(np.asarray([r["w"] for r in rows], dtype=np.float64))
        spent = np.asarray([bool(r.get("spent")) for r in rows])
        ids = [r["id"] for r in rows]
        y = ids.index(d["planted"]) if d["kind"] == "hidden" and d["planted"] in ids else -1
        summ = np.asarray(
            [X[:, 0].max(), X[:, 1].max(), float(X[:, 3].max() > 0), float(X[:, 4].max() > 0), math.log1p((len(f) + 1) / 2)]
        )
        out.append(
            {
                "X": X,
                "lw": lw,
                "s": summ,
                "y": y,
                "kind": d["kind"],
                "lag": d["lag"],
                "planted": d["planted"],
                "spent": spent,
                "n": d["n"],
                "w": np.exp(lw),
            }
        )
    return out


class Net:
    def __init__(self, hidden: int, seed=0):
        r = np.random.default_rng(seed)
        self.h = hidden
        self.W1 = r.standard_normal((NF, hidden)) * 0.3
        self.b1 = np.zeros(hidden)
        self.w2 = r.standard_normal(hidden) * 0.3
        self.b2 = 0.0
        self.nb = 0.0
        self.nw = np.zeros(NULL_NF)
        self.mu = np.zeros(NF)
        self.sd = np.ones(NF)
        self.t = 1.0
        self.floor = 0.0

    def logits(self, e):
        Xn = (e["X"] - self.mu) / self.sd
        A = Xn @ self.W1 + self.b1
        Hh = np.maximum(0, A)
        z = Hh @ self.w2 + self.b2
        zn = self.nb + self.nw @ e["s"]
        return z, zn, Xn, Hh

    def probs(self, e, t=None):
        z, zn, *_ = self.logits(e)
        t = t or self.t
        all_ = np.concatenate([[zn / t], z / t + e["lw"]])
        p = to_probs(all_)
        # Per-source probability (a sampled row stands for w sources alike: each gets p / w).
        return p[1:] / e["w"], p[0]


def fit_mlp(net: Net, train, epochs: int, lr: float, l2: float = 1e-4):
    A = np.concatenate([e["X"] for e in train[:3000]])
    net.mu, net.sd = A.mean(0), A.std(0) + 1e-6
    rng = np.random.default_rng(1)
    # Adam
    params = ["W1", "b1", "w2", "nw"]
    m = {k: np.zeros_like(getattr(net, k)) for k in params}
    v = {k: np.zeros_like(getattr(net, k)) for k in params}
    mb = {"b2": 0.0, "nb": 0.0}
    vb = {"b2": 0.0, "nb": 0.0}
    step = 0
    for ep in range(epochs):
        loss = 0.0
        for i in rng.permutation(len(train)):
            e = train[i]
            z, zn, Xn, Hh = net.logits(e)
            all_ = np.concatenate([[zn], z + e["lw"]])
            p = to_probs(all_)
            y = 0 if e["y"] < 0 else e["y"] + 1
            loss -= math.log(max(1e-12, p[y]))
            g = p.copy()
            g[y] -= 1
            gz = g[1:]
            gzn = g[0]
            grads = {
                "w2": Hh.T @ gz + l2 * net.w2,
                "W1": Xn.T @ (np.outer(gz, net.w2) * (Hh > 0)) + l2 * net.W1,
                "b1": (np.outer(gz, net.w2) * (Hh > 0)).sum(0),
                "nw": gzn * e["s"],
            }
            gb = {"b2": gz.sum(), "nb": gzn}
            step += 1
            for k in params:
                m[k] = 0.9 * m[k] + 0.1 * grads[k]
                v[k] = 0.999 * v[k] + 0.001 * grads[k] ** 2
                setattr(net, k, getattr(net, k) - lr * (m[k] / (1 - 0.9**step)) / (np.sqrt(v[k] / (1 - 0.999**step)) + 1e-8))
            for k in gb:
                mb[k] = 0.9 * mb[k] + 0.1 * gb[k]
                vb[k] = 0.999 * vb[k] + 0.001 * gb[k] ** 2
                setattr(net, k, getattr(net, k) - lr * (mb[k] / (1 - 0.9**step)) / (math.sqrt(vb[k] / (1 - 0.999**step)) + 1e-8))
        print(f"mlp epoch {ep}: loss {loss / len(train):.4f}", file=sys.stderr, flush=True)


def fit_temperature(net: Net, val):
    best, bt = float("inf"), 1.0
    for t in np.exp(np.linspace(math.log(0.2), math.log(5), 25)):
        nll = 0.0
        for e in val:
            z, zn, *_ = net.logits(e)
            p = to_probs(np.concatenate([[zn / t], z / t + e["lw"]]))
            y = 0 if e["y"] < 0 else e["y"] + 1
            nll -= math.log(max(1e-12, p[y]))
        if nll < best:
            best, bt = nll, t
    net.t = float(bt)


def gate(net: Net, data, floor: float):
    """Offline reads and recall at a floor: per request, sources read live (not spent before, p over the floor) by
    weight, against those read before the router (not spent); hidden requests' planted source kept or not."""
    reads_after, reads_before, hit, rare_hit, n_h, n_rare = 0.0, 0.0, 0, 0, 0, 0
    by_kind = {}
    for e in data:
        p, _ = net.probs(e)
        live = ~e["spent"]
        before = float((e["w"] * live).sum())
        after = float((e["w"] * (live & (p >= floor))).sum())
        reads_before += before
        reads_after += after
        k = by_kind.setdefault(e["kind"], [0.0, 0.0, 0])
        k[0] += before
        k[1] += after
        k[2] += 1
        if e["y"] >= 0:
            n_h += 1
            ok = bool(p[e["y"]] >= floor) or bool(e["spent"][e["y"]])
            hit += ok
            if e["planted"] not in ("gmail", "calendar", "drive", "slack", "crm"):
                n_rare += 1
                rare_hit += ok
    return {
        "floor": floor,
        "hidden": n_h,
        "recall": hit / max(1, n_h),
        "rare": n_rare,
        "rare_recall": rare_hit / max(1, n_rare),
        "reads_before": reads_before / max(1, len(data)),
        "reads_after": reads_after / max(1, len(data)),
        "cut": 1 - reads_after / max(1e-9, reads_before),
        "by_kind": {k: {"n": v[2], "before": v[0] / v[2], "after": v[1] / v[2]} for k, v in by_kind.items()},
    }


def fit_floor(net: Net, val, target: float) -> float:
    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if gate(net, val, mid)["recall"] >= target:
            lo = mid
        else:
            hi = mid
    return lo


def save(net: Net, W: np.ndarray, path: str):
    for c in DROP:
        net.W1[c, :] = 0.0
        net.mu[c], net.sd[c] = 0.0, 1.0
    np.savez(
        path,
        conj=W,
        W1=net.W1,
        b1=net.b1,
        w2=net.w2,
        b2=net.b2,
        nb=net.nb,
        nw=net.nw,
        mu=net.mu,
        sd=net.sd,
        t=net.t,
        floor=net.floor,
        hidden=net.h,
    )


def load(path: str):
    d = np.load(path)
    W = d["conj"]
    if "W1" not in d:
        return None, W
    net = Net(int(d["hidden"]))
    for k in ("W1", "b1", "w2", "nw", "mu", "sd"):
        setattr(net, k, d[k])
    net.b2, net.nb, net.t, net.floor = float(d["b2"]), float(d["nb"]), float(d["t"]), float(d["floor"])
    return net, W


def quantise(W: np.ndarray):
    scale = float(np.abs(W).max() / 127) if np.abs(W).max() > 0 else 1.0
    return np.clip(np.round(W / scale), -127, 127).astype(np.int8), scale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("args", nargs="*")
    ap.add_argument("--buckets", default="2**18")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=0.1)
    ap.add_argument("--hidden", type=int, default=16)
    ap.add_argument("--recall", type=float, default=0.98)
    ap.add_argument("--int8", action="store_true", help="score with the int8 table, as the engine does")
    ap.add_argument("--drop", default="", help="input names to leave out, e.g. size,rate,hours")
    a = ap.parse_args()
    names = ["conj", "local", "sketch", "named", "rare", "used", "run", "whole", "hours", "size", "rate"]
    DROP[:] = [names.index(x) for x in a.drop.split(",") if x]
    if a.cmd == "conjlogs":
        model, logs = a.args
        _, W = load(model)
        train_conj_logs(W, logs, a.epochs, a.lr)
        np.savez(model, conj=W)
        return
    if a.cmd == "conj":
        a.m2, a.logs, a.out = a.args
        train_conj(a)
    elif a.cmd == "mlp":
        out, tr, va = a.args
        _, W = load(out)
        if a.int8:
            q, sc = quantise(W)
            W = q.astype(np.float64) * sc
        train = examples(tr, W)
        val = examples(va, W)
        print(f"mlp: {len(train)} train requests, {len(val)} validation", file=sys.stderr)
        net = Net(a.hidden)
        fit_mlp(net, train, a.epochs, 3e-3)
        fit_temperature(net, val)
        net.floor = fit_floor(net, val, a.recall)
        print(json.dumps({"temperature": net.t, **gate(net, val, net.floor)}))
        save(net, W, out)
    elif a.cmd == "eval":
        out, logs = a.args
        net, W = load(out)
        q, sc = quantise(W)
        data = examples(logs, q.astype(np.float64) * sc)
        print(json.dumps(gate(net, data, net.floor)))
    elif a.cmd == "export":
        out, binp = a.args
        net, W = load(out)
        q, sc = quantise(W)
        head = json.dumps(
            {
                "buckets": len(W),
                "conjScale": sc,
                "hidden": net.h,
                "mu": net.mu.tolist(),
                "sd": net.sd.tolist(),
                "w1": net.W1.ravel().tolist(),
                "b1": net.b1.tolist(),
                "w2": net.w2.tolist(),
                "b2": net.b2,
                "nullBias": net.nb,
                "nullW": net.nw.tolist(),
                "temperature": net.t,
                "floor": net.floor,
            }
        ).encode()
        with open(binp, "wb") as fh:
            fh.write(struct.pack("<II", 0x3152384D, len(head)))
            fh.write(head)
            fh.write(q.tobytes())
        print(f"wrote {binp}: {os.path.getsize(binp)} bytes", file=sys.stderr)
    else:
        raise SystemExit(f"unknown command {a.cmd}")


if __name__ == "__main__":
    main()
