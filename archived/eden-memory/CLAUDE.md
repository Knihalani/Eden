# Eden — agent instructions

Eden is passive memory for coding agents ([README.md](README.md); docs index: [docs/README.md](docs/README.md)). The compile-era code still in the tree (`packages/compile`, `runtime`, `shadow`, `measure`, `know`, `sdk-js`, `sdk-py`, the "compile traces into a tool" CLI commands) is not the product; its documents are in `archived/compile-era/`. Describe Eden from `docs/memory-ship/`, not from compile-era docs.

Bun/TypeScript monorepo. The repo is `Knihalani/Eden`, and all work targets `main`. CI is four steps (`.github/workflows/test.yml` lists them):
1. `bun run format:check` (`scripts/format.sh`; `bun run format` fixes all but long comments)
2. `bun run typecheck`
3. `bun run test` (`scripts/test.sh`)
4. `EDEN_SKIP_CHECKS=1 bash scripts/build-cli.sh`. Without the variable, build-cli runs typecheck and the whole suite again first.

**GitHub Actions is off** (since 2026-10-10: the user does not pay for Actions minutes; the `test` and `stability` workflows are disabled). CI runs **locally** and gates every merge: the four steps, once, on the final tree, in a checkout outside the repo. `bun run test:parallel` runs step 3 as six parallel shards (`scripts/test-parallel.sh`, `EDEN_TEST_SHARD=k/6`), balanced by each test file's measured time (`scripts/test-shard.ts`, `scripts/test-times.txt`; refresh the table when you add a test file that takes more than a few seconds), then the latency-gated files of `scripts/test-serial.txt` alone. A latency-gated file that fails under load is re-run alone on a quiet machine, and the report says so. Local runs are macOS only: name any test whose behaviour depends on the platform.

## The memory program (most work here)

The Eden memory rebuild is planned in `docs/memory-ship/`. Read these before touching memory code (`src/`, `packages/cli/src/memory-hook.ts`, `packages/wrap/src/`, `plugins/eden-memory/`):

| Doc | Why |
|---|---|
| `docs/memory-ship/PROGRESS.md` | What is done, what is next, dependencies |
| `docs/memory-ship/ROADMAP.md` | The slice: its build scope, size and gate |
| `docs/memory-ship/DECISIONS.md` | Every design decision (D1–D37, X1–X12). **It wins every conflict** |
| `docs/memory-ship/A4-DELIVERY-CONTRACT.md`, `A7-CUES.md`, `A6-TRUST-AND-SAFETY.md` | The normative spec |
| `docs/memory-ship/A5-EVALUATION.md` | The test arms and metrics that gate each slice |
| `docs/memory-ship/EXECUTION.md` | How to build, verify, merge and roll out |

Run slices with `/next` (picks the next unblocked slice) or `/slice <id>`. Both follow the lifecycle below.

## Autonomy

- Agents in this repo have **full permissions**: they may commit, push, open PRs and **merge their own PRs into `main`**.
- Because nothing mechanical stops a bad merge, **the quality gates below are mandatory**. Skipping one is a defect, not a shortcut.

## Slice lifecycle (every slice, in order)

1. **Isolate.** Work in a git worktree on branch `mem/<slice>-<slug>`, cut from an up-to-date `origin/main`. Never work in the main checkout. Never share a worktree with another agent.
2. **Pre-register** (first commit): `docs/memory-ship/prereg/<slice>.md`, ≤ 15 lines:
   - target metric, baseline (measured now, not assumed), pre-registered delta;
   - the A5 arms that gate the slice;
   - A5 tolerance table and the paired counter-metric;
   - `harness_sha` = `git rev-parse HEAD:benchmarks/memory-long-horizon`.
   Targets are never edited after results are known. If the harness changes, amend the prereg in a visible commit that says why.
