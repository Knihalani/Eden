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
