"""M12: a binary pairnet (pairnet.py, without --float) as the engine's EP12 file (pool-pair.ts), with parity checks.

The encoders' ternary tables as two bit planes (+1, -1) per bucket, the batch norms folded into a per-bit
(scale, shift) on the integer gram count; each binary layer as sign bits with its per-row scale folded into the next
batch norm; the head in float32. Writes 64 parity cases (requests and items from M2 val as term lists) with
PyTorch's codes, scan scores and pair scores, which `packages/sim/lab/m12/pair-parity.ts` must reproduce.

  python3 -I export_pair.py RUN/model.pt OUT.ep12 --val sval.terms.jsonl --checks OUT.checks.json
"""
import argparse
import json
import os
import struct
import sys

import numpy as np
import torch

ap = argparse.ArgumentParser()
ap.add_argument("model")
ap.add_argument("out")
ap.add_argument("--val", required=True)
ap.add_argument("--checks", required=True)
ap.add_argument("--n", type=int, default=64)
a = ap.parse_args()

ck = torch.load(a.model, weights_only=False)
st, targs = ck["state"], ck["args"]
assert not targs["float"], "only binary networks are served"
B, NB, W = targs["bits"], targs["buckets"], targs["width"]
assert B % 32 == 0 and W % 32 == 0


def bn(prefix):
    g, b = st[f"{prefix}.weight"], st[f"{prefix}.bias"]
    m, v = st[f"{prefix}.running_mean"], st[f"{prefix}.running_var"]
    s = g / torch.sqrt(v + 1e-5)
    return s, b - m * s


def planes(w):
    """Ternary table (NB, B) -> (+1 plane, -1 plane) as uint32 words (NB, B/32), and its scale."""
    al = w.abs().mean()
    pos = (w > 0.7 * al).numpy()
    neg = (w < -0.7 * al).numpy()

    def pack(m):
        bits = m.reshape(m.shape[0], B // 32, 32).astype(np.uint64)
        return (bits << np.arange(32, dtype=np.uint64)).sum(-1).astype(np.uint32)
    return pack(pos), pack(neg), float(al)


def enc(prefix):
    p, n, al = planes(st[f"{prefix}.w"])
    s, t = bn(f"{prefix}.norm")
    return p, n, (al * s).numpy().astype(np.float32), t.numpy().astype(np.float32)


def lin(prefix):
    w = st[f"{prefix}.w"]  # (O, I)
    al = w.abs().mean(dim=1)
    s, t = bn(f"{prefix}.norm")
    sign = (w >= 0).numpy()
    I = w.shape[1]
    bits = sign.reshape(w.shape[0], I // 32, 32).astype(np.uint64)
    words = (bits << np.arange(32, dtype=np.uint64)).sum(-1).astype(np.uint32)
    return words, (al * s).numpy().astype(np.float32), t.numpy().astype(np.float32)


qp, qn, qs, qt = enc("qenc")
ip, inn, is_, ishift = enc("ienc")
l1w, l1s, l1t = lin("l1")
l2w, l2s, l2t = lin("l2")
hw = st["head.weight"].numpy().astype(np.float32).reshape(-1)
hb = st["head.bias"].numpy().astype(np.float32).reshape(-1)
dscale = float(st["dscale"])
parts = [qp, qn, qs, qt, ip, inn, is_, ishift, l1w, l1s, l1t, l2w, l2s, l2t, hw, hb]
cap = int(targs.get("item_cap") or 0)
head = b"EP12" + struct.pack("<IIIIIfI", 2, B, NB, W, 32, dscale, cap)
with open(a.out, "wb") as f:
    f.write(head)
    for x in parts:
        f.write(np.ascontiguousarray(x).tobytes())
size = len(head) + sum(x.nbytes for x in parts)
print(f"{a.out}: {size} bytes (bits {B}, buckets {NB}, width {W}, item cap {cap})")

# Parity cases from PyTorch itself.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D  # noqa: E402


def grams(terms, cap=400):
    import zlib
    out = set()
    for t in terms[:200]:
        out.add(zlib.crc32(b"w" + t.encode()) % NB)
        p = f"<{t}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                out.add(zlib.crc32(b"c" + p[k: k + n].encode()) % NB)
    for x, y in zip(terms, terms[1:200]):
        out.add(zlib.crc32(f"b{x} {y}".encode()) % NB)
    return sorted(out)[:cap] or [0]


def encode(words_p, words_n, scale, shift, g):
    """The served integer path: count per bit, then sign(count * scale + shift)."""
    c = np.zeros(B, np.int64)
    for k in g:
        for j in range(B // 32):
            pw, nw = int(words_p[k, j]), int(words_n[k, j])
            for b in range(32):
                c[j * 32 + b] += ((pw >> b) & 1) - ((nw >> b) & 1)
    return np.where(c * scale + shift >= 0, 1.0, -1.0)


def forward(qc, ic):
    x = np.concatenate([qc * ic, qc, ic])
    signs1 = np.array([[(int(l1w[o, j]) >> b) & 1 for j in range(l1w.shape[1]) for b in range(32)]
                       for o in range(W)]) * 2 - 1
    h = np.where((signs1 @ x) * l1s + l1t >= 0, 1.0, -1.0)
    signs2 = np.array([[(int(l2w[o, j]) >> b) & 1 for j in range(l2w.shape[1]) for b in range(32)]
                       for o in range(32)]) * 2 - 1
    h2 = np.where((signs2 @ h) * l2s + l2t >= 0, 1.0, -1.0)
    return float(hw @ h2 + hb[0])


cases = []
w = next(D.read_jsonl(a.val))
for r in [r for t in w["tasks"] for r in t["requests"]][: a.n // 2]:
    for item in w["items"][:2]:
        qterms = r["q"]
        iterms = item["title"] + (item["text"][:cap] if cap else item["text"])
        qc = encode(qp, qn, qs, qt, grams(qterms))
        icode = encode(ip, inn, is_, ishift, grams(iterms))
        cases.append({"q": qterms, "title": item["title"], "text": item["text"], "qcode": qc.astype(int).tolist(), "icode": icode.astype(int).tolist(),
                      "dot": float(qc @ icode) * dscale, "score": forward(qc, icode)})
json.dump({"cases": cases}, open(a.checks, "w"))
print(f"{len(cases)} parity cases → {a.checks}")
