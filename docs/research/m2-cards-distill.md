# M2: can a small open model write Eden's background cards instead of Haiku?

Status: 2026-11-10, session M2, finished: not promoted (D446). Lab study only: nothing here is wired into product code.
Every paid figure is Modal GPU time at Modal's published per-second list prices (checked on modal.com/pricing on
2026-11-10; the same rates as `distill_data.GPU_USD_PER_HOUR`); Anthropic spend $0. Decisions D445–D449. Weights stay in
the Modal Volume **`eden-cards-distill`** (`/models/<run>/merged`); only metrics are in the repository.

## In plain words

- **The cards: yes.** A 1.5-billion-parameter open model (Qwen2.5-1.5B-Instruct, Apache-2.0), fine-tuned with LoRA
  on Haiku's own cards for the train worlds, writes the constraint cards as well as Haiku does for what Eden reads.
  On held-out items it agrees with Haiku's constraint flag at precision 0.80 and recall 0.81, better than the cards
  the funnel replays today (0.75 and 0.65), and in the funnel its cards with Haiku's requests find 321 hidden facts
  against the teacher's own 318 (decoys 277 against 278).
- **The requests: not yet.** The same call also writes up to four "requests this item would bear on" for every item
  (the intent index, D87). The small model's requests are worse, and that loses hidden facts: through the funnel it
  reads hidden 303 and decoys 282 against the default's 314 and 273. It fails the bar written before the run
  (hidden ≥ 312, decoys ≤ 273), so it is **not promoted** (D446). Every lost fact traces to the requests, not the
  cards (the swap table below).
- **The bigger model trades one miss for another.** Qwen3-4B-Instruct-2507 on the same data keeps the hidden facts
  (317) but its wider requests surface more decoys (289), so it fails the same bar on the other side; and at 4B it
  costs what Haiku costs.
- **Cost: cheaper only when busy.** On one L4 GPU at 16 calls at once it costs about **$0.013 per 1,000 items**
  against Haiku's **$0.051** (4x cheaper). One call at a time it costs $0.133 (2.6x dearer), and the GPU bills while
  idle and takes minutes to start cold. Haiku's per-item price is the same at any traffic; a GPU only wins as a shared
  service carding many users' backfills at once. Latency per call is similar (p50 5.0 s against Haiku's 5.4 s).
- **Spend:** Modal $9.51 of the $80 cap (billing report, below); Anthropic $0.

## Pre-registered promote bar (written before step 4, the funnel through the endpoint)

Committed before any funnel run through a distilled model (commit effdba7d). A model passes only if all of these hold:

1. **Parses.** Item parse rate ≥ 0.95 on the 61 held-out rows (719 items), by Eden's own `parseCards`/`parseRequests`.
2. **Constraint flag against Haiku, held-out.** Recall ≥ 0.65 and precision ≥ 0.75: no worse than the cards the
   funnel replays today (`cards-v2.jsonl` + `cards-train.jsonl`, mixed teachers), which agree with Haiku's
   `intent-v2` flag at precision 0.75 (24/32) and recall 0.65 (24/37) on the 83 held-out items they cover.
3. **Funnel, train1–6, seeds 41–42** (`bun run funnel --cards-endpoint URL`): hidden surfaced ≥ 312 (the default's
   314 minus 2) and decoys surfaced ≤ 273 (not up), task-by-task diff with `--baseline` read and reported.
4. **Cost.** GPU dollars per 1,000 items carded (measured GPU-seconds × list price, at the serving shape measured)
   below Haiku's per-item cost from the ledgers quoted in docs/COST-MODEL.md.

Added before step 4, after a $0 control run (commit 9dbb4e6a): the funnel with **Haiku's own `intent-v2`
cards replayed** (the teacher the model learns from, in place of the mixed-teacher replay) reads hidden 318, decoys
278 on the same suites and seeds. So the bar in (3) is against the shipped replay as asked; a secondary line,
reported but not a gate, compares with the teacher: hidden ≥ 316 and decoys ≤ 278.

