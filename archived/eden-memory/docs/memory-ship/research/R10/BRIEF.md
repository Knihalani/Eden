# R10 — the retrieval research programme (brief)

You are running a long, open-ended research programme on Eden (GitHub repo Knihalani/Eden; all work targets `main`). **It does not end: keep working until the user stops this session.** A finished cycle is the start of the next one.

This brief is committed at `docs/memory-ship/research/R10/BRIEF.md`. Re-read it, and `STATE.md` beside it, at the start of every cycle: your context will be compacted.

## 1. Goal

Eden is passive memory for AI agents. It watches conversations, stores what matters, and injects a short "packet" of memories into the agent's context when they are needed. Its hosts are agents that work with the same user over time:
- coding agents (Claude Code is the first host);
- inside the product: personal assistants, proactive agents, coworkers, tutors and companions.

The user, in their words:
- "completely, ground up innovate to get to the bleeding edge… make the retrieval basically perfect… injecting exactly what's needed every and all the time without much unnecessary stuff";
- "you're sticking to very mundane, already known methods";
- "make sure you're not overfitting to coding agents";
- "make sure it doesn't settle into local optima";
- "make sure that the benchmark actually reflects real use".

**"Perfect" means:**
- on every turn, the packet holds every memory the agent needs for that turn and nothing it doesn't, including memories the user never mentions (proactive needs);
- the packet is empty on the many turns that need nothing;
- nothing is repeated that is already in context.

## 2. Orientation (first cycle)

**Read:**
- `CLAUDE.md`: its engineering rules bind you;
- `README.md`;
- in `docs/memory-ship/`: `PROGRESS.md`, `ROADMAP.md`, `DECISIONS.md`, `A4-DELIVERY-CONTRACT.md`, `A5-EVALUATION.md`, `A7-CUES.md`, and `research/R1-cue-experiment.md`, `R2-cue-architecture.md`, `R6-real-usage.md`, `R8-nim-experiments.md`;
- `benchmarks/memory-long-horizon/` (world scenarios, need oracle, simulated context window) and `benchmarks/memory-cues/` (R1/R8 fixtures).

**Start** from branch `research/r10-retrieval`. Its `benchmarks/memory-cues/nim/r10_gen.py` and `r10_eval.py` (a prompt-to-prompt "cue bank") are a known-method baseline to beat, not a direction.

**Prior numbers,** on R1's synthetic coding fixture, recall@4 at FIR on negatives:

| Method | Recall@4 | FIR |
|---|---|---|
| BM25F_ctx | 0.47 / 0.56 | 7.5% / 15% |
| gemma-31b doc2query aliases | 0.48 | 5% |
| hosted 1B embedder | 0.72 | 7.5% (collapses at strict silence) |
| P4.3's evidence gate (merged, in shadow) | 0.51 | 10% |

On zero-overlap paraphrases, no method exceeds 0.32.

**Realism facts** to calibrate against. They are aggregates from the user's real use; the data stays private and you cannot reach it.

- **Real use (R6 replay).** 23 real Claude Code sessions had 177 prompt events: 80 typed by the human, 67 background-task notifications, 30 messages from other agents. Non-human turns are 45% and must stay silent. A human typed about 3.5 prompts per session.
- **Base rate of need.** In an agent-labelled sample of about 140 unique real prompts, only 11 needed a stored memory: **about 8%**. Silence and bullet precision dominate real quality.
- **Where the noise comes from.** In multi-session world replays, 89% of injected bullets were unneeded. Most were the user's own past requests and tool output re-injected as "memories", not wrong facts.
- **The current lexical gate** with your best fix still fires on 39 of 125 real negatives when the store is dense with project facts.

## 3. Part A — do these first, once

1. **Already done; don't redo:** the stale branch `mem/P4.3-evidence-gate` and a stray local file were removed.
2. **Make the plan domain-general.**
   - Audit the plan docs for coding-only assumptions in the core retrieval decision (paths, identifiers, file reads treated as the main signal).
   - Add to ROADMAP and PROGRESS, as new ids, the slices and A5 arms that support and measure non-coding agents. Keep the existing numbering stable.
