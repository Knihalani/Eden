# Background economy: cheaper cards and sync (track "econ-background")

Status: 2026-10-31, one session, **in-sample only** (dev and held-out 1–4, seeds 41–44). Held-out 5–9 were not run or
read. Live spend $0.0506 of the track's $0.30 cap (178 card-enrichment calls; no agent run). Integrated as D66
("Integration" at the end records what changed against the track).

## The question

The full Pi benchmark (D64, [pi-full-benchmark.md](pi-full-benchmark.md)) put Eden ALL's all-in cost at $0.474 per
1,000 tasks, $0.156 of it a one-time card backfill (about $0.005 per simulated user, ~1,500 items). The track's goal:
cut background cost (card enrichment and sync) by 80% or more, with no loss of facts found.

## What the enrichment reads today (census, no model)

`cards-census.ts` replays the in-sample funnel's 40 simulated users (5 suites × 2 variants × 4 seeds) through the
cache and the prefilter, against the committed card file:

| Per user | Items | Pass D59's prefilter | Get a constraint card |
| --- | --- | --- | --- |
| Mean | 1,503.7 | 166.5 (11.1%) | 63.3 (38% of passed) |

All 268 planted items are a day old; 248 pass the prefilter and 196 get a constraint card.

What passes without being a constraint, by the prefilter word that let it through (6,660 passed items, 40 users):

- "confidential" 2,318 times (1,970 on items carded `none`) and "privileged" 1,880 (1,630): the legal footer
  ("CONFIDENTIALITY NOTICE: This email and any attachments are confidential and may be legally privileged…");
- "do not" 706 (693): a notification footer ("visit your notification preferences. Please do not reply");
- "policy" 1,332 (583): mostly replies whose subject is "Re: Expense policy" and whose own text says nothing.

Each is real mail's boilerplate, not a template quirk of the simulation, so the fix generalises in kind (its size here
is the simulation's).

## Hypotheses and results

