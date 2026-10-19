# Eden Memory — Roadmap (v2)

**Dated 2026-09-29, v2.** Build from this document. It orders the work that `DECISIONS.md` decides and `A4-DELIVERY-CONTRACT.md` specifies. It supersedes v1 and `EDEN-MEMORY.md` §12–§13.

## The goal

The user should almost never have to tell the agent something twice. Each turn, the right memory arrives **automatically**, from the situation the agent is in:
- what the user typed
- what the agent just said
- the files it touched
- the command it is about to run
- the error it just hit

Nothing already in the context window is repeated. Nothing stale, irrelevant, or from another folder is injected. The store may grow for years without retrieval getting worse.

## What the evidence says (why this order)

Measured on this machine and on 19 public repos (research/R0–R6):

| Finding | Number | Consequence |
|---|---|---|
| The installed hook repeats itself | **56%** of bullets repeat within a session; **60%** of packets fire after task notifications or agent messages (76% counting queued mid-turn prompts); fixed 6 bullets; 54% of human prompts get a packet; "continue" gets one 78% of the time | **Stop the bleeding first** (P0.2): it's small and removes most waste immediately |
| Memory dies with the session | keyed by `session_id`; sessions are a median of 3 human prompts | Repo-keyed store before anything else (P0.5) |
| Users restate **policies**, not facts | git/PR-workflow category: 17 cross-session recurrences (loose category bound; strict lexical recurrence 0); 0 package-manager/path/command restatements; copula facts are 0.5% of sentences | **Policies ship before slot facts** (Phase 2) |
| Policies aren't a similarity problem | action-class triggers: recall 0.47 at 4% FIR on negatives; every similarity method ≤ 0.22 at 5–15% FIR. Cost: 19% of other positives gain a policy bullet | Compiled triggers + PreToolUse guard |
| Context is the free cue win | ctx recall 0.18 → 0.41 at no FIR cost; embeddings +0.01–0.03 at 165 ms cold | Situation cue; no embeddings on the hot path |
| Most context windows are subagents | ~89% | SubagentStart delivery; ledger per window |
| Scope must be validated | the R5 rule: 90% agreement / 3.8% root-leak vs v0's 81% / 11% | R5 rule verbatim |
| Several failures are invisible to the current bench | single process, no sessions, no rewinds | The harness is P0.0 |

## Documents

| Doc | Role |
|---|---|
| **ROADMAP.md** | order, sizes, gates |
| [DECISIONS.md](DECISIONS.md) | every choice (D1–D36), with evidence; earn-in backlog |
| [EXECUTION.md](EXECUTION.md) | **how** it is built: Day-0 reset, slice lifecycle and definition of done, eval discipline, flags + shadow + staged rollout, loop policy, NIM, data governance, migration, calendar, risks (X1–X12) |
| [A4-DELIVERY-CONTRACT.md](A4-DELIVERY-CONTRACT.md) | normative design (v2) |
| [A7-CUES.md](A7-CUES.md) | how cues work beyond word overlap |
| [A5-EVALUATION.md](A5-EVALUATION.md) | oracle metrics, harness v2, arms, ship rule |
| [A6-TRUST-AND-SAFETY.md](A6-TRUST-AND-SAFETY.md) | authority, secrets, wording, guard safety, forgetting |
| [A1](A1-ADVERSARIAL-REVIEW.md) / [A2](A2-TECHNICAL-CHOICES.md) / [A3](A3-NATURE.md) | first review, technical choices (citation-audited), nature mechanisms (citation-audited) |
| [research/](research/) | R0 hook facts · R1 cue experiment · R2 cue architecture · R3 review v2 · R4 citation audit · R5 scope on real repos · R6 real usage |
| [EDEN-MEMORY.md](EDEN-MEMORY.md) | prior doc: its measurements and history |

Sizes: **S** ≤ 1 day · **M** ≤ 3 days · **L** ≤ 2 weeks. Every gate is an A5 arm or metric.

---

## Day-0 reset (EXECUTION §1)

