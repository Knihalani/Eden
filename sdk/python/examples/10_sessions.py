"""Example: F23 agent sessions — begin → traces → complete."""

from __future__ import annotations

import eden

eden.configure(
    org_id="org_demo",
    api_key="sk_eden_demo",
    dry_run=True,
)

with eden.begin(agent_id="support-bot", user_id="user_1") as session:
    eden.identify("user_1")
    with session.trace("turn-1"):
        # your agent work here
        session.add_cost(0.0012)
    # session.complete() called automatically on exit

print("session_id=", session.session_id)
print("traces=", session.trace_ids)
print("cost_usd=", session.cost_usd)
