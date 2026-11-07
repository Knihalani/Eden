$ bun packages/server/src/digest.ts ".local/a7/demo-agent.log"
# Eden: what it added

Eden added context after **4 of 8 events (50%)** over 5 sessions, and stayed silent on the rest.
The agent visibly used **6 of 6 injections (100%)** whose outcome is known.

## What kind of context

- 3 × a clash or a person/day match with the request (no model)
- 3 × items to check before an action (the request acts)
- 1 × answers to the agent's own questions (ask_context)
- the agent asked 1 time; 1 answer held items (100%)

## From which connectors (items handed over)

- gmail: 16; used in 6 of 6 injections
- drive: 1; used in 1 of 1 injections
- slack: 1; used in 1 of 1 injections

## When it stayed silent

- 3 events had nothing to look up (chatter, the agent's own turns)
- 1 × Silent: found candidates, but none passed the no-model bar (score, entities, grounding), and no judge is wired: Eden stays quiet rather than guess (D3).

## Cost and speed

- sources: p50 8 ms, p95 46 ms (n 3; Eden's time to decide, not the network)
- reader-push: p50 12 ms, p95 54 ms (n 3; Eden's time to decide, not the network)
- silent: p50 6 ms, p95 6 ms (n 1; Eden's time to decide, not the network)
- answer: p50 2 ms, p95 2 ms (n 1; Eden's time to decide, not the network)
- 0.25 connector calls and 0 model calls per event
- request-time model spend $0.0000 ($0.0000 per 1,000 events); background cards and intent are billed by the model provider, not traced

_Counts and connector ids only: the log holds no request or item text (D56)._