State on 2026-09-29, after the merge to `main` on `Knihalani/Eden`:
- **Done:**
  - the `whatever` loop is parked (STOP files);
  - full agent autonomy is set up: local `bypassPermissions`, with agents merging their own PRs behind mandatory gates (`CLAUDE.md`, `/next`, `/slice`, the `slice-reviewer` subagent, `PROGRESS.md`);
  - the untracked product files are now tracked;
  - the `session → cwd` snapshot is taken.
- **Open, user:**
  - rotate the leaked token;
  - protect `main` on GitHub: CI is green since P0.−1, but a required check on a private repo needs GitHub Pro (the API answers 403);
  - ~~make `main` the default branch~~ (done 2026-09-30);
  - opt in to real-negative collection.
- **Open, agent** (run `/next`):
  - P0.−1 (below);
  - the formatter/reformat PR for the line-joined files (R-5).

**How to build:** run `/next` in Claude Code at the repo root. Progress is tracked in [PROGRESS.md](PROGRESS.md).

## Phase 0 — Floor: stop the bleeding, make it correct, make it safe

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P0.−1 Green CI baseline** | `main` fails `bun run typecheck` with 112 errors (mostly `packages/know/src/pack.ts`; also `packages/know/src/store.ts`, `apps/site/src/assets.ts`: Buffer/Uint8Array generics, possibly-undefined values, SQLite API shape). Fix them; then run `bun run test` and `bash scripts/build-cli.sh` and fix or quarantine (one tracked issue per quarantined test). No behaviour change | M | the CI `test` workflow green on `main`; afterwards it is the required check (EXECUTION R-6b) |
| **P0.0 Harness v2** | Claude-shaped events for every delivery point; process per event; real transcript format (attachments, `parentUuid` rewinds, subagent files, task-notification submits, compaction); world oracle; simulated context window; annotated cues; ≥ 300 real-negative prompts (scrubbed, kept local). Land every arm in A5 §4 **red first** | L | Arms fail on today's code for the documented reasons |
| **P0.1 Packaging** | ~~Track every module `src/index.ts` imports plus wrap/plugin files and tests~~ (done in `11c3101c3`); verify a fresh clone loads them; fix or delete dead tests (`memory-wal`, `memory-env-docs`); `eden doctor` (modules load, hooks registered, repo key, scope catalog, guard on/off); the plugin's silent fallback logs once; the plugin's fallback chain obeys the 150 ms budget (no 8 s fetch/spawn timeouts on Submit) | S | Fresh clone passes; doctor green |
| **P0.2 Stop the bleeding** | Silence on non-human submits (D24) and on `ack`/chatter turns (A7 §2). Variable bullet count: stop at the first empty stage (D28). Declarative wording (D14). Human-turn counter | S | `nonhuman`, `continue` arms; replaying R6's transcripts gives packet rate ≤ 30% and bullet volume ≤ 20% of today |
| **P0.3 Ids, clocks, validity** | ULIDs; per-repo `seq` under `flock` (+ `pending.jsonl`); persist `t`, `invalid_at`, `valid_until`; order by `seq`; delete the numbered-list-beats-everything rule; real ages | M | `spawn-writers`, `reload-stale`, `numbered-list` |
| **P0.4 Trust gate** | Authority by entry type + paste stripping (D12); `sanitizeForStore` with gitleaks rules + keyword rule (D13); assistant/tool/compaction text → episodes only; `purge`, `forget` | M | `secrets`, `poison` |
| **P0.5 Repo identity + windows + migration** | Store per `git-common-dir` (D1); window keys (D2); `dir → repo` cache; migration of old session stores **through P0.4** as `legacy` episodes (A6 §4) | M | `cross-session`, `worktree` |
| **P0.6 Delta encode** | `hwm.json` on complete lines; prompt from the payload; `last_assistant_message` at Stop; PostToolBatch records paths, exit codes and error signatures in one write; PostToolUse stops parsing the transcript; branch-point (rewind) detection in the delta encoder (A4 §3.3); sync `stop-fast` writes `qprev.json` | M | `rewind`; hook p99 flat over a 1,000-turn session |
| **P0.8 Flags, shadow mode, observability** | `~/.eden/flags.json` + per-repo override, `off/shadow/on` per delivery point, unknown → off (X7); shadow ledger + `would_preempt`/`would_ask` measures; one wide event per invocation; circuit breaker; exit-0 fail-open test per entry point; `eden doctor` lists kill switches | M | both flag states for every arm; injected-throw test; stage-1 entry (EXECUTION §5) |
| **P0.7 Cache-safe placement** | Wrap and OpenAI-shaped inject move the packet to the tail of the last user message (D29) | S | cached-prefix test |

