"""M11: export a trained CopyGen (copygen.py --save) to the engine's model file, with a numpy reference forward on the
quantised weights and 64 held-out parity checks (packages/engine/src/micro.test.ts reads them).

File layout (little-endian): b"EIM1", u32 header length, the JSON header (args, vocab, prior, arrays: name -> dtype,
shape, offset, scale per row or one), then each array's bytes 8-aligned. Float tables are int8 with a float32 scale
per row; a ternary table (ctx bin) is int8 {-1, 0, 1} with one scale; batch norms are folded to scale and shift.

  python3 -I packages/sim/lab/m11/export.py --model .local/m11/nets/X.pt --out packages/engine/models/intent-micro.bin \
      --checks packages/engine/src/fixtures/intent-micro-checks.json
"""
import argparse, json, os, struct, sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import copygen as C  # noqa: E402
import data as D  # noqa: E402


def q8_rows(w):
    w = w.astype(np.float32)
    s = np.abs(w).max(axis=1) / 127.0
    s[s == 0] = 1.0
    return np.clip(np.round(w / s[:, None]), -127, 127).astype(np.int8), s.astype(np.float32)


def deq(q, s):
    return q.astype(np.float32) * s[:, None]


def fold_bn(st, p):
    g, b, m, v = (st[f"{p}.{k}"].numpy() for k in ("weight", "bias", "running_mean", "running_var"))
    s = g / np.sqrt(v + 1e-5)
    return s.astype(np.float32), (b - m * s).astype(np.float32)


def build(ck):
    a, st = ck["args"], {k: v for k, v in ck["state"].items()}
    arrs, meta = {}, {}

    def put(name, arr, scale=None):
        arrs[name] = (arr, scale)

    if a["ctx"] == "bin":
        w = st["w"].numpy()
        sc = float(np.abs(w).mean())
        t = np.where(w > 0.7 * sc, 1, np.where(w < -0.7 * sc, -1, 0)).astype(np.int8)
        put("ctx_t", t, np.array([sc], dtype=np.float32))
        s0, h0 = fold_bn(st, "bn0")
        put("bn0_s", s0), put("bn0_h", h0)
        l1 = st["l1"].numpy()
        put("l1", np.sign(l1).astype(np.int8), np.abs(l1).mean(axis=1).astype(np.float32))
        s1, h1 = fold_bn(st, "bn1")
        put("bn1_s", s1), put("bn1_h", h1)
    else:
        q, s = q8_rows(st["ctx.weight"].numpy())
        put("ctx", q, s)
    if a["gen"] == "mlp":
        for n in ("gh", "go"):
            q, s = q8_rows(st[f"{n}.weight"].numpy())
            put(f"{n}_w", q, s), put(f"{n}_b", st[f"{n}.bias"].numpy().astype(np.float32))
    elif a["gen"] == "codes":
        q, s = q8_rows(st["pick.weight"].numpy())
        put("pick_w", q, s), put("pick_b", st["pick.bias"].numpy().astype(np.float32))
        q, s = q8_rows(st["book"].numpy())
        put("book", q, s)
    q, s = q8_rows(st["temb.weight"].numpy())
    put("temb", q, s)
    for n in ("ch", "co"):
        q, s = q8_rows(st[f"{n}.weight"].numpy())
        put(f"{n}_w", q, s), put(f"{n}_b", st[f"{n}.bias"].numpy().astype(np.float32))
    return a, arrs


