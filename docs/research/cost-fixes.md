# Cutting Eden's cost: lean intent reads and change-notification sync (D125)

Status: 2026-11-04. Measured on the Pi harness, both market latency profiles (eden-market-effect.md), Haiku 5.5
everywhere, blind held-out 13, seeds 41–44: 128 hidden and 128 control tasks per profile. Hermes results are in the
section of that name. Every number comes from a command run in this session.

## In plain words

Eden's cost had two separate causes, depending on how a customer pays for connectors:

- **Model spend** (it matters most on free first-party APIs with a cheap agent). Per 1,000 tasks Eden spent $0.90 on
  cards, $0.45 on its reader and $0.32 on the agent's own calls. Cards were 55% of it. Of the items the intent index
  read, 88% were read only for intent, most of them automated mail or months old.
- **Connector calls** (they matter on platforms that bill per call). Eden polled the user's sources 3.4–3.9 times per
  task to keep its synced copy fresh. On a $12-per-1,000-calls platform that was most of the bill.

What changed:

1. **`cardsLean`** (now in the default): an item the card prefilter rejects is read for intent only when a person wrote
   it (not a no-reply sender, bulk category or bulk footer) and it is dated within 30 days or upcoming. Items with
   constraint wording are read as before, whatever their sender or age. **Card spend fell from $0.90 to $0.39 per
   1,000 tasks (−57%).**
2. **`syncPush`** (now in the default) plus a new integration API: an integrator that receives the provider's change
   notifications forwards them (`POST /v1/sources/changed`), or the changed items themselves
   (`POST /v1/sources/items`). A notifying source is no longer polled on a guess. **With item-carrying notifications,
   Eden's connector calls fell from 3.8–5.1 to 0.6–0.8 per task (−82% to −85%). With Eden, total connector calls are
   now 38–61% below the agent alone's** (61% on tasks with something to find). With signal-only notifications the
   count barely moves, because a busy inbox really does change every hour.
3. **Coalescing parallel asks** (two `ask_context` calls at once sharing one reader call) was built, measured and
   **deleted**. It would save about 20% of reader calls (about $0.09 per 1,000 tasks), and the paired results on the
   tasks it touched leaned the wrong way (old Eden won 12, new won 7). D116 had found the same about reusing readings.
4. **Prompt-cache placement** was checked and needs no change. Pi's provider layer sends Eden's packet as a native
   system message after the cached system prompt and tools. The lower cache-read share with Eden comes from the agent
   making fewer model calls, not from a broken cache.

Quality is unchanged. Against the old default rerun on the same tasks in the same hour (both profiles pooled, 256
hidden tasks), hidden facts raised went +0.0 points (95% CI −4.3..+4.7) with signals and −0.4 (−5.9..+5.1) with
payload. False concerns moved within ±1 point. The first market run's 80.5% was a high draw: the unchanged default,
rerun, scored 77.3% and 73.4%.

## The runs

Each arm reuses the same agent-alone arm (`--reuse-arms` from the market-effect runs), so the comparison is Eden
against Eden on the same tasks:

| Arm                        | Configuration                        | Push mode                                                                                           |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| OLD (`c-*`)                | main's default, rerun now            | — (sources do not notify)                                                                           |
| NEW, signals (`a-*`)       | `cardsLean` + `syncPush`             | `signals`: notifications at assumed rates (inbox 4/h, chat 6/h, calendar and docs 0.3/h, CRM 0.2/h) |
| NEW, payload (`p-*`)       | `cardsLean` + `syncPush`             | `payload`: notifications carry their items (no poll needed)                                         |
| NEW + coalescing (`sig-*`) | the above + `askReaderCoalesceMs` 25 | `signals`, before the harness's `notifies` fix (see "What went wrong")                              |

### Quality and speed (Pi)

|                                                | Direct OLD         | Direct NEW payload | Hosted OLD         | Hosted NEW payload |
| ---------------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ |
| Hidden facts raised                            | 77.3%              | 77.3%              | 73.4%              | 72.7%              |
| False concerns                                 | 0.8%               | 2.3%               | 1.6%               | 1.6%               |
| Wall, hidden tasks, p50 / p90 / mean (s)       | 3.49 / 7.09 / 4.29 | 3.64 / 6.79 / 4.26 | 3.58 / 7.15 / 4.41 | 3.46 / 6.71 / 4.16 |
| Wall, control tasks, p50 / p90 / mean (s)      | 5.75 / 7.12 / 5.48 | 5.63 / 7.13 / 5.32 | 6.01 / 8.35 / 6.07 | 5.28 / 7.07 / 5.07 |
| Connector calls per hidden task: agent + Eden  | 0.61 + 3.83        | 0.71 + 0.61        | 0.65 + 4.24        | 0.63 + 0.78        |
| Connector calls per control task: agent + Eden | 1.30 + 3.98        | 1.34 + 0.61        | 1.28 + 5.06        | 1.25 + 0.78        |

