"""M3 (D907): export a trained binnet `supersede` or `tags` network (binnet.py --save) to flat files a TypeScript
forward reads (m3r/twin-forward.ts), with PyTorch's own scores on a few held-out inputs for an exactness check.

Binary nets: the encoder table as int8 {-1, 0, +1} with one scale (TWN), each binary layer as int8 signs with a
per-row scale, batch norms folded to (scale, shift) per unit. Float nets: the same layout in float32.

  .venv-m3/bin/python -I packages/sim/lab/m3r/export_net.py --model NET.pt --eval worlds-val.jsonl --out DIR
"""
import argparse, json, os, sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import binnet as B  # noqa: E402


def bn(state, prefix):
    g, b = state[f"{prefix}.weight"], state[f"{prefix}.bias"]
    m, v = state[f"{prefix}.running_mean"], state[f"{prefix}.running_var"]
    s = g / torch.sqrt(v + 1e-5)
    return s.numpy().astype(np.float32), (b - m * s).numpy().astype(np.float32)


def enc_table(w, real):
    if real:
        return w.numpy().astype(np.float32), 1.0
    a = w.abs().mean()
    q = torch.where(w > 0.7 * a, 1, torch.where(w < -0.7 * a, -1, 0)).to(torch.int8)
    return q.numpy(), float(a)


def lin(w, real):
    if real:
        return w.numpy().astype(np.float32), np.ones(w.shape[0], dtype=np.float32)
    a = w.abs().mean(dim=1)
    return torch.sign(w).to(torch.int8).numpy(), a.numpy().astype(np.float32)


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--model", required=True)
    a.add_argument("--eval", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--n", type=int, default=64)
    o = a.parse_args()
    ck = torch.load(o.model, map_location="cpu", weights_only=False)
    st, real, arch, bits = ck["state"], ck["float"], ck["arch"], ck["bits"]
    os.makedirs(o.out, exist_ok=True)
    enc_prefix = "enc"
    T, alpha = enc_table(st[f"{enc_prefix}.w"], real)
    s0, h0 = bn(st, f"{enc_prefix}.norm")
    W1, a1 = lin(st["l1.w"], real)
    s1, h1 = bn(st, "l1.norm")
    head_w = st["head.weight"].numpy().astype(np.float32)
    head_b = st["head.bias"].numpy().astype(np.float32)
    arrays = {"enc": T, "enc_scale": np.array([alpha], dtype=np.float32), "enc_bn_s": s0, "enc_bn_h": h0,
              "l1": W1, "l1_scale": a1, "l1_bn_s": s1, "l1_bn_h": h1, "head_w": head_w, "head_b": head_b}
    meta = {"arch": arch, "float": real, "bits": bits, "buckets": B.BUCKETS, "tags": B.TAGS if arch == "tags" else None,
            "arrays": {}}
    for name, arr in arrays.items():
        arr.tofile(os.path.join(o.out, f"{name}.bin"))
        meta["arrays"][name] = {"dtype": str(arr.dtype), "shape": list(arr.shape)}
    # PyTorch's scores on held-out inputs, for the TypeScript forward's exactness check.
    q = B.Q(real)
    if arch == "supersede":
        net = B.PairTag(q, bits)
        net.load_state_dict(st)
        net.eval()
        _, pairs = B.m2_items(o.eval)
        pairs = pairs[: o.n]
        with torch.no_grad():
            p = net([x[0] for x in pairs], [x[1] for x in pairs]).tolist()
        checks = [{"a": x[0], "b": x[1], "logit": round(v, 5), "label": x[2]} for x, v in zip(pairs, p)]
    else:
        net = B.Intent(q, bits, len(B.TAGS))
        net.load_state_dict(st)
        net.eval()
        items, _ = B.m2_items(o.eval)
        items = items[: o.n]
        with torch.no_grad():
            lg = net([x[0] for x in items]).tolist()
        checks = [{"text": x[0], "logits": [round(v, 5) for v in row], "tag": x[1]} for x, row in zip(items, lg)]
    meta["checks"] = checks
    json.dump(meta, open(os.path.join(o.out, "meta.json"), "w"))
    size = sum(os.path.getsize(os.path.join(o.out, f"{n}.bin")) for n in arrays)
    print(json.dumps({"out": o.out, "arch": arch, "float": real, "bytes": size, "checks": len(checks)}))
