"""M3 retriever: where each days request's planted item (hidden) or decoy (control) ranks in the push's pool, from
`days-calls.ts --pool-diag` rows that carry `pool` (M3, D900). Grouped by kind and by suite (the template family)."""
import json, sys
from collections import defaultdict

def load(path):
    return [json.loads(l) for l in open(path)]

def rank_of(r):
    pool = r.get("pool") or []
    p = r["task"] and r.get("planted")
    return r["rank"]

def table(rows, ks=(1, 5, 15, 50)):
    agg = defaultdict(lambda: defaultdict(int))
    for r in rows:
        suite = (r.get("template") or "?/").split("/")[0]
        for g in (r["kind"], f"{r['kind']} {suite}"):
            a = agg[g]; a["n"] += 1
            for k in ks:
                a[f"@{k}"] += 0 <= r["rank"] < k
            a["pushed"] += r["pushed"]; a["today"] += r["today"] and not r["pushed"]
            a["noRun"] += not r["pushRan"]
    return agg

if __name__ == "__main__":
    for path in sys.argv[1:]:
        print(path)
        for g, a in sorted(table(load(path)).items()):
            print(f"  {g:18s} n {a['n']:4d}  " + "  ".join(f"{k} {a[k]:4d}" for k in a if k != "n"))
