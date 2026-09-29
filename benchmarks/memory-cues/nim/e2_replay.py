"""E2(c): blind strong-model aliases as CANDIDATES + D21's silence replay as ACCEPTANCE (no >=2-miss requirement).
For each row, each blind alias is added greedily; it is kept only if replaying the dev cues + dev negatives gives <= 1 new
false fire (a negative starts firing, or the row enters a packet where it is not gold) and >= 1 new dev hit is NOT required.
Approximation for speed: only dev cues sharing a token with the alias are re-scored (other cues' packets cannot change except
through tiny idf / length-normalization shifts). The final accepted set is then scored exactly, at the fixed gate and re-tuned.
Usage: python e2_replay.py <aliases.json> <name>"""
import json, os, sys
import numpy as np
os.environ.setdefault("CUES", "fixture/cues-all.json")
import e2
from lexpy import toks
from e2_retune import scores, pk_from, tune

C, VIS, Q, LIVE = e2.C, e2.VIS, e2.Q, e2.LIVE
DEV = [q for q in C if C[q]["split"] == "dev"]


def run(path, name, fir):
    p = e2.TUNED[fir]; t, rel = p["t"], p.get("rel", 0)
    blind = json.load(open(path))
    acc = {}
    bm = e2.build(acc)
    base = {q: e2.packet(bm, q, t, rel) for q in DEV}
    qtok = {q: set(Q[q]) for q in DEV}
    kept = rej = 0; new_fires_total = 0
    for m in LIVE:
        g = m["id"]
        for a in blind.get(g, []):
            at = set(toks(a))
            if not at:
                continue
            trial = {k: list(v) for k, v in acc.items()}; trial.setdefault(g, []).append(a)
            bmt = e2.build(trial)
            fires = 0
            for q in DEV:
                if not (qtok[q] & at):
                    continue
                pk = e2.packet(bmt, q, t, rel)
                if not C[q]["gold"]:
                    fires += bool(pk) and not base[q]
                elif g in pk and g not in C[q]["gold"] and g not in base[q]:
                    fires += 1
                if fires > 1:
                    break
            if fires <= 1:
                acc = trial; kept += 1; new_fires_total += fires
                bm = bmt
                for q in DEV:
                    if qtok[q] & at:
                        base[q] = e2.packet(bm, q, t, rel)
            else:
                rej += 1
    res_fixed = e2.eval_sets(e2.run_all(e2.build(acc), t, rel))
    S = scores(e2.build(acc))
    out = {}
    for f2 in (0.05, 0.0):
        u, tt, rr, mdev = tune(S, f2)
        out[f2] = dict(t=tt, rel=rr, **e2.eval_sets({q: pk_from(S, q, tt, rr) for q in C}))
    json.dump(acc, open(f"out/e2-replay-aliases-{name}-{fir}.json", "w"))
    return dict(kept=kept, rejected=rej, new_fires_total=new_fires_total, fixed=res_fixed, retuned=out)


if __name__ == "__main__":
    path, name = sys.argv[1], sys.argv[2]
    R = {}
    for fir in ("0.05", "0.0"):
        r = run(path, name, fir); R[fir] = r
        f = lambda d: f"r4 {d['test']['r4']:.3f} fir {d['test']['fir']:.3f} prec {d['test']['prec']:.2f} | nim {d['test_nim_pos']['r4']:.3f} (policy {d['test_nim_policy']['r4']:.3f}) neg {d['test_nim_neg']['fir']:.3f} prec {d['test_nim_pos']['prec']:.2f}"
        print(f"{name} replay@{fir}: kept {r['kept']} rejected {r['rejected']} dev new fires {r['new_fires_total']}", flush=True)
        print("   fixed gate:", f(r["fixed"]), flush=True)
        for f2, d in r["retuned"].items():
            print(f"   re-tuned {f2} (t={d['t']:.2f}):", f(d), flush=True)
    json.dump(R, open(f"out/e2-replay-{name}.json", "w"), indent=1, default=float)
