# A7 (D291): connector calls and their price per plan for the no-key Pi run, beside the model cost.
# usage: python3 -I connectors.py RUN41.json RUN42.json CONNECTOR-CALLS.json
# Agent's own connector calls = its tool calls less ask_context (Eden's tool, not a connector); Eden's request-time
# calls = the traces' sourceCalls in each task's timeline; Eden's one-time backfill = connector-calls.ts's listing
# calls per stream (no task is current then, so no timeline has them), spread over the run's tasks (an upper bound:
# a real user's backfill is spread over far more requests). Plans: market.py's CONNECTORS ($ per 1,000 calls).
import json, sys, os, collections

CONNECTORS = {
    "First-party APIs (quota only)": 0.0,
    "Composio (overage)": 0.30,
    "Unified.to (Pro)": 0.75,
    "Arcade.dev (Team)": 10.0,
    "Pipedream Connect (overage)": 12.0,
    "Zapier MCP (10k tasks)": 25.8,
}
MIX = {"hidden": 1, "control": 1, "neutral": 8}
runs, bf = sys.argv[1:-1], json.load(open(sys.argv[-1]))
agent = collections.defaultdict(list)  # (cond, kind) -> calls per task
eden = collections.defaultdict(list)
usd = collections.defaultdict(list)
for p in runs:
    d = json.load(open(p))
    res = {(r["condition"], r["task"]): r for r in d["results"]}
    tl = os.path.join(d.get("timeline") or p[:-5] + ".tl", "tasks.jsonl")
    for line in open(tl):
        t = json.loads(line)
        c, k = t["condition"], t["kind"]
        r = res[(c, t["task"])]
        asks = sum(1 for e in t["events"] if e.get("ev") == "tool.ask_context" and e.get("ph") == "B")
        sc = sum((e.get("data") or {}).get("sourceCalls", 0) for e in t["events"] if e.get("ev") in ("eden.decision", "eden.cache-hit"))
        agent[(c, k)].append(r["toolCalls"] - asks)
        eden[(c, k)].append(sc)
        usd[(c, k)].append(r["costUsd"] + r.get("edenCostUsd", 0))
mean = lambda xs: sum(xs) / len(xs)
mix = lambda f, c: sum(w * f(c, k) for k, w in MIX.items()) / sum(MIX.values())
backfill_per_task = bf["backfillCalls"] / bf["tasks"]
print(f"Eden's one-time backfill: {bf['backfillCalls']} listing calls over {bf['streams']} streams "
      f"({bf['backfillCalls'] / bf['streams']:.0f} per simulated user), {bf['runCalls']} calls between tasks; "
      f"spread over the run's {bf['tasks']} tasks per arm: {backfill_per_task:.2f} a task\n")
print("| Arm | Agent connector calls/task (mix) | Eden request-time calls/task | Eden backfill calls/task (one-time, spread) | Model $/1k (mix) |")
print("|---|---|---|---|---|")
conds = sorted({c for c, _ in agent}, key=["tools", "eden", "eden+nokey"].index)
bfc = lambda c: 0.0 if c == "tools" else backfill_per_task
for c in conds:
    print(f"| {c} | {mix(lambda c, k: mean(agent[(c, k)]), c):.2f} | {mix(lambda c, k: mean(eden[(c, k)]), c):.2f} "
          f"| {bfc(c):.2f} | {1000 * mix(lambda c, k: mean(usd[(c, k)]), c):.3f} |")
print("\n$ per 1,000 tasks on the 1:1:8 mix, model + connectors (steady state: request-time calls only; all-in adds the "
      "backfill spread over this run's tasks):\n")
print("| Plan ($/1k calls) | " + " | ".join(f"{c} steady / all-in" for c in conds) + " |")
print("|---|" + "---|" * len(conds))
for plan, price in CONNECTORS.items():
    cells = []
    for c in conds:
        model = 1000 * mix(lambda c, k: mean(usd[(c, k)]), c)
        steady = model + price * mix(lambda c, k: mean(agent[(c, k)]) + mean(eden[(c, k)]), c)
        cells.append(f"{steady:.3f} / {steady + price * bfc(c):.3f}")
    print(f"| {plan} ({price}) | " + " | ".join(cells) + " |")