The funnel (`hidden-funnel.ts`, no model, cards replayed from disk, `--lead-in clause`, ALL's configuration) gives
facts delivered and decoys; the enricher's counters give items sent to the model and calls. Baseline ALL: **218/268
delivered, 19/268 decoys, 6,660 items sent, 970 calls** (40 users). Cards are worth 15 hidden facts here (ALL without
`cards`: 203/18).

| Change (on ALL) | Delivered | Decoys | Items sent | Calls | Kept? |
| --- | --- | --- | --- | --- | --- |
| Strict prefilter (`strict`) | 218 | 19 | 3,550 (−46.7%) | 784 | yes |
| Sentence reuse (`sentenceReuse`) | 218 | 19 | 5,920 (−11.1%) | 905 | yes |
| Recency: old items carded only when a lookup reaches them (30 days) | 218 | 19 | 6,230 (−6.5%) | 954 | **no** |
| **Economy preset** (`cardsEconomy`: strict + reuse + 20 per call) | **218** | **19** | **2,810 (−57.8%)** | **486 (−49.9%)** | yes |

The strict, reuse and preset runs each delivered the same item on the same path as ALL for every one of the 536 tasks
(task-level diff: 0), as did the preset in the aged stress test below.

**Stress test: old planted items.** Every suite plants a day-old item, so any rule that reads items by age is
untested by default. `--planted-age-days 45` re-dates every planted item 45 days back. ALL: 208/21; the economy preset:
208/21 (same). The recency rule (deferred old items, carded when a lookup first returns them) lost 3 facts here
(205/21: the card arrives one lookup late) and saved only 6.5% of items in the default run, so it was removed.

### The prefilter's strict mode (`worthCardingStrict`)

Same lexicon (`DEONTIC`), read on less: a footer block (a legal disclaimer, a notification-settings footer, from its
first words to the end of its paragraph) is cut, and a reply's or forward's subject is not read (the thread's first message
carries it). On the census it keeps 2,349 of the 2,530 constraint cards (93%) and every planted item. The constraint
cards it loses are items whose only prefilter word sat in the footer (for example "Legal updated the MSA template,
please use v4": a status change the lexicon has no word for).

### Sentence reuse (`sentenceKey`)

Items whose deontic sentences are the same (greeting, sign-off and footer aside) share one card: the model reads the
first, the rest take its card with no call. A sentence dated relative to its message ("tomorrow", "next Friday",
weekdays) gives no key, since the same words then name other days. The reuse is per user: one user's card is never
another's (tested). In the simulation most reuse is one template (the expense-policy reminder re-sent by several
people), so real mail will reuse less; the strict prefilter carries most of the saving.

### Cheaper calls (live, $0.0506)

Per-item cost depends mostly on **which OpenRouter endpoint serves the call**, not on the prompt. Per call, batch of
20, same items:

| Endpoint (glm-5.3-flash) | Calls | $ per call | Output tokens |
| --- | --- | --- | --- |
| OpenInference (fp4) | 30 | 0.000134–0.000145 | 2,648–2,925 |
| Wafer | 14 | 0.000280–0.000305 | 794–931 |
| InferenceNet, CoreWeave, BaseTen, Together, Reka, Cohere, Modal, Morph | 31 | 0.00039–0.00124 | 748–1,761 |

Re-carding all 657 strict-passed in-sample items (batch 20, cap 4,000–6,000 tokens), then replaying each file through
the economy preset's funnel:

| Cards made by | $ per item | Coverage | Delivered | Decoys |
| --- | --- | --- | --- | --- |
| The committed file (D59, default routing, batch 10) | — | — | 218 | 19 |
| Default routing, batch 20 (file not kept) | 0.0000249 | 637/657 | 219 | 23 |
| `sort: "price"`, batch 20 (`econ-price20-v2.jsonl`) | **0.0000151** | 617/657 | **219** | **18** |
| `sort: "price"` + `max_price` 0.05/0.25 $/M (OpenInference only) | 0.0000075 | 577/657 | **207** | 18 |

Re-carding alone moves the funnel by about ±1 fact and ±4 decoys (default routing: 219/23), so price-sorted routing is
within that noise. A price ceiling that forces the fp4 endpoint loses 11 facts (its long reasoning cuts batches off,
and its cards are worse), so it is rejected. Pooled over every run this session, default routing cost $0.0000245 per
item (997 items) and price-sorted $0.0000144 (897 items): **−41%**.

Also measured and rejected (40–100-item pilots against the committed cards; a re-run of the same prompt agrees with
them on 0.82–0.93 of items, the noise floor):

- `reasoning: "none"`: glm-5.3-flash refuses it (reasoning is mandatory). `"minimal"`: no saving (862 against 899
  output tokens per call).
- The lean prompt (byte-stable system prefix, terse cards): recall against the committed cards 0.70 at batch 25 (0.88
  for the standard prompt).
- Cheaper models (ZDR endpoints only): mistral-nemo $0.0000037 per item but recall 0.47; gpt-oss-20b $0.0000139, recall
  0.58; qwen3.7-flash has no ZDR endpoint.
- Batch 50: the 2,000-token cap cut both calls off (no cards). Batch 20–25 per-item cost was within routing noise of
  batch 10; it halves calls, not dollars.
- Prompt caching: OpenRouter reported cached input on some calls (128–1,664 tokens), unpredictably by endpoint. Input
  is about a third of a call's cost on the cheap endpoints, so even a fully cached 700-token system prompt saves under
  10%; not modelled as a saving.

### Cost per user (arithmetic on the measurements above)

| | Items read per user | $ per item | One-time backfill per user | Per user-month (50 items/day) |
| --- | --- | --- | --- | --- |
| ALL (D59 cards) | 166.5 | 0.0000245 | $0.0041 | $0.0041 |
| Economy preset, default routing | 70.25 | 0.0000245 | $0.0017 (−58%) | $0.0017 |
| **Economy preset + `sort: "price"`** | 70.25 | 0.0000144 | **$0.0010 (−75%)** | **$0.0010** |

The per-month line assumes new items pass the filters at the in-sample rate (4.7% of items read). Applied to the
benchmark's card share ($0.156 per 1,000 tasks), the backfill would be about $0.039, Eden ALL about $0.36 per 1,000
tasks instead of $0.474 (arithmetic, not a live run). **The 80% target is not met with no loss of facts: 75% is.**
The one setting that reaches 87% (the price ceiling) loses 11 of 218 facts.

## Sync

### Source calls per user-day (`sync-econ.ts`, simulated arrivals)

One user, three working days after the backfill, items arriving at assumed rates (per working day: mail 60, chat 150,
calendar 6, docs 8, CRM 4; 3% deleted the same day), 30 lookups a day, the sync ticking every five minutes. Every mode
holds 99.8–99.9% of the items that arrived a minute or more before a lookup.

| Mode | Calls / user-day | In lookups | Per lookup | Deleted items still held | Delay p50 / p90 |
| --- | --- | --- | --- | --- | --- |
| D57 (on-demand polls, daily sweep) | 104.7 | 79.0 | 2.63 | 64.6% | 13.2 / 55.4 min |
| Timed polls every 15 min | 252.3 | 49.7 | 1.66 | 67.4% | 6.9 / 14.6 min |
| Push, notices read at the next tick | 151.0 | 31.7 | 1.06 | 0.4% | 2.3 / 4.6 min |
| **Push, background reads at most every 30 min** (`syncPushGapMs`) | **79.3 (−24%)** | 55.3 | 1.84 | **0.4%** | 8.2 / 27.9 min |
| Push, read only by lookups | 65.3 | 64.7 | 2.16 | 0.4% | 12.5 / 55.4 min |

Push (`syncPush`): the tenant relays its connectors' change notices (Gmail watch, Calendar push channels, Slack Events,
Drive changes) to `ContextPartner.sourceChanged`; a source that has declared a watch (`sourcePushes`) is current until
a notice arrives, a notice is read with one incremental read-only list call, and one naming deleted items drops them
at once. A notice carries no content (Eden reads the change itself, D7), and notices for a user not synced start
nothing. The busiest source sets the call count: chat at 150 messages a day. Slack's Events API carries the message
itself, which would remove those calls, but that puts tenant-relayed content into the index; not done.

