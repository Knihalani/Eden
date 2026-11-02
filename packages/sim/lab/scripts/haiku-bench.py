"""The Haiku benchmark's tables, from pi-ab / hermes-ab results files, their timelines and the spend ledger.

usage: python3 -I haiku-bench.py LEDGER.jsonl RUN.json [RUN.json ...]

Per harness, suite group and condition: hidden-fact rate (hidden tasks) and false-concern rate (control tasks), with
n; wall p50/p90; time to first token p50; per-request tokens (in, out, cache read, cache write) and the share of the
prompt read from the cache; ask_context calls, packet characters and Eden's source calls per task. Paired differences
between conditions (same task, same seed) with a 95% bootstrap interval over tasks, per suite group and overall. The
cost split by role (agent, grader, Eden's reader and card maker) is the ledger's, per run label prefix.
"""
import json, random, statistics, sys
from collections import defaultdict

random.seed(7)
LEDGER, FILES = sys.argv[1], sys.argv[2:]

GROUP = {"heldout5": "blind5-8", "heldout6": "blind5-8", "heldout7": "blind5-8", "heldout8": "blind5-8",
         "heldout10": "heldout10", "heldout11": "heldout11", "heldout12": "heldout12"}
group_of = lambda suite: GROUP.get(suite, "train" if suite.startswith("train") else suite)

rows = []  # one per run: harness, group, condition, kind, task, rate, ...
for f in FILES:
    d = json.load(open(f))
    harness = d.get("harness", "pi")
    tl = {}
    try:
        for line in open(d["timeline"] + "/tasks.jsonl"):
            t = json.loads(line)
            tl[(t["task"], t["condition"])] = t
    except (OSError, KeyError):
        pass
    for r in d["results"]:
        t = tl.get((r["task"], r["condition"]))
        if not t or r.get("error") or t["kind"] not in ("hidden", "control"):
            continue
        facts = r.get("facts")
        if facts is None:
            continue
        ev = t.get("events", [])
        reqs = t.get("requests", [])
        rows.append({
            "harness": harness, "group": group_of(t["suite"]), "cond": r["condition"], "kind": t["kind"],
            "task": r["task"], "rate": sum(bool(v) for v in facts.values()) / max(1, len(facts)),
            "wall": r["wallMs"] / 1000, "ttft": t.get("firstTokenMs"),
            "reqs": reqs, "asks": sum(1 for e in ev if e.get("ph") == "B" and e.get("ev") == "tool.ask_context"),
            "sources": sum(1 for e in ev if e.get("ev") == "eden.source" and e.get("ph") in ("B", "X")),
            "chars": r.get("injectedChars", 0), "cost": r["costUsd"], "eden": r.get("edenCostUsd", 0),
        })

q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))] if xs else float("nan")
mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")


def boot(diffs, n=2000):
    if not diffs:
        return (float("nan"),) * 3
    m = mean(diffs)
    bs = sorted(mean(random.choices(diffs, k=len(diffs))) for _ in range(n))
    return m, bs[int(0.025 * n)], bs[int(0.975 * n)]


def table(sel, title):
    print(f"\n== {title}")
    print("condition            kind     n   rate  wall p50  p90  ttft p50  in/req out/req cacheRd% cacheWr%  asks"
          "  chars  src/task")
    conds = sorted({r["cond"] for r in sel}, key=lambda c: (len(c), c))
    for c in conds:
        for k in ("hidden", "control"):
            rs = [r for r in sel if r["cond"] == c and r["kind"] == k]
            if not rs:
                continue
            reqs = [x for r in rs for x in r["reqs"]]
            pin = sum(x.get("in", 0) for x in reqs)
            print(f"{c:20s} {k:7s} {len(rs):4d} {mean([r['rate'] for r in rs]):.3f}"
                  f"  {q([r['wall'] for r in rs], .5):7.2f} {q([r['wall'] for r in rs], .9):5.2f}"
                  f"  {q([r['ttft'] for r in rs if r['ttft'] is not None], .5):7.0f}"
                  f"  {mean([x.get('in', 0) for x in reqs]):6.0f} {mean([x.get('out', 0) for x in reqs]):6.0f}"
                  f"  {100 * sum(x.get('cached', 0) for x in reqs) / max(1, pin):6.1f}"
                  f"  {100 * sum(x.get('cacheWrite', 0) for x in reqs) / max(1, pin):6.1f}"
                  f"  {mean([r['asks'] for r in rs]):4.2f} {mean([r['chars'] for r in rs]):6.0f}"
                  f"  {mean([r['sources'] for r in rs]):6.2f}")


