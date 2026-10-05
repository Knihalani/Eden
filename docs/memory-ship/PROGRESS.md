# Memory program — progress

This is the single source of truth for what is done and what is next. `/next` reads this file, picks the first `todo` row whose dependencies are all `done`, runs the slice lifecycle (`CLAUDE.md`), and updates the row.

**Status values:**
- `todo`
- `in-progress` (with branch)
- `done` (with PR + report)
- `blocked` (with reason)
- `waiting` (a stage whose calendar or data entry criteria are not met yet)

**Rules for editing this file:**
- Update it in the same PR as the slice.
- The order of rows is the default priority. Sizes follow ROADMAP: S ≤ 1 day, M ≤ 3 days, L ≤ 2 weeks.
- Slices before P0.0c have no harness arms yet. Their gate is CI plus the check named in the Gate column.

## Day-0

| ID | Item | Deps | Size | Status | PR | Report |
|---|---|---|---|---|---|---|
| R-2 | Park the `whatever` loop (`.whatever/STOP`) | — | S | done | — | EXECUTION §1 |
| R-6 | Agent permissions (full autonomy; see EXECUTION §1) | — | S | done | #1 | — |
| R-7 | Snapshot `session_id → cwd` to `~/.eden/migrate/session-map.json` | — | S | done | — | EXECUTION §1 |
| R-6b | Default branch `main`; require the `test` check on `main` | P0.−1 | S | won't do (user, 2026-10-04: no GitHub Pro; default branch done; a green `test` run stays a merge rule, not a GitHub setting) | — | [reports/P0.-1.md](reports/P0.-1.md) |
| R-1 | Rotate the leaked `cfat_…` token | — | — | won't do (user, 2026-10-04: ignore it) | — | — |
| R-8 | Opt in to text collection for the real-negative set (EXECUTION §8), and to every opt-in flag (`log.text`, `sleep.llm`) | — | — | done (user opted in to everything, 2026-10-04) | — | — |

## Slices