The agent alone made 3.42–3.64 connector calls per hidden task and raised the hidden fact in 9.4% (direct) and 5.5%
(hosted) of tasks. NEW with signals scored 75.0% and 75.8%, with Eden's calls at 3.71–4.70 per task.

Paired against OLD, both profiles pooled (bootstrap, 4,000 resamples):

| NEW − OLD            | Hidden (n = 256)  | Control (n = 256) |
| -------------------- | ----------------- | ----------------- |
| signals              | +0.0 (−4.3..+4.7) | −0.4 (−2.0..+0.8) |
| payload              | −0.4 (−5.9..+5.1) | +0.8 (−0.8..+2.3) |
| signals + coalescing | −1.2 (−6.2..+3.9) | −0.4 (−1.2..+0.0) |

### Eden's model spend per 1,000 tasks (Pi, both profiles, hidden and control pooled)

|              | Agent  | Reader | Cards and intent (cold-cache upper bound) | Total  |
| ------------ | ------ | ------ | ----------------------------------------- | ------ |
| OLD          | $0.318 | $0.448 | $0.900                                    | $1.666 |
| NEW, payload | $0.323 | $0.458 | $0.387                                    | $1.168 |
| NEW, signals | $0.316 | $0.437 | $0.402                                    | $1.155 |

On the $0 train screen (cards and intent replayed, train1–6 seeds 41–42), `cardsLean` sent 13,604 items to the card
model instead of 35,700 (−62%) in 822 calls instead of 1,809 (−55%). Hidden surfaced went 245 → 243 and decoys
232 → 228, and the hidden item reached the reader's pool slightly more often (255 → 257). Of the 85 planted items the
prefilter rejects, 81 are still read for intent.

### Cost per 1,000 tasks, agent + Eden (10% hidden, 90% control; direct profile)

The agent is re-priced per model from each request's token split, which is an estimate for Sonnet and Opus (they may
use tokens differently). Connector plans are those of eden-market-effect.md.

| Agent model | Connectors                 | Agent alone | OLD Eden       | NEW Eden, payload |
| ----------- | -------------------------- | ----------- | -------------- | ----------------- |
| Haiku 5.5   | First-party APIs ($0/call) | $0.36       | $1.77 (+399%)  | $1.25 (+250%)     |
| Haiku 5.5   | Composio ($0.30/1k)        | $1.39       | $3.33 (+140%)  | $1.81 (+30%)      |
| Haiku 5.5   | Pipedream ($12/1k)         | $41.67      | $64.14 (+54%)  | **$23.84 (−43%)** |
| Haiku 5.5   | Zapier MCP ($25.8/1k)      | $89.18      | $135.85 (+52%) | **$49.82 (−44%)** |
| Sonnet 5.5  | First-party APIs           | $7.11       | $8.39 (+18%)   | $7.69 (+8%)       |
| Sonnet 5.5  | Composio                   | $8.15       | $9.95 (+22%)   | $8.25 (+1%)       |
| Sonnet 5.5  | Pipedream                  | $48.43      | $70.75 (+46%)  | **$30.28 (−37%)** |
| Opus 5.5    | First-party APIs           | $13.80      | $15.18 (+10%)  | $14.25 (+3%)      |
| Opus 5.5    | Composio                   | $14.83      | $16.73 (+13%)  | $14.82 (−0%)      |
| Opus 5.5    | Pipedream                  | $55.12      | $77.54 (+41%)  | **$36.84 (−33%)** |

Hosted profile, same mix: Haiku on first-party APIs $0.33 → OLD $1.73, NEW $1.24; on Pipedream $39.97 → OLD $76.11
(+90%), NEW $24.87 (−38%); Sonnet on Pipedream $46.33 → OLD $82.50, NEW $31.48 (−32%).

With signal-only notifications (direct): Haiku on first-party $1.24 (+248%), on Pipedream $61.77 (+48%); Sonnet on
first-party $7.88 (+11%). The model saving holds, but the connector saving needs notifications that carry their items.

## What the payload arm does not show

