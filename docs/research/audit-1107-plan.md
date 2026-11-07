# Audit and fix, 2026-11-07 afternoon (A wave): plan

Owner's ask: for 6.5 hours, keep finding and fixing everything that holds Eden back on cost, speed, quality and
scale (including a user with ~1,000 connectors and many users per server), and the reasons people would not adopt it.
Base: main at 39f9bea7b (the CL wave: candidates default, D237). Paid calls: Anthropic only, `HAIKU_API_KEY`,
`claude-haiku-5-5` (Sonnet for regrades only), lab provider, capped ledgers. Held-out suites 9–16 are all read: tune
on train; a new blind suite is written for the end of the day if a quality claim needs one.

## Wave A (parallel sessions; each audits its area, ranks issues by impact, fixes the top ones, measures)

| Session | Area | Decisions | Paid cap |
| --- | --- | --- | --- |
| A1 | Scale: 1,000 connectors per user, 10k users per server, sync and routing at that size, memory, cold start, fan-out | D261–D265 | $1.5 |
| A2 | Quality: recall the candidates default gave up (−5), false concerns, long-horizon facts (recaps, revisions), non-Haiku agents | D266–D270 | $3 |
| A3 | Cost and speed beyond the agent: per-task tokens Eden adds (Hermes +$0.077), the session reader-call cap, server and SDK overhead, p99 | D271–D275 | $2 |
| A4 | Adoption: why a team would not use Eden (setup, no-key mode, trust and privacy, debuggability, docs, SDKs, connectors) and fixes | D276–D280 | $1 |
| A5 | Correctness: a deep bug hunt over engine, server, client, sources (the `/deep-audit` method) with fixes | D281–D285 | $0.5 |

Later waves start from what wave A finds.

## Later waves (started from what earlier sessions found)

| Session | Area |
| --- | --- |
| A6 | Moonshots (new shapes for cost, speed and quality) |
| A7 | Adoption, part 2 |
| A8 | Connector calls and their plan pricing |
| A9 | Late facts and plans that conflict (`planConflict`) |
| A10 | Live prompt-injection suite against the candidates packet |
| A11 | Second bug hunt on the day's new code |
| A12 | Powered quality measurement and the ask nudge (`askNudge`) |
| A13 | Scale part 2: source-aware cards and sweep, routing at 1,000 sources |
| A14 | Many users per server |
| A15 | Moonshot: retrieval for facts that share no words with the request |
| A16 | Moonshot: Eden inside the agent loop |
| A17 | Quality over long horizons |
| A18 | Speed and latency end to end |
| A19 | Blind suite `heldout17` for the end-of-day check |
| A20 | Security review of the day's additions |
| A21 | Scale part 3: sweep unused sources less often, live check at 1,000 sources |
| A22 | Quality: a no-model link line on each candidate; a full intent re-draw spread |
| A23 | Adoption: a fresh-eyes onboarding walkthrough on three paths |
| A24 | Scale part 4: compact per-user sync id sets; a card drain on its own timer (D328) |
| A25 | Injection residual: a check on actions that add a recipient, guest or payee only a packet named |
| A26 | Decide the `pushReshow` trial (D340) with a fresh paired run |
| A27 | Hermes cost with Eden: plugin context and the prompt cache, cards spend, Eden's connector calls |
| A28 | Scale part 5: live searches of cut copies and noise cards at 1,000 sources |
| A29 | The end-of-day blind confirmation on `heldout17` (Pi in a cloud session; Hermes on the coordinator machine) |
| A30 | Close the first-party token gap heldout17 found (+$0.06–0.09/1k against the agent alone) |
