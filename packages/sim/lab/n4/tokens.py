# N4 (docs/research/n4-agents.md): the agent's bill per 1,000 tasks by Anthropic token class (plain input, cache
# write 1.25x, cache read, output), each arm and eden - tools, from pi-ab timelines (STEM.tl/tasks.jsonl).
# usage: python3 -I tokens.py MODEL STEM [STEM ...]   (MODEL: haiku | sonnet | opus)
import json, sys, collections

# $ per token: input, output, a cache read's share of input (anthropic.ts ANTHROPIC_PRICES).
PRICES = {"haiku": (0.1e-6, 0.5e-6, 0.1), "sonnet": (2e-6, 10e-6, 0.05), "opus": (4e-6, 20e-6, 0.05)}
IN, OUT, READ = PRICES[sys.argv[1]]
agg = collections.defaultdict(collections.Counter)
for stem in sys.argv[2:]:
    for line in open(stem + ".tl/tasks.jsonl"):
        d = json.loads(line)
        if not d["requests"]:
            continue
        a = agg[d["condition"]]
        a["n"] += 1
        a["requests"] += len(d["requests"])
        for q in d["requests"]:
            read, write = q.get("cached", 0), q.get("cacheWrite", 0)
            a["plain"] += q["in"] - read - write
            a["write"] += write
            a["read"] += read
            a["out"] += q["out"]
RATE = {"plain": IN, "write": IN * 1.25, "read": IN * READ, "out": OUT}
usd = lambda a, c: a[c] * RATE[c] / a["n"] * 1000
print(f"{'arm':8} {'n':>4} {'req/t':>6} " + " ".join(f"{c + ' tok/t':>12} {c + ' $/1k':>10}" for c in RATE) + f" {'total $/1k':>11}")
for cond, a in agg.items():
    cells = " ".join(f"{a[c] / a['n']:12.0f} {usd(a, c):10.3f}" for c in RATE)
    print(f"{cond:8} {a['n']:4d} {a['requests'] / a['n']:6.2f} {cells} {sum(usd(a, c) for c in RATE):11.3f}")
if "eden" in agg and "tools" in agg:
    e, t = agg["eden"], agg["tools"]
    cells = " ".join(f"{e[c] / e['n'] - t[c] / t['n']:+12.0f} {usd(e, c) - usd(t, c):+10.3f}" for c in RATE)
    print(f"{'e - t':8} {'':4} {e['requests'] / e['n'] - t['requests'] / t['n']:+6.2f} {cells} {sum(usd(e, c) - usd(t, c) for c in RATE):+11.3f}")