class Ref:
    """The numpy forward on the quantised weights: what micro.ts computes, in float64."""

    def __init__(self, a, arrs, vocab, prior):
        self.a, self.vocab, self.prior = a, vocab, np.asarray(prior, dtype=np.float64)
        self.A = {k: (deq(v, s) if s is not None and v.dtype == np.int8 and v.ndim == 2 and len(s) == v.shape[0]
                      else v.astype(np.float64) * (s[0] if s is not None and v.dtype == np.int8 else 1.0))
                  for k, (v, s) in arrs.items()}
        self.A = {k: np.asarray(v, dtype=np.float64) for k, v in self.A.items()}

    def context(self, ids):
        A = self.A
        if self.a["ctx"] == "bin":
            x = A["ctx_t"][ids].sum(0)
            x = np.where(x * A["bn0_s"] + A["bn0_h"] >= 0, 1.0, -1.0)
            y = A["l1"] @ x
            return np.where(y * A["bn1_s"] + A["bn1_h"] >= 0, 1.0, -1.0)
        return A["ctx"][ids].mean(0) if len(ids) else np.zeros(A["ctx"].shape[1])

    def forward(self, title, text, terms, title_terms):
        A, a = self.A, self.a
        full = f"{title}\n{text}"
        c = self.context(D.grams(full, a["buckets"], cap=a["cap"]))
        cg = self.context(D.grams(C.delex(full), a["buckets"], cap=a["cap"])) if a["delex"] else c
        gen = None
        if a["gen"] == "mlp":
            gen = A["go_w"] @ np.maximum(A["gh_w"] @ cg + A["gh_b"], 0) + A["go_b"]
        elif a["gen"] == "codes":
            k = int(np.argmax(A["pick_w"] @ cg + A["pick_b"]))
            gen = A["book"][k]
        cps = []
        for t, sc in C.term_scalars(terms, title_terms):
            te = A["temb"][C.term_grams(t, a["tbuckets"])].sum(0)
            h = np.maximum(A["ch_w"] @ np.concatenate([te, c, sc]) + A["ch_b"], 0)
            cps.append((t, float((A["co_w"] @ h + A["co_b"])[0])))
        return gen, cps

    def expand(self, title, text, terms, title_terms):
        gen, cps = self.forward(title, text, terms, title_terms)
        sig = lambda z: 1 / (1 + np.exp(-z))
        copied = [(sig(z), t) for t, z in cps]
        pg = None if gen is None else torch.tensor(sig(gen))
        ns = argparse.Namespace(**self.a)
        return C.decode(copied, pg, set(terms), ns, self.vocab, torch.tensor(self.prior)), gen, cps


def write(path, a, arrs, vocab, prior):
    header = {"args": {k: a[k] for k in ("ctx", "gen", "buckets", "tbuckets", "cap", "delex", "kc", "kg", "theta_c",
                                          "theta_g", "lift")},
              "vocab": vocab, "prior": [float(x) for x in prior], "arrays": {}}
    blobs, off = [], 0
    for name, (v, s) in arrs.items():
        entry = {"dtype": str(v.dtype), "shape": list(v.shape), "offset": off}
        b = np.ascontiguousarray(v).tobytes()
        blobs.append(b)
        off += len(b)
        pad = (-off) % 8
        blobs.append(b"\0" * pad)
        off += pad
        if s is not None:
            entry["scale_offset"] = off
            entry["scale_len"] = len(s)
            sb = np.ascontiguousarray(s, dtype=np.float32).tobytes()
            blobs.append(sb)
            off += len(sb)
            pad = (-off) % 8
            blobs.append(b"\0" * pad)
            off += pad
        header["arrays"][name] = entry
    h = json.dumps(header).encode()
    hpad = (-(8 + len(h))) % 8
    h += b" " * hpad
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"EIM1" + struct.pack("<I", len(h)) + h + b"".join(blobs))
    return os.path.getsize(path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--checks", required=True)
    ap.add_argument("--n", type=int, default=64)
    x = ap.parse_args()
    ck = torch.load(x.model, weights_only=False)
    a, arrs = build(ck)
    vocab, prior = ck["vocab"], [float(p) for p in ck["prior"]]
    size = write(x.out, a, arrs, vocab, prior)
    ref = Ref(a, arrs, vocab, prior)
    items, _ = D.load()
    held = sorted((it for it in items.values() if it["split"] == "held"), key=lambda it: it["h"])[: x.n]
    checks = []
    for it in held:
        exp, gen, cps = ref.expand(it["title"], it["text"], it["terms"], it.get("titleTerms") or [])
        checks.append({"title": it["title"], "text": it["text"], "expansion": exp,
                       "copy": [[t, z] for t, z in cps[:8]], "gen": None if gen is None else [float(g) for g in gen[:8]]})
    json.dump(checks, open(x.checks, "w"))
    print(f"wrote {x.out} ({size / 1e6:.2f} MB), {len(checks)} checks -> {x.checks}")
