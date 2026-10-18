"""Run one R10 method on one fixture: tune on dev at each FIR cap, score dev (and test with --test, logged as a look).

Usage (repo root):
  python3 benchmarks/r10/run.py --fixture life --method bm25ctx [--test] [--out FILE]

Methods are registered in METHODS below; each is `name -> lambda fx: object with .scores(cue)`.
"""
import argparse, importlib, json, os, sys

sys.path.insert(0, os.path.dirname(__file__))
from common import load, tune, gate, metrics, by_cat, log_look, timed  # noqa: E402


def _m(mod, cls, **kw):
    return lambda fx: getattr(importlib.import_module(mod), cls)(fx, **kw)


METHODS = {
    "bm25": _m("methods_lex", "BM25", ctx=False),
    "bm25ctx": _m("methods_lex", "BM25", ctx=True),
}


def register(name, factory):
    METHODS[name] = factory


def evaluate(fx, method, caps=(0.05, 0.0), test=False, dev_split="dev", test_splits=None, note=""):
    dev = fx.split(dev_split)
    res = {"fixture": fx.name, "caps": {}}
    for cap in caps:
        best = tune(fx, method.scores, dev, fir_cap=cap)
        if best is None:
            res["caps"][str(cap)] = None
            continue
        _, th, rel, _ = best
        row = {"theta": th, "rel": rel}
        sets = {"dev": dev}
        if test:
            for s in test_splits or (["test"] if fx.name == "life" else ["test", "test_nim"]):
                sets[s] = fx.split(s)
        for name, cues in sets.items():
            pk, lat = timed(lambda c: gate(method.scores(c), th, rel), cues)
            row[name] = metrics(fx, pk, cues)
            row[name]["lat"] = lat
            row[name + "_cat"] = by_cat(fx, pk, cues)
        res["caps"][str(cap)] = row
    if test:
        log_look(fx.name, "+".join(test_splits or ["test"]), note or "run.py --test")
    return res


def show(res):
    for cap, row in res["caps"].items():
        if not row:
            print(f"  cap {cap}: no feasible point")
            continue
        print(f"  cap {cap}: theta={row['theta']:.3f} rel={row['rel']}")
        for k, v in row.items():
            if isinstance(v, dict) and "r4" in v:
                print(f"    {k:9s} r4={v['r4']} full={v['full']} prec={v['prec']} fir={v['fir']} stale={v['stale']} "
                      f"bullets={v['bullets']} p50={v['lat']['p50_ms']}ms")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default="life")
    ap.add_argument("--method", required=True)
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--cats", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()
    fx = load(a.fixture)
    m = METHODS[a.method](fx)
    res = evaluate(fx, m, test=a.test, note=f"run.py {a.method}")
    print(a.fixture, a.method)
    show(res)
    if a.cats:
        for cap, row in res["caps"].items():
            if row:
                for split in [k for k in row if k.endswith("_cat")]:
                    print(f"  cap {cap} {split}")
                    for cat, v in row[split].items():
                        print(f"    {cat:12s} n={v['n']} r4={v['r4']} prec={v['prec']} fir={v['fir']} stale={v['stale']}")
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)