**Phase 0 exit:** all floor arms green; the locked 2k whatever bench still has 0 misses; A/A noise floors recorded (EXECUTION X6); rollout **stage 1** (shadow everywhere) starts.

Every slice follows the lifecycle and definition of done in EXECUTION §3. New behaviour merges dark and is enabled only through the stages in EXECUTION §5.

## Phase 1 — The ledger: never repeat (G5)

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P1.1 Ledger core** | `delivery.log` + snapshot; `cid`/`ver`; refractory by transcript distance (400 KB policies, 1.2 MB others); overflow policy; `hook.log.d/` (ids + stage drops); `hturn` from `turn` records | M | `repeat`, `budget`, `re-eligibility` |
| **P1.2 Epochs** | `clear` bumps the epoch; PostCompact re-arms only cids absent from `compact_summary`; resume keeps the ledger; fork copies it; rewind drops branch deliveries | M | `compaction`, `resume`, `rewind` |
| **P1.3 Residual + shadow** | Residual on typed and assistant text only (D26): episode/policy Jaccard now, the slot co-occurrence rule with P3.3; per-window shadow set fed by InstructionsLoaded + AGENTS.md + MEMORY.md (D27) | M | `residual`, `shadow` |

**Phase 1 exit:** `redundant_rate` < 5% on the replayed R6 sessions and the 300-turn soak; `tokens_per_epoch` ≤ 6k at p99.

## Phase 2 — Policies: the things users actually repeat (G1)

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P2.1 Policy & intent extraction** | Regex at write time per D9 incl. the R8 fixes (qualifier rule, extra triggers and exclusions, class-default objects, `protected-path` class). User-typed imperatives on action classes, keyed `(class, polarity, object)` (D9): temporally qualified → intent (expires on action completion or after 7 days); unqualified `never/always`, or recurrence in ≥ 2 sessions → pin; revocation and opposite-polarity handling; `<pasted_content>` stripping | M | `fixture/extraction-e3.json` (330 items; batch B held out): regex false durable ≤ 1% on the 217 no-durable items; rule recall ≥ 0.80 on batch B (today 0.72) |
| **P2.2 Compiled triggers** | `classes.json` lexicon (A7 §5); prompt-side class firing; ≤ 2 per class by recency. Secondary to the guard (D18) | S | `policy-trigger`: R1 cues recall ≥ 0.45 at FIR ≤ 5%; **held-out** `nim-policy` cues reported (baseline 0.18 at 10% FIR), not ship-blocking until class-word learning (P5.3) lands |
| **P2.3 PreToolUse guard** | Static `hooks.json` handlers, one per `(class, pattern)` (A7 §5), with the class as an argument; command re-check; `guard.log` dedup; `ask` for irreversible classes and live intents, context always; permission-mode downgrade (D19); decline labels read from the transcript (A6 §2.5); `EDEN_POLICY_GUARD` | M | `policy-guard`, `guard-modes`, `guard-dedup`, `intent-expiry`; guard p99 < 80 ms |
| **P2.4 Recurrence → promotion** | `policy_recur` detection on `(class, polarity, object)`; session recurrence → pin; repo recurrence → user-global **proposal** confirmed at SessionStart (D11) | S | `policy-recur` |
| **P2.5 SessionStart + SubagentStart delivery** | ≤ 3 policy pins for the likely scope; `PreToolUse(Agent)` records task paths to `spawn.log`; subagent packets by task scope / agent type; fork subagents skip the parent's delivered items | S | `subagent` (policy part) |

**Phase 2 exit:** on replayed R6 sessions, every cross-session PR-policy recurrence after the second would have been pre-empted, by a packet or by the guard.

