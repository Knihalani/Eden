import json, sys, collections

# Join the engine's prototype dump (EDEN_CS_DUMP) to funnel tasks: per task the planted item's card and intent match.
S = sys.argv[1]
run = sys.argv[2] if len(sys.argv) > 2 else "dumprun.json"
d = json.load(open(f"{S}/{run}"))
req = {}
for l in open(f"{S}/corpus.jsonl"):
    w = json.loads(l)
    for t in w["tasks"]:
        req[(w["suite"], w["seed"], w["variant"], t["template"])] = (t["request"], t["planted"])
rows = [r for r in d["perTask"] if r.get("pushPoolAt") is not None]
lines = [json.loads(l) for l in open(f"{S}/csdump.jsonl")]
L = collections.defaultdict(list)
for l in lines:
    L[(l["scope"], l["req"])].append(l)
out = []
for r in rows:
    k = (r["suite"], r["seed"], r["variant"], r["template"])
    ls = L[("w%d" % r["seed"], req[k][0])]
    l = ls[0 if k[2] == "hidden" else 1]
    items = {i["id"]: i for i in l["items"]}
    out.append(
        dict(
            k=k,
            req=req[k][0],
            planted=req[k][1],
            acts=l["acts"],
            pool=r["pushPoolAt"],
            surf=bool(r["delivered"] or r.get("askCited")),
            p=items.get(req[k][1]),
            items=l["items"],
        )
    )
json.dump(out, open(f"{S}/joined.json", "w"))
print(len(out))
