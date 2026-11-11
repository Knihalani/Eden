"""M3 retriever (D900): the eval set, joined from $0 dumps (simulated worlds only).

  days:  `days-calls.ts --corpus-dump C --pool-diag P15` and the same with --set '{"askReaderPool":50}' (P50)
  short: `bun run funnel ... -- --corpus-dump C --pool-dump P` (one request a world, train1-6)

Writes one JSON line a world: {key, items: [{id, text}], requests: [{rid, request, planted, kind, template, pool15,
pool50}]}. Item text is "title\\ntext" as the cache holds it (redacted, 1,200 chars).

  python3 -I prep.py --days C P15 P50 --short C P --out eval.jsonl
"""
import argparse, json

def text(it):
    return f"{it['title']}\n{it['text']}"

def days(corpus, p15, p50):
    pools50 = {}
    for l in open(p50):
        r = json.loads(l)
        pools50[(r["seed"], r["task"])] = r["pool"]
    reqs = {}
    for l in open(p15):
        r = json.loads(l)
        reqs.setdefault(r["seed"], []).append({
            "rid": f"days/{r['task']}", "request": r["request"], "planted": r["planted"], "kind": r["kind"],
            "template": r["template"], "pool15": r["pool"], "pool50": pools50.get((r["seed"], r["task"]), r["pool"]),
        })
    for l in open(corpus):
        w = json.loads(l)
        yield {"key": f"days/w{w['seed']}", "items": [{"id": i["id"], "text": text(i)} for i in w["items"]],
               "requests": reqs.get(w["seed"], [])}

def short(corpus, pool):
    pools = {}
    for l in open(pool):
        r = json.loads(l)
        pools[(r["suite"], r["seed"], r["variant"], r["template"])] = [x["id"] for x in r["pool"]]
    for l in open(corpus):
        w = json.loads(l)
        k = (w["suite"], w["seed"], w["variant"])
        rq = []
        for t in w["tasks"]:
            p = pools.get(k + (t["template"],), [])
            rq.append({"rid": f"short/{w['suite']}/{w['seed']}/{w['variant']}/{t['template']}", "request": t["request"],
                       "planted": t["planted"], "kind": w["variant"], "template": f"{w['suite']}/{t['template']}",
                       "pool15": p, "pool50": p})
        yield {"key": f"short/{w['suite']}/{w['seed']}/{w['variant']}",
               "items": [{"id": i["id"], "text": text(i)} for i in w["items"]], "requests": rq}

if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--days", nargs=3)
    a.add_argument("--short", nargs=2)
    a.add_argument("--out", required=True)
    o = a.parse_args()
    n = 0
    with open(o.out, "w") as f:
        for w in (list(days(*o.days)) if o.days else []) + (list(short(*o.short)) if o.short else []):
            if any(not r["template"].startswith("train") for r in w["requests"]):
                raise SystemExit("train suites only")
            f.write(json.dumps(w) + "\n"); n += 1
    print(f"{n} worlds -> {o.out}")
