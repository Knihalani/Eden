"""A9 (docs/research/a9-ahead.md): per arm and kind from pi-ab timelines (STEM.tl/tasks.jsonl): tasks, share with an
answer-ahead packet (`ways` why "ahead"), asks a task, agent output tokens a task; and, paired by task against BASE,
asks and output tokens on the tasks ARM's ahead packet reached (bootstrap 95%, 5,000 draws, seed 1). With --questions,
prints the ask questions of ARM's ahead tasks. python3 -I asks.py ARM BASE STEM [STEM ...] [--questions]"""
import json, random, sys
from collections import defaultdict

args = [a for a in sys.argv[1:] if a != "--questions"]
show = "--questions" in sys.argv
arm, base, stems = args[0], args[1], args[2:]
T = {}
for stem in stems:
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        asks = [e["data"].get("question", "") for e in t["events"] if e["ev"] == "eden.ask" and e["ph"] == "I"]
        T[(t["task"], t["condition"])] = {
            "kind": t["kind"],
            "ahead": any(w["why"] == "ahead" for w in t.get("ways", [])),
            "asks": asks,
            "out": sum(r.get("out", 0) for r in t["requests"]),
            "turns": len(t["requests"]),
        }


def boot(v):
    rng = random.Random(1)
    d = sorted(sum(rng.choice(v) for _ in v) / len(v) for _ in range(5000))
    return sum(v) / len(v), d[125], d[4874]


agg = defaultdict(lambda: defaultdict(float))
for (task, cond), x in T.items():
    a = agg[(cond, x["kind"])]
    a["n"] += 1
    a["ahead"] += x["ahead"]
    a["asks"] += len(x["asks"])
    a["out"] += x["out"]
print(f"{'arm':12} {'kind':8} {'n':>4} {'ahead%':>7} {'asks':>6} {'out tok':>8}")
for (cond, kind), a in sorted(agg.items()):
    n = a["n"]
    print(f"{cond:12} {kind:8} {int(n):4} {a['ahead']/n:7.0%} {a['asks']/n:6.2f} {a['out']/n:8.0f}")
print(f"\n== {arm} − {base}, paired, on the tasks {arm}'s ahead packet reached")
for kind in ("hidden", "control", "neutral", "all"):
    da, do, dt = [], [], []
    for (task, cond), x in T.items():
        if cond != arm or not x["ahead"] or (kind != "all" and x["kind"] != kind):
            continue
        b = T.get((task, base))
        if not b:
            continue
        da.append(len(x["asks"]) - len(b["asks"]))
        do.append(x["out"] - b["out"])
        dt.append(x["turns"] - b["turns"])
    if da:
        print(f"{kind:8} n {len(da):4}  asks {'%+.2f (%+.2f..%+.2f)' % boot(da)}  out tok {'%+.0f (%+.0f..%+.0f)' % boot(do)}"
              f"  turns {'%+.2f (%+.2f..%+.2f)' % boot(dt)}")
print(f"\n== {arm} − {base}, paired, every task; mix 1:1:8 (hidden:control:neutral, an assumption)")
W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
mix = {"asks": 0.0, "out": 0.0, "turns": 0.0}
for kind in ("hidden", "control", "neutral"):
    da, do, dt = [], [], []
    for (task, cond), x in T.items():
        b = T.get((task, base))
        if cond != arm or x["kind"] != kind or not b:
            continue
        da.append(len(x["asks"]) - len(b["asks"]))
        do.append(x["out"] - b["out"])
        dt.append(x["turns"] - b["turns"])
    if da:
        a, o, t = boot(da), boot(do), boot(dt)
        print(f"{kind:8} n {len(da):4}  asks {'%+.3f (%+.3f..%+.3f)' % a}  out tok {'%+.1f (%+.1f..%+.1f)' % o}"
              f"  turns {'%+.3f (%+.3f..%+.3f)' % t}")
        for k, v in (("asks", a[0]), ("out", o[0]), ("turns", t[0])):
            mix[k] += W[kind] * v
print("mix (point estimates) " + "  ".join(f"{k} {v:+.3f}" for k, v in mix.items()))
if show:
    for (task, cond), x in sorted(T.items()):
        if cond == arm and x["ahead"] and x["asks"]:
            print(task, "|", " || ".join(x["asks"]))
