"""E2(a) for one more blind alias file (e.g. the self-hostable gpt-oss-20b): fixed R1 gate and dev re-tuned, raw and df-capped.
Usage: python e2_extra.py fixture/aliases-gptoss20b.json gpt-oss-20b"""
import json, os, sys
os.environ.setdefault("CUES", "fixture/cues-all.json")
import e2
from e2_retune import scores, pk_from, tune

path, name = sys.argv[1], sys.argv[2]
al = {k: v for k, v in json.load(open(path)).items() if k in e2.IDX}
out = {}
for variant, a in [("raw", al), ("capped", e2.df_cap(al))]:
    bm = e2.build(a); S = scores(bm)
    for fir, p in e2.TUNED.items():
        r = e2.eval_sets(e2.run_all(bm, p["t"], p.get("rel", 0)))
        out[f"{variant}|fixed|{fir}"] = r
        print(f"{name} {variant} fixed {fir}: test r4 {r['test']['r4']:.3f} fir {r['test']['fir']:.3f} prec {r['test']['prec']:.2f} | nim {r['test_nim_pos']['r4']:.3f} neg {r['test_nim_neg']['fir']:.3f}", flush=True)
    for fir in (0.05, 0.0):
        u, t, rel, mdev = tune(S, fir)
        r = e2.eval_sets({q: pk_from(S, q, t, rel) for q in e2.C})
        out[f"{variant}|retuned|{fir}"] = dict(t=t, rel=rel, **r)
        print(f"{name} {variant} retuned {fir} (t={t:.2f}): test r4 {r['test']['r4']:.3f} fir {r['test']['fir']:.3f} prec {r['test']['prec']:.2f} | nim {r['test_nim_pos']['r4']:.3f} (policy {r['test_nim_policy']['r4']:.3f}) neg {r['test_nim_neg']['fir']:.3f} prec {r['test_nim_pos']['prec']:.2f}", flush=True)
print(name, "aliases", sum(map(len, al.values())))
json.dump(out, open(f"out/e2-extra-{name}.json", "w"), indent=1, default=float)
