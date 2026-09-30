# Eden Memory — Execution methodology

**Dated 2026-09-29.** How the ROADMAP is built, verified, shipped and rolled back.

- `DECISIONS.md` decides **what**; `ROADMAP.md` decides the **order**; this file decides **how**.
- Evidence: `research/R9-execution-methodology-research.md` (practices, statistics, repo facts; 45 references) and `research/R8-nim-experiments.md` (offline models).
- Execution decisions are numbered **X1–X12** and cited from the ROADMAP.

**Operating model (decided by the user, 2026-09-29): full agent autonomy.**
- Agents run with all permissions (local `bypassPermissions`).
- They commit, push, open PRs, **merge their own PRs** and flip rollout stages.
- The user's involvement is reading reports and labelling the few packets the stages need.

Because nothing mechanical blocks a bad merge, quality comes from process, and these rules are mandatory:
- work on a branch in its own worktree;
- open and merge a PR only when the definition of done (§3) is met;
- an independent reviewer agent must approve;
- verify end to end;
- research deeply, with primary sources.

The rules live in `CLAUDE.md` (loaded by every agent), the `/next` and `/slice` commands and the `slice-reviewer` subagent. That way nobody has to repeat them.

---

## 0. Principles

1. **Evidence before code.** Every slice starts with a pre-registered target and failing tests that fail *for the documented reason*.
2. **Merge dark, enable in stages.** New behaviour merges behind a flag set to `off`/`shadow`. Turning it on is a separate, reversible step taken by the agent only when the stage's entry criteria and minimum soak time are met (§5). The evidence is recorded in `reports/stage-<n>.md`.
3. **One change at a time is attributable.** One slice per PR; one delivery point per rollout stage.
4. **Fail open, always exit 0.** Eden must never break, block or slow a turn beyond its budget.
5. **Loops tune parameters; humans decide designs.** The autonomous optimizer never touches schemas, trust, scope or delivery semantics.
6. **Local data stays local, and text is opt-in.** Logs carry ids and hashes. Any text is sanitized, retained 30 days, and never enters git or an agent's context without the user.

---

## 1. Day-0 reset (before P0.0)

**State as of 2026-09-29, after the merge** (R9 §3, updated):
- **Remote.** The repository is **`Knihalani/Eden`** (private). The `origin` URL was updated.
  - Its GitHub **default branch is still `feat/compiled-tools-horizon`**. Every slice branches from and targets **`main`**.
- **Merge.** The user chose to merge everything. `main` was fast-forwarded to `11c3101c3` (1,700 commits; no history rewritten). It now contains:
  - the whole `whatever/sep28-scale` loop history, including its ~290 line-joining "pack" commits;
  - the previously untracked memory product files, tests and benches;
  - the memory-ship docs.
- **The loop.** Its primary metric saturated at **experiment 1 of 321** (misses 1 → 0). The remaining keeps passed only a net-line-deletion rule. `src/index.ts` went from 1,444 to 379 lines, mostly by joining lines: 48 lines exceed 200 characters, and the longest is 1,001.
- **CI is red on `main`.** `bun run typecheck` fails with **112 errors**, mostly `packages/know/src/pack.ts`, plus `packages/know/src/store.ts` and `apps/site/src/assets.ts`. Tests and the CLI build never run. `main` was already red before this merge (every run since 2026-08-25).
- 8 of 10 registered worktrees are prunable.