3. **Build the benchmark suite to the realism contract in §4,** before optimising anything.

## 4. The benchmark must reflect real use (realism contract)

R1 and R8 are isolated memory–cue pairs written by one author for one synthetic repo, and their own README warns of this. Keep them as secondary arms; never optimise on them alone. The primary benchmark has these properties:

1. **Streams, not pairs.** Evaluate on whole multi-session conversation streams, turn by turn, with the real hook sequence: session start, human prompts, assistant replies, tool calls and results, non-human turns (background notifications, other agents), compactions, resumed sessions.
   - Build on `benchmarks/memory-long-horizon/` (world scenarios, need oracle, simulated context window), and extend it.
   - Add the personal/proactive domains, with the same oracle discipline.
2. **The store comes from the write path.** Memories are what Eden's own write path extracts from the raw stream: duplicates, noise, misread facts, stale values and corrections included. Also run every system on an **oracle store** (perfect extraction), so write-path errors and retrieval errors are measured separately.
3. **Realistic base rates and volume.**
   - About 8–15% of human turns need a memory; most need nothing.
   - About 45% of all prompt events are non-human.
   - Stores grow to thousands of rows over weeks of simulated time.
   - Report results across several base rates, not one.
4. **What counts as a need.** A need is something a careful human expert would want the agent to know at that turn, labelled per turn by the oracle. Labels cover:
   - direct questions;
   - indirect and situational needs;
   - **proactive needs**, where the user never asks ("book dinner Friday with Sam" → "Sam is vegetarian");
   - multi-memory needs;
   - corrections that make an older memory stale;
   - "already in context", which is not a need.
5. **Proactive and event-triggered moments.** For personal and proactive agents, cues are not only user prompts. They include:
   - time ("Friday 6 pm");
   - calendar or plan events;
   - a returning user after days away;
   - an agent's own planned action.

   Include them.
6. **Hard negatives from real behaviour.** Include:
   - general-knowledge questions on the user's own topics;
   - other-project or other-person questions;
   - chit-chat;
   - acknowledgements;
   - long pasted content;
   - the user restating something already in context.
7. **Downstream effect.** On a sample of turns, check whether the packet changes the outcome. A strong model answers with the packet, without it, and with the oracle packet; a judge scores the difference. Bullet-level metrics must be validated against this.
8. **External anchors.** Where you can download them, run the public long-term-memory benchmarks:
   - **LongMemEval**;
   - **LoCoMo**;
   - Multi-Session Chat, or similar.

   Check licenses, fetch them by script, and never commit large datasets. They are QA-style, so also convert their evidence annotations into per-turn need labels.
9. **Authorship and leakage.** Every dataset records its author or model. Use different generators for the data and for any sleep-time model. Keep a sealed holdout, written separately, opened only in audit cycles. Regenerate fresh test sets periodically to detect overfitting. Log every test look.

**Metrics on every arm, per turn:**
- need recall: all needed memories in the packet, plus a top-4 variant;
- bullet precision: the share of injected bullets that are needed;
- silence: no packet on turns needing nothing, with human and non-human turns reported separately;
- proactive recall;
- redundancy with context;
- stale-value rate;
- packet tokens;
- hot-path latency p50 and p99, and memory, at thousands of memories;
- the downstream-effect score.

Judge on the Pareto frontier, on coding and non-coding arms alike.

## 5. Part B — the never-ending research loop

**State files**, all under `docs/memory-ship/research/R10/`:
- `STATE.md` holds:
  - the Pareto frontier per arm;
  - the hypothesis portfolio and each one's status;
  - the graveyard: failed ideas and why they failed;
  - the next three experiments;
  - every test or holdout look.
- `LEDGER.md` is append-only: hypothesis, setup, numbers, verdict for every experiment.
- `R10-retrieval.md` is the readable report.