| ID | Slice | Deps | Size | Gate (A5 arm or check) | Status | PR | Report |
|---|---|---|---|---|---|---|---|
| P0.−1 | Green CI baseline (112 typecheck errors; then tests, CLI build) | — | M | GitHub `test` workflow green on `main`; no behaviour change (test count before = after, minus named quarantines) | done | #68 | [reports/P0.-1.md](reports/P0.-1.md) |
| R-5 | Formatter config + reformat line-joined files (`src/index.ts`, `src/memory-sota.ts`, …); `git worktree prune` | P0.−1 | S | formatting-only diff (AST-equal or identical test results before/after); CI green | done | #94 | [reports/R-5.md](reports/R-5.md) |
| P0.0a | Harness: Claude-shaped event + transcript simulator, process-per-event runner | R-5 | M | simulator self-tests; replays an R6-shaped session | done | #107 | [reports/P0.0a.md](reports/P0.0a.md) |
| P0.0b | Harness: world oracle, simulated context window, annotated cues | P0.0a | M | oracle self-tests; A/A noise floors recorded in A5 | done | #108 | [reports/P0.0b.md](reports/P0.0b.md) |
| P0.0c | Harness: every A5 §4 arm, landed **red** with asserted reasons; `arms.json` | P0.0b | L | CI checks red arms fail for their reason | done | #110 | [reports/P0.0c.md](reports/P0.0c.md) |
| P0.0d | Harness: real-negative loader + `eden eval build-negatives` (canary secrets) | P0.0a | S | canary test; CI prints `skipped: private set absent` | in-progress (`mem/P0.0d-real-negatives`) | | |
| P0.1 | Packaging: fresh-clone check, dead tests, `eden doctor`, plugin fallback within 150 ms | P0.0c | S | fresh clone passes; doctor green | todo | | |
| P0.2 | Stop the bleeding: non-human + ack silence, variable k, declarative wording | P0.1 | S | `nonhuman`, `continue`; R6 replay packet rate ≤ 30% | todo | | |
| P0.3 | Ids, clocks, persisted validity | P0.0c | M | `spawn-writers`, `reload-stale`, `numbered-list`; plus two writer processes with the same `pid % 36` run one after the other, and both keep their rows (#98) | todo | | |
| P0.4 | Trust gate: authority, paste stripping, gitleaks + keyword secrets, purge | P0.0c | M | `secrets` (≥ 300 cases), `poison` | todo | | |
| P0.8 | Flags, shadow mode, wide events, circuit breaker | P0.0c | M | both flag states on every arm; injected-throw test | todo | | |
| P0.5 | Repo identity (git-common-dir), window keys, migration | P0.3, P0.4 | M | `cross-session`, `worktree`, `migrate` | todo | | |
| P0.6 | Delta encode, PostToolBatch recording, rewind detection, stop-fast | P0.5 | M | `rewind`; p99 flat over 1,000 turns | todo | | |
| P0.7 | Cache-safe placement (wrap / OpenAI inject) | P0.1 | S | cached-prefix test | todo | | |
| P1.1 | Ledger core | P0.6, P0.8 | M | `repeat`, `budget`, `re-eligibility` | todo | | |
| P1.2 | Epochs: clear, selective PostCompact re-arm, resume, fork, rewind | P1.1 | M | `compaction`, `resume`, `rewind` | todo | | |
| P1.3 | Residual + per-window shadow set | P1.2 | M | `residual`, `shadow` | todo | | |
| P2.1 | Policy & intent extraction (regex, D9 incl. R8 fixes) | P0.4 | M | `extraction` (E3 set) | todo | | |
| P2.2 | Compiled triggers (`classes.json`) | P2.1 | S | `policy-trigger` | todo | | |
| P2.3 | PreToolUse policy guard | P2.2, P1.1 | M | `policy-guard`, `guard-modes`, `guard-dedup`, `intent-expiry` | todo | | |
| P2.4 | Recurrence → pin; user-global proposal | P2.1, P0.5 | S | `policy-recur` | todo | | |
| P2.5 | SessionStart + SubagentStart delivery | P2.3 | S | `subagent` | todo | | |
| P3.1 | Scope catalog (R5 §9 rule) | P0.5 | M | R5 §9.3 + R3 F9 unit rows | todo | | |
| P3.2 | Place signal + read set | P3.1, P0.6 | M | `fan-out`, `single-package` | todo | | |
| P3.3 | Slot table + live/history + retraction | P0.5 | M | slot phrasing table; `negation`; `stale-episode` | todo | | |
| P3.4 | Repo-fact mining + citations + watchPaths | P3.3 | M | `repo-facts`, `citation` | todo | | |
| P3.5 | Cascade + first-touch delivery | P3.2, P3.3 | S | `scoped`, `cascade`, `first-touch` | todo | | |
| P4.1 | Situation cue + turn mode | P1.3 | S | `continuation`; CueBench ctx ≥ 0.40 | todo | | |
| P4.2 | Prebuilt postings + BM25F + bounded C + budget abort | P4.1, P3.1 | M | `scale-20k` | todo | | |
| P4.3 | Evidence gate + τ calibration | P4.2, P0.0d | M | CueBench + real negatives (point estimate + CI) | todo | | |
| P4.4 | Slot detector + indirect bundles | P3.3, P4.1 | S | indirect recall ≥ 0.3 at unchanged FIR | todo | | |
| P4.5 | Gotchas (failure → success; PostToolUseFailure) | P0.6 | M | `gotcha` | todo | | |
| P4.6 | How-to lane | P4.2 | S | non-flake how-to scoped | todo | | |
| P5.1 | Restate / confirm logging + weekly report | P1.1 | S | events on every arm | todo | | |
| P5.2 | Restatement classification | P5.1 | M | scripted class table | todo | | |
| P5.3 | Bridge maturation (NIM alias batches + miss-driven class words) | P5.2, P4.3 | M | `alias-batch`, `restate-learn` | todo | | |
| P5.4 | Sleep LLM extraction (NIM, opt-in) | P2.1, P3.3 | M | E3 admission gate | todo | | |
| P6.1 | SQLite store + FTS5 with guards | P4.2 | L | `scale-1e6` | todo | | |
| P6.2 | Dense-arm experiment (≥ 1B embedder, warm) | P6.1 | M | D15 re-open condition | todo | | |

## Follow-ups for later slices

Earlier reports filed these follow-ups. The first column is the slice the report named or, where it named none, the slice whose scope covers the item. That slice reads its rows before planning, closes them in its PR and deletes them here. If it leaves a row open, its report says why. Follow-ups with no owning slice stay in their reports.

| For | Follow-up | From |
|---|---|---|
| P0.1 | Decide the dead-import test files P0.−1 listed whose issues are still open: #39, #54, #59, #60, #61, #64 (each says "Decide in P0.1": re-point the import, restore the feature, or delete the test). Their broken tests are `test.failing` today | [P0.−1](reports/P0.-1.md) |
| P0.1 | Run the fresh-clone check in a tree outside the repo with an empty `HOME`. The plugin's silent fallback hid the fresh-install failure; a checkout without `bun install` falls back to spawning `eden hook`, about 2.6 s per hook | [P0.−1](reports/P0.-1.md), [P0.0b](reports/P0.0b.md) |
| P0.3 | Clear `arms.json`'s three `unstable` checks, `scoped` `junk-on-disk`, `re-eligibility` `reeligible-401` and `compaction` `b-rearmed` (#98): once ids are ULIDs, run those arms ≥ 20 times on macOS and on Linux (CI), and make them plain checks. `re-eligibility`'s `refractory-399` flipped too, once: it passed in a full local suite run under load (P0.0d, at `309d831e9`), while 10 of 10 isolated runs on that tree and 10 of 10 on `main` matched the record | [P0.0c](reports/P0.0c.md) |
| P0.3 | Honour `EDEN_NOW` (epoch ms): the arms hand hooks and the CLI the simulated clock through it | [P0.0c](reports/P0.0c.md) |
| P0.3 | Re-run P0.0b's A/A noise floors: packets differed between identical runs, likely through #98 | [P0.0b](reports/P0.0b.md) |
| P0.4 | Open issues #19 (memory-import stores an `sk-ant-…` key) and #42 (memory-consent). The Agent tool result is stored as the episode `The Agent tool result is [object Object]` (with P0.6) | [P0.−1](reports/P0.-1.md), [P0.0a](reports/P0.0a.md) |
| P0.4 | Measure `poison_hits` on pins: P0.0b could not without Eden's store format, and the `poison` arm counts packets, not pins (with P2.1) | [P0.0b](reports/P0.0b.md), [P0.0c](reports/P0.0c.md) |
| P0.4 | Build `sanitizeForStore` and D12 authority on P0.0d's `src/memory-secrets.ts` (D13 / A6 §2.2 rules: gitleaks v8.30.1 plus Eden's provider shapes) and `src/memory-authority.ts` (`userTyped`, `stripPastes`); no hook calls them yet. Gitleaks' base64/hex segment decoding is not ported. D13's keyword rule matches `is` inside a word (`secrets … pre-registration` hits), so it fires on prose: consider `\b(is\|=\|:)` | [P0.0d](reports/P0.0d.md) |
| P0.5 | A5 has no cross-repo arm. Today's gist store is global (repo A's rules reach repo B's SessionStart in `policy-recur`). D1 implies isolation, so add an arm that asserts it | [P0.0c](reports/P0.0c.md) |
| P0.5 | Re-run `arms/silence.ts` (twice) and record its R1/R8 FIR in A5: today 0 of the store's 6 control prompts get a packet in a fresh session (per-session store, A1 D1), so its 1/150 and 0/98 say nothing yet. With a per-repo store the control should pack | [P0.0d](reports/P0.0d.md) |
| P0.5 | EXECUTION §9 and A6 §4 disagree on how legacy sessions are mapped (R-7's session map vs a transcript's first line). Settle it in the spec; the `migrate` arm accepts either | [P0.0c](reports/P0.0c.md) |
| P0.8 | Re-record every arm's `off` and `shadow` states in `arms.json` (`arms/run.ts --flags off`, `--flags shadow`); measure `abort_rate` | [P0.0c](reports/P0.0c.md), [P0.0b](reports/P0.0b.md) |
| P1.1 | If P0.3 has not cleared `reeligible-401`, clear it before turning `re-eligibility` green | [P0.0c](reports/P0.0c.md) |
| P1.2 | If P0.3 has not cleared `compaction`'s `b-rearmed`, clear it before turning `compaction` green | [#112](https://github.com/Knihalani/Eden/pull/112) |
| P1.3 | The simulator does not fire nested `InstructionsLoaded` (`nested_traversal`, `path_glob_match`), which the D27 shadow set needs | [P0.0a](reports/P0.0a.md) |
| P2.3 | The simulator has no `if` filters, PermissionRequest or PermissionDenied | [P0.0a](reports/P0.0a.md) |
| P2.5 | Claude Code 2.1.285 has no `fork` subagent type (A4 §5.3, A5 `subagent`); the harness simulates one. Say which mechanism "fork" means (perhaps SessionStart `source: fork`), or drop the clause until one is captured | [P0.0c](reports/P0.0c.md) |
| P3.5 | Run `scoped` at full scale (4,752 and 15,840 junk turns); `arms.json` records CI scale only | [P0.0c](reports/P0.0c.md) |
| P4.3 | Replay the real negatives against the planted CueBench store (`eden memory remember`, the gate's store); `arms/silence.ts` uses the world-scenario store today | [P0.0d](reports/P0.0d.md) |
| P5.1 | When `log.text` writes `dogfood/prompts.jsonl`, `eden eval build-negatives` reads it too (R9 §R5.3 step 1); today it reads Claude transcripts only, which Claude Code sweeps after 30 days | [P0.0d](reports/P0.0d.md) |

## Rollout stages (EXECUTION §5)

The agent flips a stage when its entry criteria and minimum soak time are met. It records the evidence in `reports/stage-<n>.md`. The circuit breaker reverts automatically.

| Stage | Turn on | Deps | Entry criteria | Min soak | Status | Report |
|---|---|---|---|---|---|---|
| S1 | shadow on every point (this repo) | P0.8, all Phase 0 | Phase 0 arms green | 7 days + ≥ 50 human prompts | todo | |
| S2 | `deliver.submit=on` | S1, P1.3 | shadow packet rate ≤ 30%, redundant < 5% | 7 days | todo | |
| S3 | `session_start`, `subagent` | S2, P2.5 | ≥ 20 labelled shadow subagent packets, 0 harmful | 7 days | todo | |
| S4 | `batch`, `failure` | S3, P3.5, P4.5 | ≥ 20 labelled shadow batch packets, 0 harmful | 7 days | todo | |
| S5 | `guard.context` | S4, P2.3 | `would_ask` precision ≥ 0.9 on ≥ 20 events | 7 days | todo | |
| S6 | `guard.ask` (irreversible classes) | S5 | `guard-modes` green on the installed Claude Code | 14 days | todo | |
| S7 | other repos | S6 | S2–S6 clean | — | todo | |

"Labelled" packets need a human label. The agent prepares them in `docs/memory-ship/labels/<stage>.md` for a quick yes/no pass by the user. **Until they are labelled, the stage stays `waiting`**; it is never auto-approved.
