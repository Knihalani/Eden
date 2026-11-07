# CL8 (docs/research/cl-cl8.md): the agent's billed cost per arm and kind split by Anthropic token class, from pi-ab
# timelines (STEM.tl/tasks.jsonl): cache reads (0.1x input), cache writes (1.25x), plain input, output; per task, and
# the first request's cache read and write (the prefix the next task can reuse).
# Haiku 5.5 prices: $0.1/M in, $0.5/M out.
# `--prefix P` adds a counterfactual column, labelled so: an Eden arm's first request that read nothing from the cache
# reads its first P tokens instead of writing them (P = the arm's stable prefix, tools + system prompt, which on Pi's
# minimal Eden agent is too short for Anthropic to cache; any agent with a longer prompt caches it).
# usage: python3 -I cache.py [--prefix P] STEM [STEM ...]   (a STEM ending in .jsonl is read as the tasks file itself:
# hermes-ab writes it to <out>.timeline/tasks.jsonl, A27)
import json, sys, collections

args = sys.argv[1:]
PREFIX = 0
if "--prefix" in args:
    i = args.index("--prefix")
    PREFIX = int(args[i + 1])
    del args[i : i + 2]

IN, OUT = 0.1e-6, 0.5e-6
agg = collections.defaultdict(collections.Counter)
for stem in args:
    for line in open(stem if stem.endswith(".jsonl") else stem + ".tl/tasks.jsonl"):
        d = json.loads(line)
        if not d["requests"] or d.get("kind") is None:
            continue
        a = agg[(d["condition"], d["kind"])]
        a["n"] += 1
        for i, r in enumerate(d["requests"]):
            cr, cw = r.get("cached") or 0, r.get("cacheWrite") or 0
            a["req"] += 1
            a["read"] += cr
            a["write"] += cw
            a["plain"] += r["in"] - cr - cw
            a["out"] += r["out"]
            if i == 0:
                a["read0"] += cr
                a["write0"] += cw
                a["hit0"] += cr > 0
                if PREFIX and d["condition"] != "tools" and cr == 0:
                    a["moved"] += min(PREFIX, cw)
cf = " | cf total" if PREFIX else ""
HEAD = "arm         kind     n    req   read  write  plain   out | $/1k read write plain  out  total | 1st req read write hit%"
print(HEAD + cf)
MIX = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
mix = collections.defaultdict(lambda: [0.0, 0.0])
for (arm, kind), a in sorted(agg.items()):
    n = a["n"]
    usd = [a["read"] * IN * 0.1, a["write"] * IN * 1.25, a["plain"] * IN, a["out"] * OUT]
    print(
        f"{arm:11s} {kind:8s} {n:4d} {a['req']/n:5.2f} {a['read']/n:6.0f} {a['write']/n:6.0f} {a['plain']/n:6.0f} "
        f"{a['out']/n:5.0f} | " + " ".join(f"{u/n*1000:.3f}" for u in usd) + f" {sum(usd)/n*1000:.3f} | "
        f"{a['read0']/n:6.0f} {a['write0']/n:5.0f} {100*a['hit0']/n:4.0f}"
        + (f" | {(sum(usd) - a['moved'] * IN * 1.15) / n * 1000:.3f}" if PREFIX else "")
    )
    mix[arm][0] += MIX[kind] * sum(usd) / n * 1000
    mix[arm][1] += MIX[kind] * (sum(usd) - a["moved"] * IN * 1.15) / n * 1000
print("1:1:8 mix, agent billed $/1k" + (" (counterfactual cached prefix)" if PREFIX else ""))
for arm, (b, c) in sorted(mix.items()):
    print(f"  {arm:11s} {b:.3f}" + (f"  {c:.3f}" if PREFIX else ""))
