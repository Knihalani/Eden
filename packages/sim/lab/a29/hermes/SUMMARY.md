# Hermes on heldout17 (blind, A29's Hermes half)

Run on the coordinator's machine, 2026-11-07 16:50–16:55 UTC, tree ed93f3365, `run.sh` here (Hermes Agent at
06433066f4, Haiku 5.5 in every role, Anthropic-direct lab provider, payload notices, direct profile, time scale 1,
seeds 41–42, 32 templates × hidden/control/neutral). Spend $0.288. Reports: `hermes-heldout17-report.txt`,
`hermes-heldout17-cost.txt`. Haiku-graded concerns (not regraded).

| | hermes (alone) | hermes-eden (Eden in place of its source tools) | hermes+eden (both) |
| --- | --- | --- | --- |
| Hidden raised | 4/64 (6.3%) | 45/64 (70.3%) | 41/64 (64.1%) |
| False concern: control / neutral | 0 / 0 | 0 / 0 | 1 / 2 of 64 |
| Wall p50, 1:1:8 mix | 4.23 s | 3.26 s | 4.56 s |
| Connector calls a task (agent + Eden) | 2.21 | 0.56 (+18 a user once) | 2.32 |
| $/1k tokens, mix steady | 0.334 | 0.501 | 0.470 |
| $/1k mix with Composio | 0.996 | 0.670 (0.839 with the backfill) | 1.165 |
| $/1k mix with Zapier MCP | 57.3 | 15.0 (29.5 with the backfill) | 60.2 |

- hermes-eden − hermes: hidden +64.1 points (+53.1..+76.6); wall −1.04 s hidden (−1.61..−0.52), −0.89 s neutral.
- Tokens: +$0.155/1k billed over all kinds (+0.128..+0.182), +$0.088 cache-neutral (+0.033..+0.144): Eden's packet is
  new input each task, mostly written to the cache (A27). On tasks where both arms asked the same, +$0.008 billed.
- With connectors priced per call, Eden in place of the tools is cheaper on every paid plan (Composio, Unified.to,
  Arcade, Pipedream, Zapier) and dearer only with first-party connectors (quota only).
