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
| P0.3 | Ids, clocks, persisted validity | P0.0c | M | `spawn-writers`, `reload-stale`, `numbered-list`; plus two writer processes with the same `pid % 36` run one after the other, and both keep their rows (#98) | done (4 review rounds, the 4th allowed by the user; the 1,000-turn soak guard missed: `main` loses rows to #98, rest filed to P0.6) | #122 | [reports/P0.3.md](reports/P0.3.md) |
| P0.4 | Trust gate: authority, paste stripping, gitleaks + keyword secrets, purge | P0.0c | M | `secrets` (≥ 300 cases), `poison` | done (secret_bytes 0 of 360 cases; poison 0 packets and 0 briefings; 3 review rounds and an evidence check; Submit timing met after a perf fix) | #124 | [reports/P0.4.md](reports/P0.4.md) |
| P0.8 | Flags, shadow mode, wide events, circuit breaker | P0.0c | M | both flag states on every arm; injected-throw test | done (`off` and `shadow` green on the 34 arms that drive a delivery point, `fail-open` green; delivery unchanged with no flag file; 2 review rounds and an evidence check; stage-1 entry waits for the rest of Phase 0) | #125 | [reports/P0.8.md](reports/P0.8.md) |
| P0.5 | Repo identity (git-common-dir), window keys, migration | P0.3, P0.4 | M | `cross-session`, `worktree`, `migrate` | done (`migrate`, `cross-repo` green; the user accepted `scoped` and `cascade` red until P3.2/P3.5; silence with a store R1 38/150, R8 48/98, filed to P4.3; 2 review rounds; soak not run, at the user's request) | #126 | [reports/P0.5.md](reports/P0.5.md) |
| P0.6 | Delta encode, PostToolBatch recording, rewind detection, stop-fast | P0.5 | M | `rewind`; p99 flat over 1,000 turns | done (`rewind` green; p99 flat: Submit +48.0 ms over 1,000 turns vs main's +541.7, `stop-fast` 8.56 ms; R6 `packet_rate` 50/122 missed, filed to P4.3; child-transcript encode deferred to P1.3 by the user; 4 review rounds, the 4th allowed by the user) | #127 | [reports/P0.6.md](reports/P0.6.md) |
| P0.7 | Cache-safe placement (wrap / OpenAI inject) | P0.1 | S | cached-prefix test | done (0 prefix breaks in 11 request pairs on each of 4 wrap paths, main 7; the 5 follow-up rows closed; 2 review rounds) | #128 | [reports/P0.7.md](reports/P0.7.md) |
| P1.1 | Ledger core | P0.6, P0.8 | M | `repeat`, `budget`, `re-eligibility` | done (`repeat`, `re-eligibility` green, `budget` 477 / 610 tokens; a Submit reads 17,319 B of ledger after 300 soak turns, `main` 52,216; the wrap follows `deliver.submit` and keeps its prefix across restarts; guards identical to `main`; 3 review rounds; 4 follow-up rows closed, 4 filed) | #129 | [reports/P1.1.md](reports/P1.1.md) |
| P1.2 | Epochs: clear, selective PostCompact re-arm, resume, fork, rewind | P1.1 | M | `compaction`, `resume`, `rewind` | done (`compaction` green: PostCompact holds what the summary still names, re-arms the rest; `resume`, `rewind` green; `clear` starts an epoch; a forked session copies its parent's ledger after its first turn; guards identical to `main`; 2 review rounds; 1 follow-up row closed, 4 filed) | #130 | [reports/P1.2.md](reports/P1.2.md) |
| P1.3 | Residual + per-window shadow set | P1.2 | M | `residual`, `shadow` | done (`shadow` green, with a nested CLAUDE.md check; `residual` green; InstructionsLoaded feeds a per-window shadow set, with AGENTS.md and the project's MEMORY.md, at Submit and SessionStart; typed prompts reach the residual and `q_turn`; guards within tolerance, `redundant_rate` −3.59 pp; R6 `packet_rate` 53/122 vs `main`'s 50/122, accepted by the user and filed to P4.3; 2 review rounds) | #132 | [reports/P1.3.md](reports/P1.3.md) |
| P2.1 | Policy & intent extraction (regex, D9 incl. R8 fixes) | P0.4 | M | `extraction` (E3 set) | in-progress (`mem/P2.1-policy-extraction`) | | |
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
| P4.1 | `qprev.json` holds the end of `last_assistant_message` (8,000 characters, through the secret gate), not A4 §5.7's rare tokens minus the last delivery's tokens: own-delivery stripping and rare-token selection are P4.1's (A7 §2–3); the turn mode's proposal check reads the text | [P0.6](reports/P0.6.md) |
| P3.4 | The idle sleeper (`eden sleep --idle`) runs the full legacy sleep with the session that started it; other sessions of the repo get their gist and how-to from their own light sleep at `stop-sleep`. D34's heavy tier (≥ 30 min idle; repo-fact mining is its first job) and SessionStart's detached launch are not built | [P0.6](reports/P0.6.md) |
| P4.3 | R6 replay `packet_rate` 50/122 (41.0 %) after P0.6, against P0.2's ≤ 30 % (main 18/122 on the same 29 sessions, corpus `5765d80836fd`). Main's rate partly rested on its own losses: re-read texts stored twice and tool-result rows that `relevant` can never score filled its candidate pool (18 → 35 with each line encoded once, 35 → 50 with unscorable rows out of the postings). Most added bullets are tool and agent episodes admitted on a shared path (A7 §4 STRONG), and typed episodes, which bypass the gate (gating them: 45). τ_repo and the 0.7·top cut are the precision this needs | [P0.6](reports/P0.6.md) |
| P6.1 | The idle sleeper's full sleep rewrites `memories.jsonl` by rename (`patchWhere`, `rewriteWhere`); a hook appending a row at that moment loses it. It runs only after 5 quiet minutes, but nothing locks it out of a hook that starts during it. A store with transactions (P6.1) or a writer lock closes it | [P0.6](reports/P0.6.md) |
| P2.5 | SessionStart still briefs the 3 latest session gists (P0.2's carrier between sessions). Since P0.5 the store is per repo, so the header "recalled from earlier sessions" holds, and a later session also retrieves the same fact's row at Submit: in P0.5's end-to-end session the port fact arrived twice, as the gist at SessionStart and as the row at Submit. D23's selection (≤ 3 pins and `Updated:` items) replaces the gists; its pins now come from every session of the repo | [P0.2](reports/P0.2.md), [P0.5](reports/P0.5.md) |
| P3.2 | **Accepted by the user (2026-10-09) until P3.2:** since P0.5, rows cross sessions with no folder scope, so `scoped` fails `no-leak` (an apps/web cue's packet carries "packages/cli has no auth, and its database is sqlite"). A4 §2: never siblings; the read set decides | [P0.5](reports/P0.5.md) |
| P3.5 | **Accepted by the user (2026-10-09) until P3.5:** since P0.5, `cascade` fails `no-stale`: the root's "We use node 20 across the repo" reaches the apps/web cue, whose own row (node 22) overrides it (D5). The guard worlds keep `stale_rate` 0 | [P0.5](reports/P0.5.md) |
| P2.5 | A child window's refractory distance is measured on its own `subagents/agent-<agent_id>.jsonl` (A4 §4, D25); no child point delivers before SubagentStart, so P1.1 left it. SessionStart's `Updated:` items (A4 §5.2, values changed since the repo's last session) and a non-human submit's (D24) need a lookup from a delivered cid to its current value, which keyed slots give (P3.3); P1.1's `Updated:` items come only on the cue that retrieves the new value | [P1.1](reports/P1.1.md) |
| P3.3 | P1.1's `Updated:` items rest on the legacy store: a slot at another `ver` (copula rows), or a row whose D7 switch or retraction names only subject words of a live slot (`sw`, hashed). Keyed slots make "`ver` changed" a key comparison and retire the switch reading. An `Updated:` item renews its slot before D28's shape and 900 B cap, so if the first row stating a change is skipped for size, a second row stating it was already dropped (rare; P1.1 review round 2) | [P1.1](reports/P1.1.md) |
| S2 | The wrap's exceptions are swallowed by `inject` (fail open) and never reach the circuit breaker (X7), and since P1.1 `deliver.submit` governs the wrap; decide whether stage 2's breaker should count wrap failures (its wide events are `ev: "wrap"`, which the breaker's reader skips) | [P1.1](reports/P1.1.md) |
| P4.3 | Silence with a per-repo store (`arms/silence.ts`, world seed 1, twice each): R1 38/150 and R8 48/98 false fires (main: 0/150 and 0/98, because a fresh session's store was empty), control 5/6 (main 0/6). The lexical admission of rows the user typed (P0.2) is far from A5's ≤ 5% once a store has content | [P0.5](reports/P0.5.md) |
| S1 | Confirm the live UserPromptSubmit `prompt` of an idle peer message (R0 F34; P0.2 accepts a one-line preamble before `<agent-message`), then settle D24's wording. Since P0.8 a non-human Submit's wide event names the rule it matched (`nonhuman: agent-message`, `preamble: true`) with its `prompt_hash`, so stage 1's logs show which shape arrives; the text itself needs `log.text` (P5.1) | [P0.2](reports/P0.2.md), [P0.8](reports/P0.8.md) |
| P2.3 | The guard's shadow mode logs `would_ask` (and what the user did next) in its wide event; P0.8 left the field to the guard. A repo's `.eden/flags.json` beats the user file (X7), so a cloned repo can raise `guard.ask` to `on`: decide whether an untrusted repo file may raise a kill switch, with `/security-review` | [P0.8](reports/P0.8.md) |
| P4.2 | The budget abort: P0.8's wide events carry `aborted`, always false until the hook can abort, so `abort_rate` is 0 by construction and the breaker's abort budget never trips | [P0.8](reports/P0.8.md) |
| P2.5 | A fork subagent's copy of its parent's ledger (D25, A4 §5.3): `inheritLedger` (`src/memory-ledger.ts`) copies a parent window's current-epoch deliveries; SubagentStart (`agent_type: "fork"`) should call it for the child window before its packet, so the fork gets no bullet the parent already holds. P1.2 built the session fork only, as no child delivery point exists | [P1.2](reports/P1.2.md) |
| P2.1 | Compaction value tokens for rules come from the rule text (`src/memory-value-tokens.ts`: the first clause naming an A7 §5 class, its verb's class and its object words, singular). With `(class, polarity, object)` keys, take them from the key, and let a class's default object match its synonyms ("pull requests" for "PR"), which P1.2 does not widen | [P1.2](reports/P1.2.md) |
| P5.3 | A slot stays habituated after a compaction only when `compact_summary` names its value's words as typed: a summary saying "PostgreSQL" for "postgres" re-arms it (one repeat). In P1.2's real session the summary also said "postgres". Value aliases (D21's bridges) would let a summary's alias hold the slot | [P1.2](reports/P1.2.md) |
| P2.1 | A rule's per-class declarative rewrite ("PRs are merged by you, not by the agent") and ledger `cid`s from `(class, polarity, object)` keys, so two rows saying one rule share a `cid` | [P0.2](reports/P0.2.md) |
| P2.1 | A one-off imperative the user typed ("Reply with just OK") is stored and delivered verbatim as "… (you said, …)"; telling it from a standing rule is D9's. A heading's numbered list still absorbs the next unpunctuated line ("2. Logs go to stdout Reply with just OK"): `observe` collapses line breaks before extraction, and keeping them changes sentence splitting for every multi-line prompt (both re-filed by P0.4 from P0.2 and P0.3) | [P0.2](reports/P0.2.md), [P0.3](reports/P0.3.md), [P0.4](reports/P0.4.md) |
| P3.3 | P0.2's validity (`src/memory-validity.ts`) is a value token and a time on legacy text, with D7's and A4 §3.1's forms read narrowly (a "we" subject; a capitalized or identifier-shaped value that ends its clause; no "use A, not B"; never applied to rules; whole sentences dropped): a value shaped by its capitals alone is matched as typed, so "we use redis" is not superseded by "We no longer use Redis"; it covers the world's retractions, but not `stale-episode`'s ("packages/cli switched its database from postgres to sqlite"). `negation` passes through P0.2's approximation (the sleep checks a gist's sources at their own times), which P3.3 replaces. Replace it with keyed slots, value classes and retraction | [P0.2](reports/P0.2.md) |
| P2.5 | SessionStart's selection (D23: ≤ 3 pins and `Updated:` items); P0.2 keeps the legacy pins (none after a compaction) and the 3 latest valid gists, within 900 B | [P0.2](reports/P0.2.md) |
| P4.1 | Continuation turns get no packet until `q_prev` and STRONG evidence exist (P0.2): restore STRONG injections, such as a trigger hit on the proposal ("ok merge it" after "Shall I merge?"). Tune the proposal markers ("I can see …"). `q_path` joins P0.2's episode gate | [P0.2](reports/P0.2.md) |
| P4.3 | P0.2's episode gate (A7 §4) lacks BM25F ≥ τ_repo and the 0.7·top cut, and reads WEAK words from a fixed function-word list until the repo's df exists | [P0.2](reports/P0.2.md) |
| P3.3 | `validity.jsonl` stays after P0.3 (which closed P0.2's other approximations): it is the clause-level log of retractions, switches, revocations and D31's `stale_for`, read against gists and other sessions' rows. Rows keep `t`, so its time comparison is real. Keyed slots' `invalid_at` replace it | [P0.3](reports/P0.3.md) |
| P2.3 | The simulator has no `if` filters, PermissionRequest or PermissionDenied | [P0.0a](reports/P0.0a.md) |
| P2.3 | `eden doctor --memory`'s `guard` line says `off · no PreToolUse policy guard`: print `EDEN_POLICY_GUARD` and the guard's mode | [P0.1](reports/P0.1.md) |
| P2.5 | Claude Code 2.1.285 has no `fork` subagent type (A4 §5.3, A5 `subagent`); the harness simulates one. Say which mechanism "fork" means (perhaps SessionStart `source: fork`), or drop the clause until one is captured | [P0.0c](reports/P0.0c.md) |
| P2.5 | SubagentStop still does not encode the child's own transcript (P0.6, deferred by the user; P1.3 refiles it): the redundancy it caused (`redundant_rate` +4.42 pp in P0.6's guard runs) comes from the Agent call's result in the parent window, a tool result, which neither D26's residual nor D27's shadow set may read. Decide it with the child window's delivery point: the parent's Agent result is what the child's rows would repeat | [P0.6](reports/P0.6.md), [P1.3](reports/P1.3.md) |
| S2 | Phase 1's exit asks `redundant_rate` < 5 % on the 300-turn soak: 180/226 on `main`, 168/223 after P1.3 (`replay.ts --soak 300`, 2026-10-11). The cause is A4 §4's distances (re-eligible every 1.2 MB, ~48 turns, while the simulated window holds the item until its compaction at 4.8 MB), and the `re-eligibility` arm pins the 400 KB / 1.2 MB distances. Refit them from stage 1–2 dogfood (`ctx_tokens` beside `off` in each human Submit's wide event since P1.1), or tie re-eligibility to the window's tokens | [P1.1](reports/P1.1.md), [P1.3](reports/P1.3.md) |
| P4.3 | R6 replay `packet_rate` after P1.3: 53/122 against `main`'s 50/122 (corpus `5765d80836fd`; accepted by the user). Variants, each alone: without the `typedPrompt` fix 51/122, also without the residual's Jaccard polarity 50/122. Now that A7's `q_turn` holds the previous typed prompt, more episodes reach MEDIUM evidence from two cue parts (guard runs: `packet_rate` +5.74 pp, `false_rate` +0.26 pp); τ_repo and the 0.7·top cut are the precision this needs | [P1.3](reports/P1.3.md) |
| P2.5 | D27 at SessionStart and in child windows: (1) Claude Code 2.1.294 ran SessionStart(startup) before the session's InstructionsLoaded(session_start) in a capture, so a startup briefing may not see CLAUDE.md yet (P1.3 reads what is recorded; compact, clear and resume see it); (2) a child window's shadow set by its type (general-purpose: the parent's instruction files; Explore and Plan: none; R0 F35) waits for SubagentStart delivery | [P1.3](reports/P1.3.md) |
| P3.3 | D26's slot rule (now used by D27 too) on real slot keys: subject aliases and value classes. Until then a subject's words stand for its aliases, and D7's bare `use V` takes the value to name one slot, the row's (`statesSlot`, `src/memory-residual.ts`) | [P0.2](reports/P0.2.md), [P1.3](reports/P1.3.md) |
| S1 | Window directories and auto memory: (1) on Claude Code 2.1.294 a resumed process's first InstructionsLoaded can carry a provisional session id ("no session bound"), so such a resume leaves a window directory holding only `shadow.log` (8 of 8 resumes in P1.3's final end-to-end); nothing prunes `windows/`; (2) D27 reads none of the `autoMemoryEnabled`, `autoMemoryDirectory` or `instructionFiles` settings, and finds MEMORY.md from the event's `cwd`, not the session's start root (a session that `cd`s into another repo looks in the wrong folder). Dogfood shows how often each matters | [P1.3](reports/P1.3.md) |
| P3.1 | `eden doctor --memory`'s `scope catalog` line says `none`: print the catalog's scope count and when it was built | [P0.1](reports/P0.1.md) |
| P3.1 | `eden memory forget --all-in <scope>` (A6 §3) needs the scope catalog; P0.4 built the typed forget and `eden memory purge` | [P0.4](reports/P0.4.md) |
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
