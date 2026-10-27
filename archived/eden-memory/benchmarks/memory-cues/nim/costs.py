"""Cost summary from out/calls.jsonl: live requests per (experiment tag, model): ok / failed attempts, tokens, latency p50/p95."""
import json, collections
import numpy as np

L = [json.loads(l) for l in open("out/calls.jsonl")]
g = collections.defaultdict(list)
for l in L:
    tag = l["tag"].split("-")[0] + ("-" + l["tag"].split("-")[1] if l["tag"].startswith(("e1-", "e2-", "e3-", "e4-", "e5-")) else "")
    g[(tag, l["model"])].append(l)
rows = []
tot = collections.Counter()
for (tag, model), ls in sorted(g.items()):
    ok = [l for l in ls if l["ok"]]
    lat = [l["latency_s"] for l in ok]
    pt = sum((l.get("usage") or {}).get("prompt_tokens", 0) or 0 for l in ok)
    ct = sum((l.get("usage") or {}).get("completion_tokens", 0) or 0 for l in ok)
    fails = collections.Counter(("429" if "429" in l.get("err", "") else "5xx" if "HTTP 5" in l.get("err", "") else "net") for l in ls if not l["ok"])
    rows.append(dict(tag=tag, model=model, ok=len(ok), failed=sum(fails.values()), fails=dict(fails), prompt_tokens=pt, completion_tokens=ct,
                     lat_p50=float(np.percentile(lat, 50)) if lat else None, lat_p95=float(np.percentile(lat, 95)) if lat else None))
    tot["ok"] += len(ok); tot["failed"] += sum(fails.values()); tot["pt"] += pt; tot["ct"] += ct
print("tag | model | ok | failed attempts (429/5xx/net) | prompt tok | completion tok | latency p50 | p95")
for r in rows:
    print(f"{r['tag']} | {r['model']} | {r['ok']} | {r['failed']} {r['fails']} | {r['prompt_tokens']:,} | {r['completion_tokens']:,} | {r['lat_p50']:.2f}s | {r['lat_p95']:.2f}s" if r["lat_p50"] is not None else f"{r['tag']} | {r['model']} | 0 | {r['failed']}")
print("TOTAL", dict(tot))
json.dump(dict(rows=rows, total=dict(tot)), open("out/costs.json", "w"), indent=1)
