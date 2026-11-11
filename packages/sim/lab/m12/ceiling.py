"""M12: the ceiling of candidate channels over the funnel's own pools (sim fit suites, $0).

For each hidden (control) task whose fact (decoy) is outside main's pool, is it among a channel's first K new items?
Channels: `wide` (pushWide's ranked rest and deeper lexical hits, from a pushWide pool dump), `exp` (a lowrank expansion
model's own search), `prf` (the pool head's rare terms). A perfect selector over a channel's candidates gains at most
this many."""
import argparse, json, os, sys
from collections import Counter
import numpy as np
import torch
import torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D

ap = argparse.ArgumentParser()
ap.add_argument("--terms", required=True)
ap.add_argument("--wide-pool", required=True)
ap.add_argument("--model", default="")
ap.add_argument("--k", default="5,10,30")
a = ap.parse_args()
Ks = [int(x) for x in a.k.split(",")]
rows = {}
for p in D.read_jsonl(a.wide_pool):
    rows[(p["suite"], p["seed"], p["variant"], p["template"])] = p
exp = None
if a.model:
    ck = torch.load(a.model, weights_only=False)
    st, iv, rv = ck["state"], ck["iv"], ck["rv"]
    IV = D.Vocab(iv)
    rid = {t: i for i, t in enumerate(rv)}
    with torch.no_grad():
        per = F.relu(st["u.weight"] @ st["v"].T + st["b"]) * F.softplus(st["g.weight"])
        vals, idx = per.topk(16, 1)

    def exp(q):
        out = {}
        for t in dict.fromkeys(q):
            if t in rid:
                for j, v in zip(idx[rid[t]].tolist(), vals[rid[t]].tolist()):
                    if v > 0:
                        out[j] = out.get(j, 0) + v
        return out
res = Counter()
for w in D.load_fit(a.terms):
    var = w["key"][2]
    if var not in ("hidden", "control"):
        continue
    items = w["items"]
    ids = [it["id"] for it in items]
    X = None
    if exp:
        X, _ = D.bm25_matrix(items, IV)
    for t in w["tasks"]:
        r = rows.get(w["key"] + (t["template"],))
        if not r:
            continue
        pool = [x["id"] for x in r["pool"]]
        v = var[0]
        res[v] += 1
        if t["planted"] in pool:
            res[v + "_in"] += 1
            continue
        if not pool:
            res[v + "_nopush"] += 1
            continue
        chans = {"wide": [x["id"] for x in r.get("wide", [])]}
        if exp:
            ev = np.zeros(len(IV), np.float32)
            for j, val in exp(t["q"]).items():
                ev[j] = val
            sc = X @ ev
            chans["exp"] = [ids[i] for i in np.argsort(-sc) if sc[i] > 0 and ids[i] not in pool][:60]
        union = {}
        for K in Ks:
            got = set()
            for name, lst in chans.items():
                hit = t["planted"] in lst[:K]
                res[f"{v}_{name}@{K}"] += hit
                got |= set(lst[:K])
            res[f"{v}_union@{K}"] += t["planted"] in got
for v in ("h", "c"):
    print(v, {k[2:]: n for k, n in sorted(res.items()) if k.startswith(v + "_")}, "of", res[v])
