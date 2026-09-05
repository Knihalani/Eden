# Eden Roadmap — v4.0 Adversarial Edition

**Date:** August 26, 2026 · Supersedes v3.1. This edition folds in the adversarial verification wave (`benchmarks/campaign/`): a positive campaign across six agent domains, a **negative-control campaign across nine regimes where Eden should not help**, and five capacity/degradation probes that broke Eden four times before the fixes landed. Every number below is either gated (paired, counterbalanced, A/A-checked) or labeled modeled. The companion ledger lives in `benchmarks/campaign/README.md`.

---

## 0. Thesis, north star, and method

**Thesis (unchanged):** *The best tool surface is no surface.* Agents should not have to discover Eden, choose Eden, or know Eden exists. Compiled routines are served when behavior matches them; everything else stays invisible. Over time the model only ever sees what is genuinely new.

**North star: Determinism Coverage (DC%)** — the share of production agent tokens executed by approved deterministic paths (compiled, memoized, or transparently served), measured continuously per workspace per day. Instrumented in Arc 1; every other arc must move it or justify itself against it.

**Method (three tiers, enforced everywhere below):**
1. **Positive gates.** Every measurable improvement runs a paired, counterbalanced, replicated benchmark with a clean A/A cell (`bun run bench*`, `benchmarks/campaign/bench-campaign.ts`). WIN or it does not ship.
2. **Negative gates.** *New in v4.* Nine adversarial regimes where Eden should NOT help (non-repeating work, all-judgment stretches, sub-minimum sequences, instant tools, distribution drift, failure storms, concurrent interleaving, silent-drop host). Success criterion is **parity within materiality** (+1%); a LOSS fails the exit code. A tool that only benchmarks well on its own home turf is a bias machine, not a product. (`bench-negative.ts`)
3. **Struggle probes.** *New in v4.* Pass/fail correctness under capacity pressure and partial failure — eviction pressure, slack overflow, mid-run timeouts, dead islands, version churn. Exactly-once mutations hold or the probe fails. (`struggle.test.ts`)
4. Every code path obeys the prime directive: a broken Eden never breaks the agent. Default observe; enforcement opt-in; fail-open on every internal error.
5. Nothing goes live without human Approve (Workshop is the only place a tool turns On).
6. Modeled numbers are labeled modeled; measured numbers carry their benchmark file.

### Now / Next / Later

Execution proceeds in **waves** (§4): batches of benchmarking / testing / optimization / debugging phases that run in parallel within a wave and gate each other across waves.

| Horizon | Items |
|---|---|
| **Now** | Wave 22.2 shipped (default `jit`) |
| **Later — Wave 22.1** | Un-retire only when a live invoice file exists |

### Standing rules

1. Honest numbers or absent — including negative ones (the negative-control table publishes with the wins; see Arc 8).
2. A broken Eden never breaks your agent.
3. Nothing goes live without Approve.
4. Fail closed where deterministic gates exist; fail open to raw everywhere else.
5. One language — canvas panel, Requests inbox, receipt drill-in.
6. No bloat: no governance SKUs, no adapter markets, no unproven percentages.

---

## 1. Shipped record — performance & cost wave (August 2026)

All items below are live in production code, proven by benchmarks under `benchmarks/poc/` (16 files, all WIN), with the workspace suite at 1,028 passing / 0 failing and typecheck clean. Engineering ledger: `benchmarks/poc/README.md`.

| # | Improvement | Mechanism | Measured result | Production files | Tests | UX surface touched |
|---|---|---|---|---|---|---|
| 1 | Shape-extraction memo | Bounded Map caches over `commandShape`/`commandShapeKey`; wired into islands predicates, mining alignment, fulfill, steering | ~64× on repeat passes (88 → 1.4 ms per 4,000-command pass) | `packages/core/src/shapes.ts`, `islands.ts`, `fulfill.ts`; `compile/mine.ts`; `wrap/steer.ts` | `shapes.test.ts` | Faster Workshop candidates; faster steering decisions |
| 2 | Wave schedules computed once | `wavesFor()` memoizes Kahn layers per steps blob | ~10,600 ns → <1 ns graph work per call | `apps/site/src/playback.ts` | site suite | Lower `server_ms` on every receipt |
| 3 | Cache fill off response path | Fire-and-forget `writeResult` | −1 DB round trip per uncached step | `playback.ts liveLoad` | site suite | Lower p50 latency on cold tools |
| 4 | Billing bytes carried from fetch | `densifyPayload(value, {rawBytes})` | 12–26% of densify cost removed per receipt | `core/densify.ts`, `playback.ts` | core/densify tests | Identical receipts, less CPU |
| 5 | OpenAI-log import fidelity | Conversation-keyed partitioning in `detectAndParse` | 0 candidates → compiled tools from OpenAI exports | `core/ingest.ts` | 2 ingest tests | Cold start for OpenAI shops |
| 6 | Scored warming | Recency×frequency scorer over 60-id window | +3–5 pts hit rate (pocJ) | `playback.ts` | site suite | Warmer first calls |
| 7 | ETag revalidation | Versioned envelope `{__eden_cache:2, etag, v}`; conditional request refreshes TTL | −74% full upstream responses at equal freshness (poc4) | `site/cache.ts`, `playback.ts` | 3 cache tests | Fewer rate-limit encounters |
| 8 | Shared public pool | `rcp:` keys; host allowlist AND credential-free AND GET-ok | ÷W cross-tenant fetches (pocA); isolation provably intact | `cache.ts`, `playback.ts` | pool/envelope tests | Cheaper multi-team scale |
| 9 | Deterministic-first islands | `withWitnessMemo`: identical input seen ≥2× with identical output serves from table | witnessed glue calls skip the island model entirely | `wrap/island.ts` | 3 island tests | Programs lose residual LLM cost automatically |
| 10 | Prompt-cache breakpoints | Anthropic-dialect ephemeral markers; opt-out `EDEN_PROMPT_CACHE=0` | modeled 5.3× input-spend vs prior emission (poc5) | `wrap/anthropic.ts` | 3 breakpoint tests | Provider bills drop; invisible |
| 11 | Multi-agent installer | Gemini/Codex/OpenCode config writes alongside Claude hooks; idempotent | Claude/Gemini/Codex/OpenCode coverage | `cli/setup.ts` | 3 installer tests | Recording on every major terminal agent |
| 12 | Cross-platform open | darwin/win32/linux fallbacks | URL always opens or prints | `cli/open.ts` | platform test | Knock reachable off-macOS |

### 1.1 Shipped record — adversarial & negative-control wave (this edition)

The campaign exists because every benchmark in the table above shares one flaw: it was designed by someone who knew what Eden was for. The negative controls and struggle probes remove that advantage. Files: `benchmarks/campaign/{worlds,negative-worlds,session,gates}.ts`, runners `bench-campaign.ts` / `bench-negative.ts`, probes `struggle.test.ts`, soak `soak.ts`. All wired into `scripts/test.sh`.

| # | Finding → fix | Mechanism | Measured result | Production files | Tests |
|---|---|---|---|---|---|
| A1 | **Duplicated writes for non-stopping agents** | Tail calls couldn't carry the head call's full input; strict input equality made every post-steer raw call re-execute after the compiled run had already done the work. Fixed with partial-input matching (every recoverable key must agree; different entities never match) | probes went 4-fail → 0-fail; `oblivious-long` violations eliminated | `wrap/wrap-tools.ts` | `wrap/oblivious.test.ts`, `struggle.test.ts` P3/P4 |
| A2 | **Failed runs deleted their own evidence** | A deopt after a mutating step deleted the arming — destroying `headErr.toolCalls`, the only record of which steps ran. Siblings then re-ran completed writes. Failed armings now survive for sibling claims and expire normally | struggle P3/P4 exactly-once under timeout and dead-island | `wrap/wrap-tools.ts` | `struggle.test.ts` |
| A3 | **Capacity pressure stole live suppressions** | >64 concurrent stretches evicted armings mid-tail ("least-budget first"). Fix: capacity gate before insert — bursts fail open to raw instead of corrupting in-flight stretches | struggle P1: 80 concurrent stretches, zero duplicates | `wrap/wrap-tools.ts` | `struggle.test.ts` P1 |
| A4 | **Budgets starved each other** | Staleness budget counted process-wide calls; interleaved stretches disarmed each other mid-tail. Now counts matching calls only — anti-staleness property preserved (`safety.test.ts` green), concurrency independent | P2: 40-step tails × concurrent stretches, exactly-once | `wrap/wrap-tools.ts` | `struggle.test.ts` P2 |
| A5 | **Fan-out loops never compiled across widths** | Clustering merges different fan-out widths; loop binding demanded majority-width witnesses — a contradiction that refused every merged cluster. Binding is now per-trace; `maxGram` option un-fragments long stretches | orders domain: refusal → certified 15-step loop program; long-orders scenario flipped LOSS → WIN 1.19× | `compile/compile.ts`, `compile/mine.ts` | `compile.test.ts` mixed-width test |
| A6 | **Shadow punished environment flakes** | Replay dying on a transient failure the recording also contains was charged as a program miss. Now set aside as unvalidatable | incident world go-live: FAIL → PASS | `shadow/shadow.ts` | shadow suite green |
| A7 | **Long-stretch fragmentation** | n-gram cap (12 events) shredded 20+-call stretches into positional fragments with literal-baked args. `maxGram` option added | etl domain: fragment soup → certified 20-step program; long-etl WIN 1.43× turns | `compile/*`, campaign harness | edge tests |
| A8 | **Time-bomb fixtures** (2 found) | Guard-budget tests passed only while the suite ran <50s of process uptime; cache-sweep test raced its own sampled sweeper (~2%/write). Both now control their clocks/randomness | suite stable at any duration | `guard-budget.test.ts`, `cache.test.ts` | — |

### 1.2 Measured campaign results (gated)

Positive (arms: raw vs Eden through real `wrapTools`, think-time billed per decision):

| Scenario | Turns | Wall | Cost | Verdict |
|---|---|---|---|---|
| short-support (program live, 1 stretch) | **6.67× fewer** | 1.78× faster | 4.17× cheaper | WIN p=0.0005 n=12 |
| long-desk lifecycle | 1.36× | 1.16× | 1.31× | WIN p=0.016 |
| long-orders (fan-out loop + refund) | 1.19× | 1.12× | 1.19× | WIN p=0.016 |
| long-etl (read fan-out → report) | 1.43× | 1.28× | 1.36× | WIN p=0.016 |
| long-incident (flaky reads, retries) | 1.35× | 1.13× | 1.32× | WIN p=0.016 |
| thrash-enforce (runaway loop halted) | **5.14× less spend** | 5.29× faster | 5.14× | WIN p=0.002 n=10 |

Negative (parity is success; full table in `benchmarks/campaign/README.md`):

| Regime | Result |
|---|---|
| unique-work (nothing repeats) | parity (+0.2% wall = recorded overhead) |
| creative (all-judgment stretches) | compile refuses honestly; parity |
| micro (2-call stretches ×16) | exact parity |
| chaos-observe (67% failures, observe mode) | parity — prime directive holds |
| fastdesk-live (instant tools, program live) | **7.0× turns / 6.4× wall WIN** — savings are think-time, not tool time |
| drift (half witnessed, half novel ids) | **1.72× turns WIN**, graceful raw fallback |
| concurrent (3 interleaved goals) | **6.67× turns WIN**, exactly-once under overlap |
| chaos-enforce (enforcement on failures) | **1.78× spend WIN** |