## Phase 3 — Place and facts: the right folder, the true value (G2, G3)

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P3.1 Scope catalog** | R5 §9 rule (tracked files; manifests; members; exclusions; buckets; min-2; Bazel; `.eden/scopes`); rebuild on manifest writes | M | R5 §9.3 unit rows + R3 F9 rows |
| **P3.2 Place signal + read set** | Weighted paths (D4 table: prompt 3, recent main batch 2, main 1, Bash 1, subagent 0.5 as tie-breaker); ≤ 2 scopes at ≥ 30% weight; two-scope rendering | M | `fan-out`, `single-package` |
| **P3.3 Slot table + live/history** | ~15 slots (D7) with `default_scope`, the status lexicon and the R8 patterns (retractions, `we're on V`, `deploy to V`, `to A from B`, `use A for B, not C`), incl. bare `use V`, `use A for B`, `use A not B`, `switched to`; retraction; supersession to history; `stale_for` on episodes | M | slot phrasing table (≥ 30 rows incl. R3 E8's, plus "the auth is broken" → no slot, and "we use pnpm here" in `apps/web` → `pkg.manager=pnpm` at `""`); E3 batch B regex slot recall ≥ 0.70 (today 0.38), 0 false slots on status/trap items; `negation`; `stale-episode` |
| **P3.4 Repo-fact mining + citations** | Sleep mines lockfiles, `.nvmrc`/engines, deps, scripts, CI → cited slot facts (`src=tool`); SessionStart / CwdChanged / FileChanged return `watchPaths` for cited files → FileChanged recheck; a user statement overrides | M | `repo-facts`, `citation` |
| **P3.5 Cascade + first-touch delivery** | Cascade with override for slots (D5); PostToolBatch first touch of a new scope → ≤ 2 STRONG items | S | `scoped` at 4752 / 15840 turns; `cascade`; `first-touch` |

## Phase 4 — Cues that work without word overlap (G1, G3)

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P4.1 Situation cue + turn mode** | `q_prompt ⊕ q_turn ⊕ q_path ⊕ q_prev`, mode weights, own-delivery stripping (A7 §2–3) | S | `continuation`; CueBench ctx recall ≥ 0.40 |
| **P4.2 Prebuilt postings + BM25F + bounded C** | Sleep writes a scoped postings snapshot (the in-process build at 20k rows costs ~100 ms, A7 §8); BM25F fields; newest-64 on fat terms; \|C\| ≤ 200; 150 ms budget abort | M | `scale-20k`: gold recall, silence, p99 < 150 ms |
| **P4.3 Evidence gate + τ calibration** | STRONG / MEDIUM / WEAK (A7 §4); identifier-shaped STRONG; per-repo τ refit on the real-negative replay, seeded with R8's 98 vocabulary-rich generated negatives (reported separately; harder than R1's); episodes need 2 cue parts | M | CueBench at repo τ: recall ≥ 0.50 with test FIR ≤ 7.5% (R1 strict point: 0.498 / 7.5%), **and** FIR ≤ 5% on the ≥ 300 real-negative set. If the real-negative FIR exceeds 5%, raise τ and report the recall cost; do not relax the FIR gate |
| **P4.4 Slot detector** | Seed lexicon per slot → keyed lookup; indirect-need bundles (`setup` → pkg manager, node version, env location) | S | indirect cues (R1) recall ≥ 0.3 at unchanged FIR |
| **P4.5 Gotchas** | Failure→success detection (D10); PostToolUseFailure / PostToolBatch delivery | M | `gotcha` |
| **P4.6 How-to lane** | Procedure cues (not `\bflake\b`-only); scoped; ≤ 1 bullet; PostToolBatch context after the command head ran (it helps the next attempt) | S | non-flake how-to packs in scope only |