3. **Red first** (second commit). Every A5 §4 arm is already in `benchmarks/memory-long-horizon/arms.json` with its measured state on today's plugin (P0.0c): `red` with the checks it fails and why, or `green` (5 `on` states). Run the slice's arms (`bun benchmarks/memory-long-horizon/arms/run.ts --arm <id>`) and confirm each matches its record. A green arm must stay green. This commit adds the slice's own failing tests, and any arm or check the slice adds, as `red` with its failing checks and why. A test that fails for the wrong reason is a broken test.
4. **Implement** to the spec. Where the spec is ambiguous, pick the reading most consistent with DECISIONS and record it under "Decisions made" in the report. Fixture or oracle edits go in separate commits prefixed `fixture:`. When an arm passes, set it `green` in `arms.json` in the commit that makes it pass. A slice that builds an entry point an arm drives confirms or revises that arm's contract (its header) in a `fixture:` commit.
5. **Verify.** Cheap checks while the code changes; the full measurement once, on the commit the code review approved (step 6). Details and commands: `.claude/commands/slice.md` §5.
   - While iterating, run only the affected test files, the slice's arms (`arms/run.ts --arm <id>`) and the earlier review rounds' probes (committed as tests). For behaviour changes, add one kept world replay and the real-session end-to-end (minutes each). No full measurement chain while the code is still changing.
   - Measure with `bun run measure:slice` (`scripts/slice-measure.ts`). It runs the count-only measures in parallel (arms in every flag state, the nine guard runs, R6 replays) and the timing-sensitive ones alone on a quiet machine (soak, bench). After a later change, `--changed <last measured commit>` re-runs only what that change can affect; the report lists what was skipped and why.
   - Run CI's four steps locally once, on the final tree, all green, with `bun run test:parallel` for step 3, in a checkout outside the repo. Don't repeat them for each small fix: re-run the affected files. Keep the logs: the reviewer's evidence check reads them.
   - Run the slice's arms twice (the measure script runs `on` twice, as separate fresh processes); both runs must match `arms.json`.
   - Run both flag states: `--flags off` (identity) and `--flags shadow` (shadow ledger only). The suite gates them for one sample arm per group, so a slice that changes flag behaviour runs both on every arm and updates `arms.json`.
   - Run the end-to-end scenario in a **real Claude Code session** with the plugin built from this worktree. Run it headless: `claude -p … --plugin-dir ./plugins/eden-memory`, with a temp `EDEN_MEMORY_DIR` (details in `.claude/commands/slice.md`).
   - Record the numbers exactly as the commands printed them.
6. **Independent review.**
   - Run the `slice-reviewer` subagent on the code first: the diff, prereg, tests and arms, before the full measurement. After the measurement, the same reviewer checks the report's numbers against the artifacts (the evidence check). It must return `APPROVE`.
   - Fix every correctness, spec or test-honesty finding and re-run it, and commit the reviewer's probes as regression tests. Stop after 3 code-review rounds: ask the user whether to allow one more; otherwise mark the slice `blocked`.
   - Also run `/security-review` for P0.4, P0.5, P2.3, any migration, and anything touching secrets or permissions.
7. **Merge.**
   - Rebase on `origin/main`, push, open the PR with the report as its body. Put related fixes in one PR.
   - Local CI on the final tree must be green. If the rebase changed files the slice touches or imports, run it again on the rebased tree. No GitHub run exists to wait for.
   - `gh pr merge --rebase --delete-branch`.
   - Never force-push `main`. Never rewrite published history.
8. **Record.**
   - Update `PROGRESS.md` (status, PR, report link, and its follow-ups table: see `.claude/commands/slice.md` step 8).
   - Write the report to `docs/memory-ship/reports/<slice>.md` (format below) and include it in the merged PR.
   - Print the report as the final message.

## Engineering rules

- **Fail open.** Every hook entry point exits 0 and prints nothing on error. On UserPromptSubmit, exit code 2 **erases the user's prompt**.
- **Isolated tests.** Tests and benches set `EDEN_MEMORY_DIR` / `EDEN_HOME` to a temp dir. Never read or write `~/.eden` from a test.
- **No models on hook hot paths.** No LLM or embedding calls in any hook. Offline models use NVIDIA NIM (`NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NIM_MODEL` in `.env`), only in sleep or evals, only on sanitized rows. Never print or commit the key.
- **Secrets.** Run the secret scan before every commit that adds data files. Never commit `.env`, transcripts, `~/.eden` contents or the private real-negative set.
- **Readable code.** No line over the formatter's max length (120). Only literal text may run past it: a string, a regex, or a template's text (not the code in its `${…}`). Do not join lines to shrink line counts: lines of code are never a metric.
- **Holdout.** Never read the private holdout (`~/.eden/eval/real-negatives*.jsonl`). Use aggregate numbers and the ids of false fires only.
- **Autonomous loops.** Do not start the `whatever` loop. `.whatever/STOP` exists on purpose (EXECUTION X9).
- **Scope.** Stay inside the slice. File anything else as a follow-up in the report.

## Report format (`docs/memory-ship/reports/<slice>.md`, also the PR body and the final message)

```markdown
# <slice id> — <title>

**Outcome:** <one sentence: merged / blocked, and what now works that did not before>
**PR:** <url> · **Merge commit:** <sha> · **Date:** <yyyy-mm-dd>

## What changed
- <behaviour-level bullets; then key files with one-line purpose>

## Pre-registered target vs result
| Metric | Baseline | Target | Result | Met? |

## Guards (A5 tolerances)
| Metric | Baseline | Result | Δ | Tolerance | OK? |

## Evidence
- Arms: <red→green list, with the command run>
- CI: <local: the four steps' results on the final tree, with the commit>
- End-to-end: <scenario, what happened in the real session, hook.log ids>
- Review: <reviewer verdict, rounds, findings fixed>

## Decisions made
- <spec ambiguities resolved and why, with the DECISIONS/A4 section>

## Not done / follow-ups
- <anything out of scope, deferred, or still uncertain>

## Verification notes
- <every number above came from a command in this session; list anything unverified and why>
```

The report must be **accurate**:
- Every number is copied from command output produced in this session.
- Nothing is rounded into a better result.
- Unverified claims are labelled as such.
- A failed or blocked slice is reported as plainly as a successful one.
