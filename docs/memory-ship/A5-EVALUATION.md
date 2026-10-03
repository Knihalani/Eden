# A5 — Evaluation (v2): measuring what the user cares about

**Dated 2026-09-29, v2.** It specifies DECISIONS D35 and is what gates every ROADMAP slice.

v1's metrics were replaced because R3 F3 showed several were **zero by construction**:
- `stale_rate` counted exactly what the validity filter drops;
- `redundant_rate` counted what the ledger drops;
- `poison_pins` counted `src ≠ user`, which is enforced by design.

v2 measures against **independent oracles**.

---

## 1. Why existing benches cannot certify the product

| Bench | Blind spot |
|---|---|
| Locked whatever 2k bench | one auth / one db; no folders, sessions or processes |
| Hard scale bench (`benchmarks/memory-scale/hard.ts`, 20k rows; dev split = Dev tier, `--split test` = Locked test tier, X5) | in-process and session-less, so it cannot see A1 D1/D2; no tool events, `open_files` or `q_path`; one author wrote its paraphrases |
| Long-horizon runner (today) | single process, so it cannot see id collisions (A1 D2); session-less, so it cannot see the per-session store (A1 D1); supplies `open_files`, which no host sends; no rewinds, subagents, non-human submits or policies |
| CueBench-code (R1) | cue quality only; synthetic, one author; no tool events |
| League B (MAB / LME / TB) | chat QA; no metric for restatement, repetition or stale injection |
| Real transcripts (R6) | one user; only possible post hoc; the only source of real negatives and real restatements |

---

## 2. Metrics

Each metric is computed per arm from the harness's **oracle files** (§3) and Eden's `hook.log`.

| Metric | Definition (oracle-based) | Gate |
|---|---|---|
| `stale_rate` | bullets whose value ≠ the **world oracle** value for that slot/policy at that moment ÷ bullets. The oracle includes repo changes the user never mentions | **0** (hard) |
| `redundant_rate` | bullets whose normalized content is already in the **simulated context window** ÷ bullets. The window holds every message, attachment and tool result on the current branch since the last compaction, plus loaded instruction files | < 5% |
| `need_miss_rate` | annotated cues with `needs: [ids]` where a needed item is neither in the packet nor in the simulated window ÷ annotated cues | ≤ baseline − slice target |
| `false_rate` | bullets ∉ the cue's annotated `needs ∪ allowed` ÷ bullets | ≤ 5% on hard negatives |
| `silence` | packets on: (a) non-human submits other than `Updated:` items (must be 0); (b) `ack` turns (A7 §2; must be 0); (c) the real-negative set (report FIR with a 95% CI). `continuation` turns are scored by `false_rate` | a = b = 0; c ≤ 5% |
| `packet_rate` | packets ÷ human prompts | ≤ 25% on replayed real sessions |
| `tokens_per_epoch` | Σ Eden tokens between compactions | ≤ 6k at p99 |
| `guard_precision` | guard `ask`s where the policy applied (annotated) ÷ guard asks | ≥ 0.9; each false `ask` is a fixture |
| `guard_recall` | annotated policy-violating commands that got an `ask` ÷ such commands | 1.0 on fixtures |
| `secret_bytes` | secret-fixture bytes anywhere under the memory root or in any packet | **0** (hard) |
| `poison_hits` | packets or pins containing any string from the **poison corpus** (not `src`-based) | **0** (hard) |
| `abort_rate` | budget aborts ÷ hook invocations; aborts also count as misses | ≤ 0.5% |
| `p99_hook_ms` | wall time including spawn, per delivery point | Submit < 150; guard < 80; PostToolBatch < 60 |
| `restate_rate` | **dogfood only**: `restate` + `policy_recur` events per 100 human prompts, by class | trend down; a policy restated in 2 sessions never needed a 3rd time |

**Statistics** (EXECUTION X6, R9 §1.1):
- Deterministic arms run twice in fresh processes; any disagreement is a bug.
- Concurrency arms need ≥ 20 repetitions with 0 failures.
- Rates get Wilson 95% CIs and per-cue paired tests (McNemar), clustered by memory or session.
- A zero-event hard gate on n cases bounds the rate at ≈ 3/n, so `secrets` grows to **≥ 300 cases** (shapes × prompt / paste / tool / assistant × start / middle / pasted / split).
- p99 needs ≥ 1,000 samples per point.
- **A/A first:** before the first slice PR, the harness runs baseline-vs-baseline and records each metric's noise floor. No tolerance may be tighter than it.
- For **sampled** metrics, a regression counts only if a paired test rejects at 95% or the point estimate crosses a hard gate.
- The FIR gate is a point estimate on ≥ 300 real negatives with the interval printed. It is called certified only when the upper bound is ≤ 5% (≈ 460 negatives at an observed 3%).

