# packages/sim/modal: the lab on Modal (M0)

Lab tooling for three uses of the Modal credits: the lab at scale (`lab_fanout.py`), the background card model
distilled into a small open model (`cards_distill.py`), and an embedding retrieval screen (`embed_screen.py`). **Not
product code**: nothing in `packages/*` product code imports anything here, and every figure these apps make is a
lab figure, labelled so. Built and tested without a Modal token on 2026-11-10 (session M0); nothing here has run on
Modal yet, so every cost below is an **estimate**.

| File | What it is | Needs Modal |
| --- | --- | --- |
| `lab_fanout.py` | pi-ab seeds or funnel shards fanned out over containers, one hard Anthropic cap split across shards | yes |
| `fanout_plan.py` | its arithmetic: shards, cap split, each shard's command, merging, presets, waves; `plan` prints a plan with no token | no |
| `bench_report.py` | the powered bench's report (F3, D487): paired effects clustered by template, McNemar, the run's minimum detectable effect | no |
| `cards_distill.py` | LoRA on Haiku's cards, held-out eval, a vLLM OpenAI-compatible endpoint | yes |
| `distill_data.py` | its data checks, bases, GPU choice, cost estimates | no |
| `embed_screen.py` | the train corpus embedded on a GPU; planted item ranks against the lexical pool | yes |
| `embed_score.py` | its scoring (ranks, groups, report) | no |
| `tests/` | unit tests for the three no-Modal modules | no |

Bun side (lab only, in `packages/sim/src/lab/`): `cards-distill.ts` (the training set's export and the eval's
scorer, by Eden's own parsers) and `cards-endpoint.ts` (the lab card transport behind `bun run funnel
--cards-endpoint`).

## Setup (once)

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install -r packages/sim/modal/requirements.txt
# = modal[api-proxy-support]==1.6.3: behind an HTTPS proxy (a Claude Code cloud container) the client needs the
# extra and the proxy's CA, else "Could not connect to the Modal server":
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt     # cloud containers only
export MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=…        # or `modal token new`
```

Secrets are the owner's to make (never created by a session):

- **`HAIKU_API_KEY`**: a Modal Secret named `HAIKU_API_KEY` holding the env var `HAIKU_API_KEY` (exists). Another
  name: `EDEN_HAIKU_SECRET=<name>` when running `lab_fanout.py`.
- **`eden-cards-endpoint`**: holding `EDEN_LAB_CARDS_KEY`, the card endpoint's bearer key; the same value is
  exported locally as `EDEN_LAB_CARDS_KEY` for the funnel. Needed only by `cards_distill.py`'s `serve`.

Each app is its own Modal app: `lab_fanout.py` is CPU only, and the GPU apps (`cards_distill.py`, `embed_screen.py`)
are separate, since one GPU function blocks a whole app while the workspace cannot use GPUs.

Only pi-ab shards get the Haiku secret; funnel shards, the distillation and the embedding screen never see a key.

## 1. The lab at scale: `lab_fanout.py`

The image is Debian with Bun 1.4.4 and the repository at one commit (`EDEN_COMMIT`, default `HEAD`): a `git archive`
of that commit (less `archived/`, 26 MB) is built into the image with `bun install --frozen-lockfile`, so a shard
runs exactly what was committed (uncommitted changes are not in it; the entrypoint says so). Each shard is one
container:

- **pi-ab**: one seed per shard (the lab's rule: one seed a process), suites grouped by `--suites-per-shard` (0: all
  in one). 4 CPUs, 16 GiB; 24 GiB when the args hold `--noise-sources` ≥ 100 (A21: ~10 GB a process at 1,000
  sources, two at once killed on 15 GiB; here every shard has its own container).
- **funnel**: suite × seed cells (or `--shards N` blocks), 8 CPUs, 8 GiB (16 GiB at scale), no key at all. Refuses
  `live` (a live reader or judge spends: run those on pi-ab or locally).

**The spend cap.** A pi-ab run refuses to start without `--cap USD`. Each of N shards runs with its own ledger
(`--spend-ledger`), `--spend-cap cap/N` (rounded down to $0.001, so the caps sum to at most `--cap`), the same as
`--budget`, and a headroom of 10% of its cap (at most $0.25). The planner owns those flags (and `--seeds`,
`--suite`, `--out`, `--timeline`, `--cards-out`, `--run-label`): passing one in `--args` is refused. After the run the
shards' ledgers are summed and checked against the cap (`manifest.json`: `spentUsd`, `withinCap`, `overCap`).
Held-out suites need `--blind` in `--args`, as `bun run funnel` asks.

```bash
# Plan only, no token, nothing started:
python3 -I packages/sim/modal/fanout_plan.py plan --kind pi-ab --suites train --seeds 41,42,43,44 --cap 4 \
  -- --conditions tools,eden --model claude-haiku-5-5

# pi-ab, train, four seeds, $4 Anthropic in all ($1 a shard):
EDEN_COMMIT=HEAD modal run packages/sim/modal/lab_fanout.py --kind pi-ab --suites train --seeds 41,42,43,44 \
  --cap 4 --run m1-train --args "--conditions tools,eden --model claude-haiku-5-5 --grader claude-haiku-5-5 \
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --cards packages/sim/lab/cards/cards-train.jsonl"

# The funnel at 1,000 sources, train, four seeds, $0 Anthropic:
modal run packages/sim/modal/lab_fanout.py --kind funnel --suites train --seeds 41,42,43,44 \
  --run m1-scale --args "-- --noise-sources 995 --limit 16"
```

**Card lists and concurrency (M1, D440).** `--cards A,B,C` in a pi-ab run's `--args` is merged into one file inside
each shard (pi-ab reads one; `prepare_shard`). Run Anthropic shards one or two at a time: a short train shard runs
about 60 agent streams, and four fan-outs at once on one key met Anthropic's concurrent-request limit (1,500–1,900
retried 429s a shard), which made wall times useless though quality pairs held. M1 measured the real costs: a train
pi-ab shard (all six suites, 5 arms, 384 tasks an arm) took 3–10 minutes and $0.47–0.57 Anthropic; a `--days 8` user
with 6 arms 5–8 minutes and $0.21–0.29; this session's 53 containers cost $1.54 of Modal credits (billing report).

