# A30 (docs/research/a30-token-gap.md): where the eden arm's agent bill differs from the tools arm's, by Anthropic
# token class (cache read 0.1x, cache write 1.25x, plain input 1x, output) and by request position (first request of a
# task, later ones), per kind and on the 1:1:8 mix, from pi-ab timelines (STEM.tl/tasks.jsonl).
# Counterfactual "mark before packet" (lever 1, $0, labelled so): the first request's cache mark is not put on the
# user turn, so what it writes (the user turn, and in eden the packet before it) is billed plain (1x); when anything
# later reads it (a later request of the task, or with --days a later task of the same day, whose transcript keeps
# it) that later request writes it instead of reading it (1.25x instead of 0.1x).
# Haiku 5.5: $0.1/M in, $0.5/M out.
# usage: python3 -I gap.py [--days] STEM [STEM ...]
import json, sys, collections

args = sys.argv[1:]
DAYS = "--days" in args
args = [a for a in args if a != "--days"]
IN, OUT = 0.1e-6, 0.5e-6
MIX = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
CLS = ["read1", "write1", "plain1", "out1", "readN", "writeN", "plainN", "outN"]
PRICE = {"read": IN * 0.1, "write": IN * 1.25, "plain": IN, "out": OUT}
agg = collections.defaultdict(collections.Counter)
for stem in args:
    rows = [json.loads(l) for l in open(stem + ".tl/tasks.jsonl")]
    rows = [d for d in rows if d["requests"] and d.get("kind") is not None]
    # Within a day (pi-ab --days keeps the agent's transcript for the day), a task's first-request write is read by
    # the next task of the same condition and day; the file is in run order per condition.
    nxt = {}
    if DAYS:
        last = {}
        for i, d in enumerate(rows):
            key = (d["condition"], d.get("day"))
            if key in last:
                nxt[last[key]] = True
            last[key] = i
    for i, d in enumerate(rows):
        a = agg[(d["condition"], d["kind"])]
        a["n"] += 1
        a["req"] += len(d["requests"])
        for j, r in enumerate(d["requests"]):
            cr, cw = r.get("cached") or 0, r.get("cacheWrite") or 0
            s = "1" if j == 0 else "N"
            a["read" + s] += cr
            a["write" + s] += cw
            a["plain" + s] += r["in"] - cr - cw
            a["out" + s] += r["out"]
        w1 = d["requests"][0].get("cacheWrite") or 0
        reread = len(d["requests"]) > 1 or nxt.get(i, False)
        a["cfA"] += w1 * IN * (1.15 if reread else -0.25)
        a["multi"] += reread

def usd(a, c):
    return a[c] * PRICE[c[:-1]] / a["n"] * 1000

print("tokens a task:")
print("arm         kind     n   req  multi |" + "".join(f"{c:>7s}" for c in CLS))
for (arm, kind), a in sorted(agg.items()):
    n = a["n"]
    print(f"{arm:11s} {kind:8s} {n:4d} {a['req']/n:4.2f} {a['multi']/n:5.2f} |" + "".join(f"{a[c]/n:7.0f}" for c in CLS))
print("\n$/1k tasks by class, 1:1:8 mix:")
mix = collections.defaultdict(collections.Counter)
for (arm, kind), a in agg.items():
    for c in CLS:
        mix[arm][c] += MIX[kind] * usd(a, c)
    mix[arm]["cfA"] += MIX[kind] * a["cfA"] / a["n"] * 1000
print("arm         |" + "".join(f"{c:>7s}" for c in CLS) + "  total | lever1 delta")
for arm, m in sorted(mix.items()):
    tot = sum(m[c] for c in CLS)
    print(f"{arm:11s} |" + "".join(f"{m[c]:7.3f}" for c in CLS) + f" {tot:6.3f} | {m['cfA']:+.3f}")
if "tools" in mix:
    print("\ngap to tools, $/1k on the mix, by class (positive: the arm pays more):")
    for arm, m in sorted(mix.items()):
        if arm == "tools":
            continue
        d = {c: m[c] - mix["tools"][c] for c in CLS}
        print(f"{arm:11s} |" + "".join(f"{d[c]:+7.3f}" for c in CLS) + f" {sum(d.values()):+6.3f}")