## Phase 5 — Learning from restatement

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P5.1 Restate / confirm logging** | Events per D30 in `hook.log` → `miss.jsonl`; weekly dogfood report | S | events emitted on every arm; the dogfood report runs |
| **P5.2 Classification** | `not_retrieved` / `gated_out` / `suppressed` / `not_encoded` / `recurring_policy` (A4 §7) | M | a scripted class table |
| **P5.3 Bridge maturation** | (a) Opt-in strong-model blind alias batches (gemma-4-31b via NIM, D21a), accepted or dropped **as a batch** after a τ refit; (b) miss-driven class words and repo jargon (D21b); expiry (A7 §6) | M | `restate-learn`; a batch is kept only if silence-replay FIR ≤ pre-batch and annotated recall −0.02 at most; held-out paraphrase recall reported (R8 baseline: 0.102 with gemma aliases vs 0.000 without) |
| **P5.4 Sleep LLM extraction (opt-in)** | Confirm + extend (D9.5) via NIM: D12 stripping first; small batches; LLM-only finds stay candidates until confirmed; model admission via the E3 gate (D37) | M | E3: false durable ≤ 1%, 0 on stripped pastes; regex + LLM confirm reaches 0/217 false durables |

## Phase 6 — Scale and optional semantics

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P6.1 SQLite store** | `bun:sqlite` live / history / episodes + FTS5 (external content, `tokenchars '._-/'`, scope as token), WAL; never an unbounded `bm25()` order | L | `scale-1e6`: p99 < 150 ms; gold recall unchanged |
| **P6.2 Dense arm experiment (optional)** | A ≥ 1B embedder (nemotron-embed-1b class) served **warm** (daemon or self-hosted container) as a **separate** dense gate (not an RRF union), plus a cross-encoder veto on dense-only admissions; 5 ms connect budget. bge-small is dropped as the default candidate (R8 E5) | M | D15 re-open condition: > +0.05 recall@4 at equal FIR on ≥ 300 real hard negatives, within the Submit budget; else leave it off |

## Phase 8 — Beyond coding: one core for every agent (added 2026-10-18, R10)

Eden also serves personal assistants, proactive agents, coworkers, tutors and companions. [research/R10/DOMAIN-AUDIT.md](research/R10/DOMAIN-AUDIT.md) lists the coding-only assumptions in the retrieval core (F1–F14). These slices make the core host-neutral; the coding machinery (paths, D7 slots, git classes) stays as the coding host's adapter. Targets are set from R10's measurements on **StreamBench** (`benchmarks/memory-stream/`: multi-session code and personal-assistant streams played through the real hooks; LifeBench and CueBench are secondary pair fixtures) and are pre-registered by each slice. Order and scope may change as R10 reports; R10's report (`research/R10-retrieval.md`) is the evidence.

