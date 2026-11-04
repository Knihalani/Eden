# Eden's effect on an agent's cost, speed and quality, at market connector latency and prices

> **Superseded for cost by [cost-fixes.md](cost-fixes.md) (D125):** the default now reads fewer items for intent and
> takes change notifications, so Eden's model spend and, with item-carrying notifications, its connector calls are
> lower than below. The quality and speed findings stand; this note's first-run 80.5% hidden was a high draw (the same
> default rerun scored 77.3%).

Status: 2026-11-04. Measurement, no decision. Pi harness (the standard agent), Haiku 5.5 agent, grader and Eden
roles, blind held-out 13, seeds 41–44: 128 hidden and 128 control tasks per arm. The shipped default (`--config
default`) against the agent alone with its search tools (`tools`). Spend $1.09 for the 8 processes plus $0.06 for a
pilot.

## What was run

The sim connectors keep their search behaviour (AND search, snippets, errors, rate limits) and take two latency
profiles meant to match what an agent builder would actually get. No vendor publishes p50/p95 for authenticated
search on these APIs (the research notes below), so the medians are **estimates**, built from:

- a measured network floor from this container (unauthenticated TTFB p50: Gmail 156 ms, Calendar 139, Drive 133,
  Slack 191, HubSpot 170);
- one Gmail "search" being two sequential requests (`messages.list` + a batched `messages.get`);
- the server's own search work, and anecdotes for Drive full-text search and Slack search.

| Source   | `REALISTIC` (earlier runs) | **Direct APIs** (`direct.json`) | **Hosted platform** (`hosted.json`) |
| -------- | -------------------------- | ------------------------------- | ----------------------------------- |
| Mail     | 350 ms, σ 0.55             | 600 ms, σ 0.6                   | 800 ms, σ 0.75, 1% errors           |
| Calendar | 180 ms, σ 0.4              | 280 ms, σ 0.5                   | 480 ms, σ 0.65, 0.8% errors         |
| Docs     | 450 ms, σ 0.6              | 700 ms, σ 0.7                   | 900 ms, σ 0.85, 1% errors           |
| CRM      | 300 ms, σ 0.5              | 450 ms, σ 0.6                   | 650 ms, σ 0.75, 1% errors           |
| Chat     | 250 ms, σ 0.5              | 550 ms, σ 0.7                   | 750 ms, σ 0.85, 1% errors           |

Medians are log-normal with spread σ. The hosted profile adds about 200 ms per call for the platform's extra network
leg and processing, and a heavier tail. Rate limits stay at `REALISTIC`'s, because the sim's token bucket cannot
express Slack's 20/min. Chat search is gentler than Slack's real Tier 2 limit as a result.

**Prices.**

- **Models:** Anthropic first-party, per 1M tokens.
  - Haiku 5.5: $0.10 in, $0.50 out, $0.01 cache read.
  - Sonnet 5.5: $2, $10, $0.20.
  - Opus 5.5: $4, $20, $0.20.
  - Cache writes cost 1.25 × the input price.
- **Connector calls:** per 1,000 tool calls, fetched 2026-11-04.
  - First-party Google, Slack, Graph, HubSpot and Notion APIs: $0. They are quota-limited only.
  - Composio overage: $0.30.
  - Unified.to Pro: $0.75.
  - Arcade.dev Team: $10.
  - Pipedream Connect overage: $12.
  - Zapier MCP at 10k tasks: $25.8. Zapier bills 2 tasks per call.
  - Sources: composio.dev/pricing, unified.to/pricing, arcade.dev/pricing, pipedream.com/pricing,
    docs.zapier.com/mcp/usage.md and zapier.com/pricing, and the Google, Slack, Microsoft, HubSpot and Notion quota
    pages.

**Re-pricing for Sonnet and Opus agents.** Every request's token split (fresh input, cache writes, cache reads,
output) is re-priced at the other model's rates. This assumes a bigger agent reads and writes the tokens the Haiku
agent did, which is an estimate. Eden's own model calls (the reader, cards) stay on Haiku as billed.

## Results

### Quality and speed (measured)