### Push in the funnel

The simulated worlds do not change while tasks run, so a pushed source never gets a notice: the funnel measures the
polls push saves. ALL makes 5.55 request-time calls per task (2.90 of them on-demand listing polls) and 6.89 with the
backfill amortised. With push (`--push`):

| | Delivered | Decoys | Request-time calls / task | Amortised calls / task |
| --- | --- | --- | --- | --- |
| Economy preset | 218 | 19 | 5.55 | 6.89 |
| Economy preset + push, first version | 213 | 16 | 0.00 | 1.34 |
| **Economy preset + push, confirmed sources read as current** | **218** | **21** | **0.00** | **1.34** |

The first version lost five facts, the same five as a run that simply never let sources go stale (213/16), so it was
not push. The cause: an item counts as stale for the anticipated early decision and the fast path when the sync last
listed it more than `refreshAfterMs` (2 h) ago (D57's rule), and the on-demand polls had been re-listing the newest
page (where the planted item sits) at every lookup. A pushed source with no unread notice is known current, so its
items now count as read at the lookup (`SyncManager.confirmed`, `readAt`); with that, all 218 return, at two more
decoys (allergy, seed 44; po-threshold, seed 44: both on the `sources` path).

## Recommendation

- **`cardsEconomy`** (off by default) for every configuration with `cards`: −57.8% items read and −49.9% calls at
  identical funnel results, task by task, in-sample and in the aged stress test.
- **`sort: "price"`** on the background card maker's `OpenRouterModel` (an integrator's option, documented in
  COST-MODEL.md; the judge keeps default routing): −41% per item, within re-carding noise on facts and decoys. Together:
  **−75% card cost per user**, one-time and monthly.
- **`syncPush`** (off by default) where the tenant can relay its connectors' notices: request-time listing calls go
  to zero in the funnel, deletes propagate in seconds rather than 48 h, and with `syncPushGapMs` 30 minutes the
  background calls fall 24% against D57 in the arrival simulation. Two more decoys in-sample (21 against 19 of 268).
- Rejected: the recency deferral (loses facts when constraints are old), the price ceiling (loses 11 facts), cheaper
  models, reasoning off, the lean prompt.

## Limits

- In-sample only: the strict prefilter's footers and the sentence reuse were found by reading these worlds' items;
  held-out 5–9 decide.
