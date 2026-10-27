"""E5 (optional): nvidia/nemotron-3-embed-1b as a dense arm, vs bge-small, on the R1 fixture + test_nim.
Hosted, so sleep-only by construction (hot-path use excluded). Threshold calibrated on dev exactly as R1 calibrated bge
(eval.py single(..., MAR)), then scored on test and test_nim. Env as eval_nim.py. -> out/e5-results.json"""
import json, os, sys
import numpy as np
from nim import embed

MODEL = "nvidia/nemotron-3-embed-1b"


def emb_all(texts, input_type, bs=32):
    out = []
    for i in range(0, len(texts), bs):
        v, _ = embed(MODEL, texts[i:i + bs], input_type=input_type, tag="e5-embed")
        out += v
    a = np.array(out, dtype=np.float32)
    return a / np.linalg.norm(a, axis=1, keepdims=True)


if __name__ == "__main__":
    sys.argv = ["eval.py", os.environ.get("FIR", "0.05"), "x", "y"]
    import eval as E
    mems = [m for m in json.load(open("fixture/memories.json")) if not m["superseded_by"]]
    ids = [m["id"] for m in mems]
    D = emb_all([f"{m['subject']}: {m['text']}" for m in mems], "passage")
    ctx = json.load(open(f"out/ctx{E.SFX}.json"))
    qids = list(E.C)
    for sfx, texts in [("", [E.C[q]["c"]["cue"] for q in qids]), ("_ctx", [ctx[q] for q in qids])]:
        Qv = emb_all(texts, "query")
        S = Qv @ D.T
        for qi, q in enumerate(qids):
            E.C[q]["f"]["cos_nemo" + sfx] = np.array([S[qi][ids.index(d)] for d in E.C[q]["docs"]])
    json.dump({q: {k: E.C[q]["f"][k].tolist() for k in ("cos_nemo", "cos_nemo_ctx")} for q in qids}, open("out/e5-feats.json", "w"))
    from eval_nim import stats  # reuse metrics on test_nim
    res = {}
    for fir in (0.05, 0.0):
        E.FIR_MAX = fir
        for name, feat in [("M5 bge-small", "cos_bge"), ("E5 nemotron-embed-1b", "cos_nemo"), ("M6 BM25F|bge union RRF", "hyb_bge"), ("E5 BM25F|nemo-embed union RRF", "hyb_nemo")]:
            for sfx in ("", "_ctx"):
                if feat.startswith("hyb"):
                    d = "cos_" + feat[4:] + sfx
                    m = dict(rank=lambda f, d=d, sfx=sfx: E.rrf(f["bm25" + sfx], f[d]), gates=[("bm25" + sfx, "t"), (d, "td")], extra={})
                else:
                    m = E.single(feat + sfx, E.MAR)
                best = E.calibrate(m)
                if best is None:
                    res[f"{name}{sfx}|{fir}"] = None; continue
                u, p, sdev = best
                pk = {q: E.packet(E.C[q], m, p) for q in E.C}
                T = [q for q in E.C if E.C[q]["c"]["split"] == "test"]; N = [q for q in E.C if E.C[q]["c"]["split"] == "test_nim"]
                r = dict(params=p, dev=sdev, test=stats(T, pk), nim_pos=stats([q for q in N if E.C[q]["gold"]], pk),
                         nim_para=stats([q for q in N if E.C[q]["c"]["cat"] == "nim-para"], pk), nim_policy=stats([q for q in N if E.C[q]["c"]["cat"] == "nim-policy"], pk),
                         nim_neg=stats([q for q in N if not E.C[q]["gold"]], pk))
                res[f"{name}{sfx}|{fir}"] = r
                print(f"{name}{sfx} fir<={fir}: p={ {k: round(float(v), 3) for k, v in p.items()} } test r4={r['test']['r4']:.3f} fir={r['test']['fir']:.3f} prec={r['test']['prec']:.2f} | nim-para r4={r['nim_para']['r4']:.3f} nim-policy={r['nim_policy']['r4']:.3f} nim-neg fir={r['nim_neg']['fir']:.3f}", flush=True)
    json.dump(res, open("out/e5-results.json", "w"), indent=1, default=float)