|                                                                 | Direct: alone | Direct: + Eden               | Hosted: alone | Hosted: + Eden                             |
| --------------------------------------------------------------- | ------------- | ---------------------------- | ------------- | ------------------------------------------ |
| Hidden facts raised                                             | 9.4% (12/128) | **80.5%** (103/128)          | 5.5% (7/128)  | **77.3%** (99/128)                         |
| Paired difference (95% CI)                                      |               | **+71.1 pts** (+62.5..+78.9) |               | **+71.9 pts** (+63.3..+79.7)               |
| False concerns (control)                                        | 0.0%          | 0.8% (1/128)                 | 0.8%          | 2.3% (3/128); difference +1.6 (−1.6..+4.7) |
| Wall, hidden tasks, p50 / p90                                   | 4.78 / 6.96 s | **3.33 / 6.50 s**            | 5.57 / 9.01 s | **3.75 / 7.33 s**                          |
| Paired wall difference, hidden                                  |               | **−0.77 s** (−1.13..−0.40)   |               | **−1.45 s** (−1.93..−0.95)                 |
| Wall, control tasks, p50 / p90                                  | 4.71 / 7.34 s | 5.31 / 7.54 s                | 5.21 / 8.62 s | 5.75 / 8.17 s                              |
| Paired wall difference, control                                 |               | +0.28 s (−0.13..+0.66)       |               | +0.23 s (−0.26..+0.74)                     |
| Agent's own searches per task (critical path), hidden / control | 3.42 / 3.45   | **0.55 / 1.20**              | 3.64 / 3.27   | **0.62 / 1.28**                            |
| Eden's connector calls per task: sync polls + searches, hidden  | —             | 3.40 + 0.38                  | —             | 3.68 + 0.55                                |
| Eden on the critical path, mean (pooled)                        | 0             | 1,769 ms                     | 0             | 2,109 ms                                   |
| Agent tokens in / out per task (pooled)                         | 2,686 / 529   | 1,542 / 418                  | 2,692 / 519   | 1,598 / 443                                |
| Agent cache-read share                                          | 79.6%         | 48.7%                        | 81.6%         | 54.7%                                      |

- **Quality:** Eden's gain does not shrink as connectors slow down. It was +65.6 points at `REALISTIC` latency
  (final-before-after.md) and is +71 to +72 here.
- **Speed:** the slower the connectors, the more time Eden saves on tasks with something to find. The agent makes
  about 3 fewer blocking searches per task, and Eden's polls run in the background.
- **Control tasks:** Eden's reader call adds about 0.25 s, within noise in both profiles.

### Cost per 1,000 tasks, as shipped (Eden's sync polls billed)

The traffic mix is 10% hidden and 90% control, because most agent turns have nothing hidden to raise. The figures
include Eden's reader and its background cards at the measured cold-cache upper bound ($0.90 per 1,000; D123 recorded
$0.46 steady state).

| Agent model | Connectors                 | Direct: alone | Direct: + Eden | Hosted: alone | Hosted: + Eden |
| ----------- | -------------------------- | ------------- | -------------- | ------------- | -------------- |
| Haiku 5.5   | First-party APIs ($0/call) | $0.36         | $1.71 (+382%)  | $0.33         | $1.74 (+420%)  |
| Haiku 5.5   | Composio ($0.30/1k)        | $1.39         | $3.25 (+134%)  | $1.33         | $3.46 (+161%)  |
| Haiku 5.5   | Pipedream ($12/1k)         | $41.67        | $63.20 (+52%)  | $39.97        | $70.76 (+77%)  |
| Sonnet 5.5  | First-party APIs           | $7.11         | $8.05 (+13%)   | $6.69         | $8.26 (+23%)   |
| Sonnet 5.5  | Composio                   | $8.15         | $9.58 (+18%)   | $7.68         | $9.98 (+30%)   |
| Sonnet 5.5  | Pipedream                  | $48.43        | $69.53 (+44%)  | $46.33        | $77.27 (+67%)  |
| Opus 5.5    | First-party APIs           | $13.80        | $14.54 (+5%)   | $12.96        | $14.92 (+15%)  |
| Opus 5.5    | Composio                   | $14.83        | $16.08 (+8%)   | $13.95        | $16.65 (+19%)  |
| Opus 5.5    | Pipedream                  | $55.12        | $76.02 (+38%)  | $52.59        | $83.94 (+60%)  |

Cost per hidden fact actually raised (direct profile, hidden tasks):

| Agent model | Connectors       | Agent alone        | Agent + Eden | Eden as a share of alone |
| ----------- | ---------------- | ------------------ | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs | $3.76 per 1k facts | $1.92        | 51%                      |
| Sonnet 5.5  | First-party APIs | $75.21             | $8.84        | 12%                      |
| Opus 5.5    | First-party APIs | $145.86            | $15.97       | 11%                      |
| Sonnet 5.5  | Pipedream        | $513.21            | $73.50       | 14%                      |