- **The lab world does not change during a run**, so in `payload` mode no notification is ever sent. The arm is
  "sources marked notifying, never told anything": its 0.6–0.8 calls per task are the daily sweep and the 24-hour
  safety poll. It cannot show a quality loss from a stale copy, because nothing becomes stale. A real deployment adds
  the items pushed and, for a notification that carries no items, one poll.
- **What it costs to receive notifications is not counted.** A connector platform may bill each trigger run, and a
  Gmail push carries only a history id that the integrator turns into items with a `history.list` call of its own.
  The cost tables count only the calls Eden and the agent make.
- **False concerns per profile:** direct OLD 1/128 against NEW payload 3/128, hosted 2/128 against 2/128. Pooled the
  change is +0.8 points (−0.8..+2.3); on the direct profile alone it is +1.6 points, within its noise and not a
  measured regression, but stated here under the precision rule.

The review of this change found that pushed items could make the next poll stop early and miss an older unannounced
change. A poll now ignores items pushed since the last complete poll when it looks for where its listing reaches what
was synced before (`sync.test.ts`, "pushed items are not taken for the poll's boundary"). The lab runs above predate
that fix; in a static world it changes no call.

## Why signal-only notifications save so little here

The lab advances Eden's clock an hour between tasks. At the assumed rates, a busy inbox (4 changes an hour) and chat
(6 an hour) are almost always changed by the next task. A signal then costs the same poll the old learned rate would
have made. The rest of Eden's listing calls is the daily sweep that propagates deletions: about 0.46 calls per task
for a 1,100-mail inbox. A notification that carries the changed item needs no poll, and the source's only listings are
that sweep and the 24-hour safety poll (`syncPushMaxStaleMs`). Slack's Events API, Microsoft Graph notifications with
resource data and the connector platforms' triggers carry items. A Gmail push carries only a history id, and the
integrator turns it into items with one `history.list` call of its own.

## Hermes

The Hermes section is added when its run finishes (`h-41-42`, `h-43-44`: Hermes alone, the new default, and the old
default as variant `OLD`, direct profile, payload notifications).

## What went wrong

- **The first notification runs did nothing.** The Pi harness wraps every sim source in a timing wrapper that copied
  `listsByTime` but not `notifies`, so the sync never saw a notifying source. The coalescing runs (`sig-*`) were made
  that way and are kept only for their coalescing comparison. The wrapper now copies `notifies`. The engine's own span
  wrapper had the same gap; its lookups never reach the sync, but it now copies the flag too. Every later run
  (`a-*`, `p-*`) was made after the fix.
- **A test hung.** A sync test with a 2-item page and a frozen clock ran out of rate-limit tokens after 8 calls and
  never warmed. It now backfills in one page.
- **Hermes's `mcp` extra was missing** in a fresh checkout, so every `hermes+eden` stream stopped. LAB.md now names
  `uv sync --frozen --no-install-project --extra mcp`.

## Reproduce

```bash
W=.local/mkt; N=.local/fix; L="--spend-ledger $W/ledger.jsonl --spend-cap 12 --spend-headroom 0.3"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
P_DIR=packages/sim/lab/before-after/market-profiles
for P in direct hosted; do for S in 41 42 43 44; do
  # --config default is the new default; '{"cardsLean":false,"syncPush":false}' is the old one.
  bun packages/sim/src/lab/pi-ab.ts --suite heldout13 --variants hidden,control --time-scale 1 --config default \
    --conditions tools,eden --budget 0.6 --seeds $S --cards $PWD/packages/sim/lab/cards/cards-v2.jsonl \
    --cards-out $N/p-$P-$S.cards.jsonl $H $L --source-profile $P_DIR/$P.json --push payload \
    --reuse-arms $W/$P-$S.json --timeline $N/p-$P-$S --out $N/p-$P-$S.json &
done; done; wait
python3 -I packages/sim/lab/before-after/market.py p.md \
  "Direct=$(echo $N/p-direct-4{1,2,3,4}.json | tr ' ' ,)" "Hosted=$(echo $N/p-hosted-4{1,2,3,4}.json | tr ' ' ,)"
# $0 screen: bun run funnel --jobs 4 --set '{"cardsLean":false}' -- --intent intent-v2.jsonl (gunzip
# packages/sim/lab/distilled/intent-v2.jsonl.gz), against the default.
```

## Spend

Pi runs in this note: $2.76 (coalescing $0.61, signals $0.63, payload $0.63, old-default rerun $0.89). The Hermes run
is listed in its section.