**Presets, waves and the powered bench (F3, D487).** `--preset NAME` names a checked-in run shape
(`fanout_plan.PRESETS`: the M1 recipe with its arms), so a powered run is one command; `--args` after it add flags
or replace the preset's (`--variants hidden`, `--days 8`, `--conditions …`). `--seeds` takes ranges (`41-68`).

| preset | arms |
| --- | --- |
| `bench-tools` | `tools`, `eden` |
| `bench-fewer` | `tools`, `eden`, `eden~minus-fewer` (D404) |
| `bench-parts` | `eden` and `eden~minus-<part>` for nudge, plans, fewer, freshness (M1's arms; `PART_VARIANTS` are checked against `PARTS` by `modal-python.test.ts`) |

Anthropic shards run in **waves**: the planner counts a shard's agent streams (arms × worlds: six train suites ×
variants, or one for a `--days` user) and starts only as many shards at once as keep the streams on the key at or
under `--max-streams` (default 60, the level that ran with no retried 429 in M1's rerun, M4 and F3). A shard that
alone would pass the limit is refused, and so are `all` and `heldout-all` (name the suites: the planner cannot count
a group it does not know). `--flag=value` after a preset is read as `--flag value`. After each wave
it reads the shards' request summaries and halves the width if more than 2% of requests were retried on a 429. One
Anthropic fan-out runs at a time from a checkout (`.local/modal/anthropic.lock`): a second waits for the first.

```bash
python3 -I packages/sim/modal/fanout_plan.py plan --preset bench-fewer --seeds 49-68 --cap 4.4 -- --variants hidden
modal run packages/sim/modal/lab_fanout.py --preset bench-fewer --seeds 49-68 --cap 4.4 --run f3-b-49 \
  --args "--variants hidden"
python3 -I packages/sim/modal/bench_report.py --pair eden:tools --pair eden~minus-fewer:eden \
  --group cached=.local/modal/f3-b-41 --group inrun=.local/modal/f3-b-45,.local/modal/f3-b-49 --target 1.5
```

`bench_report.py` pairs two arms task by task and, for hidden facts, concerns, $/1k, wall, model turns and asks,
prints the effect with a **template-clustered bootstrap** interval (tasks of one template share their errors, arXiv
2411.00640), the task-level and seed-clustered intervals beside it, the design effect, the exact paired McNemar
test, the run's **minimum detectable effect** (2.80 × the clustered standard error: 80% power, 5% two-sided), and
how far more seeds can narrow it (the between-template variance sets a floor). `--sonnet` takes Sonnet's verdicts
from `regrade*.json` beside each shard. Pure Python, no numpy.

`--dry` prints the plan through Modal (it needs a token; `fanout_plan.py plan` does not). Hermes is not fanned out:
it needs a local hermes-agent checkout with its venv (packages/sim/src/lab/CLAUDE.md), not built into this image.

**Results come back** compressed in each shard's return value and land in `.local/modal/<run>/` (git ignores
`.local/`): per shard `<shard>/out.json` (its `timeline` field rewritten to the local `out.timeline/`),
`ledger.jsonl`, `cards.jsonl` (cards a pi-ab shard made live: name them with `--cards` in a later run), `log.txt`
(the last 400 KB), `status.json`; and for the run `manifest.json`, `ledger.jsonl` (all shards), and for funnel runs
`funnel.json` (every shard's `perTask`). Then, locally, pi-ab runs get `pi-ab-report.txt` and `pi-cost-report.txt`
(`pi-ab-report.ts` and `pi-cost-report.ts` over every shard's `out.json`), funnel runs `funnel-score.txt`
(`funnel-score.py` on the merged rows).

**Cost (estimate, Modal 2025 list prices: ~$0.047 a physical core-hour, ~$0.008 a GiB-hour; check
modal.com/pricing).** A pi-ab shard (4 cores, 16 GiB) is about $0.32 an hour, $0.38 at 24 GiB; a funnel shard
(8 cores, 8 GiB) about $0.44 an hour, and a train suite × seed funnel shard takes seconds at five sources. A four-seed
pi-ab train run at an assumed 2 hours a shard: about $2.60 of Modal credits, plus the Anthropic spend (capped by
`--cap`, billed by Anthropic, not Modal). The image builds once per commit (a few CPU-minutes).

## 2. The card model distilled: `cards_distill.py`

**The training set** is made locally at $0 by `cards-distill.ts export`: every item a sync of the train suites'
worlds reads (seeds 41–44: hidden, control and neutral worlds, as `cards-enrich.ts` builds them), batched (20, 10, 5
items a call, cycling) into the exact messages Eden's card call sends (`cardMessages` with the intent instructions,
as the default ships; "Today is 2026-10-27", the day the caches were made), with the reply Haiku 5.5 gave: its card
and requests from the checked-in `intent-v2.jsonl.gz`, joined by card key (`--cards-from intent`, the default). An
item the prefilter rejects targets a none card (the enricher reads it for its requests only). `--cards-from replay`
uses the cards the funnel replays (`packages/sim/lab/cards/*.jsonl`) instead; those mix teachers (`cards-train.jsonl`
was glm-5.3-flash) and agree with Haiku's constraint flag on 645 of 878 items both cover, so they are not the
default. 10% of items are held out by a hash of the card key; the splits are batched separately. Only train suites
are accepted, and any item planted in a held-out or dev world is dropped from both splits (0 were, 2026-11-10).

On 2026-11-10: 6,891 items, 529 training rows (6,172 items), 61 held-out rows (719 items, 64 with a constraint),
771 constraint cards in all; about 1.31 M tokens an epoch (3.6 characters a token, estimate).

**Bases** (Apache-2.0 only, so a result could be served): `qwen2.5-1.5b` (Qwen2.5-1.5B-Instruct, trains on an A10G,
serves on an L4) and `qwen3-4b` (Qwen3-4B-Instruct-2507, L40S). Qwen2.5-3B-Instruct is left out: its licence is
non-commercial. Pick by quality per dollar: train both, evaluate both, compare the constraint flag's F1 against Haiku
per training dollar (`evaluate` prints it). LoRA r 16, alpha 32, all linear layers, lr 2e-4 cosine, 2 epochs,
effective batch 8, loss on the reply only (TRL prompt-completion), merged into the base for vLLM.

```bash
bun packages/sim/src/lab/cards-distill.ts export --out .local/modal/cards/data           # ~60 s, $0
modal run packages/sim/modal/cards_distill.py::train --data .local/modal/cards/data --run q15-a --base qwen2.5-1.5b
modal run packages/sim/modal/cards_distill.py::evaluate --data .local/modal/cards/data --run q15-a
modal run packages/sim/modal/cards_distill.py::evaluate --data .local/modal/cards/data --run qwen2.5-1.5b  # untrained
EDEN_CARDS_RUN=q15-a modal deploy packages/sim/modal/cards_distill.py      # prints the serve URL
bun run funnel --suite train --seeds 41,42 --cards-endpoint https://…modal.run --cards .local/modal/cards/q15-a.cards.jsonl
```

**The eval** (`cards-distill.ts score`, run by `evaluate`) reads the model's output and Haiku's target with Eden's
own parsers (`parseCards`, `parseRequests`) and reports: the batch and item parse rates; the constraint flag (kind
not none) as agreement, precision and recall against Haiku; kind agreement; on items both call a constraint, the
fields the request-time match reads (kind, actions, span, limit, entities' word Jaccard); and the requests' word
Jaccard. Output in `.local/modal/cards/<run>/` (`train.json`, `outputs.jsonl`, `score.json`). D235 found small local
models fail as the *reader* (AUC 0.44–0.61); cards are a different job, which is what this measures before the
funnel trusts it.

**The funnel through the endpoint** (`--cards-endpoint URL [--cards-endpoint-model NAME]`, lab only like D97's
provider; `cards-endpoint.ts`): no card is replayed; every item the default sends for a card goes to the endpoint
(Eden's own `ModelCardMaker`: same prompt, caps and parser) and is appended to `--cards F`, so a rerun replays them
for free. The endpoint writes the intent requests too, so the checked-in requests are not replayed (unless `--intent
F`). The key is read from `EDEN_LAB_CARDS_KEY`, never a flag. Every such run is labelled `[cards: endpoint (lab,
M0)]` and its JSON carries `cardsTransport`: its numbers are the distilled model's, never the shipped card model's.
Screen hidden facts and decoys on train against the replayed-Haiku funnel (`bun run funnel --json` on the same
suites and seeds); a held-out look needs `--blind` and is measurement only.

**Cost (estimate: assumed training throughput, 2025 list prices).** Training: about $0.37 for `qwen2.5-1.5b` (A10G,
~0.33 h) and $0.77 for `qwen3-4b` (L40S, ~0.39 h) for 2 epochs (`distill_data.estimate_train`; the run records its
real seconds). Eval: one L40S for model load and 61 batches, roughly 5–10 minutes, ~$0.20–0.35. Serving: an L4 at
~$0.80 an hour while up (it scales to zero 5 minutes after the last call); a train funnel through it makes a few
hundred card calls (28 calls for train1 seed 41 with a stub endpoint, 2026-11-10).

## 3. The embedding retrieval screen: `embed_screen.py`

A15's question (docs/research/a15-retrieval.md, D330–D333): planted facts that share no word with the request mostly
never reach a candidate pool. This embeds the train suites' corpus dump (`hidden-funnel --corpus-dump`, D333: each
item as its source lists it, title and the first 500 characters) and every request with an open model on an L4, and
reports, for hidden tasks (planted facts) and control tasks (decoys: what an extra slot would also bring), how many
planted items rank in the top k (1, 5, 10) by cosine similarity against how many the push's lexical pool holds in its
first k (`pushPoolAt` from the funnel's rows), either, and the embedding alone; for all tasks, those whose planted
item shares no word with the request (A15's terms), those not in the lexical pool at all, and those the default
never surfaced. Held-out suites in the dump are refused.

```bash
bun run funnel --suite train --seeds 41,42,43,44 --json .local/modal/embed/funnel.json \
  -- --corpus-dump .local/modal/embed/corpus.jsonl                                       # local, $0
modal run packages/sim/modal/embed_screen.py --corpus .local/modal/embed/corpus.jsonl \
  --funnel .local/modal/embed/funnel.json --model Qwen/Qwen3-Embedding-0.6B
```

`--pools .local/modal/embed/pool.jsonl` (the same funnel run with `--pool-dump`; ids only are read) adds M3's hybrid
(D453): the lexical pool fused with the embedding's top k (`--hybrid-ks 3,5,10`) by RRF, gained, lost and net in the
first 5 per variant, and A15's extra-slot shape. **Run on 2026-11-10 (M3, docs/research/m3-embed-screen.md):** decoys
rose as much as facts (0.6B k 3: +42 facts, +48 decoys), no trial (D450); billed $0.043 (0.6B) and $0.063 (4B).

Models: `Qwen/Qwen3-Embedding-0.6B` (default, its query prompt), `Qwen/Qwen3-Embedding-4B` (half precision),
`BAAI/bge-large-en-v1.5` (query prefix),
`sentence-transformers/all-MiniLM-L6-v2` (D331 (4)'s CPU model, for a like-for-like line). Output in
`.local/modal/embed/<run>/`: `report.txt`, `report.json`, `ranks.jsonl` (each task's planted rank and top 20 item
indexes). Only ids and ranks come back. **Cost (estimate):** one L4 for a few minutes (model download and ~6,500
unique texts), well under $0.10 a model.

## Tests

```bash
cd packages/sim/modal && python3 -I -m unittest     # 54 tests, no Modal, no token
bun test ./packages/sim/src/lab/cards-distill.test.ts ./packages/sim/src/lab/cards-endpoint.test.ts \
  ./packages/sim/src/lab/modal-python.test.ts       # export, scorer, endpoint transport against a stub server
```

`modal-python.test.ts` runs the Python tests inside `bun run check`.