Added after the first tuned model's eval (q15-a), before any other tuned model was scored: the shipped default
keeps a card only for items its strict prefilter passes (`cardsEconomy`, `worthCardingStrict`); for any other item
the enricher drops whatever card the model wrote (`NONE_CARD`, cards.ts). The scorer now also reports the flag on
those **kept** items only (89 of the 719 held-out items; Haiku flags 61 of them). On them the replayed cards read
precision 0.74 (23/31), recall 0.68 (23/34) over the 55 they cover. Bar (2) is read on both views and reported on
both; it is not loosened.

Failing (1)–(3) means no decision to build; failing only (4) means "works, not cheaper" and is written so.

## Step 1: the data

`bun packages/sim/src/lab/cards-distill.ts export --out .local/modal/cards/data` (M0's export, 48 s): 6,891 train
items (seeds 41–44, train1–6, hidden, control and neutral worlds), 529 training rows (6,172 items) and 61 held-out
rows (719 items, 64 Haiku constraints). Haiku's target exists only for items in `intent-v2.jsonl.gz`: exporting
seeds 41–48 found 13,526 items but the same 6,891 with a target (6,635 with no requests), so more seeds add nothing,
and the remaining 1,352 lines of the file are held-out suites' items, which may not be trained on.

529 rows was too few (q15-a below: recall 0.48). The enlargement is **more batchings of the same train items**:
`--train-batchings N` (new) cuts the train items into batches N times, each from a new shuffle, so each item and
its Haiku target is seen in N different batch contexts (the 20/10/5 sizes the default's calls take). The first
batching and the held-out rows are byte-identical to a one-batching export (checked with `cmp`, and a unit test);
no held-out item enters any training row (`check_rows`). Sets used: `data` (529 rows), `data3` (1,587 rows, 3
batchings), `data6` (3,174 rows, 6 batchings).

## Step 2: training

LoRA r 16, alpha 32, all linear layers, lr 2e-4 cosine, 2 epochs, effective batch 8, loss on the reply only, merged
into the base (M0's recipe, unchanged). Two fixes were needed: TRL's default eval batch of 8 ran out of memory at the
first epoch's eval on an A10G (eval batch 1, loss only now), and vLLM 0.10.2's image needed `transformers==4.56.2`
pinned. The 1.5B trained on an L40S (`--gpu L40S`, new): 3.3 s a step against 8.4 s on the A10G, so cheaper per step
at 1.77x the hourly price.

| Run | Base | Rows | GPU | Seconds | $ (list) | Held-out loss by epoch |
| --- | --- | --- | --- | --- | --- | --- |
| q15-a | Qwen2.5-1.5B-Instruct | 529 | L40S | 449 | 0.24 | 0.728, 0.675 |
| q15-x3 | Qwen2.5-1.5B-Instruct | 1,587 | L40S | 1,328 | 0.72 | 0.615, 0.611 |
| q15-x6 | Qwen2.5-1.5B-Instruct | 3,174 | L40S | 2,491 | 1.35 | 0.653, 0.744 |
| q4-x3 | Qwen3-4B-Instruct-2507 | 1,587 | L40S | 2,684 | 1.45 | 0.569, 0.569 |
| q4-x6 | Qwen3-4B-Instruct-2507 | 3,174 | L40S | 4,951 | 2.68 | 0.624, 0.762 |

(The held-out loss is on 16 rows and is a loss curve only; the eval below is the measure. q15-x6's rose while its
generations improved.)

## Step 3: held-out agreement with Haiku

`modal run packages/sim/modal/cards_distill.py::evaluate --data .local/modal/cards/data-k --run R [--guided-json]`:
greedy vLLM on one L40S, every held-out row, scored by `cards-distill.ts score` (Eden's parsers). "Guided" is vLLM's
JSON-object decoding, which is what the funnel and a server would get: Eden's card call sends `json: true`
(`response_format`). Flag columns are precision / recall of "kind is not none" against Haiku, on all 719 items and
on the 89 the default keeps a card for. Field columns are on items both call a constraint (what the request-time
match reads); requests are the word Jaccard with Haiku's.

| Model | Batch parse | Item parse | Flag P / R (all) | Flag P / R (kept) | Kind | Actions | Span | Entities | Requests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen2.5-1.5B untuned | 1.00 | 1.00 | 0.08 / 0.11 | 0.64 / 0.11 | 0.14 | 0.14 | 0.00 | 0.14 | 0.04 |
| Qwen3-4B untuned | 0.57 | 0.40 | 1.00 / 0.09 | 1.00 / 0.10 | 0.50 | 0.00 | 0.67 | 0.39 | 0.20 |
| q15-a | 1.00 | 1.00 | 0.50 / 0.48 | 0.84 / 0.51 | 0.48 | 0.26 | 0.52 | 0.55 | 0.45 |
| q15-x3 | 1.00 | 1.00 | 0.72 / 0.75 | 0.89 / 0.79 | 0.73 | 0.38 | 0.56 | 0.62 | 0.46 |
| q15-x3 guided | 1.00 | 1.00 | 0.74 / 0.77 | 0.91 / 0.80 | 0.69 | 0.39 | 0.57 | 0.63 | 0.46 |
| q4-x3 | 0.62 | 0.45 | 0.76 / 0.34 | 0.88 / 0.36 | 0.59 | 0.45 | 0.73 | 0.71 | 0.39 |
| q4-x3 guided | 0.97 | 0.94 | 0.77 / 0.80 | 0.91 / 0.84 | 0.65 | 0.47 | 0.71 | 0.63 | 0.38 |
| **q15-x6 guided** | 1.00 | 1.00 | **0.80 / 0.81** | 0.85 / 0.85 | 0.67 | 0.46 | 0.77 | 0.68 | 0.45 |
| **q4-x6 guided** | 0.98 | 0.99 | **0.83 / 0.84** | 0.92 / 0.89 | 0.74 | 0.46 | 0.78 | 0.69 | 0.37 |

Untuned, neither base can do the job (recall ≈ 0.1). Data mattered most: three batchings took the 1.5B's recall
from 0.48 to 0.75, six to 0.81. Qwen3-4B's plain output broke JSON on 38% of batches (extra closing brackets, an
unclosed string, one loop of a repeated date); guided decoding fixes most of it (0.94 of items, just under bar 1).
q15-x6 passes bars (1) and (2) on both views; it was the one taken to the funnel first, with q15-x3 run as a check.
Measured against Haiku the field agreement is middling (actions 0.46), but the cards' funnel result below says those
differences do not cost hidden facts.

## Step 4: the funnel through the endpoint

`EDEN_CARDS_RUN=R EDEN_CARDS_SERVE_GPU=L4 modal deploy packages/sim/modal/cards_distill.py` (the bearer key
generated locally, passed as an ephemeral `modal.Secret.from_dict`, nothing stored; 401 without it), then
`bun run funnel --suite train --seeds 41,42 --cards-endpoint URL --cards F --json F --baseline base.json`. The
endpoint writes every card and every intent request; nothing of Haiku's is replayed. Cold start on first deploy:
636 s (q15-x3) and 501 s (q15-x6), image pull, `torch.compile` and CUDA graphs; q4-x6 ran on an A10G (no L4
capacity was free; `EDEN_CARDS_SERVE_GPU=A10G`) and answered in 88 s. The endpoint was stopped after each
use (`modal app stop eden-cards-distill`).

| Run (train1–6, seeds 41–42) | Hidden | Decoys | `--baseline` diff (as printed) |
| --- | --- | --- | --- |
| Default: mixed replayed cards + Haiku requests (the bar) | 314 | 273 | — |
| Haiku's own `intent-v2` cards + requests replayed (teacher) | 318 | 278 | 10 hidden gained, 6 lost; 5 decoys new, 0 gone |
| q15-x3 endpoint (live) | 295 | 272 | 7 gained, 21 lost; 3 new, 9 gone |
| **q15-x6 endpoint (live)** | **303** | **282** | 7 gained, 19 lost; 7 new, 7 gone |
| **q4-x6 endpoint (live, A10G)** | **317** | **289** | 15 gained, 11 lost; 9 new, 5 gone |

**Both fail bar (3).** q15-x6: hidden 303 < 312 and decoys 282 > 273 (teacher line: 303 < 316, 282 > 278). q4-x6:
hidden 317 passes (≥ 312, and the teacher line's ≥ 316) but decoys 289 > 273 (and > 278).

**Where the loss is ($0, every half replayed from the recorded outputs).** The endpoint's output was split into its
cards and its requests, and each half was swapped with Haiku's (`--cards C --intent R`):

| Cards | Requests | Hidden | Decoys |
| --- | --- | --- | --- |
| Haiku | Haiku | 318 | 278 |
| q15-x3 | Haiku | 320 | 276 |
| Haiku | q15-x3 | 297 | 267 |
| q15-x3 | q15-x3 | 295 | 269 |
| q15-x6 | Haiku | 321 | 277 |
| Haiku | q15-x6 | 311 | 281 |
| q15-x6 | q15-x6 | 308 | 279 |
| q4-x6 | Haiku | 322 | 278 |
| Haiku | q4-x6 | 316 | 285 |
| q4-x6 | q4-x6 | 319 | 288 |

The distilled cards are at least the teacher's every time (320–322 hidden with 276–278 decoys, against 318/278). The
requests are where the models fall short: the 1.5B's cost 7 hidden facts (q15-x6) to 21 (q15-x3); the 4B's keep the
hidden facts (316) but bring 7 more decoys (285), and with its own cards 10 more (288). Live through the endpoint and
replayed from what it wrote differ little: q15-x3 295/272 live, 295/269 replayed; q15-x6 303/282 live, 308/279 replayed
(live, the cards land seconds later while tasks run, and one call failed; not studied further). Every Haiku funnel
figure is replayed. Lost hidden tasks in the live q15-x6 run spread over train1–4 (two seeds each:
`rollout-below-crash-gate`, `helpdesk-records-legal-hold`, `piano-fee-already-paid`, `maya-jumpers-bought`), and request
word overlap with Haiku is about 0.45 whatever the data size, so more batchings fixed the cards but not the requests.

## Qwen3-4B

Qwen3-4B-Instruct-2507 needs guided JSON (38% of its plain batches did not parse) and six batchings; then it is the
best on held-out (flag precision 0.83, recall 0.84; item parse 0.99) and finds the most hidden facts in the funnel
(317 live, 319 replayed). But its requests are wider than Haiku's (word overlap 0.37, the lowest of the tuned
models): they match more decoy tasks' requests, and decoys rise to 289. Eden's rule is precision over recall, and the
bar said decoys not up, so it is not promoted either. It is also no cheaper: on an A10G (no L4 capacity was free on
the day), 16 at once costs $0.053 per 1,000 items, Haiku's price, and one at a time $0.244 (p50 7.6 s).

## Step 5: cost and latency

`python3 -I packages/sim/modal/endpoint_bench.py --url URL --data .local/modal/cards/data-k --gpu L4 --concurrency
1,16,32`: the 61 held-out card calls (Eden's prompts, guided JSON as Eden asks, 2,071 tokens in, about 420 out a
call), against a warm endpoint on one L4 ($0.80 an hour), GPU-seconds = the pass's wall time on its one GPU.

| q15-x6 on one L4 | Calls ok | p50 / p90 ms | Items / GPU-s | $ / 1,000 items | Cut at the cap |
| --- | --- | --- | --- | --- | --- |
| 1 at a time (one user's drain) | 60 of 61 | 5,003 / 11,993 | 1.67 | 0.133 | 0 |
| 16 at once (a shared backfill) | 61 of 61 | 6,747 / 15,553 | 17.6 | **0.0126** | 0 |
| 32 at once | 54 of 61 | 90,653 / 184,744 | 2.5 | 0.088 | 34 |
| q4-x6 on one A10G ($1.10 an hour), 1 at a time | 61 of 61 | 7,596 / 16,964 | 1.25 | 0.244 | 0 |
| q4-x6 on one A10G, 16 at once | 61 of 61 | 13,116 / 30,964 | 5.8 | 0.053 | 2 |

q15-x3 read the same (16 at once: $0.0122, p50 6,950 ms). At 32 at once on one L4 most replies ran to the token cap
(2,608 tokens a call against 420: greedy output that loops once the batch is that large), and calls dropped; a
server would cap a container at 16. One call in each 1-at-a-time pass dropped (RemoteDisconnected).

**Haiku, from the ledgers (docs/COST-MODEL.md):** the shipped shape (20-item batches with intent, thinking off, run
`close-cards-reasoning`, lab provider, cached) is $0.001012 a call, p50 5,406 ms, p90 8,862 ms: **$0.051 per 1,000
items** (the intent run's own figure is $0.0501: 3,331 items, $0.177), about $0.064 uncached (×1.27, D145).

Offline batch generation on an L40S (the eval: model load and all 61 rows) took 55 s for 719 items: $0.041 per
1,000 items including the load. Training the passing model cost $1.35 once.

**Bar (4)**: cheaper only at shared-service utilisation (16 at once: 4x cheaper than Haiku); one user's background
drain alone, or an idle GPU, is dearer (2.6x at 1 at a time, plus idle time: the deployment scales to zero 5 minutes
after its last call and then cold-starts for minutes).

## What a production version would need (not built)

Written for the day a model passes: a card service on a GPU host shared across tenants (batching across users is
the only way it is cheaper, see above), with at most 16 calls a container; a data agreement equivalent to D12's
zero-retention routing (items are user data; a self-hosted model keeps them on our side, which is simpler than ZDR
but makes us the processor, with the host's own terms); keys per environment, never stored with the weights; and a
fail-over to Haiku through `Budget` when the service is down, slow or returns unparseable output (Eden's parsers
already drop what does not parse; a batch with nothing parsed would go to Haiku once). A per-tenant switch and a
trial in the table (D112) before any default change. And first, requests as good as Haiku's: the evidence says the
cards could be distilled today, but the cards alone are not the cost (the intent requests read every item; cards
only the 11–15% the prefilter passes), so a cards-only split saves almost nothing.

## Spend

Modal billing report (`modal billing report --for today --resolution h`, app `eden-cards-distill`, as of 12:04 UTC):
**$9.51**: L40S $7.36, A10G $1.08, L4 $0.64, CPU, memory and egress $0.44. It includes three A10G runs stopped by the
out-of-memory error and the stopped first launches. Anthropic: $0.

## Reproduce

```bash
bun packages/sim/src/lab/cards-distill.ts export --out .local/modal/cards/data-k            # 529 rows, carded flags
bun packages/sim/src/lab/cards-distill.ts export --out .local/modal/cards/data6 --train-batchings 6
modal run packages/sim/modal/cards_distill.py::train --data .local/modal/cards/data6 --run q15-x6 \
  --base qwen2.5-1.5b --gpu L40S
modal run packages/sim/modal/cards_distill.py::evaluate --data .local/modal/cards/data-k --run q15-x6 --guided-json
export EDEN_LAB_CARDS_KEY=$(openssl rand -hex 24)                                            # local only
EDEN_CARDS_RUN=q15-x6 EDEN_CARDS_SERVE_GPU=L4 modal deploy packages/sim/modal/cards_distill.py
bun run funnel --suite train --seeds 41,42 --cards-endpoint URL --cards .local/modal/cards/q15-x6.cards.jsonl \
  --json .local/modal/funnel-q15-x6.json --baseline .local/modal/funnel-base.json
python3 -I packages/sim/modal/endpoint_bench.py --url URL --data .local/modal/cards/data-k --gpu L4 \
  --concurrency 1,16,32 --out .local/modal/cards/q15-x6/bench-L4.json
modal app stop -y eden-cards-distill
```

Small artefacts: [m2-cards-distill/](m2-cards-distill/) (each run's `score.json`, `train.json` without its step log,
the bench JSONs and the funnel totals).
