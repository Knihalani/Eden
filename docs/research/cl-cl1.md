# CL1: read at ingest (H1), verdict reuse (H2), a local reader (H15)

Status: 2026-11-07, session CL1 of the cost-and-latency wave ([cost-latency-plan.md](cost-latency-plan.md)). Every
paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5`, through the lab provider (D97), on the
ledger `.local/cl1/ledger.jsonl` with a $4 cap: **Anthropic-direct lab figures**. Decisions D233–D235.

## In plain words

- **H1 failed its screen, so it is deleted (D233).** The idea: when an item is read in the background, a model also
  writes which requests it would bind and under what conditions; at request time a no-model matcher checks the
  request against that and the reader is only called for unclear pools. Built, measured on train with the paid reader
  replayed, and dropped. The best safe version cut reader calls by **4%** on train (643 → 615) and decided **4 of 100**
  nothing-to-add pools on heldout14 (read; cost only). Every looser rule that decided more pools lost hidden facts the
  reader finds: deciding a third of train's pools lost about 100 of the reader's ~250 planted flags.
- **Why it fails.** Two different things, measured separately:
  1. Judging an item alone, without the request, the model disagrees with the reader on about one planted item in
     ten: it says "binds nothing" for 32 planted items the reader flags (prompt v2), and an item's conditions (its
     days, its party) are often stated in ways that do not line up with the request.
  2. The no-model matcher cannot tell whether a request is one of the requests an item binds. Retrieval puts items
     that share the request's words in the pool, so almost every pooled item shares a term or two with the request
     whether it binds it or not. On neutral heldout14 pools, 38 of 88 pools had six or more such items. This is the
     same wall D110 and D157 hit with features learnt from the reader's labels; here the model writes the rule, but the
     match back to the request is still lexical.
- **H2 is not built (D234).** Reusing a reader verdict across one user's sessions saves at most **1.08x** of calls
  when the input must be identical (the only safe key), 1.16x if the pool alone matches (unsafe: a verdict is about its
  request) and 1.38x for an oracle memo, on simulated sessions whose templated requests overstate repeats.
- **H15: a local model is not a reader yet (D235).** Scored on the same 530 train request/item pairs the reader
  read (planted against decoy), small local models reach planted-vs-decoy AUC 0.46–0.60 (cross-encoders) and
  0.44–0.61 (0.5B and 1.5B instruct models, yes/no logit), against Haiku's 0.90 and D147's bar of 0.85. Not built.
- **Short and long horizon live runs were not made**: nothing passed the $0 screen (as D190 and D194 did, a lever
  that fails the screen gets no live run). Spend: **$0.195** of the $4 cap.

## H1: what was built

Trial switch `readAtIngest` (off), all of it in commit `aea45d62` and deleted in the next commit:

- `applicability.ts`: per item, `{b: requests it binds (user words), k, why, who, from, until, over}`, `b: []` for
  "binds nothing" (lifted, resolved, cancelled, news). Its own background call (`ModelApplyMaker`, no reasoning),
  through the card enricher's budget, in a drain of its own beside the card drain (inside the card drain it delayed
  cards past their requests: 44 reader prompts changed, 312/131 with no decision made). Items fenced and redacted as
  the card prompt does (D10, D11); records bounded and redacted.
- Which items get a record: every item the card model reads (bulk mail excepted), and of the rest those the reader
  gate's wording test calls constraint-like. The first version gave records only to constraint-like items and missed
  most planted items: the reader flags "All done, submitted on Friday", which no constraint wording names.
- The matcher (in `readAsk`, after the reader gate): a pool is decided with no call when every item is inert, binds
  nothing, or shares no term with any request its record binds; items that bind nothing are rejected by name (as the
  reader's lookalikes, D96). Anything else, or an item with no record yet, sends the pool to the reader unchanged (the
  reader's prompt is byte-identical, so the replay still hits).
- Lab: `apply-disk.ts` (records keyed by prompt version and content hash), `hidden-funnel.ts` `--apply`,
  `--apply-model` (live, metered), `--apply-only` (a top-up limited to items that reach a pool: the engine's decision
  on those pools is then what full coverage gives), `--apply-log`, and `--card-model`/`--cards-out`.

## H1: the screen (train1–6, seeds 41–42, paid Haiku reader replayed, LAB.md recipe 2a)

| Run | Reader calls | Hidden | Decoys | Note |
| --- | --- | --- | --- | --- |
| default (baseline) | 643 | 313/384 | 127/384 | 0 misses |
| trial on, no records (own drain) | 643 | 313 | 127 | identical: the switch alone moves nothing |
| v1 records (constraint-like items), bind and not rules | 565 | 310 | 146 | listed-only decoys 37 → 60 |
| v1, records for every read item | 561 | 308 | 141 | |
| v2 prompt (done items bind), day rule on named days only | 609 | 311 | 133 | |
| **final: no bind without the reader, no day rule** | **615** | **312** | **129** | −4.4% calls |

Per pooled item, prompt v2 against the paid reader's flags (train, both seeds; one row per item per pool read):

| Matcher's call | Planted, reader flagged | Planted, not flagged | Other items, flagged | Other, not flagged |
| --- | --- | --- | --- | --- |
| binds nothing | 32 | 184 | 10 | 6,309 |
| outside the record's days | 32 | 30 | 16 | 2,174 |
| shares no term | 20 | 32 | 46 | 2,072 |
| no phrase term, a party or bearing term shared | 4 | 4 | 8 | 624 |
| bind (a phrase mostly in the request) | 110 | 68 | 38 | 130 |
| ambiguous, 1 shared term | 144 | 54 | 193 | 2,885 |
| ambiguous, 2+ shared terms | 205 | 100 | 96 | 1,048 |
| inert (no record wanted) | 8 | 24 | 8 | 1,989 |

An offline grid over the bind and not thresholds (pools decided when no item is ambiguous): 404–733 of 1,278 pools
decided lost 96–179 planted flags; the precision-first rule decided 64 pools and lost 6. Pruning "binds nothing" and
inert items from the reader's input (a diet instead of a skip) would remove 46% of pool items and 40 of 555 planted
flags. Neither is acceptable under D3.

Neutral turns (heldout14, read before, used for cost only, rule fixed on train first; cards, intent and records made
live for its items, stub reader): 100 reader reads on 64 neutral tasks, 4 decided by the matcher, 12 gated.

### Cost of the records

Heldout14 seeds 41–42 (full batches, every item wanted): cards and intent $0.0389 for 2,228 items sent; records
$0.0184 for 3,911 items ($0.0000047 an item): **+47% on the background spend** for a 4% cut of reader calls. The
train top-ups ran in small batches (only pooled items), $0.0000433 a record.

## H2: reader verdict reuse

`bun run gate-traffic --reuse` (seeds 41–44, 40 sessions each, simulated; no model):

| Preset | Reader calls | Exact input reused | Same pool | Same type and binding set (oracle) |
| --- | --- | --- | --- | --- |
| default | 65 | 5 (1.08x) | 9 (1.16x) | 18 (1.38x) |
| default without the gate | 87 | 8 (1.10x) | 14 (1.19x) | 33 (1.61x) |

The engine already reuses the push's verdict for the same request's ask (D193). Across sessions only the exact input
is safe, and its ceiling is under every bar the plan set; not built.

## H15: a local yes/no reader (research)

The same 530 train pairs the Haiku reader read (request, planted or decoy item as rendered for the reader, 240
characters; hidden 281, control 249). Haiku flags 255/281 planted and 25/249 decoys (binary AUC 0.90). Local models,
CPU (4 cores, torch 2.15 CPU), no fine-tuning:

| Model | Size | Score | AUC planted vs decoy | ms a pair |
| --- | --- | --- | --- | --- |
| cross-encoder/ms-marco-MiniLM-L6-v2 | 22M | relevance | 0.457 | 24 |
| cross-encoder/nli-deberta-v3-small | 141M | entailment of "should not simply do" | 0.596 | 85 |
| Qwen2.5-0.5B-Instruct | 0.5B | logit Yes − No, reader-style instructions | 0.436 | 774 |
| Qwen2.5-1.5B-Instruct | 1.5B | logit Yes − No, reader-style instructions | 0.608 | 2,075 |

A pool of 12 items is 12 pairs, so even the fastest is a few hundred ms of CPU per request per core, and a model of
the size that might reach the bar is seconds on CPU. Hosting it means a model runtime dependency (D22) and GPU or
large-CPU capacity per process; D147's bar (AUC ≥ 0.85) is not met by anything measured here. Options left for a
later session: fine-tune a small model on the reader's labels (`labels-train.jsonl` holds 30,924 pairs, D110), or a
hosted small open model behind the same `Budget` (a model call either way).

## Commands

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
# (on commit aea45d62) the screen at $0, records replayed:
bun run funnel --jobs 4 --allow-misses --set '{"readAtIngest":true}' -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl \
  --apply .local/cl1/apply-v2.jsonl --apply-log .local/cl1/alog4.jsonl
# the metered top-up of records for pooled items (one process):
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hidden-funnel.ts --suite train --seeds 41,42 --ask --no-record \
  --allow-misses --config '{"readAtIngest":true}' --cards packages/sim/lab/cards/cards-v2.jsonl \
  --intent packages/sim/lab/distilled/intent-v2.jsonl.gz --reader replay --reader-model claude-haiku-5-5 \
  --reader-cache .local/reader-haiku-train-4142-intent.jsonl --apply .local/cl1/apply-v2.jsonl \
  --apply-model claude-haiku-5-5 --apply-only .local/pool-hashes.txt \
  --spend-ledger .local/cl1/ledger.jsonl --spend-cap 4 --spend-headroom 0.2 --run-label cl1-apply-v2-topup
bun run gate-traffic --reuse
```

## Spend

| Ledger run | Role | $ |
| --- | --- | --- |
| cl1-apply-sample, cl1-apply-topup, cl1-apply-topup2 (prompt v1) | eden.apply | 0.0591 |
| cl1-apply-v2-topup (prompt v2, train) | eden.apply | 0.0686 |
| cl1-apply-h14, cl1-h14-cards-apply (heldout14 records) | eden.apply | 0.0280 |
| cl1-h14-cards-apply (heldout14 cards and intent) | eden.cards | 0.0389 |
| **Total** | | **0.1947** |
