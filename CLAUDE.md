# Eden — agent instructions

Bun/TypeScript monorepo. The repo is `Knihalani/Eden`, and all work targets `main`. CI (`.github/workflows/test.yml`) runs four steps:
1. `bun run format:check` (`scripts/format.sh`; `bun run format` fixes all but long comments)
2. `bun run typecheck`
3. `bun run test` (`scripts/test.sh`)
4. `EDEN_SKIP_CHECKS=1 bash scripts/build-cli.sh`. Without the variable, build-cli runs typecheck and the whole suite again first.

In CI, steps 1, 2 and 4 run in one job, and step 3 runs in six parallel shards (`EDEN_TEST_SHARD=k/6`). A run takes about as long as its slowest test file.

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
3. **Red first** (second commit): add the slice's arms to `benchmarks/memory-long-horizon/arms.json` as `red`, each with the failure `reason` asserted. A test that fails for the wrong reason is a broken test.
4. **Implement** to the spec. Where the spec is ambiguous, pick the reading most consistent with DECISIONS and record it under "Decisions made" in the report. Fixture or oracle edits go in separate commits prefixed `fixture:`.
5. **Verify.**
   - While iterating, run only the affected test files. Run CI's four steps locally once, on the final tree, all green. The full suite takes about 12 minutes, so don't repeat it for each small fix: re-run the affected files, and let GitHub CI cover the final push.
   - Run the slice's arms twice in fresh processes; results must match.
   - Run both flag states (`off` = identity, `shadow` = shadow ledger only).
   - Run the end-to-end scenario in a **real Claude Code session** with the plugin built from this worktree. Run it headless: `claude -p … --plugin-dir ./plugins/eden-memory`, with a temp `EDEN_MEMORY_DIR` (details in `.claude/commands/slice.md`).
   - Record the numbers exactly as the commands printed them.
6. **Independent review.**
   - Run the `slice-reviewer` subagent on the diff and prereg. It must return `APPROVE`.
   - Fix every correctness, spec or test-honesty finding and re-run it. Stop after 3 rounds and mark the slice `blocked`.
   - Also run `/security-review` for P0.4, P0.5, P2.3, any migration, and anything touching secrets or permissions.
7. **Merge.**
   - Rebase on `origin/main`, push, open the PR with the report as its body. Put related fixes in one PR, so CI runs once rather than once per PR.
   - Wait for CI (`gh pr checks --watch`); it must be green. Until P0.−1 lands, CI is red on `main`; then require "no new failures versus `main`" instead.
   - `gh pr merge --rebase --delete-branch`.
   - Never force-push `main`. Never rewrite published history.
8. **Record.**
   - Update `PROGRESS.md` (status, PR, report link).
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
- CI: <local + GitHub run link>
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
