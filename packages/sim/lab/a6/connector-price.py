"""A6: token $ plus connector $ per 1,000 tasks on the 1:1:8 mix, per connector plan (market.py's CONNECTORS, $ per
1,000 calls). Calls a task = the agent's own source-tool calls + Eden's request-time connector calls (arms.py's `conn`
column: tool calls plus `eden.source` spans). Not included: background sync listings while the user works and the
one-time backfill per user (not in these timelines; A3's pi-cost-report extension counts them).
python3 -I connector-price.py LABEL ARMS_TXT [LABEL ARMS_TXT ...]"""
import sys

PLANS = {"first-party": 0.0, "Composio": 0.30, "Unified.to": 0.75, "Arcade.dev": 10.0, "Pipedream": 12.0,
         "Zapier MCP": 25.8}
args = sys.argv[1:]
print(f"{'run':10} {'arm':11} {'tokens':>7} {'calls/t':>7} " + " ".join(f"{p:>11}" for p in PLANS))
for label, path in zip(args[::2], args[1::2]):
    lines = open(path).read().split("== traffic mix")[1].split("\n")
    for l in lines[2:]:
        f = l.split()
        if len(f) < 12:
            break
        arm, usd, conn = f[0], float(f[3]), float(f[11])
        print(f"{label:10} {arm:11} {usd:7.3f} {conn:7.2f} " + " ".join(f"{usd + conn * p:11.3f}" for p in PLANS.values()))
