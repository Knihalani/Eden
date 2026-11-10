"""N3 (docs/research/n3-long.md, H2): `pi-ab --day K --late` over many seeds. Per arm and kind: the planted requests
whose item arrived after their answer, the request's own grade (expected to miss) and whether the agent's later
replies that day raised it (`lateFacts`: hidden, a late correction; control, a false alarm). Plan packets taken, the
agent's $ per task. Paired differences ARM − BASE by (seed, task), with a bootstrap over templates (tasks of one
template resampled together, as bench_report.py clusters; 5,000 draws, seed 1) and the task-level one beside it.
`--sonnet DIR`: `DIR/<stem name>.json` regrades (regrade.ts on late-copy.py's copies) replace a late verdict Haiku
called raised with Sonnet's. usage: python3 -I late.py [--sonnet DIR] ARM BASE[,BASE] STEM [STEM ...]"""
import json, os, random, sys
from collections import defaultdict

args = sys.argv[1:]
sonnet = None
if args[0] == "--sonnet":
    sonnet, args = args[1], args[2:]
arm, bases, stems = args[0], args[1].split(","), args[2:]
R, TASK, PLAN, USD, N = {}, {}, defaultdict(int), defaultdict(float), defaultdict(int)
CUT = defaultdict(int)


def any_true(f):
    return float(any((f or {}).values()))


for stem in stems:
    d = json.load(open(stem + ".json"))
    name = os.path.basename(stem)
    regraded = {}
    if sonnet and os.path.exists(f"{sonnet}/{name}.json"):
        g = json.load(open(f"{sonnet}/{name}.json"))
        for r in g["graded"]:
            if r["grader"] == "claude-sonnet-5-5" and r.get("facts") is not None:
                regraded[(r["task"], r["condition"])] = any_true(r["facts"])
    for t in d["tasks"]:
        TASK[(name, t["id"])] = t
    for r in d["results"]:
        k = (name, r["task"], r["condition"])
        r = dict(r)
        # A shard stopped by its spend cap leaves requests and later replies unanswered (errors, empty replies): only a
        # planted request that was answered and whose every later reply that day was made counts.
        whole = not r.get("error") and (r.get("lateText") or "").count("[Later reply ") == r.get("lateTurns", 0) > 0
        CUT[r["condition"]] += r.get("lateFacts") is not None and not whole
        if r.get("lateFacts") is not None and whole:
            r["late"] = any_true(r["lateFacts"])
            if r["late"] and (r["task"], r["condition"]) in regraded:
                r["late"] = regraded[(r["task"], r["condition"])]
        R[k] = r
        if not r.get("error"):
            USD[r["condition"]] += r["costUsd"]
            N[r["condition"]] += 1
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        PLAN[t["condition"]] += (t.get("packets") or "").count("new in the user's sources since")


def template(name, task):
    t = TASK[(name, task)]
    must = t.get("must") or []
    last = must[0]["id"] if must and isinstance(must[0], dict) and must[0].get("id") else task.rsplit(":", 1)[-1]
    return f"{t.get('suite', '')}:{last}"


def boot(pairs):
    """pairs: [(cluster, diff)]: mean, the cluster interval and the task-level interval."""
    rng = random.Random(1)
    v = [d for _, d in pairs]
    groups = defaultdict(list)
    for c, d in pairs:
        groups[c].append(d)
    gs = list(groups.values())
    cl, tk = [], []
    for _ in range(5000):
        draw = [d for g in rng.choices(gs, k=len(gs)) for d in g]
        cl.append(sum(draw) / len(draw))
        tk.append(sum(rng.choices(v, k=len(v))) / len(v))
    cl.sort(), tk.sort()
    return sum(v) / len(v), cl[125], cl[4874], tk[125], tk[4874], len(gs)


conds = sorted({c for _, _, c in R})
print(f"{'arm':18} {'kind':8} {'n':>4} {'own':>5} {'later':>6} {'turns':>6}" + ("   (later: Sonnet-confirmed)" if sonnet else ""))
for c in conds:
    for kind in ("hidden", "control"):
        rows = [r for (n, t, cc), r in R.items() if cc == c and TASK[(n, t)]["kind"] == kind and "late" in r]
        if rows:
            print(f"{c:18} {kind:8} {len(rows):4} {int(sum(any_true(r.get('facts')) for r in rows)):5} "
                  f"{int(sum(r['late'] for r in rows)):6} {sum(r.get('lateTurns', 0) for r in rows) / len(rows):6.2f}")
print()
for c in conds:
    print(f"{c:18} plan packets taken {PLAN[c]:4}  agent $/1k tasks {1000 * USD[c] / max(1, N[c]):.4f} (n {N[c]})")
print("left out (request or a later reply cut by the shard's spend cap): "
      + ", ".join(f"{c} {CUT[c]}" for c in conds))
print()
for base in bases:
    for kind, label in (("hidden", "late correction"), ("control", "false alarm")):
        pairs = []
        for (n, t, c), r in R.items():
            b = R.get((n, t, base))
            if c == arm and TASK[(n, t)]["kind"] == kind and "late" in r and b and "late" in b:
                pairs.append((template(n, t), r["late"] - b["late"]))
        if pairs:
            m, lo, hi, tlo, thi, k = boot(pairs)
            print(f"{arm} − {base} {kind:8} {label:16} n {len(pairs):4}  {100 * m:+.1f} points "
                  f"({100 * lo:+.1f}..{100 * hi:+.1f} over {k} templates; task-level {100 * tlo:+.1f}..{100 * thi:+.1f})")
    pairs = [(template(n, t), R[(n, t, c)]["costUsd"] - R[(n, t, base)]["costUsd"])
             for (n, t, c) in R if c == arm and (n, t, base) in R
             and not R[(n, t, c)].get("error") and not R[(n, t, base)].get("error")]
    if pairs:
        m, lo, hi, tlo, thi, k = boot(pairs)
        b = USD[base] / max(1, N[base])
        print(f"{arm} − {base} agent $/1k tasks n {len(pairs)}  {1000 * m:+.4f} ({1000 * lo:+.4f}..{1000 * hi:+.4f}); "
              f"{100 * m / b:+.1f}% of {base}")
