"""Compare several methods on one or more fixtures in one table (dev only unless --test).

Usage: python3 benchmarks/r10/exp.py --fixtures code,life --methods bm25ctx,bank,distill [--cap 0.05] [--cats]
           [--test] [--out FILE]
Method specs: a name from run.METHODS, or name:key=val,key=val passed as constructor arguments.
"""
import argparse, json, sys, os, time

sys.path.insert(0, os.path.dirname(__file__))
from common import load  # noqa: E402
import run  # noqa: E402

run.register("bank", run._m("methods_bank", "Bank"))
run.register("distill", run._m("methods_distill", "Distill"))
run.register("facet", run._m("methods_facet", "Facet"))


def gated(base_name, gamma=None, beta=None, **kw):
    def f(fx):
        from methods_gate import NeedGate, Gated
        return Gated(run.METHODS[base_name](fx), NeedGate(fx), gamma=gamma, beta=beta)
    return f


def build(spec, fx):
    name, _, args = spec.partition(":")
    kw = {}
    for kv in filter(None, args.split(",")):
        k, v = kv.split("=")
        try:
            kw[k] = float(v) if "." in v or v.isdigit() else {"True": True, "False": False}.get(v, v)
        except ValueError:
            kw[k] = v
    if name.startswith("gated-"):
        return gated(name[6:], **kw)(fx)
    mod = {"bank": ("methods_bank", "Bank"), "distill": ("methods_distill", "Distill"),
           "facet": ("methods_facet", "Facet"), "bm25": ("methods_lex", "BM25"), "bm25ctx": ("methods_lex", "BM25")}
    if name in ("bm25", "bm25ctx"):
        kw.setdefault("ctx", name == "bm25ctx")
    import importlib
    m, c = mod[name]
    return getattr(importlib.import_module(m), c)(fx, **kw)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", default="life")
    ap.add_argument("--methods", required=True)
    ap.add_argument("--caps", default="0.05")
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--cats", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()
    caps = tuple(float(x) for x in a.caps.split(","))
    allres = {}
    for fname in a.fixtures.split(","):
        fx = load(fname)
        for spec in a.methods.split(";"):
            t0 = time.time()
            m = build(spec, fx)
            res = run.evaluate(fx, m, caps=caps, test=a.test, note=f"exp.py {spec}")
            res["build_s"] = round(time.time() - t0, 1)
            allres[f"{fname}|{spec}"] = res
            print(f"== {fname} | {spec} (build+eval {res['build_s']}s)")
            run.show(res)
            if a.cats:
                for cap, row in res["caps"].items():
                    for split in [k for k in (row or {}) if k.endswith("_cat")]:
                        print(f"  cap {cap} {split}")
                        for cat, v in row[split].items():
                            print(f"    {cat:12s} n={v['n']:3d} r4={v['r4']} full={v['full']} prec={v['prec']} "
                                  f"fir={v['fir']} stale={v['stale']}")
            sys.stdout.flush()
    if a.out:
        json.dump(allres, open(a.out, "w"), indent=1)
