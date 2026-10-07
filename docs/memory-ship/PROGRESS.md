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
| P0.0d | Harness: real-negative loader + `eden eval build-negatives` (canary secrets) | P0.0a | S | canary test; CI prints `skipped: private set absent` | done | #114 | [reports/P0.0d.md](reports/P0.0d.md) |
| P0.1 | Packaging: fresh-clone check, dead tests, `eden doctor`, plugin fallback within 150 ms | P0.0c | S | fresh clone passes; doctor green | done (#64's 9 `test.failing` tests wait: P0.5 row below) | #117 | [reports/P0.1.md](reports/P0.1.md) |
| P0.2 | Stop the bleeding: non-human + ack silence, variable k, declarative wording | P0.1 | S | `nonhuman`, `continue`; R6 replay packet rate ≤ 30% | done (design round 4 after the user asked to meet every target: R6 packet rate 23.4–24.1%, volume 15.9–16.3% of today's; stale 0/405, need_miss 22/54) | #119 | [reports/P0.2.md](reports/P0.2.md) |
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
| P0.3 | `re-eligibility`'s `refractory-399` flakes on `main` too (3 of 25 isolated runs; P0.2 records it `unstable`): find the cause once ids are stable, checking the legacy sleep's timing first. Persisted `invalid_at` replaces P0.2's `validity.jsonl` (a value token and a time, any scope) | [P0.2](reports/P0.2.md) |
| P0.3 | `reload-stale` passes through P0.2's approximation: the legacy sleep checks a session gist's fact and rule sentences against `validity.jsonl` at their sources' times before writing it. Persisted `invalid_at` and row times replace it. The legacy store keeps no row time on disk, so a value restated after its retraction is not delivered again (at Submit or in a gist) until rows carry their time; gists written before P0.2's change carry their writing time | [P0.2](reports/P0.2.md) |
| P0.4 | Writers record `src: user`, so the hook's "you said" / "Rule you set" appear where true (A6 §2.1). D12's kind rule for rows P0.2 tags `src:tool` / `src:agent` (today such a row can still be a legacy fact or constraint). The legacy extractor stores imperative fragments ("Reply with just OK") that reach packets verbatim (A6 §2.3) | [P0.2](reports/P0.2.md) |
| P0.5 | The packet header says "recalled from earlier sessions", true once the store is per repo; then SessionStart can drop the legacy gists for D23's pins | [P0.2](reports/P0.2.md) |
| P0.6 | The delta encoder holds the branch state P0.2's ledger reads from the transcript's last 1.5 MB at Submit; abandoned rows go to history (`rewind`'s `no-postgres`) | [P0.2](reports/P0.2.md) |
| P0.7 | The wrap and OpenAI-shaped inject adopt the hook's shape, wording, validity, episode gate, residual and ledger; P0.2 changed only their header | [P0.2](reports/P0.2.md) |
| P0.8 | Confirm the live UserPromptSubmit `prompt` of an idle peer message from wide events (R0 F34; P0.2 accepts a one-line preamble before `<agent-message`), then settle D24's wording. The `off`/`shadow` records include `no-ledger` / `no-live-ledger` since P0.2's turn records; the flags do not yet switch P0.2's validity, gate, residual and ledger off | [P0.2](reports/P0.2.md) |
| P1.1 | P0.2 built the refractory rule on `deliver`/`epoch` records (`src/memory-ledger.ts`): add the `delivery.json` snapshot, rotation, overflow policy and `hook.log.d/`; `Updated:` items (`repeat`'s `updated`; D28's hard limit 6). `budget` is green at CI scale only (about 4,000 tokens at 100 turns). `re-eligibility` has two `unstable` checks to clear before it turns green | [P0.2](reports/P0.2.md) |
| P1.2 | PostCompact re-arms only the `cid`s whose value tokens `compact_summary` dropped (P0.2 re-arms all at `compact`; `compaction`'s `a-not-rearmed`); `fork` copies the ledger. `resume` and `rewind`'s `once` already pass through P0.2's approximation (deliveries keyed by text, every `cid` re-armed at `compact`), which P1.2 replaces; `compaction`'s `delivered-before` is `unstable` since P0.2's ledger (#98 suspected) | [P0.2](reports/P0.2.md) |
| P1.3 | D27's shadow set: in P0.2's end-to-end session a fact the ledger held back came back through Claude's own auto-memory write of it, a tool result in other words. D26's slot half on real slot keys (P0.2 reads a parsed legacy fact with a short value as a slot). `residual` already passes through P0.2's approximation, which P1.3 replaces | [P0.2](reports/P0.2.md) |
| P2.1 | A rule's per-class declarative rewrite ("PRs are merged by you, not by the agent") and ledger `cid`s from `(class, polarity, object)` keys, so two rows saying one rule share a `cid` | [P0.2](reports/P0.2.md) |
| P3.3 | P0.2's validity (`src/memory-validity.ts`) is a value token and a time on legacy text, with D7's and A4 §3.1's forms read narrowly (a "we" subject; a capitalized or identifier-shaped value that ends its clause; no "use A, not B"; never applied to rules; whole sentences dropped): a value shaped by its capitals alone is matched as typed, so "we use redis" is not superseded by "We no longer use Redis"; it covers the world's retractions, but not `stale-episode`'s ("packages/cli switched its database from postgres to sqlite"). `negation` passes through P0.2's approximation (the sleep checks a gist's sources at their own times), which P3.3 replaces. Replace it with keyed slots, value classes and retraction | [P0.2](reports/P0.2.md) |
| P2.5 | SessionStart's selection (D23: ≤ 3 pins and `Updated:` items); P0.2 keeps the legacy pins (none after a compaction) and the 3 latest valid gists, within 900 B | [P0.2](reports/P0.2.md) |
| P4.1 | Continuation turns get no packet until `q_prev` and STRONG evidence exist (P0.2): restore STRONG injections, such as a trigger hit on the proposal ("ok merge it" after "Shall I merge?"). Tune the proposal markers ("I can see …"). `q_path` joins P0.2's episode gate | [P0.2](reports/P0.2.md) |
| P4.3 | P0.2's episode gate (A7 §4) lacks BM25F ≥ τ_repo and the 0.7·top cut, and reads WEAK words from a fixed function-word list until the repo's df exists | [P0.2](reports/P0.2.md) |
| P0.3 | Clear `arms.json`'s three `unstable` checks, `scoped` `junk-on-disk`, `re-eligibility` `reeligible-401` and `compaction` `b-rearmed` (#98): once ids are ULIDs, run those arms ≥ 20 times on macOS and on Linux (CI), and make them plain checks. `re-eligibility`'s `refractory-399` flipped too, once: it passed in a full local suite run under load (P0.0d, at `309d831e9`), while 10 of 10 isolated runs on that tree and 10 of 10 on `main` matched the record | [P0.0c](reports/P0.0c.md) |
| P0.3 | Honour `EDEN_NOW` (epoch ms): the arms hand hooks and the CLI the simulated clock through it | [P0.0c](reports/P0.0c.md) |
| P0.3 | Re-run P0.0b's A/A noise floors: packets differed between identical runs, likely through #98 | [P0.0b](reports/P0.0b.md) |
| P0.4 | Open issues #19 (memory-import stores an `sk-ant-…` key) and #42 (memory-consent). The Agent tool result is stored as the episode `The Agent tool result is [object Object]` (with P0.6) | [P0.−1](reports/P0.-1.md), [P0.0a](reports/P0.0a.md) |
| P0.4 | Measure `poison_hits` on pins: P0.0b could not without Eden's store format, and the `poison` arm counts packets, not pins (with P2.1) | [P0.0b](reports/P0.0b.md), [P0.0c](reports/P0.0c.md) |
| P0.4 | Build `sanitizeForStore` and D12 authority on P0.0d's `src/memory-secrets.ts` (D13 / A6 §2.2 rules: gitleaks v8.30.1 plus Eden's provider shapes) and `src/memory-authority.ts` (`userTyped`, `stripPastes`); no hook calls them yet. Gitleaks' base64/hex segment decoding is not ported. D13's keyword rule matches `is` inside a word (`secrets … pre-registration` hits), so it fires on prose: consider `\b(is\|=\|:)`. `stripPastes`' span search keeps 8 positions per anchor, so a result repeating with a period that is a multiple of 64 can hide a span (P0.0d report, Decisions) | [P0.0d](reports/P0.0d.md) |
| P0.4 | Forget tests, restating the M45 tests in `src/memory-subagent.test.ts` (:180, :214, :249, :380 at 75897d4fe) on the rebuild's entry points: a user-typed "forget X" invalidates X (A6 §3); "don't forget to …" is not a forget (D9 (2); E3 items A125, B38); agent or subagent text cannot forget (D12). A6 §2.1 does not say whether a subagent transcript's `type=user` task line counts as `src=user` (#78) | [P0.1](reports/P0.1.md) |
| P0.5 | A5 has no cross-repo arm. Today's gist store is global (repo A's rules reach repo B's SessionStart in `policy-recur`). D1 implies isolation, so add an arm that asserts it | [P0.0c](reports/P0.0c.md) |
| P0.5 | Re-run `arms/silence.ts` (twice) and record its R1/R8 FIR in A5: today 0 of the store's 6 control prompts get a packet in a fresh session (per-session store, A1 D1), so its R1 1/150 (0/150 in one of five runs) and R8 0/98 say nothing yet. With a per-repo store the control should pack | [P0.0d](reports/P0.0d.md) |
| P0.5 | EXECUTION §9 and A6 §4 disagree on how legacy sessions are mapped (R-7's session map vs a transcript's first line). Settle it in the spec; the `migrate` arm accepts either | [P0.0c](reports/P0.0c.md) |
| P0.5 | `src/memory-subagent.test.ts` keeps its 9 `test.failing` tests (#64). P0.1 decided to delete them all (they pin the per-session child stores D1, D2 and D23 replace; :214's forget moves to P0.4), but the deletion was refused by a permission check in an agent run, so it waits for the user's go-ahead, or for P0.5, which replaces that layout | [P0.1](reports/P0.1.md) |
| P0.5 | `eden doctor --memory`'s `repo key` line says `none · memory is kept per Claude session`: print the cwd's repo key (D1) and its store | [P0.1](reports/P0.1.md) |
| P0.8 | Re-record every arm's `off` and `shadow` states in `arms.json` (`arms/run.ts --flags off`, `--flags shadow`); measure `abort_rate` | [P0.0c](reports/P0.0c.md), [P0.0b](reports/P0.0b.md) |
| P0.8 | The plugin's `hooks.json` commands end in `\|\| echo '{}'`: with no `bun` on PATH a hook prints `{}` and the shell's error, not nothing. The injected-throw test should run each entry point as Claude Code does (`/bin/sh -c` on the `hooks.json` command; `pluginSubmitCommand` in `doctor-memory.ts`) | [P0.1](reports/P0.1.md) |
| P1.1 | If P0.3 has not cleared `reeligible-401`, clear it before turning `re-eligibility` green | [P0.0c](reports/P0.0c.md) |
| P1.2 | If P0.3 has not cleared `compaction`'s `b-rearmed`, clear it before turning `compaction` green | [#112](https://github.com/Knihalani/Eden/pull/112) |
| P1.3 | The simulator does not fire nested `InstructionsLoaded` (`nested_traversal`, `path_glob_match`), which the D27 shadow set needs | [P0.0a](reports/P0.0a.md) |
| P2.3 | The simulator has no `if` filters, PermissionRequest or PermissionDenied | [P0.0a](reports/P0.0a.md) |
| P2.3 | `eden doctor --memory`'s `guard` line says `off · no PreToolUse policy guard`: print `EDEN_POLICY_GUARD` and the guard's mode | [P0.1](reports/P0.1.md) |
| P2.5 | Claude Code 2.1.285 has no `fork` subagent type (A4 §5.3, A5 `subagent`); the harness simulates one. Say which mechanism "fork" means (perhaps SessionStart `source: fork`), or drop the clause until one is captured | [P0.0c](reports/P0.0c.md) |
| P3.1 | `eden doctor --memory`'s `scope catalog` line says `none`: print the catalog's scope count and when it was built | [P0.1](reports/P0.1.md) |
| P3.5 | Run `scoped` at full scale (4,752 and 15,840 junk turns); `arms.json` records CI scale only | [P0.0c](reports/P0.0c.md) |
| P4.3 | Replay the real negatives against the planted CueBench store (`eden memory remember`, the gate's store); `arms/silence.ts` uses the world-scenario store today | [P0.0d](reports/P0.0d.md) |
| P5.1 | When `log.text` writes `dogfood/prompts.jsonl`, `eden eval build-negatives` reads it too (R9 §R5.3 step 1); today it reads Claude transcripts only, which Claude Code sweeps after 30 days | [P0.0d](reports/P0.0d.md) |
| P6.2 | D20's daemon path is not built: P0.1 removed the plugin's hookd (HTTP, 8 s) and `eden hook` spawn (2.6 s) fallbacks, and the plugin loads Eden in-process only. If the warm-daemon experiment needs the plugin to reach a daemon, add D20's Unix socket first (5 ms connect, 100 ms total), serving only the memory hook: hookd's `/hook` (`respondToHook`) also records tool traces and replaces tool results. D20's row says so since P0.1 | [P0.1](reports/P0.1.md) |

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