- **Model tokens.** Eden cuts the agent's prompt by about 1,150 tokens a task (2,686 → 1,542). Its own spend is fixed
  at Haiku rates.
  - The bigger the agent model, the more that saving offsets Eden. On hidden tasks Eden is net cheaper with a Sonnet
    or Opus agent on first-party APIs (−12% and −13% before cards; +1% and −6% with them).
  - It also lowers the agent's cache-read share (49–55% against 80–82%), because the injected context changes per
    task.
- **Connector calls.** Eden saves about 2.9 blocking agent searches per hidden task and about 2.2 per control task.
  It adds about 3.4–3.9 background sync polls and 0.4–0.7 searches.
  - On per-call platforms the polls dominate: Eden raises the connector bill by 50–80%.
  - On first-party APIs the calls cost nothing beyond quota. At these rates the quota is far from binding: about 4
    calls per task against Gmail's 6,000 units/min per user.

### If sync used change notifications instead of polls (not built)

Gmail, Calendar, Drive, Slack (Events API), Graph and HubSpot all offer change notifications at no charge. If Eden's
sync took them instead of polling, only its searches would be billed. Same mix as above:

| Agent model | Connectors            | Alone   | + Eden, push sync | Change   |
| ----------- | --------------------- | ------- | ----------------- | -------- |
| Haiku 5.5   | Unified.to ($0.75/1k) | $2.94   | $2.94             | 0%       |
| Haiku 5.5   | Pipedream ($12/1k)    | $41.67  | $21.32            | **−49%** |
| Sonnet 5.5  | Pipedream             | $48.43  | $27.65            | **−43%** |
| Opus 5.5    | Zapier MCP ($25.8/1k) | $102.63 | $56.69            | **−45%** |

These figures hold the measured call counts and subtract the polls. Nobody has built or measured push sync.

## Caveats

- **Latency profiles are estimates.** They rest on the measured network floor plus published structure, not timed
  authenticated searches. No vendor publishes those, and timing them needs a test account. A tail worse than modelled
  favours Eden: it moves the agent's blocking searches into Eden's background.
- **Poll counts are lab conditions.** Each world runs 64 tasks back to back. In production, polls follow each
  source's learned change rate and the user's activity (`syncStaleChance`, `syncMaxStaleMs`, `syncSweepMs`), not
  the task count. Per-task poll costs here are what this pacing gives, not a deployment figure.
- **Cards are a cold-cache upper bound.** The $0.90 per 1,000 tasks is a cold backfill of every item, paid once per
  item lifetime in a deployment.
- **Sonnet and Opus costs are re-priced, not run.** A stronger agent may search differently, so treat those rows as
  estimates.
- **Narrow scope.** One suite (32 templates), 128+128 tasks per arm, one harness (Pi), and Haiku 5.5 everywhere
  measured.

## Reproduce

```bash
W=.local/mkt; L="--spend-ledger $W/ledger.jsonl --spend-cap 4 --spend-headroom 0.3"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
COMMON="--suite heldout13 --variants hidden,control --time-scale 1 --config default --conditions tools,eden"
COMMON="$COMMON --budget 0.6"; P_DIR=packages/sim/lab/before-after/market-profiles
# packages/sim/lab/before-after/market-profiles/{direct,hosted}.json hold the two profiles above.
for P in direct hosted; do for S in 41 42 43 44; do
  bun packages/sim/src/lab/pi-ab.ts $COMMON --seeds $S --cards $PWD/packages/sim/lab/cards/cards-v2.jsonl \
    --cards-out $W/$P-$S.cards.jsonl $H $L --source-profile $P_DIR/$P.json \
    --timeline $W/$P-$S --out $W/$P-$S.json &
done; done; wait
python3 -I packages/sim/lab/before-after/market.py market.md \
  "Direct APIs=$(echo $W/direct-4{1,2,3,4}.json | tr ' ' ,)" \
  "Hosted platform=$(echo $W/hosted-4{1,2,3,4}.json | tr ' ' ,)"
```

`market.py` writes the full tables: every model × connector plan, hidden and control apart, with and without poll
billing, and cost per fact raised. `analyze.py` gives the critical-path, token and cache columns.
