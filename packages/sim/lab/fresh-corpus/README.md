# fresh-corpus — recurring black-box eval

The v0.3.0 broad benchmark, committed as a reusable harness. It measures Eden the way a real
user's agent sees it: a generated corpus Eden has never seen installed into a real Hermes Agent,
scored questions driven through the hooks, and an optional paid A/B run against a file-search
control arm.

## Layout

- `gen_corpus.py` — writes `corpus/docs.json`, `corpus/questions.json` (73 scored questions,
  8 categories) and `corpus/files/` (the control arm's file tree). `--seed 20261119` (the default)
  reproduces the v0.3.0 corpus byte for byte; any other `--seed` keeps the same shape but perturbs
  the persona, amounts, dates-of-month and reference codes — run a new seed each quarter so the
  eval never becomes a memorised dataset. `--distractors N` resizes the look-alike pool.
- `drive_eval.py` — free, no model calls: pre_llm_call injection recall, ask_context accuracy,
  neutral-turn false fires, hook latency, party-check suite. The regression gate: on v0.3.0 it
  reads ~84% injection recall, ~78% ask_context fully-correct, **0 false fires** (false fires
  must stay at zero).
- `ab_run.py` — paid A/B: `hermes -z` per question with the Eden plugin vs a control arm that has
  the same corpus as files. Needs OPENROUTER_API_KEY; the v0.3.0 run (146 runs, DeepSeek v3.2)
  cost $2.57. Use `--limit` for smoke runs and watch spend.
- `score_ab.py` — scores an `ab_run.py` run directory into `ab_scored.json`: full/partial/miss
  per arm plus calls, tokens, cost and wall time. Review partials/misses by hand.
- `soak.py` — free: N turns across interleaved sessions; latency percentiles and sidecar RSS
  drift (the 900-turn soak on v0.3.0 read p50 1.6 ms, RSS +68% — a leak suspect to re-check).

## Setup

1. Hermes Agent checkout at tag `v2026.9.24` (0.21.5) with a Python 3.12 venv —
   `UV_PYTHON=3.12 uv sync` in the clone. Point `HERMES_SRC` at it.
2. Two hermes-homes: an Eden one (install the release with
   `install.py --hermes-home <dir> --example`, plugin enabled) and a plain control one
   (just `hermes` having run once, or an empty dir — the control never loads plugins).
3. Load the corpus into Eden however the install ingests sources (the v0.3.0 run mounted
   `corpus/files` as the Hermes "sources" MCP server pointed at by the Eden hermes-home; the
   control arm simply `cd`s there).

## Run

```sh
python3 gen_corpus.py --seed $(date +%Y%m)01        # fresh corpus each quarter
HERMES_SRC=~/hermes-agent HERMES_HOME=~/hermes-home-eden \
    python3 drive_eval.py --corpus corpus --out runs/$(date +%Y-%m)/hook_results.json
python3 ab_run.py --corpus corpus --hermes ~/hermes-agent/.venv/bin/hermes \
    --eden-home ~/hermes-home-eden --ctl-home ~/hermes-home-ctl \
    --model deepseek/deepseek-v3.2 --out runs/$(date +%Y-%m)
python3 score_ab.py --corpus corpus --run runs/$(date +%Y-%m)
HERMES_SRC=~/hermes-agent HERMES_HOME=~/hermes-home-eden python3 soak.py --corpus corpus --out runs/$(date +%Y-%m)/soak.json
```

Paid runs go through OpenRouter only — keep the Anthropic-key rule (`EDEN_ALLOW_OPENROUTER` is
for Bun lab scripts; these are plain Python, so set the key in the environment yourself).

`corpus/` is gitignored: regenerating it is the point of the eval, and committing generated
output would pin the eval to a corpus the model may have memorised.