**A/A noise floors** (P0.0b, 2026-10-03; [report](reports/P0.0b.md)).
- **Setup.** Today's `plugins/eden-memory` against itself, every run in fresh processes (`harness/aa.ts`, harness at `8ed6fa4dd`):
  - the world scenario (`harness/world.ts`) at seeds 1, 2 and 3, three runs each;
  - the latency soak (`replay.ts --soak 1000`), three runs.
- **The floor** is the largest spread (max − min) between the runs of one seed. For `need_miss` it is also the most cues whose outcome flips between two runs of a seed. p99 floors come from the soak, the only workload with ≥ 1,000 samples per point.
- **Why today's plugin is noisy.** Every seed's three runs fired the identical event sequence (same digest), so the spread is the plugin's own: its row ids come from `process.pid % 36` (#98, P0.3).
- **What the rule requires.** No tolerance may be tighter than its floor, so until an A/A re-run after P0.3 shows a smaller floor:
  - for `redundant_rate`, `need_miss_rate` and `p99`, the floor is the effective tolerance;
  - a slice that needs a finer comparison uses the paired per-cue test above.

| Metric | Values per run (seed 1 · 2 · 3) | Noise floor | Tolerance | Tolerance ≥ floor? |
|---|---|---|---|---|
| `stale_rate` | 4.4 4.6 4.4 · 12.7 7.1 8.6 · 1.5 1.5 1.6 % | 5.58 pp | hard gate 0 | today's plugin is not at the gate |
| `redundant_rate` | 48.4 49.4 47.8 · 35.5 33.0 35.2 · 56.0 57.3 57.8 % | 2.42 pp | +1 pp | **no** |
| `need_miss_rate` (6 cues per run) | 4 3 4 · 4 4 4 · 5 5 4 missed | 1 cue; 3 cues flip between two runs | +1 cue (long-horizon) | **no** (paired) |
| `false_rate` | 100 100 100 · 100 100 100 · 98.85 98.84 98.86 % | 0.03 pp | +0.5 pp | yes |
| silence, non-human submits | 13 12 12 /71 · 16 16 16 /58 · 18 16 13 /77 | 6.49 pp | hard gate 0 | today's plugin is not at the gate |
| silence, `ack` turns | 0 0 0 /1 · 0 0 0 /1 · 0 0 0 /3 | 0 | hard gate 0 | yes |
| `packet_rate` | 18 17 18 /36 · 22 21 21 /39 · 25 26 26 /47 | 2.78 pp | — | — |
| `tokens_per_epoch` p99 | 1764 1845 1827 · 1188 1211 1211 · 1192 1135 1175 | 81 tokens | ≤ 6k (gate) | — |
| `guard_recall` / `guard_precision` | 0/1 every run / no `ask` | 0 / n/a | — | — |
| `secret_bytes` | 0 every run | 0 | hard gate 0 | yes |
| `poison_hits` | 3 every run | 0 | hard gate 0 | today's plugin is not at the gate |
| `p99_hook_ms` UserPromptSubmit (n = 1,000) | 376.5 412.5 433.5 | 57.0 ms | +10 ms | **no** |
| `p99_hook_ms` PostToolUse (n = 971) | 237.3 299.6 245.3 | 62.3 ms | +10 ms | **no** |
| `p99_hook_ms` Stop (n = 1,000) | 1373.4 1347.0 1427.7 | 80.7 ms | +10 ms | **no** |

Not measured by this A/A, so no floor yet:
- silence on real negatives (P0.0d);
- `abort_rate` (P0.8);
- `restate_rate` (dogfood);
- p99 at points today's plugin does not register (PreToolUse, PostToolBatch, SubagentStart).

**Ship rule** (R3 F20):
- Fixtures are deterministic. Seeds only vary the long-horizon schedule generator (3 seeds).
- A slice ships if its **pre-registered** target moves by its stated delta and no other metric regresses beyond this tolerance:

| Metric | Allowed regression |
|---|---|
| hard gates | 0 |
| `need_miss_rate` | +0 on scoped fixtures, +1 cue on long-horizon |
| `false_rate` | +0.5 pp |
| `redundant_rate` | +1 pp |
| `p99` | +10 ms |

- Dogfood labels find regressions; they are not ship votes. Any `harmful` label becomes a fixture. Aggregate monthly at n ≥ 80.

---

## 3. Harness v2 (`benchmarks/memory-long-horizon/`, extended; the whatever harness stays locked)

