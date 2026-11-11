"""M3 retriever: recall of the push's lexical pool from a funnel `--pool-dump` (last pass a task), by variant and suite.
recall@k = planted (hidden) or decoy (control) item at pool rank < k; handed = in the candidates handed."""
import json, sys
from collections import defaultdict

def last_pass(path):
    rows = {}
    for line in open(path):
        r = json.loads(line)
        rows[(r["suite"], r["seed"], r["variant"], r["template"])] = r  # later pass replaces the first
    return rows

def stat(rows, ks=(5, 15, 50)):
    agg = defaultdict(lambda: defaultdict(int))
    for (suite, seed, var, tpl), r in rows.items():
        ids = [x["id"] for x in r["pool"]]
        rank = ids.index(r["planted"]) if r["planted"] in ids else -1
        for g in (var, f"{var} {suite}"):
            a = agg[g]; a["n"] += 1
            for k in ks:
                a[f"@{k}"] += 0 <= rank < k
            a["handed"] += any(x["id"] == r["planted"] and x["handed"] for x in r["pool"])
    return agg

if __name__ == "__main__":
    rows = last_pass(sys.argv[1])
    for g, a in sorted(stat(rows).items()):
        print(f"{g:22s} n {a['n']:4d}  " + "  ".join(f"{k} {a[k]:4d}" for k in a if k != "n"))