| # | Action | Owner | Status | Why |
|---|---|---|---|---|
| R-1 | **Revoke or rotate the pasted API token** (`cfat_…`) found in the Claude transcripts | user | **open** | Rotation removes its power; scrubbing only removes copies (R9 §1.5 R5.2) |
| R-2 | Park the loop | agent | **done 2026-09-29**: `.whatever/STOP` and `.whatever-v1/STOP` written. The `whatever` skill finishes on any wake while STOP exists | Goodhart on a saturated metric (X9) |
| R-3 | ~~Salvage metric-moving keeps instead of merging~~ | — | **superseded**: the branch was merged by the user's decision. Its useful change (skip WH-question store) is on `main` with the rest. R-5 handles readability | — |
| R-4 | Base for all slices | — | **decided**: branch from `main` (`mem/<slice>-<slug>`) | A single baseline |
| R-5 | **Hygiene PR**: add a formatter config with a max line length (the repo has none); reformat `src/index.ts`, `src/memory-sota.ts` and the other pack-touched files so no line exceeds the limit; `git worktree prune`. Behaviour-neutral: the diff must be formatting only, verified by an identical test run before and after | agent → user merges | open | Every later diff in those files must be reviewable |
| R-6 | Agent permissions | agent | **done 2026-09-29, then superseded the same day by the user's choice of full autonomy.** Now: `.claude/settings.local.json` sets `defaultMode: bypassPermissions` (personal, git-ignored); the shared `.claude/settings.json` has no restrictions. Superseded first version: `deny` `Bash(gh pr merge*)`, `Bash(git push* main*)`, `Bash(git push*:main*)`, `Bash(git push --force*)`, `Bash(git push -f*)`; `ask` `Bash(gh pr create*)`. Agents can no longer push to `main` or merge; `main` changes only through a PR the user merges | The user's norms, enforced by the harness |
| R-6b | On GitHub, after R-9 makes CI green: require the `test` check on `main` (agents merge through PRs, so a required check is the one mechanical gate that remains); consider setting `main` as the default branch | user (or agent via `gh api`) | **partial 2026-09-30**: `main` is the default branch. Requiring the `test` check is blocked: GitHub answers 403 "Upgrade to GitHub Pro or make this repository public" to both branch protection and rulesets on this private repo. User: upgrade the plan, then add a ruleset requiring `test` and blocking force-push and deletion on `main` | Server-side enforcement; a required check that always fails would block every PR |
| R-7 | Snapshot `session_id → cwd` for every existing Claude transcript into `~/.eden/migrate/session-map.json`, **now** | agent (script) | **done 2026-09-29**: 40 sessions, 8 distinct cwds, file mode 0600 | Claude Code deletes transcripts after 30 days by default; the migration (P0.5) needs this map |
| R-8 | Start opt-in text collection for the real-negative set (§8) as soon as P0.1's `eden doctor` ships | user opts in | open | 300+ real negatives cannot come from today's 178 prompts; expect 4–8 weeks |
| **R-9** | **Green CI baseline** (ROADMAP **P0.−1**): fix the 112 typecheck errors, then make `bun run test` and `bash scripts/build-cli.sh` pass (or quarantine named failing tests with an issue each) | agent → user merges | **open; blocks P0.0** | Every slice's definition of done (§3 step 4) requires green CI; a red baseline hides every regression |

## 2. Unit of work and branching (X1–X3)

- **X1. One slice = one branch = one PR = one worktree.**
  - Branch `mem/<slice>-<slug>` (e.g. `mem/P0.2-stop-bleeding`), cut from `main`.
  - Worktree `.claude/worktrees/<slice>`. Never two agents in one checkout, and never an agent and the optimizer.
  - Size **L** slices split into 2–4 PRs. For P0.0: (a) event and transcript simulator; (b) oracles and simulated window; (c) red arms; (d) real-negative loader.
- **X2. Merge dark; stack only true dependencies.**
  - A slice merges when its arms are green, with its delivery point `off`/`shadow`.
  - Stack only when a slice needs another's code: P0.3 → P0.5 → P0.6 → P1.1. Maximum depth 3.
  - Rebase, never merge `main` into a slice, so red → green commits stay readable.
- **X3. Lanes.** P0.0 gates everything. After it, at most **3 active lanes**:

| Lane | Slices |
|---|---|
| A | P0.−1 (first, alone) → P0.1 → P0.2 → P0.7 |
| B | P0.3 → P0.5 → P0.6 → P1.1 → P1.2 |
| C | P0.4 → P0.8 → P2.1 → P2.2 (pure functions, parallel with B) |

  Phase 3 and Phase 4 lanes open as Phase 1 and Phase 2 merge.

---

## 3. Slice lifecycle and definition of done (X4)

Each slice runs these steps in order. **The PR is opened only after step 9.**