| Slice | Build | Size | Gate |
|---|---|---|---|
| **P8.1 Space identity** | A store keyed by a host-declared **space** (`user`, `user/<project>`) where there is no git dir (F1); the coding host keeps D1 | S | `space` arm: two spaces never share a row; a coding session's store is unchanged |
| **P8.2 Host-neutral situation** | The cue takes any of `{prompt, prev_turn, prev_assistant, paths, entities_in_play, now, calendar_window, recipient, event}` (F4); each present part is scored apart, as A7 §3 | M | `stream-life`, `stream-code` (A5): recall and human silence on dev at least the incumbent's (P4.3 gate on), with no recall loss on code; CueBench-code unchanged |
| **P8.3 Entity layer** | Entities (people, places, pets, projects, trips) extracted at write and at sleep; an entity mention is the place signal (F2) and STRONG evidence for that entity's rows when the name is not a common word (F3, a DECISIONS proposal) | M | `entity-cue`; `stream-life` proactive recall; silence unchanged |
| **P8.4 Personal action classes + tool-call guard** | book / buy / send / schedule / pay / cancel / share in `classes.json`; guard matchers on MCP tool names and arguments (F5, F6) | M | `life-policy`: standing instructions fire on their action, not on topical mentions |
| **P8.5 Dated validity** | Plans with dates expire when the date passes; routines recur; entity × attribute supersession (F8, F9) | M | `stale-life`: no superseded or past-dated bullet |
| **P8.6 StreamBench arms in A5** | StreamBench as harness arms: `stream-code`, `stream-life`, `stream-silence`, `stream-proactive`, `stream-trigger`, `stream-downstream`; LifeBench pairs as `cuebench-life` (secondary); a sealed stream holdout, written by a different generator, read only at audit | S | arms land red with reasons (P0.0c's rule) |
| **P8.7 Proactive delivery point** | An event-driven cue (`eden memory recall --situation <json>`, SDK and wrap) for hosts that wake with no prompt (F7) | M | `stream-trigger`: life trigger recall ≥ 0.30 (incumbent 0.0) with trigger silence ≥ 0.50 |
| **P8.8 Sleep compiler with need cues and self-play** (R10 F11 + F4) | At sleep, an offline model rewrites the write path's episodes into atomic memories, each with `when` cues (entities, activities, times). A second model writes per-memory situations that need it, and near misses. The hot path matches the turn against both, with no model, behind a flag in shadow | L | `stream-code`/`stream-life` dev, strict: recall ≥ 0.30 code / ≥ 0.18 life at human silence ≥ 0.50 (R10: 0.29–0.33 / 0.18–0.20 at 0.47–0.62); silence on non-human events stays 1.0; Submit p99 within D15/D20 at ≥ 3k rows |
| **P8.9 Optional pull channel** (R10 F13; DECISIONS proposal R10-1) | A secondary extra, not the core. Hosts that support tools also get a one-screen memory index and a `recall(query)` tool for explicit needs. Push stays in charge of proactive needs, triggers, rules and corrections | M | same-event comparison on the judge sample: precision ≥ 2× and silence ≥ +0.15 over the hook frontier on both worlds (R10 C3-E1: 2.5×/+0.18 code, 2.1×/+0.26 life); calls ≤ 25% of no-need human turns (R10: 28.2% code fails; must improve) |
| **P8.10 Calibrated firing** (R10, blank-slate cycle) | The packet rate calibrates itself per user: a turn fires only when its evidence beats a quantile of the user's earlier turns. Paste-stripped queries; three-detector vote | S | `stream-code` silence +0.10 at equal recall over P8.8 alone (R10 C3-E6: +0.11) |

## Phase 7 — Earn-in backlog and League B

- Items in DECISIONS §7 enter only when their logged-data trigger fires: ACT-R activation, reconsolidation window, tag-and-capture, FlyHash, Stop-time LLM prediction, co-change graph, promotion across sibling scopes, pointer bullets, NLI contradiction.
- League B is off the ship path; it runs after Phase 3.

---

## Minimal viable delivery

**Day-0 reset → P0.−1 → P0.0–P0.8 → P1.1–P1.3 → P2.1–P2.5 → P3.1–P3.3 → P4.1.**

That set already delivers:
- memory that survives sessions and worktrees
- no repeats, no non-human or chatter packets
- no poisoning or secrets
- the policies users actually restate, including the guard at the action
- the right folder
- situation cues

Upper bound at the sizes above: 53 working days (~11 weeks) for one engineer, plus P0.−1 (≤ 3 days); expected 6–8 weeks.

## Hygiene carried over

- ~~Delete `sleep-postings.jsonl` or read it (superseded by P4.2).~~ Done in P4.2: sleep writes `postings.snap`, which the Submit reads, and removes the old file.
- Delete the WAL unlink.
- Compact `semantic.jsonl` tombstones at sleep.
- Remove dead env knobs from the docs.

## Open items

- Real-negative and real-restatement numbers come from **one user**. Dogfood with more users before tuning thresholds beyond the defaults.
- R1's fixture has one author. Held-out cues and alias experiments are being re-run with **NVIDIA NIM** (R8), the project's offline model provider (EXECUTION §7); MiniMax is no longer used.
- The guard's `ask` behaviour, from the docs (R0 F24, F26):
  - auto mode forces a prompt from v2.1.211;
  - `dontAsk` would turn `ask` into a deny, so the guard downgrades;
  - in `bypassPermissions` it is skipped;
  - `-p` without a permission host denies.
  Still to live-check: whether `additionalContext` reaches Claude when the user **declines** an `ask`, and that `if` works on plugin `hooks.json` entries (documented, not yet exercised).
