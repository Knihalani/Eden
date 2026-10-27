"""E2(a)(ii): blind-alias BM25F_ctx re-tuned on dev exactly like R1 M3 (eval.py: tau over 60 quantiles of dev top-1,
rho in {0, .5, .7}; maximize r@4 + 0.1*precision s.t. dev FIR <= target), then scored once on test and test_nim."""
import json, os, itertools
import numpy as np
os.environ.setdefault("CUES", "fixture/cues-all.json")
import e2

C, VIS, Q, LIVE = e2.C, e2.VIS, e2.Q, e2.LIVE
DEV = [q for q in C if C[q]["split"] == "dev"]


def scores(bm):
    return {q: np.array([bm.score(Q[q], i) for i in VIS[q]]) for q in C}


def pk_from(S, q, t, rel):
    s = S[q]; keep = s >= t
    if keep.any() and rel:
        keep &= s >= s[keep].max() * rel
    order = [j for j in np.argsort(-s, kind="stable") if keep[j]]
    return [LIVE[VIS[q][j]]["id"] for j in order[:e2.KMAX]]


def tune(S, fir_max):
    tops = [S[q].max() for q in DEV]
    grid = list(np.unique(np.quantile(tops, np.linspace(0.02, 0.99, 60)))) + [float("inf")]
    best = None
    for t, rel in itertools.product(grid, [0.0, 0.5, 0.7]):
        pk = {q: pk_from(S, q, t, rel) for q in DEV}
        m = e2.metrics(pk, DEV)
        if m["fir"] > fir_max:
            continue
        u = m["r4"] + 0.1 * (m["prec"] or 0)
        if best is None or u > best[0] + 1e-12:
            best = (u, t, rel, m)
    return best


if __name__ == "__main__":
    out = {}
    sets = [("none (BM25F_ctx)", None), ("phi35(R1)|raw", "out/e2-aliases-phi35-raw.json"), ("phi35(R1)|capped", "out/e2-aliases-phi35-capped.json"),
            ("gemma-4-31b|raw", "out/e2-aliases-gemma-4-31b-raw.json"), ("gemma-4-31b|capped", "out/e2-aliases-gemma-4-31b-capped.json"),
            ("nemotron-3-super|raw", "out/e2-aliases-nemotron-3-super-raw.json"), ("nemotron-3-super|capped", "out/e2-aliases-nemotron-3-super-capped.json")]
    for name, path in sets:
        bm = e2.build(json.load(open(path)) if path else {})
        S = scores(bm)
        for fir in (0.05, 0.0):
            u, t, rel, mdev = tune(S, fir)
            pk = {q: pk_from(S, q, t, rel) for q in C}
            res = e2.eval_sets(pk)
            out[f"{name}|{fir}"] = dict(t=t, rel=rel, **res)
            print(f"{name} fir<={fir} t={t:.2f} rel={rel} dev r4={mdev['r4']:.3f} fir={mdev['fir']:.3f} | test r4={res['test']['r4']:.3f} fir={res['test']['fir']:.3f} prec={res['test']['prec']:.2f} | nim r4={res['test_nim_pos']['r4']:.3f} (policy {res['test_nim_policy']['r4']:.3f}) nim-neg fir={res['test_nim_neg']['fir']:.3f} prec={res['test_nim_pos']['prec']:.2f}", flush=True)
    json.dump(out, open("out/e2-retune.json", "w"), indent=1, default=float)