| # | Step | Artifact |
|---|---|---|
| 1 | **Pre-register** (first commit): target metric, baseline, delta, arms, tolerance table, counter-metric, `harness_sha`, analysis for sampled metrics. ≤ 15 lines. It is committed before any code; the reviewer checks it was not edited after results | `docs/memory-ship/prereg/<slice>.md` |
| 2 | **Red arms** (their own commit): the slice's A5 arms, each with `reason` asserted in `benchmarks/memory-long-horizon/arms.json`. CI fails if a red arm fails for a different reason | `arms.json` diff |
| 3 | **Implement.** Fixture or oracle edits go in separate `fixture:` commits with the reason; reviewers read those first | code |
| 4 | **Local CI**: `bun run typecheck`, `bun run test`, `bash scripts/build-cli.sh` (the CI workflow's steps) | green |
| 5 | **A5 table**: target before/after (Wilson CI where sampled); every guard's delta vs tolerance; locked 2k bench still 0 misses | PR body |
| 6 | **Both flag states**: `off` asserts identity (no stdout, exit 0, no ledger write); `shadow` writes only the shadow ledger; `on` delivers | tests |
| 7 | **End to end in real Claude Code**: build and install the plugin on this machine; run the slice scenario by hand; attach `hook.log` wide events (ids only) and the transcript excerpt of the packet or ask | PR body |
| 8 | **Fresh-context review**: `/code-review` or a reviewer subagent that sees only the diff and the prereg. `/security-review` for P0.4, P0.5, P2.3 and every migration. Fix correctness findings; style is optional | review log |
| 9 | **Five hand-read packets** from the replay, one-line verdict each; DECISIONS/A4 updated if behaviour differs; ROADMAP row gets the PR link | PR body |
| 10 | Rebase; `gh pr create` with the report as the body; `gh pr checks --watch` green (or, until P0.−1 lands, no new failures versus `main`); **`gh pr merge --rebase --delete-branch` by the agent** | merged PR |
| 11 | Later, separately: **stage flip** by the agent per §5, only when entry criteria and soak are met; the evidence goes to `reports/stage-<n>.md` | `flags.json` change |

**Running it.** The brief lives in the repo, so there is nothing to paste:
- `CLAUDE.md` (auto-loaded): lifecycle, engineering rules, report format.
- `.claude/commands/slice.md` (`/slice <id>`) and `.claude/commands/next.md` (`/next`): the full procedure. `/next` picks the first eligible row of `PROGRESS.md`.
- `.claude/agents/slice-reviewer.md`: the independent reviewer that must return `APPROVE` before a merge.
- `docs/memory-ship/PROGRESS.md`: status, dependencies and gates for every slice and stage.

Typical use:
- `claude` in the repo, then `/next`. The agent runs one slice to merge and ends with the report.
- For unattended runs, `/loop /next` runs slices back to back.
- Up to 3 parallel sessions may each run `/next`. Each claims its slice by marking it `in-progress` in its first commit, so pull first.

---

## 4. Evaluation discipline (X5–X6)

**X5. Four data tiers, never mixed.**

| Tier | Contents | Rows visible to | Use |
|---|---|---|---|
| Dev | R1 dev split, new scripted sessions, unit tables | all | tune |
| Locked test | R1 test split, `test_nim` (R8), A5 arms, schedule seeds | all; never tuned on | scored once per slice |
| Private holdout | real negatives + held-back real sessions (§8) | **user only**; agents get aggregates and ids of false fires | P4.3 gate, τ acceptance |
| Dogfood | live `hook.log`, `miss.jsonl`, weekly labels | user | find regressions; never a ship vote |

Every holdout look is logged. The holdout is refreshed after ~20 looks or at each phase boundary.

**X6. Statistics by kind of metric.**

| Kind | Practice |
|---|---|
| Deterministic arms | pass/fail; run twice in fresh processes; any disagreement is a bug |
| Concurrency arms (`spawn-writers`) | ≥ 20 repetitions, 0 failures required; report the rule-of-three bound |
| Rates (FIR, policy recall, guard precision) | Wilson 95% CI; compare methods by per-cue paired tests (McNemar), clustered by memory/session |
| Zero-event hard gates | 0/n bounds the rate at ≈ 3/n. Grow `secrets` to ≥ 300 cases (shapes × 4 channels × positions) so "0" means ≤ 1% |
| Latency p99 | ≥ 1,000 samples per point (1,000-turn soak); median of 3 runs |
| Dogfood trends | monthly, n ≥ 80; no decisions from weekly peeks |

**Before the first slice PR, run the harness A/A** (baseline against itself, fresh processes) and record each metric's noise floor in A5. No tolerance may be tighter than its noise floor.

**Sizing for the P4.3 FIR gate** (Wilson, 95%):
- FIR is gated as a **point estimate on ≥ 300** real negatives, with its interval printed.
- It is called *certified* only when the upper bound is ≤ 5%. That needs ~460 negatives at an observed 3%.

**Goodhart controls.**
- **Paired counter-metrics** in every prereg:

| Target | Counter-metric |
|---|---|
| recall | FIR, silence |
| `packet_rate` | `need_miss` |
| `redundant_rate` | `need_miss` |
| `guard_recall` | `guard_precision`, `guard_bypassed` |
| p99 | gold recall |

- **Oracle independence.** Oracle directories are never imported by `src/`, enforced by a test. Fixture edits land in separate `fixture:` commits.
- **Saturated arms become regression arms.** They must stay at 100% and no longer count as progress.
- **Qualitative veto.** One `harmful` dogfood label blocks promotion of that delivery point until it is a green fixture.

---

## 5. Rollout (X7–X8)

**X7. Flags: one per delivery point, `off | shadow | on`, read from a file on every event.**

| Flag | Point | While building | At stage |
|---|---|---|---|
| `EDEN_MEMORY` (exists) | master | on | — |
| `deliver.submit` | UserPromptSubmit | shadow → on | 2 |
| `deliver.session_start`, `deliver.subagent` | SessionStart, SubagentStart | shadow | 3 |
| `deliver.batch`, `deliver.failure` | PostToolBatch, PostToolUseFailure | shadow | 4 |
| `guard.context` | PreToolUse `additionalContext` | shadow | 5 |
| `guard.ask` (= `EDEN_POLICY_GUARD`) | PreToolUse `ask` | off → shadow | 6 |
| `sleep.llm` | NIM calls at sleep (§7) | off | per repo, user opt-in |
| `log.text` | text-bearing dogfood log | off | user opt-in |

- **Location and precedence.** Flags live in `~/.eden/flags.json`, with an optional per-repo override. Precedence: env > repo file > user file > default.
- **Env vars are not a kill switch**: hooks inherit the environment Claude Code started with. The file is the kill switch, and it applies from the next event.
- **Unknown values resolve to `off`** (`shadow` for `deliver.submit`). This reverses today's `memoryConsent` (unknown → on, `src/memory-consent.ts:14`).
- **Flag lifecycle.** Each release flag has a removal date, and a test fails once it passes. Kill switches (`guard.ask`, the master) are exempt.

**Shadow mode** runs the full pipeline inside the real latency budget and emits nothing. It writes a **shadow ledger** (`delivery.shadow.log`), so refractory behaviour is simulated honestly, plus a wide event.

It measures:

| Measure | What it tells you |
|---|---|
| `would_preempt` | Did a shadow packet in the last 3 human turns contain the cid the user then restated? The G1 estimate before enabling |
| shadow `packet_rate` and `redundant_rate` | Would the point meet the A5 packet and redundancy gates on real traffic? |
| `would_ask` (+ what the user did next) | guard precision and recall evidence |
| p99, aborts | real latency on the real code path |

When a point is replaced, the old and new paths run side by side and log `match | mismatch` (Scientist pattern).

**X8. Stages** (canary = the user's own Eden sessions; **one point per stage**):

| Stage | Turn on | Entry | Dwell | Roll back on |
|---|---|---|---|---|
| 0 | replay of R6 sessions + A5 arms | slice arms green | — | — |
| 1 | shadow on every point (Eden repo) | Phase 0 floor green | ≥ 7 days and ≥ 50 human prompts | any user-visible hook error; p99 over budget |
| 2 | `deliver.submit` | shadow packet_rate ≤ 30%, redundant < 5% | 7 days | any `harmful` label; `secret_bytes`/`poison_hits` > 0 |
| 3 | `session_start`, `subagent` | subagent arm green; ≥ 20 labelled shadow subagent packets, 0 harmful | 7 days | as above |
| 4 | `batch`, `failure` | ≥ 20 labelled shadow batch packets, 0 harmful | 7 days | a packet that derails a working agent (`distracting`) |
| 5 | `guard.context` | `would_ask` precision ≥ 0.9 on ≥ 20 labelled events | 7 days | a false context on an irreversible command |
| 6 | `guard.ask`, irreversible classes | `guard-modes` arm green on the installed Claude Code (≥ v2.1.211) | 14 days | any false `ask`; any deny caused by Eden |
| 7 | other repos (per-repo flag file) | stages 2–6 clean | — | per-repo off |

Dwell times are **[U]** until stage 1 measures the real prompt rate.

**Fail-open contract.**
- Every hook exits 0 and prints nothing on error. On UserPromptSubmit, exit code 2 **erases the user's prompt**, and other non-zero codes show stderr to the user.
- A test injects a throw into each entry point and asserts exit 0 with empty stdout and stderr.
- Budget per point: `abort_rate` ≤ 0.5%, unhandled exceptions ≤ 0.1%, user-visible errors 0.
- **Circuit breaker:** a point that exceeds its budget over its last 200 invocations is forced to `shadow` for 24 h via `~/.eden/flags.auto.json`. `eden doctor` and the next SessionStart say so once. Re-enabling needs a new stage evaluation (`/next stages`) that shows the cause is fixed.

**Kill switches**, narrowest first:
1. per-point flag in `flags.json` (next event);
2. `EDEN_MEMORY=off` (next session);
3. disable the plugin or `disableAllHooks`.

`eden doctor` prints all three.

**Observability.** One wide event per hook invocation. Fields:
- `point`, `mode`, flag states
- `repo`, `win`, `hturn`, `prompt_id`
- human or non-human, turn mode
- cids, stage drops, top score and τ
- `ms`, `aborted`, `err`

Always slice by point and by submit kind before comparing; non-human submits are 63% of all submits (R6), so pooled rates mislead. Nightly: run the A5 arms against the **installed** plugin build, not only the repo.

---

## 6. The optimization loop (X9)

- **Use** it only when all four hold:
  - a bounded parameter;
  - a frozen, versioned harness;
  - an unsaturated metric;
  - every A5 hard gate is a guard.
- **Targets**, once harness v2 exists:
  - BM25F weights, `k1`/`b`;
  - the 0.7·top ratio;
  - cue-part mass limits;
  - τ-fitting constants;
  - refractory distances, once dogfood gives `message.usage` data;
  - packet soft limit;
  - p99 micro-optimizations under a behaviour-equivalence guard.

  All of these move into one module, `src/memory-params.ts`, first.
- **Never** use it on schemas or storage, delivery semantics, the trust gate, scope rules, wording, or anything needing a human label.
- **Controls:**
  - scope limited to `memory-params.ts`;
  - `harness.sha256` recorded in every results row; a harness change ends the run;
  - the agent may not edit the harness or benches; the hash is checked each iteration;
  - epsilon ≥ 2× the baseline's spread over 5 runs;
  - **stop at saturation** (no "simplicity-only" phase; lines are never a metric);
  - guards = hard gates + a formatter/max-line-length check;
  - a holdout scored once, at the end (discard the run if the gap is large);
  - a keep that touches a bench-imported file, or special-cases a bench string, is discarded on sight;
  - its own worktree;
  - the output is squashed into ≤ 5 commits and goes through §3 like any slice.

---

## 7. Offline models: NVIDIA NIM (X10)

Decided in DECISIONS **D37** from `research/R8-nim-experiments.md`.

**Rules:**
- **Provider.** NVIDIA NIM, through its OpenAI-compatible API, replaces MiniMax, which is no longer used. The repo's benchmarks already use it: `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NIM_MODEL`; default `google/gemma-4-31b-it`.
  - **Hosted:** `integrate.api.nvidia.com`.
  - **Self-hosted:** a NIM container exposes the same API locally. This is the privacy path, since only the base URL changes.
- **Where it may run:** sleep and offline evaluation only. **Never on any hook's hot path** (lock unchanged).
- **Consent.** Opt-in per repo via `sleep.llm` (§5).
- **What it receives.** Only `sanitizeForStore`d rows, never files, diffs or transcript text.
- **Provenance.** Every model output is recorded with its model id, so `purge` can remove everything a provider produced.
- **Budget.** Responses are cached, and there is a per-day request cap.
- **Evaluation.** Model outputs such as aliases, extractions or proposals are accepted only through the same silence-set and annotated-set gates as any other change.

**Model per job** (R8):

| Job | Model | Gate it passed | Tier |
|---|---|---|---|
| Extraction confirm + extend (P5.4) | `google/gemma-4-31b-it` | E3: false durable 1/217, slot recall 1.00, rule recall 0.97; 0/26 raw pastes | opt-in, hosted |
| Blind alias candidates (P5.3a) | `google/gemma-4-31b-it` | E2: with τ refit, R1 test 0.482 / 5.0% FIR (vs 0.498 / 7.5%), held-out paraphrases 0.102 vs 0.000 | opt-in, hosted |
| Held-out cue authoring for evals | `moonshotai/kimi-k3` | a different model family from every alias, extraction or memory author | eval only |
| Dense arm experiment (P6.2) | `nvidia/nemotron-3-embed-1b` | E5: +0.14 recall@4 at half the FIR (5% point); collapses at strict silence | sleep / experiment only |
| Local extraction (≥ 32 GB machines) | `openai/gpt-oss-20b` via llama.cpp/Ollama | E3: 0/217 false durables, slot recall 0.92, rule recall 0.79 | optional |
| Not admitted | `nemotron-3-super`, `nemotron-3.5-lightning` (reasoning off) for extraction; content-safety guards as a trust gate | 15 / 7 false durables; guards miss authority spoofing | — |

**Operational limits** (R8 §4):
- Hosted latency is dominated by queueing: p50 1–20 s, p95 40–70 s. Hosted calls therefore run only in detached heavy sleep, never on a hook path.
- Cap requests at 36 per minute across processes; retry 429/503 with backoff; cache every response by payload hash.
- Batch 10 utterances per extraction request to cut system-prompt tokens by about 8×. That is roughly 1 M prompt tokens per 1,000 utterances unbatched.
- Log every call's model, latency and token usage to `~/.eden/…/llm-calls.jsonl`.
- **This machine:** Apple M3, 16 GB, no NVIDIA GPU. Self-hosted NIM is impossible here, and gpt-oss-20b is tight. The practical choice is hosted opt-in or no model.

---

## 8. Data governance and the real-negative set (X11)

| Log | Contents | Default | Retention |
|---|---|---|---|
| `hook.log.d/` | ids, cids, counts, stage drops, scores, ms, flags, **hashes** of prompt text; **no text** | on | 90 days, then daily aggregates |
| `delivery.shadow.log` | cid, ver, offset | in shadow | until the point flips |
| `dogfood/prompts.jsonl` | human prompt text after `sanitizeForStore`, pastes stripped | **opt-in** (`log.text`) | 30 days |
| `eval/real-negatives.vN.jsonl` | curated, reviewed negatives | explicit command | versioned by sha256; **never in git** |

- Everything is local. A test asserts that no Eden writer resolves a path inside any git toplevel.
- `sanitizeForStore` runs before every write, including error fields.

**`eden eval build-negatives`** (user-run):
1. Select human prompts only.
2. Strip pastes as in D12.
3. **Drop, don't redact**, any prompt with a secret-rule hit.
4. Normalize user paths and hosts.
5. **Canary test:** inject 5 synthetic secrets; the build aborts if any survives.
6. The user labels each prompt `negative` / `positive` / `drop` (30–60 min for 300–500 prompts; this is also the privacy review). This is one of the two places the process still needs a human: an agent cannot certify its own holdout.
7. Freeze with a sha256.

Agents see only aggregates and the ids of false fires. CI prints `skipped: private set absent`. The P4.3 gate is run locally and its output attached to the PR.

---

## 9. Migration of existing stores (X12)

This is expand → migrate → contract (Fowler's parallel change; the Stripe online-migration pattern).

1. **Expand** (P0.5): new writes go to per-repo stores; the migrator reads old ones.
2. **`eden memory migrate --dry-run`** (default): prints the mapping from R-7's snapshot, rows in/out, sanitizer drops (counts only) and unmappable sessions.
3. **`--apply`:**
   1. tar backup (0600, 30-day TTL, inside `purge` scope);
   2. repo `flock`;
   3. stage on the same filesystem;
   4. `rename(2)` swap;
   5. deterministic `legacy:<hash>` ids, so re-runs are no-ops;
   6. old tree renamed to `memory.legacy-v1/`, read-only.
4. **Verify:** row accounting; 50-cue old-vs-new read comparison. A mismatch rolls back automatically.
5. **`--rollback`:** delete `legacy:` rows, restore the tree. Rows written after the migration are never touched.
6. **`--contract`** (≥ 30 days, user-confirmed): delete the legacy tree and the backup.

Every store carries `format.json`; a reader seeing an unknown major version does not inject from that store. The A5 `migrate` arm covers crash injection between steps, idempotency, byte-identical rollback, and `secret_bytes = 0`.

---

## 10. Calendar (one engineer + agents; ≤ 3 lanes)

| Week | Lane A | Lane B | Lane C | User touchpoints |
|---|---|---|---|---|
| 0 | **P0.−1 green CI** (R-9); hygiene/format PR (R-5); session-map snapshot (R-7) | — | — | rotate token (R-1); require the `test` check once CI is green (R-6b); read reports |
| 1–2 | **P0.0 harness** (4 PRs); A/A run | — | — | read reports |
| 3 | P0.1 packaging + doctor (+ session map, opt-in collection) | P0.3 ids/clocks | P0.4 trust gate | read reports |
| 4 | P0.2 stop the bleeding → **stage 1 shadow** | P0.5 repo identity + migrate dry-run | P0.8 flags/shadow/wide events | read the migration dry-run report |
| 5 | P0.7 cache placement | P0.6 delta encode | P2.1 extraction | **stage 2** (Submit on) |
| 6–7 | P1.3 residual + shadow | P1.1 ledger → P1.2 epochs | P2.2 triggers → P2.3 guard (shadow) | stage 3 |
| 8 | P2.4 promotion, P2.5 SessionStart/Subagent | P3.1 scope catalog | P3.3 slots | stage 4 |
| 9–10 | P4.1 situation cue | P3.2 place + read set | P3.4 repo facts | stage 5; real-negative set ≥ 300 → P4.3 |
| 11 | P4.2 postings + BM25F, P4.3 gate | P3.5 cascade + first touch | P5.1 restate logging | **stage 6 guard ask** |

This is the minimal viable delivery (ROADMAP) by about week 11. The upper bound matches ROADMAP's 53 working days. Stages move no faster than their dwell and entry criteria allow.

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rewrite collides with loop commits | low (loop parked) | high | R-2 STOP file; X9 scope rule; R-5 reformat before editing |
| Red CI hides regressions | certain until R-9 | high | P0.−1 before P0.0; no slice PR while `main` is red |
| Real-negative set too small to certify FIR | high | medium | R-8 start now; point-estimate gate + printed CI; R1 hard negatives meanwhile |
| Guard `ask` annoys (false or stale policies) | medium | high | stages 5→6, precision ≥ 0.9, decline tracking → revoke proposal, `(class, polarity, object)` keys, intents expire |
| Transcripts expire before the migration maps them | certain after 30 days | medium | R-7 snapshot now |
| Hook latency regress with growth | medium | medium | 150 ms budget abort, prebuilt postings (P4.2), p99 per point in shadow |
| Single-user thresholds overfit | high | medium | per-repo τ refit; dogfood with more users before tightening |
| Hosted NIM receives sensitive text | low (sanitized rows only) | high | opt-in per repo; self-hosted NIM path; provenance for purge |
| Claude Code hook semantics change | medium | medium | nightly arms against the installed build; `guard-modes` arm; raw doc snapshots re-diffed monthly |
