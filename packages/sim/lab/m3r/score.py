"""M3 retriever (D900): recall of the planted item (hidden) and the decoy (control) at 5 and 15, for Eden's lexical
pool, a model's own ranking, and their hybrid (the lexical pool fused with the model's top k by reciprocal rank,
c 60, ties to the lexical order; the first 15 kept), on the eval file's days and short requests, split into the
templates the model trained on and the held-out families.

  python3 -I score.py EVAL.jsonl.gz RUN_DIR [RUN_DIR...] --heldout train5,train6 [--ks 5,10,15]
"""
import argparse, gzip, json, os
from collections import defaultdict

def load_eval(path):
    reqs = {}
    with gzip.open(path, "rt") as f:
        for line in f:
            w = json.loads(line)
            for r in w["requests"]:
                reqs[r["rid"]] = r
    return reqs

def load_ranks(run):
    return {r["rid"]: r["top"] for r in map(json.loads, open(os.path.join(run, "ranks.jsonl")))}

def rrf(lists, cut=15, c=60):
    score, first = defaultdict(float), {}
    for li, l in enumerate(lists):
        for i, x in enumerate(l):
            score[x] += 1.0 / (c + i + 1)
            first.setdefault(x, (li, i))
    return sorted(score, key=lambda x: (-score[x], first[x]))[:cut]

def hit(lst, x, k):
    return x in lst[:k]

def table(reqs, ranks, heldout, ks):
    agg = defaultdict(lambda: defaultdict(int))
    for rid, r in reqs.items():
        top = ranks.get(rid)
        if top is None:
            continue
        horizon = rid.split("/")[0]
        fold = "held" if r["template"].split("/")[0] in heldout else "train"
        g = agg[(horizon, fold, r["kind"])]
        g["n"] += 1
        lex, x = r["pool15"], r["planted"]
        g["lex@5"] += hit(lex, x, 5); g["lex@15"] += hit(lex, x, 15)
        g["lex50@15+"] += hit(r["pool50"], x, 50)
        g["mod@5"] += hit(top, x, 5); g["mod@15"] += hit(top, x, 15); g["mod@50"] += hit(top, x, 50)
        for k in ks:
            h = rrf([lex, top[:k]])
            g[f"hyb{k}@5"] += hit(h, x, 5); g[f"hyb{k}@15"] += hit(h, x, 15)
    return agg

def show(agg, label):
    print(label)
    for key in sorted(agg):
        g = agg[key]
        n = g["n"]
        cells = "  ".join(f"{k} {v:4d}" for k, v in g.items() if k != "n")
        print(f"  {'/'.join(key):22s} n {n:4d}  {cells}")

def bar(agg, run, horizon="days", at5=False):
    """The pre-registered bar (m3-retriever.md §1) on the held-out days requests, one line a variant."""
    h, c = agg.get((horizon, "held", "hidden")), agg.get((horizon, "held", "control"))
    if not h or not c:
        return
    h0, c0 = h["lex@15"], c["lex@15"]
    for v in ["mod"] + [k[:-3] for k in h if k.startswith("hyb") and k.endswith("@15")]:
        h1, c1 = h[f"{v}@15"], c[f"{v}@15"]
        pts = 100 * (h1 - h0) / h["n"]
        ok = pts >= 15 and c1 / max(1, c0) <= h1 / max(1, h0)
        if at5:
            # §1b's second bar: recall@5 at least +10 points over the shipped default's pool, decoys at @5 no faster.
            f0, f1, d0, d1 = h["lex@5"], h[f"{v}@5"], c["lex@5"], c[f"{v}@5"]
            p5 = 100 * (f1 - f0) / h["n"]
            ok5 = p5 >= 10 and d1 / max(1, d0) <= f1 / max(1, f0)
            print(f"  BAR5 {run.rstrip('/').split('/')[-1]:13s} {v:6s} facts@5 {f0}->{f1} ({p5:+.1f} pts)  "
                  f"decoys@5 {d0}->{d1}  ratio {f1 / f0:.3f} vs {d1 / d0:.3f}  {'PASS' if ok5 else 'fail'}")
            continue
        print(f"  BAR {run.rstrip('/').split('/')[-1]:14s} {v:6s} facts@15 {h0}->{h1} ({pts:+.1f} pts)  "
              f"decoys@15 {c0}->{c1}  ratio {h1 / h0:.3f} vs {c1 / c0:.3f}  @5 {h['lex@5']}->{h[f'{v}@5']}  "
              f"{'PASS' if ok else 'fail'}")

if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("eval")
    a.add_argument("runs", nargs="+")
    a.add_argument("--heldout", default="train5,train6")
    a.add_argument("--ks", default="5,10,15")
    a.add_argument("--brief", action="store_true")
    a.add_argument("--at5", action="store_true", help="§1b's @5 bar (the eval's pool15 is the shipped default's)")
    o = a.parse_args()
    reqs = load_eval(o.eval)
    for run in o.runs:
        agg = table(reqs, load_ranks(run), set(o.heldout.split(",")), [int(k) for k in o.ks.split(",")])
        if not o.brief:
            show(agg, run)
        bar(agg, run, at5=o.at5)