**Each cycle:**
1. Re-read BRIEF.md and STATE.md.
2. Pick experiments by the exploration rules below.
3. Implement runnable code under `benchmarks/` or `research/`, never product behaviour on `main`.
4. Measure on dev. Score test only when a candidate has earned it, and log the look.
5. Update STATE.md and LEDGER.md. Commit and push to a research branch, and keep a draft PR updated.
6. Spawn an independent **adversarial critic** subagent. Its brief: "argue the current best is a local optimum; find blind spots and failure classes; propose 3 orthogonal directions; check the numbers against the artifacts; check the benchmark against the realism contract." Fold its strongest points into the portfolio.
7. Every few cycles, consolidate:
   - update `R10-retrieval.md`;
   - turn proven ideas into planned slices and waves in ROADMAP and PROGRESS, with pre-registerable targets on the realism arms (coding and non-coding);
   - propose DECISIONS changes;
   - run CI's four steps (`CLAUDE.md`);
   - after an independent reviewer subagent approves, merge the research, benchmark and plan PR with `gh pr merge --rebase`;
   - continue on a fresh branch.
8. Go straight into the next cycle.
   - If a self-paced loop or wake-up tool is available (`/loop`, ScheduleWakeup), use it so the session keeps re-firing. Otherwise never end your turn.
   - Never write a "final report and stop". Feeling finished is the trigger for a blank-slate redesign cycle.

**Exploration rules (against local optima):**
1. **Portfolio.** Keep at least 5 live hypothesis families that differ in *mechanism*, not parameters. Examples of the intended breadth (go beyond them):
   - injection as value-of-information or utility maximisation under a token budget;
   - sleep-time compilation of memories into executable need-predicates or programs;
   - distilling a strong LLM judge into a sub-millisecond per-user model;
   - labels from the downstream effect;
   - anticipatory retrieval from conversation and world state;
   - structured world-state tracking instead of retrieval;
   - generative self-play producing per-user training data;
   - learned sparse expansion;
   - cognitive models of recall and priming;
   - recommender and bandit framings with online feedback;
   - models of what is already in context.
2. **Exploration share.** At least 40% of each cycle goes to families that are not the current best. Never run more than two consecutive cycles of parameter tuning.
3. **Blank slate.** Every 3rd cycle, design a complete system from scratch without looking at the current best, then compare.
4. **Ceilings.** Maintain oracle ceilings (a strong LLM judge with full knowledge; a perfect-need oracle). Decompose the remaining errors into classes and aim new ideas at the largest class.
5. **A moving benchmark.** Each cycle a red-team subagent adds hard, *realistic* cases to dev. Report frozen and fresh sets separately.
6. **Kill criteria first.** Write each hypothesis's kill criterion before running it. Revisit buried ideas only with a new argument.

## 6. Constraints

Challenge these only with measured grounds, as labelled DECISIONS proposals; never break them silently.
- **Hook hot path.** Hook hot paths allow no LLM or embedding calls today, and the Submit budget is 150 ms (D15, D20). Heavy work belongs at sleep or in an optional warm daemon. If a design needs a model at hook time, measure its latency and cost and say so.
- **Product changes.** No product behaviour change on `main` outside the slice lifecycle in `CLAUDE.md`. Product changes become planned slices, or ship behind a flag in shadow with that full lifecycle.
- **Secrets and private data.** Never commit secrets, transcripts or `.env`. Private real data exists only on the user's machine; do not try to reach it.
- **The `whatever` loop.** Do not start the repo's `whatever` loop (`CLAUDE.md`). This research loop is the user's explicit request and is a different thing.
- **Models.** Offline models normally use NVIDIA NIM via `NVIDIA_API_KEY`, which is probably not set here. Use whatever model access you have, or your own reasoning for data generation, and record the source of every dataset.
- **Attribution.** Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## 7. Status notes

After each cycle, print 3–6 plain-language lines:
- what was tried;
- the frontier per arm;
- what is next.

Then continue. **Do not stop until the user stops the session.**