Soak: flat heap under forced GC across thousands of executions; zero correctness violations; go-live certification 11/14 rounds (the 3 misses drive Arc 4's witness-efficiency items).

---

## 2. The Surfacing Ladder (flagship)

**The problem, stated precisely.** A compiled tool creates value only when the agent uses it. Every known surfacing mechanism charges one of two currencies: context tokens (schemas advertised whether or not relevant) or probabilistic choices (the model must notice, prefer, and correctly invoke). Industry data makes both expensive: tool schemas can consume 41–58% of agent input tokens pre-optimization (Anthropic now documents 134K-token definition loads before optimization); every model loses 5–10 accuracy points multi-turn vs single-turn (BFCL v4); Anthropic Tool Search cut schema tokens 85% *while accuracy rose* (Opus 4: 49%→74%), proving removal beats advertisement; Programmatic Tool Calling cut billed input 38% on a 75-tool benchmark; Block/Cloudflare-style code-execution stacks claim ~98.7%.

**Eden's structural advantage:** because hooks sit on the tool path and programs come from recorded behavior, Eden can serve results *without the agent ever choosing anything* — and unlike PTC, without requiring the host to support a code-execution container, without per-call model routing decisions, and with a human approval gate on everything that mutates. That determines the ladder order.

**Positioning vs Anthropic advanced tool use (now GA, in-product):** Tool Search trims the menu; PTC trims the meal; neither mines recorded behavior, neither carries an approval gate, and both are provider-locked. PTC's own honest failure mode — strictly sequential workflows where the model reasons between calls, where it *costs 8% more* — is exactly the shape class where Eden's linear compiled programs deliver their largest wins (6.7× turns on desk-shaped stretches). Eden composes with these features (S4 emits deferred-loading-compatible manifests) rather than competing with them.

| Rung | Mechanism | Agent pays | Status |
|---|---|---|---|
| **S0 · Silent + record** | Hooks record behavior; nothing injected; steering routes behind the scenes | 0 tokens, 0 decisions | shipped (default) |
| **S1 · Transparent execution** ⭐ | See §2.1 | 0 tokens, 0 decisions | shipped (read-only; Write dual-gated). OpenCode native rewrite; Codex post_tool; Gemini additionalContext degrade |
| **S1b · Remainder suppression** | PreToolUse deny for calls 2..N of an already-served stretch | 0 tokens + short denial reason | shipped on Claude Code; OpenCode before-hook + MCP-drop class (`opencode-drop.ts`) |
| **S2 · Skill-native manifest** | SKILL.md bundle; plain `eden.tools.md` fallback | ~25 tok/program, read-once | shipped |
| **S3 · JIT injection** | Exactly one schema appended on matched turns; episode pinning; precision-gated | ≤1 schema on matched turns | wiring shipped; rollout gated |
| **S4 · MCP / hosted adapters** | Capped catalog, meta-tool, hosted dispatch; deferred-loading-compatible | legacy tax | shipped; permanent adapter tier |

**Ladder rules.**
1. Downward-only skipping: S1 silently covers S2's audience; S4 exists so no host is excluded.
2. One selection policy and one receipt format across all rungs.
3. Coverage is measured per workspace *across the ladder*, reported once Arc 1 lands.

**S1b business case (measured this edition).** Two meters. Wrap-path `oblivious-long` (in-process skipRest) is still a **loss: +2.8% cents and +3.2% wall**. That is not S1b. S1b is PreToolUse remainder deny on the **hook / headless** path: **−9.1% cents (analogue)** vs raw on the silent-drop replica (3.3 → 3.0, n=8, `benchmarks/campaign/SILENT-DROP.md`), 2 suppressions per stretch. Live Claude Code cannot ack an always-drop of a correct rewrite; the replica writes `host-drop`. Analogue cents, replica-only host-drop, wrap-path sign, and Home stretch-vs-latest-receipt close in **Wave 8.1**, not here.

### 2.1 S1 — Transparent execution (spec)

**Flow.** Agent emits its natural loop → PostToolUse fires with `tool_name`, `tool_input`, `tool_response` → hookd records (always) → eligibility check → `/v1/play` executes the approved program (6 s timeout) → response merged: original output first, then `[eden:<program>] The remaining steps of this routine were already served (read-only). Facts: … Do not re-run this routine.` → returned as `updatedToolOutput`.

**Eligibility (fail closed):** plane attests `read_only === true`; sequence ≥2; call matches `sequence[0]`; input passes the witnessed envelope; kill switches `transparent_exec:false` / `EDEN_TRANSPARENT=0`; any error anywhere ⇒ `{ok:true}`.

**Risks & mitigations:** hook-path latency (capped 6 s, falls open); wrong-program serving (envelope + first-step match make it require two coincidences); silent replacement drops (R1 below — shape table + verification).

### 2.2 Research integrated — findings R1–R6

**R1 · Output replacement is shape-strict and silently lossy.** `updatedToolOutput` must mirror the tool's native result shape; mismatches are silently ignored (debug-log only). *Shipped:* `TOOL_SHAPES` for Bash/Read/WebFetch/Glob/Grep/Write; 9,500-char merge cap; `transcript-diff` harness; OpenCode/Codex/Gemini adapters (Gemini honest additionalContext degrade).

**R2 · One rewriter per matcher** — concurrent PostToolUse rewrites race. *Consequence:* setup owns exactly one managed entry.

**R3 · `additionalContext` always lands** — survives even `decision:"block"`. *Consequence:* guaranteed-delivery degrade path.

**R4 · Agent Skills crossed into shared infrastructure** — SKILL.md read by ~40 products; progressive disclosure; skills marketplaces are now indexing and grading community skills (SkillHub et al.). *Consequence:* S2 emits SKILL.md bundles; marketplace listing is Wave 16.4, draft-only from `PUBLIC_CLAIMS`, unpublished.

**R5 · Hook timing budgets** — command hooks default 600 s; PostToolUse timeout keeps tool result; timed-out hooks discarded. *Consequence:* self-caps at 1 s/8 s internally.

**R6 · Prompt-cache fragility is now a documented, common failure class.** Community issue trackers document resume paths breaking the cached prefix on every turn (~3.8K tokens re-billed per resume in Claude Code SDK; block-reordering bugs fixed by third-party interceptors that sustain 98.3% hit rates across 4,700+ intercepted calls). *Consequence:* (a) Eden's alphabetical/stable emission discipline is a moat worth advertising honestly; (b) new Arc 3 candidate: a **cache-guard** mode that normalizes volatile blocks on proxy paths — scoped to Eden-managed sessions first, generalization only if measured.

### 2.3 Surfacing backlog (deliverable-level)

| Item | Deliverables | Done when |
|---|---|---|
| S1 hardening: per-tool shape table | `TOOL_SHAPES` map (Bash/Read/WebFetch/Glob/Grep/Write); unknown ⇒ string form + `additionalContext` duplicate | **Shipped.** `packages/cli/src/shapes.ts` + `transparent.test.ts`. OpenCode/Codex/Gemini: Wave 11 |
| S1 verification harness | scripted headless sessions assert model-visible output contains sentinel | **Shipped.** `packages/cli/src/transcript-diff.ts` + host applyOpenCodeAfter / applyCodexAfter / applyGeminiAfter |
| S1b remainder suppression | hookd session state mirroring wrap skipRest semantics; deny reason cites program | **Shipped.** `packages/cli/src/remainder.ts`; OpenCode MCP-drop still denies (`opencode-drop.ts`) |
| S1 write-inclusive transparency | Approve-time checkbox + `EDEN_TRANSPARENT_WRITES=1` gate | **Shipped.** Wave 10 |
| S2 skill auto-refresh | Approve regenerates SKILL.md atomically when present | **Shipped.** `packages/cli/src/drain.ts` / `manifest.ts` |
| S2 when_to_use synthesis | island-generated one-liners rendered into manifest/skill entries | **Shipped.** `islandWhenToUse` + `whenToUseOf`; silent island → description |
| S3 injection-rate guards | max injections/episode; auto-demote to S0 on poor conversion | **Shipped.** `EDEN_JIT_MAX` (default 4). Default surface is `jit` — Wave 22.2 soak printed PASS (`precision=1.000 n=38`) |
| S4 hosted dispatch endpoint | POST transcript → ≤1 schema or empty; tenancy-isolated | **Shipped.** `tools/dispatch` + `POST /v1/dispatch`; `tools/list` empty; W=100 dups=0 |
| S4 deferred-loading compatibility | manifest entries carry `defer_loading` metadata so S4 catalogs light up under Anthropic Tool Search without dual maintenance | **Shipped.** Wave 9.4 |

---

## 3. Arcs (work streams)

Arcs are queues, not schedules. Each closes with a `packages/measure` pass; LOSS = fix or roll back. The campaign tiers (§0 method) apply to every arc: positive gates for wins, negative gates for claims of harmlessness, struggle probes for anything touching suppression state.

**Catching scenarios (Wave 1.3).** Every item below names a running fixture in `benchmarks/campaign/ARC-REGRESSION.md`. The map is gated by `benchmarks/campaign/arc-catchers.test.ts` (every table row names a catcher). Product work for these items stays in later waves; Wave 1 only names what would catch a regression.

### Arc 1 — Measurement spine *(feeds every other arc; P0)*

Why first: every other arc claims numbers; this arc makes claims cheap and honest. **And as of this edition, Arc 1 unblocks revenue-relevant behavior: shadow cannot certify island-bearing programs without provider-reported usage (extrapolated tokens are refused by design — "honest numbers or absent"), so until usage attribution lands, ~1 in 5 go-lives installs UNCERTIFIED (simulated-usage path in the campaign harness; production equivalent is "approved but unmeasured").**

| Item | Deliverables | Facts / research anchor | UI/UX integration | Done when |
|---|---|---|---|---|
| Token attribution per run | Receipt fields tagging each turn `compiled`/`memoized`/`transparent`/`steered-skip`/`frontier` | Manus KV-cache spread makes attribution the difference between real and imagined savings | Metric strip gains "deterministic share"; drill-in colors steps by class | **Shipped (Wave 12).** Recorded window billed=prompt+completion; canvas `data-token-class` + summing ledger. `benchmarks/campaign/provider-window.ts` |
| **Certified go-live pipeline** *(new)* | Wrap `usage.ts` scraper feeds per-run provider tokens into traces; shadow accepts scraped usage, retiring the extrapolated-token objection; UNCERTIFIED badge retires with it | Campaign finding: island programs were INCERTIFIABLE offline; prod integrations already scrape usage (`usage.ts`) — plumb it through | Workshop approval card shows "certified: measured" vs "uncertified" honestly | **Shipped (Wave 2).** Campaign `assumeProviderUsage` retired from the go-live path; silent-host stays uncertified |
| DC% per workspace/day + trend | Nightly aggregation; frozen definition; sparkline | North-star §0 | Metric-strip tile | **Shipped.** `packages/measure/src/dc-day.ts` + `scripts/dc-from-runs.ts` |
| Skip ledger as accounted events | Every steer/suppression/serving/memo-hit/breaker-trip = counted row | Transparency is invisible in-transcript; the ledger is its only witness | Drill-in lists skips inline | **Shipped.** Wrap `{eden:"steered"}` + S1/S1b hook ledger |
| Novelty feed | Rank uncompiled frequent patterns by wasted tokens | Popularity admission exists; novelty closes the loop | "Needs attention" panel | **Shipped (Wave 12).** Waste desc, then named-miss, then recency. Unique-work `[]`. Top desk PASS compiles certified. `packages/measure/src/novelty.ts` |
| `cached_tokens` parsing | Parse provider cache fields in both dialects | Breakpoints (shipped) make these nonzero | Ledger line "provider cache hit %" | **Shipped (Wave 12).** Both dialects on receipts; SSE; POST/GET round-trip write+denom; DC% excludes cache. `providerCacheHitPct` |
| Activation funnel instrumentation | Redacted stage counters install→record→mine→knock→approve→first serving | Silent breakage killed funnels before | Internal | **Shipped (Wave 12).** Doctor `install → record → mine → knock → approve → serving` with counts + fix sentences. `packages/cli/src/doctor.ts` |

### Arc 2 — Zero-friction onboarding *(P0)*

Unchanged from v3.1 except **Wave 9 shipped** the terminal path: `eden explain` (honesty-loop diagnoses with exact counts), `eden approve` (diff card + `--yes`), supervised `eden hookd` (pid + `--stop`), and doctor funnel stages. In-browser Workshop remains a place a tool turns On. New input from the campaign: the **honesty loop names "why didn't anything compile?"** from measured refusal causes — sequence entropy too high (noise-world parity proves nothing was lost), repeats below support 3 (micro-world), width classes split (orders-world lesson: same-shape support needs ≥3), envelope coverage gaps (drift-world lesson). Each diagnosis names the exact count that fell short, because every one of those thresholds is now pinned by a campaign fixture.

### Arc 3 — Trajectory memoization & cache intelligence

Foundation shipped (ETag envelopes, public pool, scored warming). Wave 6 shipped exact-key run cache, admission, compression at rest, single-flight, ETag TTLs. Cache-guard and PTC-complement shipped Wave 9. Attribution-adjacent cache tokens closed in Wave 12. **Nothing in this arc is unscheduled.**

| Item | Deliverables | Facts / anchor | Done when |
|---|---|---|---|
| Cache-guard mode *(new)* | Proxy-path normalization of volatile prefix blocks (skill listings, timestamps) on Eden-managed sessions; opt-in | Community interceptors sustain 98.3% cache-hit on resumed sessions by relocating reordered blocks; upstream bugs re-bill ~3.8K tokens/turn | **Shipped (Wave 9).** `EDEN_CACHE_GUARD=1` |
| PTC-complement emission *(new)* | When a host exposes code execution, emit compiled programs as callable functions (`allowed_callers`) so approved routines compose into PTC scripts | PTC cuts 38% billed input on fan-out shapes but costs 8% more on sequential reasoning — exactly where Eden's linear programs win; composition covers both | **Shipped (Wave 9).** `codingRegistry.allowed_callers` |

### Arc 4 — Envelope & island graduation

Thesis unchanged: convert fail-closed refusals from a wall into a gradient. **New items forced by measured certification failures this edition:**

| Item | Deliverables | Measured anchor | Done when |
|---|---|---|---|
| Witness-efficiency pipeline *(new)* | Go-live today needs ~13 witnesses (≥3 same-shape in training + 3 held out inside the envelope; sloppy variants dilute clusters below support). Deliverables: variant-tolerant clustering (variants vote for sequence but not envelope), rolling shadow (hold-out refreshes as receipts arrive instead of a fixed split), width-class envelope inheritance (a certified width-class extends its envelope to sibling widths after K clean live receipts) | Campaign: go-live SKIP/INCONCLUSIVE in 3/14 soak rounds and multiple campaign cells traced to exactly these three mechanisms | Campaign worlds certify at ≤8 witnesses with zero UNCERTIFIED inflation; soak certification ≥95% |
| Width-class envelope generalization *(new)* | Fan-out widths legitimately vary per entity; a program mined at width 10 should serve width 7 after supervised confirmation rather than falling back raw | orders/drift worlds: novel-width goals fall back raw despite identical shape | Drift scenario turns WIN at higher margin; OOD scenario narrows |
| Integration guidance: read-set exposure *(new)* | Documented pattern for SDK integrations: tools whose result includes the exact array a later loop will iterate (grepCode lesson: 12 hits returned, 6 read → loop unbindable) | research world compile failure reproduced and fixed in fixture | **Shipped.** `docs/compile-refusals.md` `read_set_mismatch`; miner warns |
| Remaining v3.1 items | Witness-seeded islands · stability scoring · graduation proposals · zero-LLM badge · soft-match tier · refusal analytics · envelope editor · graduated rollout | **Wave 10 shipped.** Canvas/Home/CLI. SOC2 stays uncertified. | Canvas contract strip + canary Approve; `packages/ir/src/graduate.ts` |

### Arc 5 — Governance, trust, compliance

Pieces shipped: drift fingerprints, deopt ledger, shadow measure, struggle probes, fuzz 10k, drift auto-refresh, read-your-writes, canary, bit-exact replay, audit export, retention, isolation page, **SOC2 evidence pack (aligned, not certified)**, access-review exports, pool allowlist cadence, `EDEN_NET_ALLOW` in doctor, ZDR guidance, unpublished marketplace draft. **Wave 17 shipped** S1b path-identity, HMAC-only webhooks, hookd ownership, and installer `EDEN_HOME`. **Wave 18 shipped** workbench live-review (account → onboarding, route regression, in-tree 15–52). **Wave 19 shipped** the limits board: retired live-invoice, wrap-path oblivious-long as a limit, JIT soak FAIL pin, replica host-drop. **Wave 20 shipped** the tree close: origin `KaiavN/Eden`, catchers for every Wave 16–19 row, §15 grep-complete including `EDEN_AUTO_APPROVE`, leftover Open for Wave 16–20 is empty. **Wave 21 shipped** the honesty files: `OBLIVIOUS-LONG.md` as the cited close, isolation Kind/Source with analogue and retired in their own lists, `/proof` cases on the same table chrome as wins, JIT soak remeasure FAIL `precision=0.789 n=38` with default `all`. **Wave 22.2 shipped** the soak PASS `precision=1.000 n=38` and flipped `EDEN_SURFACE` to `jit`. Wave 22.1 (live invoice) stays Later until a file exists.

### Arc 6 — Runtime depth

Wave 4 shipped concurrency matrix, multi-tenant arming, timeout-regime, idle-path. Loop-breaker and think-time are covered by campaign fixtures. **Wave 13 shipped** densify v2, turn-boundary speculation, first-wave streaming, connection amortization. **Wave 14 shipped** watch-time warming, island-miss batching, negative-space compilation, fork-mining completion. **Wave 15 shipped** program composition, budget forecasting, scheduled programs, webhook invalidation, PostToolBatch remainder. **New from this edition (shipped):**

| Item | Deliverables | Anchor | Done when |
|---|---|---|---|
| Multi-tenant arming story *(new)* | The suppression map is bounded per wrapped surface (64 entries; capacity gate fails new stretches open beyond it — correct for single agents, a throughput ceiling for hosted multi-tenant dispatch). Deliverables: shared-memory or partitioned arming store keyed by session, load-tested at W≥100 concurrent stretches | Struggle P1: correctness now provable at 80; hosted dispatch needs it at 10× | **Shipped (Wave 4/7).** P1c W=100 |
| Concurrent-regime regression gate *(new)* | The interleaved-stretch scenario graduates from campaign to CI gate (it caught A1–A4) | concurrent scenario: 6.67× turns, zero duplicates | **Shipped.** `concurrency-matrix.test.ts` |

### Arc 7 — Multi-agent

**Wave 7 shipped** parent/child runs, shared-fetch dedupe (A4 matched-calls on read-only fleet claims), handoff compilation (approve-gated), org/fleet view on Home, regional labels, MCP protocol negotiation, and archival tiers. The concurrent-regime probes remain the one-surface primitive. Mutating suppressions stay session-scoped.

### Arc 8 — Proof to the market

**Wave 8 shipped** production A/B (with retired live-invoice), whitepaper, case studies (customer-approved count 0), weekly digest. The negative-control table publishes alongside the wins.

---

## 4. Execution waves — benchmarking, testing, optimization, debugging

**Twenty-two waves.** Waves 1–21 shipped. Wave 22 is **Later**. The invariant: within a wave, every phase is fully parallel — zero inter-phase dependencies, zero shared merge points that gate execution, disjoint surfaces or an explicit ownership split. **Wave 18 was the exception** and is closed: `apps/web/REBUILD.md` rows 7–14 are live; 18.2 route tests are green; 15–52 stayed an in-tree review. Where two pieces of work were sequentially coupled (attribution→certification, cache→compression, dedupe→attribution), they are merged into one phase with one owner rather than left as a hidden chain. Cross-wave gates exist and are shown in §4.10; inside a wave, work never waits.

Arcs say *what*; waves say *in what order and what runs in parallel*. Every wave closes with the three-tier method of §0/§8: positive gates, negative gates, struggle probes. Every wave also carries one **rotation obligation** (see §4.9) so no phase ever tunes twice against the same fixture set. Wave-close acceptance may *use* artifacts built during the wave (e.g., the corpus from 3.1); it may not block their execution.

Phase types:

| Type | Produces | Closes when |
|---|---|---|
| **B** · Benchmarking | New/expanded gated measurement (scenario, fixture, or harness) | Verdict exists — WIN, LOSS, or INDISTINGUISHABLE-with-MDE — and is recorded |
| **T** · Testing | Pass/fail correctness surface (unit, edge, property, probe, CI gate) | Red→green on first discovery; green on 3 consecutive suite runs |
| **O** · Optimization | Measured performance improvement on a named hot path | Gate returns WIN (or documented parity) with no correctness regression |
| **D** · Debugging | Root cause + fix for an observed anomaly, plus the regression test that pins it | Anomaly unreproducible; pinning test merged |

### Wave 1 — Calibration & coverage floor *(all four types, fully parallel)*

Goal: make the instrument trustworthy and the coverage honest before optimizing anything. Nothing here changes product behavior.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 1.1 Noise-floor calibration | D | Per-machine A/A power analysis for every campaign scenario: jitter distribution, minimum detectable effect at n=8/12/16, machine-stability score; CI runner requirements written down | Each scenario documents its MDE; sign-test false-losses (like creative +0.1% flips) become predictable from the stability score |
| 1.2 Flake audit of the whole suite | D | Sweep every time/random-dependent test the way guard-budget and cache-sweep were found: run suite under injected clock jumps, shuffled test order, and artificial load; fix by controlling clocks, never by sleeping | Suite green across 20 consecutive shuffled-order runs with clock jump ±30% and background CPU load |
| 1.3 Coverage expansion: missing regimes | B | New campaign worlds for regimes with no fixture yet: slow-tool (>wrap-timeout) stretches, very-long sessions (100+ stretches), high-cardinality inputs (every goal unique but same shape), provider-pagination shapes | Every Arc item in §3 names the scenario that would catch its regression |
| 1.4 Failsafe property-fuzz seedling | T | Scale the five struggle probes toward property tests: generated programs (random sequences/widths/island placement) × injected faults (timeouts, 500s, corrupt JSON, aborts) asserting Eden-absent-equivalent outcomes | 1,000 generated cases green; any divergence becomes a pinned minimal repro |

Parallelism: all four touch disjoint files (measure config / various tests / campaign worlds / probes). Merge conflicts impossible by convention.

### Wave 2 — Measurement spine & certification *(Arc 1; unlocks revenue behavior)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 2.1 Attribution & certified go-live | B+T | One workstream, one owner: `usage.ts` scraper feeds per-run provider tokens into traces; shadow accepts scraped usage (extrapolated-token objection retired); UNCERTIFIED badge only for genuinely unscrapable hosts; ledger classes (`compiled`/`memoized`/`transparent`/`steered-skip`/`frontier`) sum exactly to provider totals | Reconciliation test vs a recorded provider window passes; campaign worlds certify ≥95% without `assumeProviderUsage`; ledger sums exact |
| 2.2 DC% instrumentation | B | Nightly aggregation + sparkline + drill-in coloring per token class | Number reproduces from raw runs by independent script |
| 2.3 Wrap idle-path optimization | O | Profile the ~31–37µs/call wrapped overhead (candidates: noteSignals every call, tagEvent closures, redact copies); target <12µs/call with zero behavioral change | Idle micro-bench WIN (or documented parity) + full wrap suite + negative campaigns unchanged-parity |
| 2.4 Witness-economics debugging sweep | D | Every SKIP/INCONCLUSIVE go-live across campaign + soak gets a traced root cause tagged into the known mechanisms (variant dilution, width-class split, envelope gap); unexplained ones become Arc 4 items | ≥95% of historical failures map to a named mechanism; unknown rate <5% over 50 go-lives |

Parallelism: fully parallel — four disjoint surfaces (wrap usage path / site aggregation / wrap hot loop / campaign harness instrumentation).

### Wave 3 — Compiler & mining depth *(Arc 4 groundwork)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 3.1 Compile-quality corpus | B | Fixture library spanning measured failure shapes: mixed fan-out widths, period loops, nested loops, branches, island placements (before-write/between/tail), shell-shaped CLI stretches, retry variants; each with pinned expected program or refusal reason | Every fixture has a pinned expectation; corpus runs in CI; regressions name the fixture |
| 3.2 Miner throughput pass | O | Profile `compileTraces` on 500+-trace batches (ngram windows, clustering, alignment); memoize hot hashes; target linear-ish scaling. Validated against campaign worlds now; corpus adopted at wave-close gate | 500-trace compile ≤2s on CI hardware; quality identical on current fixtures |
| 3.3 `maxGram` auto-tuning | B+O | Choose window per input length distribution instead of fixed default; validated against campaign worlds now, full corpus at close | etl/research-class stretches compile without fragments; short stretches unaffected |
| 3.4 Binding-failure telemetry | D+B | Near-miss loop bindings (research-world lesson: read-set ≠ repeat-count) emit named warnings that land in the novelty feed | Each refusal reason class maps to a docs entry or a miner improvement ticket |
| 3.5 Variant-tolerant clustering prototype | O+T | Variants vote for sequence shape but not envelope values; validated against desk/incident sloppy-noise worlds | Go-live succeeds at ≤8 witnesses on campaign worlds with zero uncertified inflation |

Parallelism: fully parallel — 3.1 builds the yardstick while 3.2–3.5 execute against existing campaign fixtures; the wave-close acceptance gate runs everything against the finished corpus. No phase waits on another to *execute*.

### Wave 4 — Runtime capacity & concurrency *(Arc 6 groundwork)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 4.1 Concurrency matrix gate | T | Grid through the struggle harness: stretches {1..200} × tail lengths {2..40} × think {0,120ms} × armings live {≤64, >64}; exactly-once asserted everywhere | Matrix green; any red cell = bug with pinned repro, not a tolerance change |
| 4.2 Multi-tenant arming store | O+T | Partitioned/shared-memory suppression store keyed by session for hosted dispatch; bounded per session, global bound configurable | W=100 concurrent stretches on the probe harness: zero duplicates, p50 steering latency flat vs W=10 |
| 4.3 Suppression fast-path & latency forensics | O+D | Short-circuit scan order (most-recent arming first), avoid extractInput on non-matching names early, reuse canonical forms; flame-graph the steering decision under the 4.1 matrix and fix what dominates | Wrapped idle path ≤ Wave-2 target with 64 live armings; steering decision p99 <1ms; profile evidence attached |
| 4.4 Timeout-regime bench | B | Slow-tool worlds (>wrap timeout) through positive campaign: measure deopt-claim behavior cost/benefit; tune timeout defaults from data | Timeout default justified by a gated number, not a guess |

Parallelism: fully parallel — 4.1 exercises existing code paths, 4.2/4.3 touch store vs scan layers, 4.4 is campaign-side.

### Wave 5 — Surfacing ladder hardening *(S1/S1b/S2)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 5.1 S1 shape table + degrade path | T+D | Native result shapes for Read/WebFetch/Glob/Grep/Write; unknown tools degrade to `additionalContext`; transcript-diff verification harness proves the sentinel reaches the model | Harness green on every built-in tool; degrade path verified under `decision:"block"` |
| 5.2 S1b remainder suppression | B+T+O | hookd session state mirroring matched-calls budget semantics; PreToolUse deny cites program; ledger rows counted | Headless-host oblivious cents ≥ break-even (wrap `oblivious-long` remains a documented wrap-path loss); suppressions counted. Wrap-path sign flip, if it ever happens, is Wave 8.1 |
| 5.3 S2 skill refresh + marketplace prep | T | Atomic SKILL.md regeneration on Approve; listing draft withheld until Arc 8 numbers publish | **Shipped** refresh (Wave 9 drain). Listing draft from `PUBLIC_CLAIMS` only — Wave 16.4 unpublished |
| 5.4 Negative-control rotation | B | Derive one NEW adversarial world from this wave's surface (e.g., a host that drops `updatedToolOutput` silently mid-session — R1 class) and add it to `bench-negative.ts` | **Done when:** unique-sequence **parity** ±1%; compilable stretch may WIN (Eden cheaper) while S1b deny still holds when the rewrite is dropped; joins the permanent rotation. Live-host ack of a correct drop is Wave 8.1 (replica-only is enough here) |

Parallelism: fully parallel — 5.1/5.2 own different hook events (Post vs Pre) and coordinate only through the documented session-state shape, which is a typed contract, not a meeting; 5.3/5.4 independent. Leftovers that must not be quoted as live Claude Code facts close in Wave 8.1.

### Wave 6 — Cache, memory & governance *(Arcs 3+5)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 6.1 Run cache: exact-key, admission, compressed envelopes | B+O | Envelope+params keyed read-cache; frequency-predicted writes; hit-rate telemetry day one; gzip+base64 envelope bodies >2KB (one envelope revision carries both) | **Shipped.** Hit-rate on the receipt (`cache_hits / cache_lookups`, omitted at 0 lookups). Write volume −93.6% vs write-all on a unique-GET storm; replay hit-rate loss **0.000 pt**. Size **−92%** on >2KB JSON-ish bodies. Hit-path read tax **−14.5%** (decoded hot set; budget is <10%). Mutating POST/PUT/PATCH/DELETE refused. `apps/site/src/cache-bench.ts` |
| 6.2 Drift auto-refresh pipeline | B+D | Canary drift → re-mine → shadow-compare → approval card; forced-upstream-rename fixture | **Shipped.** Site ingest wires real `compileTraces`+`shadowProgram`. Control plane queues `rc:<tool>` after two hard deopts; live stays live; auto-approve skips it. Fixture `benchmarks/campaign/upstream-rename.ts` (`state→conclusion`). Copy: “The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.” |
| 6.3 Fuzz suite scale-up | T | Wave-1 seedling to 10k fault seeds × both schedulers; divergences = pinned bugs | **Shipped.** Wrap n=10000 divergences=0 seed `0xF5A1`; sched n=10000 divergences=0 waves vs ready. `failsafe-fuzz.test.ts` + `failsafe-fuzz-sched.test.ts` |
| 6.4 Audit export + isolation truth page | T | JSONL/CSV export (approvals, versions, executions, refusals), tamper-evident; isolation claims each linked to code/test | **Shipped.** `eden audit export` / `verify`; `GET /v1/audit`. Hash chain. Isolation page `/isolation` + `docs/isolation.md`. Article 12 *aligned*, not certified. OWASP MCP01–MCP10 mapped. |

Parallelism: fully parallel — four disjoint surfaces (cache/playback, drift pipeline, probes, site export).

### Wave 7 — Multi-agent & hosted scale *(Arc 7)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 7.1 Fleet runs: cross-agent dedupe + parent/child attribution | B+T | Memo-store backed cross-agent claims reusing matched-calls semantics; trace tree with per-agent attribution; fleet-wide DC%; public pool already ships the unauthenticated slice | **Shipped.** Two agents, one fleet, one GET: executes **1** (was 2). Ledger exact `shared across N agents`. `tracesMatchSpans` vs orchestrator `invoke_workflow` / `invoke_agent`. Mutating stays session-isolated. `benchmarks/campaign/fleet-dedupe.ts` |
| 7.2 Hosted dispatch load-probe extension & anomaly forensics | T+D | Struggle probes against the multi-tenant store at W≥100 (from Wave 4) plus protocol-negotiation skew cases; any anomaly traced to root cause with pinned repro before the next probe round | **Shipped.** W=100 hosted connections: duplicateWrites=0, admits=100. MCP initialize echoes supported versions, degrades garbage, never 500. Eden future `x-eden-version` still 426. `benchmarks/campaign/hosted-dispatch.ts` |
| 7.3 Handoff compilation spike | B | Repeated agent→agent patterns → composed program candidates; approve-gated | **Shipped.** Intake→billing composes; `manifest` null until `POST /v1/tools/:id/approve`. `packages/compile/src/handoff.ts` |

Parallelism: fully parallel — 7.1 is runtime+site, 7.2 is probe harness, 7.3 is compile-side.

### Wave 8 — Proof to the market *(Arc 8 close-out)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 8.1 Production A/B | B | The budgeted paired live study; every public claim cites it; claims that fail get retired publicly. Closes the Wave 5 leftovers that the replica/analogue path cannot: (1) at least one S1b cell billed from a live Claude Code invoice, not `TURN_CENTS`/`ISLAND_CENTS`; (2) live host-drop of a *correct* native rewrite is either observed and receipt-classed, or recorded as a permanent host limit (replica-only `host-drop`); (3) wrap `oblivious-long` is WIN on the path under test or retired from the win table into the published limits (it is still +2.8% cents / +3.2% wall); (4) Home/canvas names the whole stretch (served + skipped tails + any drop), not only the latest receipt word — a finished 3-call session must not read as merely Skipped when a drop also happened | **Shipped.** Study published with retired live-invoice cell (`LIVE-AB.md`). Replica host-drop is a permanent host limit (`HOST-DROP.md`). oblivious-long is a **limit**, not a win. Home/canvas 3-call stretch reads `Live · Served · Skipped · Degraded` (`stretch-drop.ts`). Analogue cents and replica host-drop cannot be quoted as live Claude Code facts |
| 8.2 Whitepaper incl. negative results | B | Methodology, win table, **parity table**, limits section (OOD, oblivious agents, certification bounds) | **Shipped.** `/proof` + `docs/whitepaper.md`. Every row from `PUBLIC_CLAIMS` with a file path. Parity equal weight with wins. |
| 8.3 Case studies | B | Customer-approved measured numbers only, one per vertical | **Shipped.** Campaign fixture verticals (support, desk, orders, etl, incident) on `/proof` and `docs/cases.md`, each linking methodology. Customer-approved count **0**. No invented companies. |
| 8.4 Weekly digest | T | DC trend + savings + novelty items; mirrors dashboard exactly; opt-in | **Shipped.** Opt-in (`EDEN_DIGEST` / config `digest`, default off). Empty workspace prints zeros; fetch fail-open; never emails. `packages/cli/src/digest.ts`; GET `/v1/digest` |

### Wave 9 — Zero-friction onboarding *(Arc 2 close-out)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 9.1 Honesty loop + `eden explain` | T+D | Diagnoses from measured refusal causes (entropy, support &lt;3, width-class split, envelope gaps). Each names the exact count. Same words as Home. | **Shipped.** `eden explain`. Empty = `0 stretches`. Micro: `Too short · 16 stretches of 2 calls (need 3)`. `packages/ir/src/honesty.ts`; `packages/cli/src/explain.ts` |
| 9.2 In-terminal approvals + diff cards | T | `eden approve [id]` prints a one-screen card; `--yes` POSTs the existing approve route. Human gate unchanged. Dual write gate. | **Shipped.** Without `--yes` nothing ships (exit 2). FAIL cannot ship. `packages/cli/src/approve.ts` |
| 9.3 Supervised daemon + doctor funnel | T | `eden hookd` pid file; `--stop`; init starts hookd when down. Doctor names install → record → mine → knock → approve → serving. Lanes: wrap / site / hookd. | **Shipped.** Stale pid is `!!`. Funnel checks in `doctor.ts`. |
| 9.4 Cache-guard + PTC-complement + S4 `defer_loading` | T+O | Opt-in `EDEN_CACHE_GUARD=1` moves volatile prefix after stable. `allowed_callers` on coding + compiled schemas (guidance, not a wall). MCP/manifest `defer_loading: true`. | **Shipped.** `anthropic.test.ts` reorder; `codingRegistry.allowed_callers`; MCP list entries. |

Parallelism: 9.1–9.3 are the CLI onboarding path (one owner); 9.4 is wrap + MCP catalog metadata.

Rotation: honesty letter on unique-work / micro shapes (`benchmarks/campaign/honesty.test.ts`) — class+count, not a retune of negative-control cents.

### Wave 10 — Envelope & island graduation *(Arc 4 close-out)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 10.1 Witness-efficiency | B+O | 8-witness certified go-live; sibling-width inherit after K=3; rolling shadow `rollEnvelope` | **Shipped.** `bench-8-witness` PASS/total=4/4 uncertified=0. Width-7 stays OOD until 3 clean receipts. Identity-stable `rollEnvelope` (no version bump on no-op). `packages/compile/src/width-inherit.ts`; `packages/shadow/src/roll.ts`; live stitch `apps/control/src/inherit-live.ts`. |
| 10.2 Island graduation + Zero-LLM | T | Stability score; pin on Approve (memo-only, miss deopts); badge only when no unpinned island | **Shipped.** `islandStability` ready at 4 agreeing / 0 disagreements. Home/canvas `Zero-LLM` / `Island remains`. |
| 10.3 Envelope inspect + canary | T | Contract strip shows envelope counts; drop tightens, cannot invent; Approve ships canary 10%; Promote → 100%; auto-pause still fires | **Shipped.** `Envelope · N keys · M values`. `POST /v1/tools/:id/promote`. `eden promote`. Empty session is the operator canary. Drain/hook keep `rollout` so S1 cannot silently promote. |
| 10.4 Stragglers | T+O | Soft-match opt-in; JIT max/episode then S0; read-your-writes after mutating head; dual write gate unchanged | **Shipped.** `EDEN_JIT_MAX` default 4; `EDEN_CANARY_PCT` default 10. Rotation `width-inherit`. SOC2 stays an honest gap-pin. |

Parallelism: 10.1 compile/shadow; 10.2–10.3 canvas+control (one visual language); 10.4 wrap.

Rotation: sibling-width inherit (`benchmarks/campaign/width-inherit.ts`) — not a retune of orders cents.

### Wave 11 — Ladder leftovers *(S1 hosts · S2 copy · S3 soak · S4 dispatch)*

Everything on Claude Code's S1/S1b/S2 path that had a done-when in §2.3 is shipped. This wave is the rest of the ladder: other hosts, the JIT catalog endpoint, island-written skill lines, and the last one-language miss on empty Home.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 11.1 S4 POST-transcript dispatch | T+B | `POST` a transcript → ≤1 schema or empty; tenancy-isolated; shadow precision matches local JIT | **Shipped.** `tools/dispatch` + `POST /v1/dispatch`. `tools/list` empty. Hit 1 / miss `[]`. W=100 dups=0. No 6-tool starve. |
| 11.2 S1 on OpenCode / Codex / Gemini | T | Same `TOOL_SHAPES` + `additionalContext` degrade as Claude Code; installer owns one rewriter per matcher | **Shipped.** OpenCode native `output.output`; Codex post_tool JSON; Gemini additionalContext-only (honest). Cursor/Windsurf/Cline skills-only. |
| 11.3 Island `when_to_use` | T | Islands emit the one-liner; drain/manifest/SKILL.md use it (not `description` as a stand-in) | **Shipped.** `islandWhenToUse`; silent island → description via `whenToUseOf`. |
| 11.4 S3 soak + empty inventory title | B+T | JIT default (`EDEN_SURFACE=jit`) only after §7 soak; empty Home/nav title is not `Live tools` at count 0 | **Shipped.** Empty is `0 programs`. Wave 22.2 soak PASS `precision=1.000 n=38` — default `jit`. |

Parallelism: site MCP endpoint / host installers / island+drain copy / Home title. Disjoint files.

Rotation: one NEW host-drop class from OpenCode or Codex (not a retune of `silent-drop`).

### Wave 12 — Measurement leftovers *(Arc 1 pins → covered)*

Classes, DC%, skip ledger, and certified go-live shipped. This wave flipped attribution, cache tokens, novelty, and funnel from **pinned** to **covered**.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 12.1 Token-class ledger | T+B | Every receipt's `compiled`/`memoized`/`transparent`/`steered-skip`/`frontier` sums to provider-reported usage | **Shipped.** Recorded window billed **2584** = prompt+completion; independent class labels; canvas summing ledger + mismatch. `benchmarks/campaign/provider-window.ts` |
| 12.2 `cached_tokens` on receipts | T | Both dialects land on the receipt; DC% still excludes them | **Shipped.** SSE + POST/GET write+denom; OpenAI 1920/2006 → 96%; Anthropic 40/50/10 → 40% not 80%; DC% excludes cache. `providerCacheHitPct` |
| 12.3 Novelty feed | T+B | Rank uncompiled frequent patterns by wasted tokens; the top item compiles into a WIN-ing candidate | **Shipped.** Waste desc; unique-work `[]`; #1 Ready desk waste 4000 compiles certified PASS. `packages/measure/src/novelty.ts` / `packages/compile/src/waste-compile.test.ts` |
| 12.4 Funnel counters | T | Redacted counters install→record→mine→knock→approve→first serving | **Shipped.** Six stages with counts + fix sentences; wrap-down `unknown · wrap is down`; no fake `record=1`. `packages/cli/src/doctor.ts` |

Parallelism: wrap receipts / usage parse / compile novelty / cli doctor. Disjoint files.

Rotation: a recorded provider window (not a campaign world) is the attribution fixture — never a retune of cert-rate. **Landed.** `benchmarks/campaign/provider-window.ts`

### Wave 13 — Runtime depth A *(site + wrap hot path)*

Prefetch and SSE were substrate. This wave shipped the product behavior.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 13.1 Densify v2 | O | Next densify revision with a gated ratio table; never inflates | **Shipped.** Intern table + line-fold. uniform50 3992→1764; invoice 602→179; ANSI 1411→44; never inflates; `{keys,rows,total,page}` and all-zero `d` survive. `packages/core/src/densify-bench.test.ts` |
| 13.2 Turn-boundary speculation | O+B | Lossless read-only eagerness at the turn boundary (PASTE-class); mutating stays unspeculated | **Shipped.** GitHub-like getIssue/getComments/getChecks wall WIN −33% (n=8, p=0.0078); unique-work/creative parity ±1%; mutating never started. `benchmarks/campaign/speculate.ts` |
| 13.3 First-wave streaming | O | First playback wave streams while later waves bind | **Shipped.** Wave-1 bind before last wave-0 member; fixture `server_ms` 183 vs barrier 303; wrap SSE green. `apps/site/src/playback-stream.test.ts` |
| 13.4 Connection amortization | O | Reuse egress connections across steps of one stretch | **Shipped.** Pin-keyed keep-alive; 32 GETs → 1 TCP; p50 drops vs `agent:false`; github pin to 127.0.0.1 still refused. `apps/site/src/ssrf.ts` / `egress-pool.test.ts` |

Parallelism: core densify / wrap speculate / site playback stream / site egress pool.

Rotation: speculation fixture derived from a read-only production shape, not fastdesk. **Landed.** `benchmarks/campaign/speculate.ts`

### Wave 14 — Runtime depth B *(compile + islands)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 14.1 Watch-time warming | O | Warm the next likely compiled tool while the current stretch runs | **Shipped.** First-wave read-only cache while current stretch runs; follows witnessed successors. Hit-rate 0/12 → 12/12 (n=6). Mutating execute **0**. `EDEN_WATCH_WARM=0`. `packages/wrap/src/warm.ts`; `benchmarks/campaign/watch-warm.ts` |
| 14.2 Island-miss batching | O | Island misses that can wait go through the batch API (provider −50%) | **Shipped.** Independent islands share a wave (wall < 70ms vs ~80ms serial; peak inflight 2). When CREATE returns results, or retrieve ends inside the island timeout, cents 2.0 → **1.0** (tokens unchanged). Public OpenAI / Anthropic hosts: **no** batch POST (404 / 24h SLA). Stuck `in_progress` fail-opens to sync in <500ms, never 24h. Pinned fetch **0**. Memo hit cents **0**. Lone miss stays sync. `EDEN_ISLAND_BATCH=0`. `packages/wrap/src/island-batch.ts` |
| 14.3 Negative-space compilation | B+T | Compile the *absence* of a call (the agent used to poll; the program does not) | **Shipped.** poll-world raw_polls=24 compiled_polls=0 seq=`get_job→merge→notify`; unique-work programs=0. Not thrash-enforce. `packages/compile/src/negative.ts`; `benchmarks/campaign/poll-world.ts` |
| 14.4 Fork mining completion | B | Fork groups that already detect still have to pass the same honesty gates as linear programs (min-3, under-determined, empty output) | **Shipped.** CI-gate 1 branch; `underdetermined_write` on unbound mutating arm; cap `programs=24 max_programs≥1`. `packages/compile/src/fork.test.ts`; `benchmarks/campaign/fork-gate.ts` |

Parallelism: wrap warming / wrap islands / compile negative-space / compile forks.

Rotation: a polling world (not a retune of thrash-enforce). **Landed.** `benchmarks/campaign/poll-world.ts`

### Wave 15 — Runtime depth C *(ops · schedules · webhooks · composition)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 15.1 Budget forecasting | T+B | Predicted `llm_calls` / `ms` / `cents` on the program vs remaining budget; halt is a choice | **Shipped.** Halt compares predicted vs actual on the in-flight program (sequence head included). Observe never forecast-halts. Unique-work `budget_halt=0`. `EDEN_KILL_AFTER_WARNING` still the override. `packages/wrap/src/forecast.ts`; `packages/measure/src/forecast.ts`; `benchmarks/campaign/budget-forecast.ts` |
| 15.2 Scheduled programs | T | Operator-scheduled compiled runs (cron-class) with the same Approve gate | **Shipped.** Nothing schedules itself; paused never fires; receipts are wrap-run columns. Wrap ticks every minute; `EDEN_SCHEDULE_CLOCK=0` is POST `/v1/schedule/tick` only. `apps/control/src/schedule.ts`; `eden schedule` |
| 15.3 Webhook invalidation | T | External change invalidates cache/envelope the way drift auto-refresh already knocks | **Shipped.** Named GET keys drop (hot set too); live stays On. HMAC of the body (`x-eden-webhook-signature`); empty secret fail-closed. Replacement card only after recompile PASS — not a clone of live steps. Rotation `benchmarks/campaign/webhook-get.ts` — not `upstream-rename`. |
| 15.4 PostToolBatch remainder + program composition | T | `PostToolBatch` is a suppression point for parallel tails; compose two approved programs into one when the join is witnessed | **Shipped.** Parallel siblings mutate **1**; installer one PostToolBatch entry, no matcher. Default `compileTraces` compose_n≥1, `manifest` null until Approve. `packages/compile/src/compose.ts`; `benchmarks/campaign/post-batch.ts` |

Parallelism: measure/wrap budgets / control schedules / site webhooks / wrap batch + compile compose.

Rotation: a webhook-invalidated GET (not a retune of `upstream-rename`). **Landed.** `benchmarks/campaign/webhook-get.ts`

### Wave 16 — Trust leftovers *(Arc 5 gap-pins · never a cert claim)*

SOC2 / EU certification claims stay out (§7, Wave 10). This wave ships the **evidence pack** auditors ask for and the leftover threat-model rows. Isolation tests remain the shipped truth.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 16.1 SOC2 evidence pack | T | Binder of isolation tests, audit export, human-gate, kill switches — labeled **aligned, not certified** | **Shipped.** `/isolation` + `docs/isolation.md` + `docs/evidence-pack.md`. Landing and `/proof` never say SOC2. |
| 16.2 Access-review exports | T | Who approved what, when, which version — from the existing hash chain | **Shipped.** Tenant-bound `GET /v1/audit/review` / `eden audit review`. Wrong org 403. Tamper still fails verify. `apps/control/src/access-review.ts` |
| 16.3 Doctor `EDEN_NET_ALLOW` + pool cadence | T | Doctor names the allowlist and whether it is empty; pool allowlist has a review note in isolation docs | **Shipped.** Empty is `EDEN_NET_ALLOW empty · piped network binaries stay refused`. Pool cadence in `docs/isolation.md`. |
| 16.4 ZDR guidance + marketplace draft | T | ZDR guidance for PTC/island paths; skills marketplace listing is a draft from `PUBLIC_CLAIMS` only | **Shipped.** `docs/zdr.md`. `docs/marketplace-draft.md` unpublished; `customerStudies()` = 0. Determinism Index stays pruned. |

Parallelism: docs pack / control export / cli doctor / docs+manifest draft.

Rotation: none from campaign worlds — this wave does not tune a fixture. **Landed.** Pack + export; no campaign tune.

### Wave 17 — Remainder & daemon close *(S1b honesty · webhook auth)*

Closes the live-hop leftovers that Wave 15 shipped around. Does **not** put bun back on PreToolUse (that 1s fail-open stays). Does **not** quote a live Claude Code invoice (Wave 8.1 retired that cell).

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 17.1 Path identity | T | Remainder matches `file_path`/`path` after joining relative paths against the hook `cwd`; remainder-local hint includes the path; wrap `hintIdOf` still does not invent ticket ids | **Shipped.** `./a.ts` and the absolute form of the same file claim; a disagreeing `id`/`issue` still refuses; mixed-file batches still take the program head. `packages/cli/src/remainder.ts` / `remainder.test.ts` (cwd-join); rotation `benchmarks/campaign/cwd-hop.ts` / `cwd-hop.test.ts`. Wrap `hintIdOf` still ignores `file_path`/`path`. |
| 17.2 HMAC-only webhooks | T | Raw `x-eden-webhook` / Bearer / raw `Authorization` no longer authenticate. HMAC of the body (`x-eden-webhook-signature` / `x-hub-signature-256`) is the only path. Empty `EDEN_WEBHOOK_SECRET` still 401. `EDEN_WEBHOOK_RAW=1` restores the old header for one release | **Shipped.** HMAC 200; raw header 401 unless `EDEN_WEBHOOK_RAW=1`; empty secret 401; live stays On; GET 1→0 still holds. `apps/site/src/webhook.ts` / `webhook.test.ts`; `benchmarks/campaign/webhook-get.ts` request headers HMAC (EXPECT unchanged). |
| 17.3 Hookd ownership | T | `--stop` kills the process that answers `/health` even when `hookd.pid` is stale. `eden wrap` already starts hookd; `apps/control` local does too. Doctor names a live orphan. PreToolUse stays 1s curl / `echo '{}'` | **Shipped.** Stale pid + live listener: `--stop` stops; `EDEN_HOOKD=0` still no-ops; doctor names a live orphan. PreToolUse stays 1s curl / `echo '{}'` (Limit — never cold-spawns bun). `packages/cli/src/hookd.ts` / `hook.test.ts`; `packages/cli/src/doctor.ts` / `doctor.test.ts`; `apps/control/src/local.ts`. |
| 17.4 Installer home | T | Gemini / Codex / OpenCode bake `EDEN_HOME` the way Claude's warm command already does | **Shipped.** Custom home: bun fallback and spawned hookd share the remainder store; setup tests still refuse Cursor/Windsurf/Cline invented hooks. `packages/cli/src/setup.ts` / `setup.test.ts`. |

Parallelism: remainder matching / site webhook / hookd stop / installer strings — four filesets.

Rotation: a cwd-relative remainder hop (`benchmarks/campaign/cwd-hop.ts`), not a retune of `post-batch`. **Landed.**

### Wave 18 — Workbench live *(Arc 2 UI · gated)* **Shipped.**

Landing **1–6 stay locked.** Do not restore deleted dashboard chrome. 18.1 landed Clerk sign-up / sign-in / workspace / routing / tour / setup / strip keys. 18.2 is the route-regression suite (`apps/web/app/account/route.test.ts`). 18.3–18.4 were in-tree reviews, not a rebuild.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 18.1 Account → onboarding | T | REBUILD rows **7–14** (Clerk sign up / sign in / workspace / routing / tour / setup prompt / strip keys) | **Shipped.** Auth does not dump a logged-in user on marketing; logged-out `/home` is HTTP 307 to `/` |
| 18.2 Route regression | T | Tests for logged-out → landing, logged-in → onboarding or dashboard, sign-up/sign-in return path — no new chrome | **Shipped.** Suite green; fake proof still absent on `/` and `/proof` |
| 18.3 In-tree workbench review | T | Rows **15–32** already in the tree: live pass, not a rebuild | **Shipped.** Dashboard, canvas, Approve, Pause, mobile, a11y, polish hold. No Hub, no Reach, no second inspect product |
| 18.4 Waste-layer review | T | Rows **33–52** already in wrap/compile/control/web: live pass | **Shipped.** Honest zeros until proven; no fake token counts; Approve never an `×` LLM-call ratio |

Parallelism: 18.1 was the gate. 18.2 landed tests without pixels. 18.3–18.4 were review, not autonomous loops.

Rotation: none — no campaign tune. **Landed.**

### Wave 19 — Limits board *(Arc 8 honesty · no new wins invented)* **Shipped.**

Closes the published limits by pinning them, not by reversing them. A later WIN may move a row; this wave did not require one.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 19.1 Live-invoice cell | T | Grep landing, `/proof`, whitepaper, digest copy: no live Claude Code invoice claim. `LIVE-AB.md` retired cell stays retired | **Shipped.** Zero billed S1b invoice quotes. Analogue −9.1% labeled analogue. `LIVE-AB.md` retired. `limits-board.test.ts` |
| 19.2 oblivious-long | T | Wrap-path +2.8% cents / +3.2% wall stays a **limit**, not a win table row. `PUBLIC_CLAIMS` / isolation copy name it | **Shipped.** Win tables omit it; isolation + `eden claims` print the deltas |
| 19.3 JIT soak | B | Re-run `bench:jit-soak` measurement-only. PASS → default `EDEN_SURFACE` may change in a later wave. FAIL → default stays `all` and the FAIL number is the pin | **Shipped.** FAIL `precision=0.789 n=38`; default `all`; `JIT-SOAK.md`. Not a retune |
| 19.4 Replica host-drop | T | `HOST-DROP.md` remains the close. Live Claude Code is not claimed to ack always-drop of a correct rewrite | **Shipped.** Landing/`/proof` never say live host-drop; replica class stays replica |

Parallelism: copy grep / claims file / soak remeasure / host-drop docs.

Rotation: JIT remeasure is measurement-only (not a retune of the soak fixture's expect). **Landed.**

### Wave 20 — Close the tree *(Wave 16–20 inventory empty)* **Shipped.**

When this wave's done-when holds, every **Wave 16–20** leftover in §4.12 is **Shipped** or **Limit**. Wave 21–22 Open rows stay Open until those waves run.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 20.1 Branch | T | Remaining Wave 15–19 work is committed and pushed on `KaiavN/Eden` (never a personal fork). Secrets stay out | **Shipped.** `feat/compiled-tools-horizon` on `KaiavN/Eden`; secrets out of the commit |
| 20.2 Catchers | T | §14 + `ARC-REGRESSION.md` name a fixture or gap-pin for every Wave 16–19 row. `arc-catchers.test.ts` still 0 unnamed | **Shipped.** Map row count matches; backtick paths exist; Wave 16–19 marks in `WAVE_16_19_CATCHERS` |
| 20.3 Kill-switch inventory | T | Every new `EDEN_*` from 16–19 has a §15 row. Doctor names `EDEN_NET_ALLOW` (16.3) and hookd orphan (17.3) | **Shipped.** Grep-verifiable (`packages/cli/src/switches.test.ts`); `EDEN_AUTO_APPROVE` named off-by-default |
| 20.4 Inventory sweep | T | §4.12 every **Wave 16–20** row is Shipped or Limit. Wave 21–22 Open rows do not block this close. Case studies customer-approved count stays **0** until a real n. Determinism Index stays pruned. Cursor/Windsurf/Cline stay skills-only unless the host grows a hook API | **Shipped.** Wave 16–20 leftover rows have no Open. `eden doctor --tree` |

Parallelism: git / catcher map / §15 / this table — four owners.

Rotation: none. **Landed.**

### Wave 21 — Honesty files *(Wave 19 shorts · no new wins invented)* **Shipped.**

Pins the leftovers Wave 19 named and did not close. Does **not** invent a live invoice. Does **not** flip `EDEN_SURFACE` on FAIL. Landing 1–6 stay locked.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 21.1 oblivious-long cited file | T | `PUBLIC_CLAIMS` `oblivious-long` `file` is a measurement close, not `docs/ROADMAP.md`. Isolation / `/proof` / `eden claims` / marketplace draft cite that file. `packages/measure/src/claims.ts` header is current, not “Wave 8” | **Shipped.** `file` is `benchmarks/campaign/OBLIVIOUS-LONG.md`. Listing byte-matches the draft. Header is Wave 21. |
| 21.2 Isolation limits class | T | Isolation “Published limits” names Kind (and Source, or analogue / retired in their own lists matching `/proof`). Analogue and retired are not skimmable as the same class as wrap-path / soak FAIL. Still not a SOC 2 badge | **Shipped.** Live `/isolation` splits Limits / Analogue / Retired; Kind+Source on `iso-table`; graphite; no ship CTA |
| 21.3 Proof fixture columns | T | `/proof` case-studies rows carry Kind + Source (or an equally unskimmable campaign-not-customer tag on the same chrome as the wins table). Names stay fixture verticals. Customer n stays 0 | **Shipped.** Cases use `ClaimTable` (Kind+Source). Customer n = 0 |
| 21.4 JIT soak remeasure | B | `bun run bench:jit-soak` measurement-only. Do not retune the soak fixture’s expect. FAIL → pin the printed `precision=` / `n=` and default stays `all`. PASS → print n; do **not** flip `EDEN_SURFACE` here (that is 22.2) | **Shipped.** Remeasured 2026-08-30 FAIL `precision=0.789 n=38`. `JIT-SOAK.md` matches. Default `all`. |

Parallelism: claims file / isolation copy / proof cases / soak pin — four owners. `claims.ts` `file` field is 21.1 only; 21.3 does not edit `PUBLIC_CLAIMS`.

Rotation: soak remeasure is measurement-only (same rule as Wave 19.3). **Landed.**

### Wave 22 — Un-retire only when evidence exists *(22.2 Shipped · 22.1 Later)*

22.2 started because a soak printed PASS. 22.1 stays Later until a live invoice file exists. Do not invent a bill.

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 22.1 Live invoice cell | B | If a live Claude Code invoice file is in the tree, parse it. Un-retire or keep retired with the parse result. **Do not invent a bill** | `LIVE-AB.md` live-S1b is live-invoice or still retired for a named parse miss |
| 22.2 `EDEN_SURFACE=jit` | T | Flip the default only after a soak prints PASS at the registered bar (`precision≥0.95`). FAIL keeps `all`. Doctor and §15 match the flip | **Shipped.** Unset `surfaceMode()` is `jit`. `bun run bench:jit-soak` PASS `precision=1.000 n=38`. Hold-outs id/cli/url PASS. Doctor and §15 match. |

Parallelism: invoice file vs soak default — two owners, only if both have evidence; otherwise run the one that does.

Rotation: invoice parse is not a campaign retune; soak PASS is not a bar move.

### 4.9 Anti-overfit machinery (applies to every wave)

1. **Rotation obligation.** Each wave derives at least one new world/scenario from a source that did not inform the previous wave's tuning (production traces, failure reports, or a harness behavior class). A scenario may be a primary tuning target at most once; afterwards it is measurement-only.
2. **Pre-registered expectations.** Every scenario records its expected verdict *before* the run (`expect:` field already in the harness). Post-hoc expectation edits are logged, never silent.
3. **Hold-out alternation.** Tuning may target training worlds; the alternating world-set stays untouched until the wave closes, then swaps in.
4. **Materiality thresholds are registered once** (±1% for negative controls; MDE printed for everything else) and never adjusted after seeing a result.
5. **Determinism disclosure.** Simulator metrics (turn counts) are arithmetic, not statistics; only wall-clock carries sampling weight, and the A/A cells police it. Any quoted number states which kind it is.
6. **Red-team round per wave.** One session per wave explicitly tries to break the newest code the way the struggle probes did (they found four real bugs on their first firing) — findings feed either fixes or the pruned list, both of which are progress.

### 4.10 Dependency sketch (cross-wave only — inside a wave, nothing waits)

```
W1 ──► W2 ──► W5 ──► W8 ──► W9 ──► W10
 │      ▲
 │      └──► W6 ──► W8
 └──► W3 ──► W4 ──► W7 ──► W8

W10 ──► W11 ──► W12
              └──► W13 ──► W14 ──► W15
W10 ──► W16 ──► W17 ──► W19 ──► W20
              └──► W18 ──► W20
W19 ──► W21 ──► W22
```

W1–W21 shipped. W22.2 shipped (default jit). W22.1 stays Later (no invoice file).

### 4.11 Modeled timeline *(labeled MODELED — sensitivity ±40% for staffing)*

Assumes two persistent lanes (wrap/runtime, compile/mining) plus one shared site/infra engineer, full-time. Waves are gates, not dates: a wave closes when its done-when criteria hold, not when the calendar says so.

| Wave | Modeled duration | Wall-clock if lanes run concurrently |
|---|---|---|
| W1–W15 | shipped | — |
| W16 trust pack | shipped | — |
| W17 remainder/daemon/HMAC | shipped | — |
| W18 workbench live-review | shipped | gated UI review closed |
| W19 limits board | shipped | retired claims pinned; soak FAIL `precision=0.789 n=38` |
| W20 close the tree | shipped | **Shipped.** Wave 16–20 leftover Open = 0 |
| W21 honesty files | 2 d | **Shipped.** Cited file, Kind/Source, cases chrome, soak FAIL `precision=0.789 n=38` |
| W22 un-retire | 1 d | **22.2 Shipped** (default jit). **22.1 Later** — only if an invoice file exists |
| **Total remaining (modeled)** | | **W22 not on the clock** until evidence exists. |

Critical path after W21: W22.2 closed on soak PASS. W22.1 does not start until an invoice file exists.

### 4.12 Leftover inventory *(Wave 16–21 empty Open — W21 shipped · W22.2 shipped)*

Every Open row below is assigned. **Limit** means the close is a pin, not a reversal. Wave 20.4 closed Wave 16–20. Wave 21 closed: cited file, isolation class, proof cases, claims header. Wave 22.2 closed the JIT default. Wave 22.1 stays Later.

| Leftover | Close | Status |
|---|---|---|
| SOC2 evidence pack (never a cert claim) | 16.1 | Shipped |
| Access-review exports | 16.2 | Shipped |
| Doctor `EDEN_NET_ALLOW` + pool cadence | 16.3 | Shipped |
| ZDR guidance + marketplace draft (unpublished; Index pruned) | 16.4 | Shipped |
| Relative vs absolute remainder paths; path hint | 17.1 | Shipped |
| Raw webhook secret / Bearer still authenticates | 17.2 | Shipped |
| Orphan hookd; local wrap doesn't start daemon; PreToolUse bun | 17.3 | Shipped — Pre stays 1s curl (Limit); orphan/`--stop`/local start are Shipped |
| Gemini/Codex/OpenCode `EDEN_HOME` split-brain | 17.4 | Shipped |
| Cursor/Windsurf/Cline hooks | 20.4 | Limit — skills-only until the host grows a hook API |
| Account / onboarding live (REBUILD 7–14) | 18.1 | Shipped |
| Dashboard/canvas/Approve already in tree (15–32) | 18.3 | Shipped |
| Waste/observability already in tree (33–52) | 18.4 | Shipped |
| Live Claude Code invoice / billed S1b cell | 19.1 · 22.1 | Limit — retired (`LIVE-AB.md`) until a file exists; 22.1 parses it, never invents one |
| wrap `oblivious-long` +2.8% cents / +3.2% wall | 19.2 | Limit |
| oblivious-long cited file is `docs/ROADMAP.md` | 21.1 | Shipped — `benchmarks/campaign/OBLIVIOUS-LONG.md` |
| Isolation Published limits mixed class (no Kind/Source) | 21.2 | Shipped — Kind/Source; analogue and retired own lists |
| `/proof` case-studies unlabeled vs wins table | 21.3 | Shipped — same `ClaimTable` chrome; customer n = 0 |
| `claims.ts` header still says Wave 8 | 21.1 | Shipped — header is Wave 21 honesty files |
| Wave 21.4 JIT soak remeasure pin | 21.4 | Shipped — FAIL `precision=0.789 n=38`; default stayed `all` |
| JIT soak PASS; default `EDEN_SURFACE=jit` | 19.3 · 21.4 · 22.2 | Shipped — Wave 22.2 PASS `precision=1.000 n=38`; default `jit` |
| `EDEN_SURFACE` default jit after soak PASS | 22.2 | Shipped — unset `surfaceMode()` is `jit`; hold-outs PASS |
| Replica host-drop of a correct rewrite | 19.4 | Limit (`HOST-DROP.md`) |
| Case studies customer-approved count 0 | 20.4 | Limit until a real n |
| Uncommitted Wave 15+ tree; origin not clean | 20.1 | Shipped |
| Catchers / §15 rows for 16–19 | 20.2 · 20.3 | Shipped |

---

## 5. Research appendix (consolidated)

### 5.1 Harness capabilities (Claude Code, verified Aug 2026)

| Fact | Source type | Roadmap consequence |
|---|---|---|
| `PostToolUse.updatedToolOutput` replaces model-visible output for ALL tools (since v2.1.121); value must match NATIVE result shape; mismatches silently ignored | Docs + issues | S1 shape table + verification (R1) |
| Hook strings capped 10,000 chars | Hooks reference | 9,500-char merge cap |
| `additionalContext` appends reliably; survives `decision:"block"` | Docs + issues | Guaranteed-delivery degrade path (R3) |
| Concurrent rewriting hooks race | Issue reports | One managed entry per matcher |
| Timeouts: 600 s defaults; timed-out hooks discarded; PostToolUse timeout keeps result | Reference | Self-cap 1 s/8 s |
| `PostToolBatch` fires after parallel batch resolves | SDK reference | **Shipped.** One installer entry, no matcher; remainder armed from the batch (`packages/cli/src/remainder.ts`) |
| Skills: SKILL.md open spec, ~40 products, progressive disclosure; skills marketplaces are now indexing and grading community skills (SkillHub et al.) | Ecosystem scan | S2 SKILL.md shipped; marketplace listing is a Wave 16 draft from `PUBLIC_CLAIMS` only (unpublished) |
| Advanced tool use GA (Feb 2026): Tool Search (−85% schema tokens, accuracy UP), Programmatic Tool Calling (−38% billed input on 75-tool bench; 20–40% typical at 10–49 tools; +8% COST on strictly sequential single-call shapes), Tool Use Examples (parameter accuracy 72→90%) | Provider docs + engineering blog | Ladder positioning §2; PTC-complement emission (Arc 3); sequential-stretch strength is Eden's differentiated ground |

### 5.2 Provider & macro economics (current as of Aug 2026)

| Lever / fact | Numbers | Consequence |
|---|---|---|
| Prompt caching | Reads 0.1×; 5-min writes 1.25×; 1-hr 2× | Breakpoints convert stable prefixes to 10% billing (shipped) |
| Batch API | −50% both kinds; stacks with caching | Island-miss batching stands |
| Agentic token multiplier | Agents consume 5–30× chat tokens/task (Gartner); enterprise inference ≈85% of AI budgets; Goldman projects 24× token demand by 2030 | The waste problem Eden targets is growing structurally, not cyclically |
| Cost-failure headlines | Uber exhausted 2026 AI budget by April; one enterprise $500M single-month bill; "tokenmaxxing" entered mainstream discourse | Budget-control features (budget forecasting, enforcement) are becoming board-level asks — Arc 6 items rise in priority |
| Project mortality | 88% of agent projects fail pre-production; average failed project $340K; only 11–14% of pilots reach production | Onboarding (Arc 2) attacks the biggest cost in the category: never shipping at all |
| Observability consolidation | Cisco acquired Galileo (closed May 2026); Langfuse acquired by ClickHouse (Jan 2026); Portkey acquired by Palo Alto Networks (Apr 2026); segment $0.55B (2025) → $2.05B (2030) | Consolidation validates spend while leaving "deterministic execution with a human gate" uncontested — build-vs-buy window is open but narrowing |

### 5.3 Competitive / governance landscape

| Fact | Consequence |
|---|---|
| Gateway market: Cloudflare Code Mode (~98.7% claim), Maxim Bifrost (92.8%), agentgateway.dev (LF); Gartner: 75% of API-gateway vendors ship MCP features by end-2026 | All compress STATIC surfaces; nobody mines recorded behavior with human approval. Differentiation holds |
| MCP scale: 97M monthly SDK downloads; 10k+ public servers; 80% of F500 deploy active agents; 28% have MCP implementations | S4 adapter tier keeps Eden reachable everywhere the protocol lands |
| MCP governance shift: OAuth 2.1 moving to default; Streamable HTTP replacing stdio; formal tool governance + observability becoming table-stakes; NIST AI Agent Standards profile due Q4 2026; EU AI Act high-risk obligations enforceable since Aug 2, 2026 — tool-calling layer named as where enterprise AI risk lives; OWASP MCP Top 10 published | Arc 5 audit-export/isolation items become compliance checkboxes; Eden's human-approval gate is pre-aligned with the direction regulators are converging on. Keep certifying truthfully; never claim compliance early |
| Security posture: majority of public MCP servers carry meaningful risk; small fraction implement OAuth out of the box | Reinforces S4-as-adapter (never a fat catalog strategy) and credential-free public-pool gating |
| Vendor-ceiling caveat: 92.8%-style figures are ceilings from curated workloads; realistic cleanly-compiled subsets settle 25–45% | Counter-position unchanged: publish methodology + negative results (Arc 8) |
| BFCL v4 multi-turn degradation (−5–10 pts); Tool Search accuracy gains at lower visibility | Minimizing decision points remains the ladder's premise |
| PASTE (Mar 2026): tool exec = 35–61% of request time; speculation −48% | Grounds H-S1 speculation |
| LLMCompiler (ICML 2024): 3.7× latency, 6× cost, +9% accuracy vs sequential ReAct | Prior art generalized by the DAG executor |

### 5.4 Academic / technique anchors

LLMCompiler (parallel DAG execution) · Voyager/AWM (skill libraries — programs are the persistent form) · Chain of Draft (−92% reasoning tokens) · FlashFill-style variation abstraction (implemented) · Speculative Actions / PASTE (lossless read-only eagerness). New this edition: none required — the adversarial-method tier (§0) is engineering practice, not literature.

---

## 6. Pruned (finalized out, with reasons)

| Pruned | Why |
|---|---|
| 100-slot numbering | Slots made scope feel fixed |
| Open IR-spec publication; OSS-posture milestones; public essays | Distribution before differentiation |
| Determinism Index public page | Needs an n we don't have yet |
| Landing-page scroll demos | Theater-adjacent |
| Naive next-wave prefetch | Structurally dead (benchmark arms B≡A) |
| last-6-recency warming | Measured identical to no warming |
| MCP-as-strategy | Demoted to S4 adapter by measurement |
| Bare-string `updatedToolOutput` | Silently dropped by harness |
| **Eviction-based arming bounding** *(new)* | Probed and removed this edition: dropping LIVE suppressions under load traded throughput for duplicated writes. Replaced by capacity-gate fail-open (A3) |
| **Global-counter staleness budgets** *(new)* | Probed and removed: interleaved stretches starved each other's budgets mid-tail. Replaced by matched-calls counting (A4) |
| **Strict full-input sibling matching** *(new)* | Probed and removed: tail calls that cannot carry the head's full context fell through and re-executed completed writes. Replaced by partial matching (A1) |

## 7. Explicit non-goals

Adapter markets · credential vaults · SSO-as-SKU governance · chat-replay explorers · fine-tuned-model products (we compile, we don't distill) · unproven percentages anywhere public · second dashboards · fat-catalog serving as strategy (**MCP = adapter, never the strategy**) · mega-tool union schemas · model-driven tool search (visibility decided deterministically at the ladder) · embeddings as primary router · community-standard efforts before the product earns them · any expansion of auto-approval beyond the human gate · **competing with provider runtime primitives at the layer they own** (we emit compatible artifacts for Tool Search / PTC; we do not rebuild discovery or sandboxing) · optimizing for regimes we measure as parity (creative/non-repeating work stays untouched by design — the honest answer there is "Eden does nothing," and doing nothing is free).

## 8. Verification method (how everything above stays honest)

1. **WIN gates.** Paired, counterbalanced, replicated, A/A-checked (`packages/measure`). LOSS = fix or roll back.
2. **NEGATIVE gates (new).** Nine adversarial regimes assert parity-within-materiality (+1%). Any regime where Eden claims harmlessness must carry a negative control, or the claim doesn't ship. Losses inside the band are printed as measured overhead, never silently dropped.
3. **STRUGGLE probes (new).** Five pass/fail correctness probes over capacity bounds and degradation paths (eviction pressure, slack overflow, timeouts, dead islands, churn). Born red, kept forever; new suppression-state code requires a new probe.
4. **Failsafe rules.** Prime directive enforced in code: default observe, fail-open everywhere, kill switches for every aggressive behavior.
5. **Soak gates for defaults.** Opt-in flags flip to default only after shadow traffic meets explicit criteria.
6. **Modeled vs measured.** Network hops without a live counterpart are MODELED with sensitivity ranges; everything else carries its benchmark file.
7. **Human gate.** Workshop remains the only place a tool turns On. Write-inclusive transparency requires a second explicit opt-in.
8. **Certification honesty (new).** Programs whose savings depend on extrapolated island tokens ship marked UNCERTIFIED until provider-reported usage closes the loop (Arc 1). Uncertified rate is itself a published metric.

---

## 9. Risk register & kill criteria

Every risk names its detection signal, mitigation, and the rule that decides kill-vs-continue. Reviewed at each wave close; a risk whose trigger fired and whose mitigation missed becomes a Wave-N debugging phase automatically.

| # | Risk | L×I | Detection signal | Mitigation | Kill / continue rule |
|---|---|---|---|---|---|
| R1 | Harness API churn breaks S1/S1b (replacement semantics, shape rules, hook timeouts change) | M×H | Harness release notes; transcript-diff verification harness going red | Shape table isolated in `transparent.ts`; degrade-to-`additionalContext` guaranteed-delivery path; multi-host installer abstraction | If a harness removes replacement entirely, S1 degrades permanently to `additionalContext` facts — product continues at reduced invisibility; S1b unaffected (Pre-side) |
| R2 | A provider ships native recorded-routine reuse (PTC evolves persistent, approved routines) | M×H | Provider release notes touching routine persistence / cross-session approval | Cross-provider + cross-host by construction; human gate + audit export are the compliance moat; Arc 3 PTC-complement emission makes Eden compose rather than compete | Continue: position shifts from "only one" to "the one that works on every host"; kill only if a provider ships cross-host mining with a human gate AND an honest ledger — neither has an incentive to |
| R3 | An uncertified or extrapolated number leaks into public copy | L×H (trust destruction is permanent) | Publication checklist (Arc 8): every claim links methodology + benchmark file | UNCERTIFIED badge can never be quoted; whitepaper includes parity table | Any leak → same-cycle public correction + postmortem; repeat means the checklist failed and gets redesigned |
| R4 | Capacity/suppression bug reaches hosted dispatch | L×H | Struggle probes as merge gates on any suppression-state change; W4 matrix | Capacity-gate fail-open design (worst case = lost savings, never lost writes); matched-calls budgets | Any exactly-once violation at target tenancy blocks the dispatch launch until pinned |
| R5 | Envelope staleness serves wrong results after upstream change | M×H | Drift canary fingerprints (shipped); receipt-fail spike alarms | Auto-refresh pipeline (Wave 6); read-your-writes windows; graduated rollout with auto-halt | Spike beyond threshold auto-halts the version; refresh card ships or tool pauses — silent staleness is the only unacceptable state |
| R6 | CI flake erodes trust in the gates themselves | M×M | Wave 1 flake audit; stability scores per machine | Clock-controlling fixes (never sleeps); shuffled-order runs; load-injected runs | Three unexplained flakes in a week freezes feature merges until audited |
| R7 | Overfitting to campaign fixtures | M×M | Rotation obligations; hold-out alternation; red-team rounds | Negative controls derived from non-tuning sources; pre-registered expectations | A win that fails on the hold-out set does not ship, and the fixture it tuned against gets replaced |
| R8 | Live A/B inconclusive or over budget (~$1.1K) | M×M | Pre-registered study design; interim power checks | "Retired publicly" counts as done; modeled numbers stay labeled modeled | Inconclusive = claims retire; the study publishing a null result is success for the honesty culture |
| R9 | Security incident via public pool, SSRF egress, or malicious upstream | L×H | Allowlist AND credential-free AND GET-ok triple gate; SSRF egress checks; OWASP MCP Top 10 review (Wave 6) | Tenant-isolation tests; redaction at record time; bounded retries | Any cross-tenant byte observed → pool disabled globally, postmortem before re-enable |
| R10 | Two-lane staffing gap (wrap lane and compile lane both need senior attention) | M×M | Wave ownership table; bus-factor ≥1 per lane documented | Phases specify files so hand-off is mechanical; docs carry institutional knowledge | A wave whose lane loses its owner drops to one lane; waves re-sequence rather than half-execute |

### 9.1 Pre-registered kill criteria for shipped defaults

A default flips back (e.g., `EDEN_SCHED=ready` → off) when any of these fires on shadow traffic: failure-rate above wave baseline for 48h · p95 regression vs like-for-like · any correctness violation class event. The flip is automatic where measurable; the flip event itself is published in the digest.

---

## 10. Performance budgets

Registered budgets — a phase that regresses one needs an explicit trade-off note and a compensating win elsewhere. Measured on CI hardware; budgets are ceilings, not targets.

| Component | Budget | Current (measured this edition) | Enforced by |
|---|---|---|---|
| Wrapped idle call overhead | ≤12 µs/call | 3.40 µs (0 armings); **8.94 µs with 64 live armings** (`packages/wrap/src/idle.bench.ts`) | idle micro-bench (Wave 4.3) |
| Steering decision p99 | <1 ms | **0.028 ms** p99 at W=100 hosted; p50 W=100/W=10 = 1.51× (`packages/wrap/src/steer-profile.ts`) | concurrency matrix + steer-profile |
| `compileTraces` on 500 traces | ≤2 s | 121 ms median (`packages/compile/src/time-500.ts`) | corpus CI job |
| Transparent serving added latency | ≤6 s ceiling, falls open on breach (harness keeps original output) | capped in code (`EDEN_TRANSPARENT_MS`) | S1 verification harness |
| Receipt `server_ms` | no regression wave-over-wave | playback benches | site suite |
| Soak heap drift | flat under forced GC (±15% band mid→late) | −33% observed (improving) | `soak.ts` exit code |
| Cache read-latency tax from compression | <10% vs uncompressed | **−14.52%** hit path (decoded hot set); cold gunzip once per hot-set miss (`apps/site/src/cache-bench.ts`) | cache tests + cache-bench |
| Suite wall time | <5 min full suite (flake-audit runs may exceed) | ~184s | flake audit |

---

## 11. Threat model & security plan

STRIDE-lite over Eden's four surfaces. Existing mitigations cite their tests; planned items cite their wave.

| Surface | Threat | Existing control (+test) | Planned |
|---|---|---|---|
| Hook channel (agent ↔ hookd) | Injection via crafted tool output into sentinel/facts blocks; oversized payloads corrupting merges; drive-by Origin; split-brain home; stale pid orphan | 9,500-char cap; native-shape merging; hostile-payload tests; `escapeFacts` builder; OpenCode/Codex/Gemini adapters; Origin/Host refusal; pid-after-bind; `--stop` via `/health`; local wrap start; installer `EDEN_HOME` | Wave 17.3 `--stop` via `/health` + local wrap start **Shipped**; Wave 17.4 installer `EDEN_HOME` **Shipped** |
| Control plane API | Cross-tenant reads/writes; auth bypass | Tenant-bound writes, auth UX, migration tests in site suite; ETag envelopes tenant-keyed; **tamper-evident audit export** (`GET /v1/audit`, `eden audit export`); **access-review** (`GET /v1/audit/review`, `eden audit review`) tenant-bound | Wave 16.2 **Shipped** |
| Public result pool | Cross-tenant contamination; cache poisoning via shared keys | Triple gate: host allowlist AND credential-free AND GET-ok; isolation tests provable; mutating methods refused even when the sketch loves the key; **review cadence** in `docs/isolation.md` | Wave 16.3 **Shipped** |
| Island caller | Prompt injection through witnessed inputs; secret exfiltration via drafted text | Memo key covers input; witness-memo requires two agreeing outputs; redaction at record time (`redact.ts`, redact-regression tests); island stability scoring (Wave 10); **ZDR guidance** `docs/zdr.md` | Wave 16.4 **Shipped** |
| Egress (fetch steps) | SSRF via bound URLs; credential leakage to third parties | SSRF egress checks (site suite); credential-free gating for public pool; `EDEN_NET_ALLOW` named in doctor | Wave 16.3 **Shipped** |
| Webhook invalidation | Raw shared-secret header in logs / Referer | HMAC of the body; HMAC-only (raw header no longer accepted unless `EDEN_WEBHOOK_RAW=1`); empty secret fail-closed; live stays On | Wave 17.2 HMAC-only **Shipped**; `EDEN_WEBHOOK_RAW=1` restores |
| Suppression state | Duplicate/dropped mutations under concurrency or failure; relative vs absolute path miss | Struggle probes P1–P5; oblivious tests; partial-match + matched-calls semantics; concurrency matrix as CI gate; **PostToolBatch remainder** (`packages/cli/src/remainder.ts`, `benchmarks/campaign/post-batch.test.ts`); cwd-join path identity | Wave 17.1 cwd-join path identity **Shipped** |
| Isolation / MCP | Auditor-facing claims; MCP08 lack of audit | `/isolation` + `docs/isolation.md` + `docs/owasp-mcp.md` map MCP01–MCP10 honestly; **evidence pack** `docs/evidence-pack.md` aligned, **not certified** | Wave 16.1 **Shipped** |

Non-goal reminder: credential vaults remain out (§7); the public pool's credential-free gate exists precisely so no credentials ever touch shared infrastructure.

---

## 12. Compatibility & support matrix

| Host / integration | Install (recording) | S0 silent | S1 transparent | S1b suppression | S2 skills | S3 JIT | S4 MCP | Notes |
|---|---|---|---|---|---|---|---|---|
| Claude Code | ✓ managed hooks | ✓ | ✓ shipped (read-only; Write dual-gated) | ✓ PreToolUse remainder + PostToolBatch | ✓ SKILL.md | wiring shipped | ✓ stdio | Reference host |
| OpenCode | ✓ plugin module | ✓ | ✓ native `output.output` (MCP path host-drop classed) | ✓ before-hook remainder | ✓ | gated (`all` default) | ✓ `tools/dispatch` | one rewriter plugin; MCP-shaped after is `opencode-drop` |
| Codex CLI | ✓ TOML section | ✓ | ✓ post_tool JSON rewrite | ✓ pre_tool remainder | ✓ | gated | ✓ | one managed TOML section |
| Gemini CLI | ✓ settings write | ✓ | additionalContext degrade (no native rewrite field) | ✓ AfterToolUse remainder | ✓ | gated | ✓ | honest degrade; transcript-diff green on drop |
| Cursor / Windsurf / Cline | manual skills copy | — | — | — | ✓ | — | ✓ | skills-only — Wave 11 did not invent hooks |
| Generic MCP hosts | — | — | — | — | — | POST transcript ≤1 | ✓ hosted dispatch | `tools/list` empty; `tools/dispatch` / `POST /v1/dispatch` |
| SDK: TypeScript | ✓ wrap | ✓ | n/a (in-process steering) | built-in skipRest | manifest emit | — | — | usage scraper feeds certification (Wave 2) |
| SDK: Python (stdlib-only) | ✓ wrap | ✓ | n/a | built-in | manifest emit | — | — | parity contract tested |

Rule: a rung ships on a host only after that host's verification harness (transcript-diff class) proves the artifact lands. Partial ≠ claimed.

---

## 13. Metric definitions (frozen)

Numbers may be challenged; definitions may not change retroactively. Each definition lives in code comments at its computation site; this table is the index.

| Metric | Definition | Where computed | Notes |
|---|---|---|---|
| DC% (Determinism Coverage) | provider-reported tokens on compiled+memoized+transparent+steered-skip executions ÷ total provider-reported tokens, per workspace per day | Arc 1 aggregation | excludes provider-cache discounts (reported separately, never blended) |
| Certification rate | go-lives with shadow PASS on measured tokens/time ÷ all go-lives | `shadowProgram` verdicts + campaign harness | UNCERTIFIED counted separately, never inside the numerator |
| Turn | one agent decision to issue a tool call (charged identically in both arms, including suppressed calls) | campaign driver | arithmetic, not sampled |
| Materiality threshold | ±1% relative delta for negative-control parity; any LOSS beyond it fails the run | `gates.summarize({lossTolerancePct})` | registered once; never tuned post-hoc |
| MDE reporting rule | every INDISTINGUISHABLE prints its minimum detectable effect; a parity claim without MDE is void | `decide()` output | — |
| Exactly-once | per mutating tool per entity per stretch: execution count == 1 under any scheduling | struggle probes | violation blocks merge |
| Deopt rate | structured-deopt receipts ÷ compiled attempts, per program per week | receipts | spike = auto-halt input for graduated rollout |
| Honest zero | a metric with value 0 renders as `0`, never blank/omitted | dashboard + digest | culture rule with teeth: omission is a bug |

---

## 14. Scenario & probe registry

The complete fixture inventory. Rotation obligations draw from the "derives next" column; nothing outside this table may be quoted as a benchmark.

| Fixture | Tier | Regime pinned | Key invariant | File |
|---|---|---|---|---|
| short-support | positive | live program, 1-stretch agent | 6.67× turns, exactly-once | `bench-campaign.ts` §1 |
| long-desk / long-orders / long-etl / long-incident | positive | lifecycle: record→compile→certify→steer across four waste shapes | wins p≤0.016; certified go-live each round | same, §3–6 |
| thrash-enforce | positive | runaway loop under enforcement | spend −80%, restarts bounded | same, §9 |
| unique-work | negative | no sequence ever repeats | turns/cost exact parity | `bench-negative.ts` n1 |
| creative | negative | all-judgment stretches | compile refuses loudly; parity | n2 |
| micro | negative | sub-minimum 2-call stretches | parity over 16 stretches | n3 |
| fastdesk-live | positive (regime) | instant tools, program live | think-time elimination alone yields 7× turns | n4 |
| drift | negative→positive | witnessed ids then novel ids | steers what it knows; raw falls back safely | n5 |
| chaos-observe | negative | 2-in-3 failures, observe mode | parity; never halts | n6 |
| concurrent | positive (hard) | 3 interleaved goals on one wrapped surface | 6.67× turns + exactly-once under overlap | n7 |
| chaos-enforce | positive | enforcement on failure-dominant work | 1.78× spend, violations-free | n8 |
| P1 wide-eviction | probe | >64 concurrent distinct inputs | exactly-once despite capacity pressure | `struggle.test.ts` |
| P2 long-tail | probe | 40-step tail vs slack budget | exactly-once | `struggle.test.ts` |
| P3 timeout-after-write | probe | wrap timeout mid-run post-mutation | write once; later steps honestly refused | `struggle.test.ts` |
| P4 dead-island | probe | island always fails between writes | first write never replayed | `struggle.test.ts` |
| P5 version churn | probe | live program swapped mid-session | old armings never swallow new-version work | `struggle.test.ts` |
| TicketShip bench / loop bench / guard bench | legacy gates | compile ratio · fan-out speedup · guard spend | 8× / ≤8× / −86% | `packages/runtime/src/bench*.ts` |
| soak | soak | volume + memory over minutes | heap flat (forced GC), zero violations | `soak.ts` |
| slow-tool-timeout | coverage | wrap timeout << tool sleep | deopt-claim exactly-once | `bench-coverage.ts` / `coverage-worlds.ts` |
| very-long-session | coverage | 100+ stretches over a 4-id pool | zero violations; certified go-live | `coverage.test.ts` (CI 100) + `--long` bench |
| high-card-ids | coverage | unique ids, identical shape | steer miss / parity, no corruption | `bench-coverage.ts` |
| pagination-loop | coverage | cursor pages then per-item mutate | honest NO_PROGRAM (no bindable foreach) | `bench-coverage.ts` |
| pagination-bindable | coverage | full array then per-item mutate | compile mines foreach | `coverage.test.ts` / `coverage-worlds.ts` |
| failsafe-fuzz | probe | 10,000 generated programs × faults × wrap + both playback schedulers | Eden-absent-equivalent mutations; POST never cached | `failsafe-fuzz.test.ts` + `failsafe-fuzz-sched.test.ts` |
| P1b W=100 | probe | 100 concurrent distinct inputs | fail-open past 64; zero duplicate writes | `struggle.test.ts` |
| P1c hosted W=100 | probe | 100 sessions × 1 stretch on shared store | all armed; zero dups; Wave 4.2 | `struggle.test.ts` |
| concurrency-matrix | probe | stretches {1..200} × tails {2..40} × think {0,120} × ≤64/>64 | exactly-once; red cell = pinned repro | `concurrency-matrix.test.ts` |
| session-crosstalk | probe | same entity id, two sessions, shared store | no cross-session claim (Wave 4 rotation) | `session-crosstalk.test.ts` |
| timeout-regime | bench | slowJudge vs wrap timeout sweep | deopt-claim exactly-once; default 60s justified | `bench-timeout.ts` / `TIMEOUT.md` |
| noise-floor | calibration | A/A wall_ms per scenario | MDE @ n=8/12/16 + stability | `calibrate.ts` / `NOISE-FLOOR.md` |
| flake-audit | calibration | shuffled suite + clock jump ±30% + load | 20 consecutive green | `scripts/flake-audit.sh` |
| silent-drop | negative (Wave 5.4) | host always drops `updatedToolOutput` (R1) | remainder deny still holds; unique-sequence cents parity ±1%; compilable may WIN; suppressions counted. Live-host ack of a correct drop is Wave 8.1 | `silent-drop.ts` / `bench-negative.ts` n9 |
| upstream-rename | rotation (Wave 6.2) | forced field rename `state→conclusion` | canary/control queues draft+knock; live stays On; zero manual mining | `upstream-rename.ts` / `upstream-rename.test.ts` |
| cache-admission | bench (Wave 6.1) | unique-GET storm vs repeating replay | write volume down; hit-rate loss <1pt on replay; gzip −30%+; mutating disqualified | `apps/site/src/cache-bench.ts` / `cache-redteam.test.ts` |
| audit-export | probe (Wave 6.4) | JSONL/CSV hash chain | round-trip parse; splice/flip fails verify | `packages/cli/src/audit.test.ts` |
| fleet-dedupe | rotation (Wave 7.1) | two agents, one fleet, same read-only GET | duplicate fetches 2→1; `shared across 2 agents`; mutating still 1 write/session | `fleet-dedupe.ts` / `fleet-dedupe.test.ts` |
| hosted-dispatch | probe (Wave 7.2) | W=100 hosted connections + MCP initialize skew | zero duplicate writes; initialize never 500; future Eden version still 426 | `hosted-dispatch.ts` / `hosted-dispatch.test.ts` |
| handoff | bench (Wave 7.3) | repeated intake→billing traces | composed parent, `manifest` null until Approve | `packages/compile/src/handoff.ts` / `handoff.test.ts` |
| archive-tiers | probe (Wave 7 Arc leftover) | hot / warm / cold | compact drops events; live hot kept; empty status zeros | `packages/cli/src/archive.ts` / `archive.test.ts` |
| stretch-drop | rotation (Wave 8) | 3-call stretch: serve + remainder skip + host-drop | Home/canvas names Served · Skipped · Degraded; a drop cannot hide behind Skipped | `stretch-drop.ts` / `stretch-drop.test.ts` |
| live-ab | bench (Wave 8.1) | paired live study or retired claims | missing invoice → retired live-S1b; replica host-drop is a host limit; oblivious-long is a limit | `live-ab.ts` / `LIVE-AB.md` / `HOST-DROP.md` |
| digest | probe (Wave 8.4) | weekly letter mirrors Home tiles | opt-in (`EDEN_DIGEST` default off); empty zeros; fail-open; never emails | `packages/cli/src/digest.ts` |
| honesty-explain | rotation (Wave 9) | unique-work / micro class+count in `eden explain` | named class and the count that fell short; empty is 0 stretches | `benchmarks/campaign/honesty.ts` / `honesty.test.ts` |
| width-inherit | rotation (Wave 10) | mined at width 10, sibling width 7 | 2 receipts stay OOD; 3rd inherits; 4th width-7 inDistribution; bad receipt does not inherit | `benchmarks/campaign/width-inherit.ts` / `width-inherit.test.ts` |
| opencode-drop | rotation (Wave 11) | OpenCode MCP-shaped after hook drops `output.output` | native rewrite lands; MCP drop classed; remainder deny still holds; not `silent-drop` | `opencode-drop.ts` / `opencode-drop.test.ts` |
| jit-soak | soak (Wave 11.4 · Wave 19 remeasure · Wave 21.4 · Wave 22.2) | jit-shadow precision vs unique-work empty catalog | PASS only at ≥0.95. Wave 21.4 printed FAIL `precision=0.789 n=38`. Wave 22.2 printed PASS `precision=1.000 n=38` and flipped the default | `jit-soak.ts` / `JIT-SOAK.md` / `bun run bench:jit-soak` |
| provider-window | rotation (Wave 12) | recorded OpenAI + Anthropic usage JSON (not a campaign world) | five classes = prompt+completion; cache excluded; Anthropic 40/50/10 hit % = 40 not 80; unique-work novelty empty | `provider-window.ts` / `provider-window.test.ts` |
| github-review speculate | rotation (Wave 13) | read-only getIssue → getComments → getChecks (80ms tools, THINK_MS=120); not fastdesk | wall WIN by overlapping think-time; unique-work/creative parity ±1%; mutating never started | `speculate.ts` / `speculate.test.ts` |
| watch-warm | rotation (Wave 14.1) | next compiled read-only first-wave while current stretch runs; not turnBoundary | hit-rate 0→100% (12/12); mutating execute 0 | `watch-warm.ts` / `watch-warm.test.ts` |
| poll-world | rotation (Wave 14.3) | CI/job wait `get_status` × N pending→done then merge+notify; not thrash-enforce | compiled sequence poll-count 0; unique-work programs 0 | `poll-world.ts` / `poll-world.test.ts` |
| fork-gate | rotation (Wave 14.4) | CI-gate fork + honesty gates | 1 branched program; min-3 / empty_output / underdetermined_write / max_programs named | `fork-gate.ts` / `fork-gate.test.ts` |
| webhook-get | rotation (Wave 15.3) | named GET, then `POST /v1/webhook` drop | hits 1→0; live stays On; bad secret leaves cache; not `upstream-rename` | `webhook-get.ts` / `webhook-get.test.ts` |
| schedule | bench (Wave 15.2) | operator cron on an already-live tool | paused fires 0; Approve/compile insert 0 schedule rows; receipts share wrap-run columns | `apps/control/src/schedule.ts` / `schedule.test.ts` |
| budget-forecast | rotation (Wave 15.1) | predicted vs actual llm/ms/cents on the in-flight program | unique-work halt 0; enforce head spent-halt; observe compiles | `budget-forecast.ts` / `budget-forecast.test.ts` |
| post-batch | rotation (Wave 15.4) | PostToolBatch remainder after parallel tails | mutating execute 1; garbage `{}`; compose Approve-gated | `post-batch.ts` / `post-batch.test.ts` |
| cwd-hop | rotation (Wave 17.1) | cwd-relative remainder hop | relative `./a.ts` and abs of the same file claim; disagreeing id refuses; mixed-file takes head; not `post-batch` | `benchmarks/campaign/cwd-hop.ts` / `cwd-hop.test.ts` |
| evidence-pack | probe (Wave 16.1) | binder index; aligned not certified | landing/`/proof` SOC2 hits 0; pack paths exist | `docs/evidence-pack.md` · `apps/web/app/(notes)/isolation/copy.test.ts` |
| access-review | probe (Wave 16.2) | who/what/when/version; tenant-bound | foreign org 403; splice/flip fails verify | `apps/control/src/access-review.ts` / `access-review.test.ts` |
| doctor-net-allow | probe (Wave 16.3) | `EDEN_NET_ALLOW` named including empty | empty count 0; refuse sentence | `packages/cli/src/doctor.ts` / `doctor.test.ts` |
| zdr-listing | probe (Wave 16.4) | ZDR guidance + unpublished `PUBLIC_CLAIMS` listing | customers 0; Index pruned | `docs/zdr.md` · `docs/marketplace-draft.md` · `packages/measure/src/listing.ts` |
| hmac-only | probe (Wave 17.2) | HMAC-only webhook auth | HMAC 200; raw header 401 unless `EDEN_WEBHOOK_RAW=1`; empty secret 401 | `apps/site/src/webhook.ts` / `webhook.test.ts` |
| hookd-ownership | probe (Wave 17.3) | `--stop` via `/health`; doctor names a live orphan | stale pid + live listener stops; `EDEN_HOOKD=0` no-op; PreToolUse stays 1s curl | `packages/cli/src/hookd.ts` / `hook.test.ts` · `packages/cli/src/doctor.ts` |
| installer-home | probe (Wave 17.4) | Gemini/Codex/OpenCode bake `EDEN_HOME` | custom home shares remainder store; Cursor/Windsurf/Cline stay skills-only | `packages/cli/src/setup.ts` / `setup.test.ts` |
| account-onboarding | probe (Wave 18.1) | REBUILD 7–14 live | logged-in not dumped on marketing; logged-out `/home` is 307 to `/` | `apps/web/app/account/route.ts` / `route.test.ts` |
| route-regression | probe (Wave 18.2) | logged-out → landing; in-product never stays on marketing | `apps/web/app/account/route.test.ts` |
| workbench-review | gap-pin (Wave 18.3) | rows 15–32 already in tree | Approve crimson; no Hub/Reach | `apps/web/app/canvas/workbench.test.ts` |
| waste-layer | gap-pin (Wave 18.4) | 33–52 already in wrap | first-warning cursor on the run | `packages/wrap/src/wrap-tools.ts` / `packages/wrap/src/forecast.test.ts` |
| limits-board | probe (Wave 19.1) | no live invoice quote; analogue labeled | landing/`/proof`/whitepaper/digest grep 0 | `benchmarks/campaign/limits-board.test.ts` / `LIVE-AB.md` |
| oblivious-long | probe (Wave 19.2 · Wave 21.1 file) | wrap-path +2.8% / +3.2% is a limit | win tables omit it; cited file is the measurement close | `benchmarks/campaign/OBLIVIOUS-LONG.md` / `packages/measure/src/claims.ts` |
| replica-host-drop | probe (Wave 19.4) | replica class; live ack never claimed | `HOST-DROP.md`; landing/`/proof` never live host-drop | `benchmarks/campaign/HOST-DROP.md` / `limits-board.test.ts` |

Rotation draws: production trace shapes, harness behavior classes, customer failure reports — never another campaign fixture.

---

## 15. Kill-switch inventory

Defaults are the safety posture; flipping any default requires the §7 soak gate. Complete list of behavioral switches (config/env), their default, and flip criteria:

| Switch | Default | What it gates | Flip criteria |
|---|---|---|---|
| observe-mode guards | observe (no `enforce`) | halts/blocks/refusals | operator opt-in per install; never default |
| `EDEN_ENFORCE` | off | enforcement behaviors generally | opt-in only |
| `EDEN_STEER_HOOKS` | off | hook-driven steering | shadow criteria met per host |
| `EDEN_TRANSPARENT` / config `transparent_exec` | on for read-only serving | S1 transparent execution | kill switch honored within one call |
| `EDEN_TRANSPARENT_WRITES` | off | write-inclusive transparency | Approve checkbox AND flag |
| `EDEN_PROMPT_CACHE` | on | cache breakpoints | retire if provider caching regresses |
| `EDEN_SCHED=ready` | off | ready scheduler | flip-gate soak: 2 weeks clean shadow |
| `EDEN_MAX_STEPS` (default 150) | 150 | executed-call ceiling in enforce mode | env-tunable; ceiling never fires in observe |
| `EDEN_KILL_AFTER_WARNING` | off | post-warning spend refusal | operator override only |
| `EDEN_TIMEOUT_MS` (60s) / `EDEN_TRANSPARENT_MS` (6s) | as stated | compiled-run / serving ceilings | timeout default justified by Wave 4.4 (`benchmarks/campaign/TIMEOUT.md`); 60s stays |
| `EDEN_ARM_MAX` | 64 | per-session arming cap; bursts fail open | hosted dispatch raises only with a probe; never live-evict |
| `EDEN_ARM_GLOBAL` | 4096 | process-wide arming cap across sessions | fail-open at the ceiling; never steal another session's live arming |
| `EDEN_SESSION` | empty (single-tenant bucket) | session partition key for the shared store | set per hosted agent; default keeps one-wrap isolation |
| `EDEN_FLEET` | empty (no sharing) | read-only cross-agent claims; mutating stays session-scoped | set per hosted fleet; empty keeps Wave 4 isolation |
| `EDEN_AGENT` | empty (falls back to session) | attribution id on traces/receipts | set per agent; never a tenancy boundary |
| `EDEN_REGION` | empty | region label on traces/receipts/DC% slice | label only; cache keys stay workspace-scoped |
| `EDEN_RETAIN_DAYS` | 14 | sweep of un-uploaded `~/.eden/runs` logs (hot tier) | env-tunable; operational ceiling, not a legal hold |
| `EDEN_WARM_DAYS` | 90 | compacted receipts in `~/.eden/archive/warm` | env-tunable; `eden archive compact` |
| `EDEN_COLD_MONTHS` | 24 | monthly DC+counts in `~/.eden/archive/cold` | env-tunable; not a legal hold |
| `EDEN_DIGEST` / config `digest` | off | weekly digest CLI + GET `/v1/digest` | operator opt-in; never default; never emails from the API; fail-open zeros |
| `EDEN_CACHE_GUARD` | off | reorder volatile Anthropic prefix blocks (timestamps, skill listings) so the cache breakpoint stays on stable text | opt-in; `EDEN_PROMPT_CACHE=0` still wins; retire if upstream prefix bugs are gone |
| `EDEN_CANARY_PCT` | 10 | fraction of hosted sessions that see a canary-approved tool | env-tunable 0–100; unpartitioned wrap (empty session) is the operator and always sees canary |
| `EDEN_JIT_MAX` | 4 | max JIT schema injections per episode; unused injections demote to S0 (`none`) | only applies when `EDEN_SURFACE=jit`; default surface is `jit` (Wave 22.2 soak printed PASS) |
| `EDEN_SURFACE` | `jit` | schema advertisement policy | Wave 22.2 printed PASS `precision=1.000 n=38`. Default is `jit`. `EDEN_SURFACE=all` restores the historic full catalog |
| `EDEN_SPECULATE` | on | turn-boundary start of the next compiled **read-only** stretch; mutating never starts | `0` disables within one call; miss discards; fail-open |
| `EDEN_WATCH_WARM` | on | while the current stretch runs, fill first-wave read-only cache of the next likely compiled tool; mutating never pre-executed | `0` disables within one call; miss discards; fail-open |
| `EDEN_ISLAND_BATCH` | on | waitable independent island misses go through the provider Message Batches path (billed cents 50% when results return in-band or via retrieve inside the island timeout); public OpenAI/Anthropic hosts skip the POST; pinned/memo never join; lone miss stays sync | `0` restores one sync call per miss; batch errors and stuck `in_progress` fail-open to sync — never a 24h stall |
| `EDEN_EGRESS_POOL` | on | keep-alive reuse of pin-keyed egress sockets across a stretch | `0` is the Wave-10 `agent:false` path; SSRF pin still applies |
| `EDEN_WEBHOOK_SECRET` | empty (refuse all drops) | `POST /v1/webhook` / `/v1/hooks/invalidate` cache-key drop | HMAC-only: HMAC-SHA256 of the raw body via `x-eden-webhook-signature` / `x-hub-signature-256` (`sha256=<hex>`); raw header / Bearer / raw `Authorization` no longer accepted unless `EDEN_WEBHOOK_RAW=1`; missing/empty secret 401; wrong or malformed HMAC 403; keys left intact; never pauses live |
| `EDEN_WEBHOOK_RAW` | off (HMAC-only) | restore `x-eden-webhook` / Bearer as aliases of the HMAC path | **Shipped** hatch: unset/0 is HMAC-only; `1` is the one-release compat hatch; empty secret still 401 |
| `EDEN_HOOKD` | unset (spawn) | detached hookd from `eden wrap` / control local | `0` = do not spawn; already-healthy is a no-op; doctor names a live orphan |
| `EDEN_SCHEDULE_CLOCK` | on | wrap process ticks due operator crons every minute | `0` is POST `/v1/schedule/tick` only; does not invent schedule rows; paused still never fires |
| `EDEN_NET_ALLOW` | empty | piped network binaries (`curl`, `wget`, `nc`, …) receiving a pipe in compiled Bash | empty refuses; comma-separated names are the hatch; `eden doctor` names the list or the empty sentence; never “all hosts” |
| `EDEN_AUTO_APPROVE` | off | local-dev hatch that ships PASS candidates without a human click | **never a product default.** Unset/0 is Approve required. `1` is a named bypass; doctor prints `!!  approve-gate`; managed installs (`isManagedDeployment()` without `EDEN_DEV=1`) scrub it. Wave 20.3. |
| failOpen | true | every internal error degrades to raw | never flipped in production installs |

Inventory is grep-verifiable (`process.env.EDEN_*`); a new switch without a row here is a review blocker.

---

## 16. Decision log (condensed ADRs)

Context → decision → consequence, for the choices most likely to be relitigated:

| ADR | Context | Decision | Consequence accepted |
|---|---|---|---|
| 001 | Benchmarks designed by people who know the product overfit | Three-tier verification: positive gates, negative gates, struggle probes | More fixtures than features; some engineering time always spends on measurement |
| 002 | Tail calls cannot reconstruct a head call's full input; strict matching duplicated writes | Partial-input matching: every recoverable key must agree | Same-id-different-context stretches share suppressions — accepted, because a stretch's identity is its entity id |
| 003 | Failed compiled runs deleted armings, orphaning completed-step records | Failed armings persist until TTL/budget/eviction | Bounded extra memory (≤ map caps); expiry unchanged |
| 004 | Under >64-way bursts, evicting live armings duplicated writes | Capacity gate refuses new armings; new stretches fail open to raw | Extreme-concurrency stretches lose savings — honest degradation beats corruption |
| 005 | Process-wide call counter starved interleaved budgets | Matched-calls counting per arming | Same-id noise eventually disarms an arming (intended staleness property, test-pinned) |
| 006 | Majority-width loop binding refused merged clusters | Per-trace width binding; period loops keep exact semantics | Programs serve widths their witnesses span; novel widths fall back until covered |
| 007 | Fixed 12-event n-gram window shredded long stretches | `maxGram` CompileOpts | Larger windows cost mining time; callers who know their shapes raise it |
| 008 | Shadow punished flakes the recording also contains | Env-flake deopts count unvalidatable, not miss | Requires ≥minN surviving hold-outs; flaky environments certify slower — honestly |
| 009 | Offline simulation cannot measure island tokens | `assumeProviderUsage` installs manifests explicitly labeled UNCERTIFIED | Uncertified rate is published; flag dies when Arc 1 attribution ships |
| 010 | Sign tests flagged ±0.1% overheads on quiet machines | Registered materiality band (±1%) for negative controls | Sub-band costs are reported but do not fail runs; threshold never moves post-hoc |
| 011 | Cross-agent GET dedupe vs session isolation for writes | Fleet scan only for read-only programs when `fleetId` is set; mutating `scan(session)` unchanged; A4 matched-calls reused | Empty `EDEN_FLEET` shares nothing; same-entity writes still once per session |

---

## 17. Glossary

**Stretch** — one agent goal-execution: the ordered tool calls serving a single intent. **Compiled tool / program** — an Approved deterministic routine mined from witnessed stretches. **Witness** — a recorded stretch that evidence-trained a program; also bounds the envelope. **Envelope** — the witnessed input-value distribution a program accepts (`inDistribution`). **Island** — a judgment step executed by a cheap model inside a program; graduates to code when stable. **Arming** — runtime record that a stretch's tail is being served, absorbing sibling raw calls. **Steered-skip** — a raw call suppressed because a compiled run performed its work. **Deopt** — structured bail-out carrying exactly what ran (`toolCalls`); replay-safe iff nothing ran. **Shadow** — sandboxed replay validation of a candidate against held-out witnesses. **UNCERTIFIED** — live program whose savings rest on extrapolated island tokens (retires with Arc 1). **DC%** — Determinism Coverage, the north star (§13). **S0–S4** — the Surfacing Ladder rungs (§2). **Wave / Phase** — parallel execution batch / unit of work typed B·T·O·D (§4).

