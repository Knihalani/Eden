"""A9 plan-conflict test (`pi-ab --day K --late`, docs/research/a9-ahead.md): per arm and kind, the planted requests
whose item arrived after their answer, with the agent's later replies that day graded against them (`lateFacts`):
hidden, the fact reached the user late ("corrected"); control, the look-alike was raised ("false alarm"). Also the
request's own grade (expected to miss: the item did not exist yet), plan packets (`plan:` ways, any task), agent $ per
day (the day's tasks and its recap), and paired differences by task against BASE arms (bootstrap 95%, 5,000 draws,
seed 1). python3 -I late.py ARM BASE[,BASE] STEM [STEM ...]"""
import json, random, sys
from collections import defaultdict

arm, bases, stems = sys.argv[1], sys.argv[2].split(","), sys.argv[3:]
R, KIND, PLAN, DAYUSD, NDAYS = {}, {}, defaultdict(int), defaultdict(float), defaultdict(int)
for stem in stems:
    d = json.load(open(stem + ".json"))
    for t in d["tasks"]:
        KIND[t["id"]] = t["kind"]
    for r in d["results"]:
        R[(r["task"], r["condition"])] = r
        DAYUSD[r["condition"]] += r["costUsd"]
    for day in d.get("days", []):
        DAYUSD[day["condition"]] += day.get("recapUsd") or 0
        NDAYS[day["condition"]] += 1
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        PLAN[t["condition"]] += sum(1 for w in t.get("ways", []) if w["why"] == "plan")
        PLAN[(t["condition"], "packets")] += (t.get("packets") or "").count("new in the user's sources since")


def any_true(f):
    return float(any((f or {}).values()))


conds = sorted({c for _, c in R})
print(f"{'arm':12} {'kind':8} {'n':>4} {'own':>5} {'later':>6} {'turns':>6}")
for c in conds:
    for kind in ("hidden", "control"):
        rows = [r for (t, cc), r in R.items() if cc == c and KIND.get(t) == kind and r.get("lateFacts") is not None]
        if not rows:
            continue
        own = sum(any_true(r.get("facts")) for r in rows)
        later = sum(any_true(r.get("lateFacts")) for r in rows)
        turns = sum(r.get("lateTurns", 0) for r in rows) / len(rows)
        print(f"{c:12} {kind:8} {len(rows):4} {int(own):5} {int(later):6} {turns:6.2f}")
print()
for c in conds:
    print(f"{c:12} plan packets taken {PLAN[(c, 'packets')]:4}  agent $ per day {1000 * DAYUSD[c] / max(1, NDAYS[c]):.3f}/1k-days"
          f" ({NDAYS[c]} days; $ {DAYUSD[c]:.4f})")


def boot(v):
    rng = random.Random(1)
    d = sorted(sum(rng.choice(v) for _ in v) / len(v) for _ in range(5000))
    return sum(v) / len(v), d[125], d[4874]


print()
for base in bases:
    for kind, label in (("hidden", "corrected (later replies raise the fact)"), ("control", "false alarm (look-alike raised)")):
        v = []
        for (t, c), r in R.items():
            b = R.get((t, base))
            if c != arm or KIND.get(t) != kind or r.get("lateFacts") is None or not b or b.get("lateFacts") is None:
                continue
            v.append(any_true(r["lateFacts"]) - any_true(b["lateFacts"]))
        if v:
            m, lo, hi = boot(v)
            print(f"{arm} − {base:6} {kind:8} {label:42} n {len(v):4}  {100 * m:+.1f} points ({100 * lo:+.1f}..{100 * hi:+.1f})")
    # Cost per task (the agent's $, recaps excluded: they are no task), paired.
    v = [R[(t, arm)]["costUsd"] - R[(t, base)]["costUsd"] for (t, c) in R if c == arm and (t, base) in R]
    if v:
        m, lo, hi = boot(v)
        print(f"{arm} − {base:6} agent $/1k tasks (recaps excluded) n {len(v)}  {1000 * m:+.4f} ({1000 * lo:+.4f}..{1000 * hi:+.4f})")
