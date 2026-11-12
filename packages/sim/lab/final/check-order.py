"""Assert that each task's push check ended before its first agent request started (F7's warning via the integrator).

    python3 -I packages/sim/lab/final/check-order.py RUN.tl/tasks.jsonl [...]

A check that ends after the agent's first model request means the run measured a late-injection shape, not the
default (a subagent-answered check takes about 60-85 s; the push observe is capped by `readerPushWaitMs`). Exits 1
when any task has one.
"""

import json
import sys

late = ok = none = 0
for f in sys.argv[1:]:
    for line in open(f):
        t = json.loads(line)
        ev = t.get("events") or []
        if not isinstance(ev, list):
            continue
        check_end = [e["t"] for e in ev if e.get("ev") == "eden.check" and e.get("ph") == "E"]
        req = [e["t"] for e in ev if e.get("ev") == "model.request" and e.get("ph") == "B"]
        if not check_end or not req:
            none += 1
            continue
        if max(check_end) > min(req):
            late += 1
        else:
            ok += 1
print(f"push check before the first agent request: {ok}; after it: {late}; no check or no request: {none}")
sys.exit(1 if late else 0)
