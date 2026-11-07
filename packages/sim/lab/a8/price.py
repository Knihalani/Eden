"""A8: $ per 1,000 tasks per connector plan (market.py's CONNECTORS, $ per 1,000 calls): token $/1k plus calls a
task times the plan's price. python3 -I price.py LABEL TOKENS_PER_1K CALLS_PER_TASK [LABEL TOKENS CALLS ...]"""
import sys

PLANS = {"first-party": 0.0, "Composio": 0.30, "Unified.to": 0.75, "Arcade.dev": 10.0, "Pipedream": 12.0,
         "Zapier MCP": 25.8}
a = sys.argv[1:]
print(f"{'what':34} {'tokens':>7} {'calls/t':>7} " + " ".join(f"{p:>11}" for p in PLANS))
for label, usd, calls in zip(a[::3], a[1::3], a[2::3]):
    usd, calls = float(usd), float(calls)
    print(f"{label:34} {usd:7.3f} {calls:7.3f} " + " ".join(f"{usd + calls * p:11.3f}" for p in PLANS.values()))