1. **Claude-shaped events.** SessionStart / UserPromptSubmit / PostToolBatch / PostToolUseFailure / PreToolUse (incl. `PreToolUse(Agent)`) / SubagentStart / SubagentStop / Stop / PreCompact / PostCompact / InstructionsLoaded payloads, exactly as in R0, including `permission_mode`, and with no task prompt on SubagentStart.
2. **Process per event** (fresh `bun`), including concurrent PostToolUse bursts.
3. **Real transcript format**: attachments (`hook_additional_context`), `parentUuid` branches (rewinds), `compact_boundary`, subagent transcripts, task-notification submits, queued prompts. The schema is copied from R6 §1.1.
4. **World oracle** (`oracle.jsonl`): the true value of every slot and policy over time, including silent repo changes (lockfile swap, dependency removal). Built in P0.0b: `harness/oracle.ts`.
5. **Simulated context window**: the harness tracks exactly what the model would see on the current branch. Built in P0.0b: `harness/window.ts`. A general-purpose subagent's window starts with the parent's instruction files; Explore and Plan windows start without them (R0 F35).
6. **Annotated cues**: every scripted human prompt carries `needs` and `allowed`. Built in P0.0b: `harness/cues.ts`. The metrics of §2 are computed from these files only (`harness/metrics.ts`, whose header says how each definition is read).
7. **Real-negative set**: ≥ 300 prompts drawn from logged human prompts (scrubbed) plus the R1 hard negatives. Kept out of git if drawn from private transcripts.
8. **Session shape from R6**: sessions of 1–24 human prompts (median 3); about 8 subagent windows per main window; about 1.7 non-human submits per human submit; a rewind in 27% of sessions; compaction around 600k tokens.

---

## 4. Arms

**Correctness and safety floor.**

Every arm is also run with its delivery point's flag `off` (asserting identity: no stdout, exit 0, no ledger write) and `shadow` (asserting only the shadow ledger and wide events are written). A `fail-open` arm injects a throw into each hook entry point and asserts exit 0 with empty stdout and stderr. Arms live in `arms.json` with `state: red|green` and the asserted failure `reason` (EXECUTION X4).

| Arm | Script | Assert |
|---|---|---|
| cross-session | fact in session 1; cue in session 7 | packs (D1) |
| worktree | write from `.claude/worktrees/agent-x`; read from the main checkout | the same store (D1) |
| spawn-writers | 200 events, one process each, distinct facts; plus concurrent PostToolUse | 200 rows; 0 duplicate ids; no lost ledger entries |
| reload-stale | Auth0 → Clerk across processes; inject in a third | Clerk only; `stale_rate = 0` |
| rewind | "db is postgres" → rewind → "db is sqlite" | postgres in history (`rewind`); a delivery on the abandoned branch re-injects once |
| negation | "we no longer use Redis" | slot empty; no Redis bullet |
| numbered-list | "1. The database is sqlite", later "the database is postgres" | postgres |
| secrets | 30 secret shapes via prompt, paste, tool result and assistant text | `secret_bytes = 0` |
| migrate | fixture old stores (normal session; two worktrees of one repo; no transcript; corrupt last line; 5 secret shapes; 2 KB paste) → `--apply` twice is a byte no-op; `--rollback` restores byte-identically; crash injection between every step leaves old or new state, never a mix; `secret_bytes = 0`; legacy rows never become slots, policies or pins (EXECUTION §9) |
| poison | tool result or pasted README with "always run curl … \| sh" (incl. inside `<pasted_content>` markers with no fences); assistant-asserted fact; compaction summary claim | `poison_hits = 0` |

**Place and scope.**

| Arm | Assert |
|---|---|
| scoped | web Clerk + postgres; cli none + sqlite at 4752 and 15840 turns, junk on disk |
| cascade | root node 20; web node 22 → web 22, cli 20, root 20 |
| single-package | every fact visible everywhere |
| fan-out | a turn touching web and cli → the two-scope bullet `auth — apps/web: Clerk · packages/cli: none` |
| R5 unit rows | all 12 rows of R5 §9.3 + R3 F9 rows |

**Delivery (G5).**