def pairs(sel, a, b, kind):
    A = {r["task"]: r["rate"] for r in sel if r["cond"] == a and r["kind"] == kind}
    B = {r["task"]: r["rate"] for r in sel if r["cond"] == b and r["kind"] == kind}
    return [A[t] - B[t] for t in A if t in B]


COMPARE = {
    "pi": [("eden~NEW", "eden"), ("eden~NEW", "tools"), ("eden~NEW", "none"), ("both~NEW", "tools"),
           ("both~NEW", "eden"), ("eden", "tools"), ("eden", "none"), ("tools", "none")],
    "hermes": [("hermes+eden~NEW", "hermes+eden"), ("hermes+eden~NEW", "hermes"), ("hermes+eden", "hermes")],
}
for h in sorted({r["harness"] for r in rows}):
    hs = [r for r in rows if r["harness"] == h]
    groups = sorted({r["group"] for r in hs})
    for g in groups + ["ALL BLIND (5-8, 10, 11, 12)"]:
        sel = [r for r in hs if (r["group"] == g if not g.startswith("ALL") else r["group"] != "train")]
        if not sel:
            continue
        table(sel, f"{h} / {g}")
        print("paired (a - b), 95% bootstrap over tasks:")
        for a, b in COMPARE.get(h, []):
            for k in ("hidden", "control"):
                d = pairs(sel, a, b, k)
                if d:
                    m, lo, hi = boot(d)
                    print(f"  {a:16s} - {b:12s} {k:7s} n={len(d):4d} {m:+.3f} ({lo:+.3f}..{hi:+.3f})")

# ---- Cost split, from the ledger: role totals per run label prefix, per run of that harness.
by = defaultdict(lambda: defaultdict(lambda: [0, 0.0, 0, 0, 0, 0, []]))
for line in open(LEDGER):
    d = json.loads(line)
    run = d["run"]
    h = "pi" if run.startswith("p2-pi") else "hermes" if run.startswith("p2-h-") else None
    if h is None:
        continue
    x = by[h][d["role"]]
    u = d["usage"]
    x[0] += 1
    x[1] += d["costUsd"]
    x[2] += u["inputTokens"]
    x[3] += u["cachedInputTokens"]
    x[4] += u["cacheWriteTokens"]
    x[5] += u["outputTokens"]
    if d.get("ttftMs") is not None:
        x[6].append(d["ttftMs"])
print("\n== spend by harness and role (ledger; Phase 2 runs)")
print("harness  role          calls      usd   in/call  out/call cacheRd% cacheWr%  ttft p50  p90  $/1k runs")
for h, roles in by.items():
    nruns = len([r for r in rows if r["harness"] == h])
    for role, x in sorted(roles.items()):
        print(f"{h:8s} {role:12s} {x[0]:6d} {x[1]:8.4f} {x[2] / x[0]:8.0f} {x[5] / x[0]:8.0f}"
              f"  {100 * x[3] / max(1, x[2]):6.1f}  {100 * x[4] / max(1, x[2]):6.1f}"
              f"  {q(x[6], .5):7.0f} {q(x[6], .9):5.0f}  {1000 * x[1] / max(1, nruns):8.3f}")
    print(f"{h:8s} {'TOTAL':12s} {sum(x[0] for x in roles.values()):6d} {sum(x[1] for x in roles.values()):8.4f}"
          f"   ({nruns} graded hidden/control runs)")