- The simulation's mail is templated: 22 expense-policy reminders per user inflate sentence reuse, and its footers may be
  more uniform than real ones. The track's footer regex cut to the end of the message, which would also have cut a
  constraint written after a disclaimer (none in these worlds); the integration cuts only the footer's block.
- Live card cost per item varies 2–8× by endpoint and OpenRouter's routing; each configuration had one full run
  (657 items). The −41% is from pooled runs, not a paired experiment.
- The sync numbers come from assumed arrival rates and a five-minute tick, not real connectors; no real webhook was
  wired (the server has no notice route yet).
- No agent was run: the effect on facts found is the no-model funnel's, not the live benchmark's.

## Reproduce

```bash
# Census of what enrichment reads (no model):
bun packages/sim/src/lab/cards-census.ts --cards packages/sim/lab/cards/cards-v2.jsonl
# Funnel (in-sample), CFG = ALL (pi-full-benchmark.md) and ECON = ALL + {"cardsEconomy": true}:
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --lead-in clause --config "$ECON" --cards packages/sim/lab/cards/cards-v2.jsonl --json out.json
#   one setting at a time: --config "$CFG" --card-limits '{"strict":true}'; aged: --planted-age-days 45;
#   push: --config "$ECON + syncPush" --push; other card files: --cards packages/sim/lab/cards/econ-price20-v2.jsonl
# Re-carding (live; meters every call into --spend, stops at --cap):
bun packages/sim/src/lab/cards-enrich.ts --dir DIR --funnel hidden,heldout,heldout2,heldout3,heldout4 --strict \
  --batch 20 --sort price --spend DIR/spend.jsonl --cap 0.28
# Sync modes (no model):
bun packages/sim/src/lab/sync-econ.ts --days 3
```

Card file: `econ-price20-v2.jsonl` (sha256 `a4200cbe…0668`), the price-routed re-card, kept for `ALL2`'s funnel and
replay. The default-routed re-card (`econ-default20-v2.jsonl`) was not kept: nothing replays it.

## Integration (D66)

The track's branch was merged on top of D65 (`syncPollBehind`) with these changes; numbers from this integration's
session, no model, `--lead-in clause`, cards replayed from `cards-v2.jsonl`:

- **Footer cut limited to the footer's block.** `FOOTER` now cuts from a footer's first words to the end of its
  paragraph (a blank line), every such block, not to the end of the message; a test has a constraint after a
  disclaimer. In these worlds every footer ends its message, so the funnel is unchanged: ALL 218/19, the economy preset
  218/19 with the same counters as the track (2,810 items sent, 486 calls, 740 reused by sentence), 0 of 536 tasks
  differing from ALL or from the track's run.
- **A cut batch is retried with default routing.** Price routing cut off batches at the output cap (617 of 657 covered
  against 637). `ModelCardMaker` reports `truncated`, and `CardEnricher` sends such a batch once more with `retry`,
  which `CardMakerOptions.retry` routes to the default-routed model, under a reservation of its own; its cards fill
  only what the cut call left unread, and a retry cut off too is not sent again. `cards-enrich.ts --sort price` and
  `pi-ab.ts --card-sort price` do the same. Not measured live (no spend in this stage): the coverage gain is expected
  to recover the 20 items, at about 6% more items read at the default price.
- **Unrecommended options dropped:** the lean prompt, `reasoning` "none"/"minimal", the card maker's `maxTokens`
  override, and OpenRouter `maxPrice` (their measurements stay above). `sort` and the endpoint report (`provider`) stay.
- **Push sweeps every 3 days, not 7.** A sweep is also what re-lists a quiet pushed source's older items, and a synced
  item lapses from the cache 7 days after its last listing; a sweep spans many ticks on a large source, so with a
  7-day sweep its first pages' items lapsed before the next sweep re-read them (a test: 684 item-ticks missing over 8
  days of five-minute ticks, none at 3 days). `sync-econ.ts --days 3` is unchanged (no sweep falls due); over 7 days
  D57 makes 111.6 listing calls per user-day and push with the 30-minute gap 87.9 (−21%).
- **Push with poll-behind.** A pushed source with no unread notice is current, so a lookup polls it neither on the path
  nor behind; a source with an unread notice, or whose watch has lapsed (`syncPushMaxStaleMs`), is polled behind the
  lookup with `syncPollBehind`, never on the path (tests).