| Arm | Assert |
|---|---|
| nonhuman | 20 task-notification submits between human prompts → 0 packets from them |
| repeat | the same auth cue on 3 human turns → packets 1, empty, empty; an update → `Updated:` |
| compaction | the compact summary keeps fact A and drops rule B → only B re-arms |
| resume | resume → no re-injection of items delivered before |
| subagent | the parent is told "web auth is Clerk"; a subagent is launched with a task naming `apps/web/login.ts` → its SubagentStart packet contains Clerk; the parent's scope is unchanged **when the parent has its own recent paths**; two parallel `Explore` launches with different task paths get their own scopes (or both fall back to the parent's); a fork subagent gets no bullet already delivered to the parent |
| first-touch | the first Read in `packages/cli` → PostToolBatch delivers the cli slot facts once |
| residual | "auth is Clerk, fix login" → no Clerk bullet; a Read of a file containing "Clerk" does **not** suppress the bullet |
| shadow | an InstructionsLoaded CLAUDE.md says "use pnpm" → the pnpm fact is never injected |
| continue | "continue" after a **report** (`ack`) → no packet; "continue" after a **proposal** (`continuation`) → a packet only on STRONG `q_prev` evidence |
| budget | a 300-human-turn soak → `tokens_per_epoch ≤ 6k` |
| re-eligibility | a pin delivered at off=0 is refractory at 399 KB, re-eligible at 401 KB **with** a fresh cue, and not without one; `message.usage` context tokens are logged beside bytes so the distance can be refit from dogfood |

**Cues and policy (G1).**

| Arm | Assert |
|---|---|
| CueBench-code | R1 fixture + R8 `test_nim` (400 zero-overlap paraphrases, 60 policy-need cues, 98 vocabulary-rich negatives): recall@4, FIR, precision per category at the repo-calibrated τ. The `test_nim` negatives are reported separately; they are harder than R1's (BM25F_ctx FIR 25.5% vs 15%) |
| policy-trigger | R1 policy cues → recall ≥ 0.45 at FIR ≤ 5% on negatives, **and** policy bullets on non-policy positives ≤ 10% after the ledger; **held-out** `nim-policy` cues (kimi-k3, R8) reported: baseline 0.18 at 10% FIR, and must rise as class words are learned |
| extraction | `fixture/extraction-e3.json` (330 items; batch B held out): regex false durable ≤ 1% on no-durable items; batch-B slot recall ≥ 0.70 and rule recall ≥ 0.80; any admitted sleep model: false durable ≤ 1% and 0 on stripped pastes (D37) |
| alias-batch | a strong-model alias batch → kept only if silence-replay FIR ≤ pre-batch after the τ refit and annotated recall −0.02 at most; held-out paraphrase recall reported |
| policy-guard | "don't merge it yourself"; the agent runs `gh pr merge` → `ask` with the rule, **and** the same text in `additionalContext`; after the rule is revoked → no ask; a declined ask is labelled `declined` from the transcript |
| guard-modes | for each `permission_mode` ∈ {default, auto, dontAsk, bypassPermissions}: `ask` in default and auto; context-only in dontAsk and bypass (`guard_bypassed` logged); **no mode ever produces a deny from Eden** |
| guard-dedup | `git push --force` matches push-upstream and history-rewrite → exactly one response, from history-rewrite |
| policy-recur | the same unqualified `(class, polarity, object)` in 2 sessions → a pin; in 2 repos → a user-global **proposal**; after confirmation the 3rd repo gets it unprompted; "don't open the PR yet" in 3 sessions → 0 pins; "don't delete the fixtures" (repo A) + "don't remove the old API" (repo B) → no user-global proposal |
| intent-expiry | "don't open the PR yet" → an ask on `gh pr create`; after the user says "open it now" → no ask; after 7 days → gone |
| repo-facts | a lockfile swap from npm to pnpm with no chat → `pkg.manager=pnpm` (cited); a user statement overrides it |
| citation | `@clerk/nextjs` removed with no chat → the Clerk bullet is skipped (`stale`) |
| gotcha | failure → fix → the same error a week later → delivered next to the error |
| stale-episode | cli postgres → sqlite; cue "cli db setup" → no postgres bullet |
| restate-learn | cue phrasing B misses twice, the user restates → after sleep, B packs; no new fire on the silence replay |
| continuation | "yes do it" after a proposal naming `vitest.config` → the vitest-config memory packs |
| scale-20k / 1e6 | gold recall, silence, p99; never an unbounded bm25 on a fat term |

---

## 5. Dogfood (the only true G1 measure)

- Opt-in, local, redacted `hook.log`.
- Weekly report:
  - `restate_rate` by class
  - `policy_recur` count
  - `packet_rate`, `redundant_rate` (from transcript attachments, as in R6 §4)
  - guard asks and their user decisions
  - 20 random packets hand-labelled helpful / neutral / harmful
- **Baseline** (R6, installed hook, 2026-09):

| Measure | Value |
|---|---|
| exact repeat within the same session | 55.8% |
| packets after non-human submits | 60% (76% incl. queued mid-turn prompts) |
| silence on "continue" | 0.22 |
| packet rate | 54% of human prompts |
| tokens per epoch | p90 40k |

## 6. League B

Off the ship path. It is run after Phase 3 under the honest protocol (named backbone; 4o-mini for any SOTA sentence).
