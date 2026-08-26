# Eden Roadmap — v4.0 Adversarial Edition

**Date:** August 26, 2026 · Supersedes v3.1. This edition folds in the adversarial verification wave (`benchmarks/campaign/`): a positive campaign across six agent domains, a **negative-control campaign across eight regimes where Eden should not help**, and five capacity/degradation probes that broke Eden four times before the fixes landed. Every number below is either gated (paired, counterbalanced, A/A-checked) or labeled modeled. The companion ledger lives in `benchmarks/campaign/README.md`.

---

## 0. Thesis, north star, and method

**Thesis (unchanged):** *The best tool surface is no surface.* Agents should not have to discover Eden, choose Eden, or know Eden exists. Compiled routines are served when behavior matches them; everything else stays invisible. Over time the model only ever sees what is genuinely new.

**North star: Determinism Coverage (DC%)** — the share of production agent tokens executed by approved deterministic paths (compiled, memoized, or transparently served), measured continuously per workspace per day. Instrumented in Arc 1; every other arc must move it or justify itself against it.

**Method (three tiers, enforced everywhere below):**
1. **Positive gates.** Every measurable improvement runs a paired, counterbalanced, replicated benchmark with a clean A/A cell (`bun run bench*`, `benchmarks/campaign/bench-campaign.ts`). WIN or it does not ship.
2. **Negative gates.** *New in v4.* Eight adversarial regimes where Eden should NOT help (non-repeating work, all-judgment stretches, sub-minimum sequences, instant tools, distribution drift, failure storms, concurrent interleaving). Success criterion is **parity within materiality** (+1%); a LOSS fails the exit code. A tool that only benchmarks well on its own home turf is a bias machine, not a product. (`bench-negative.ts`)
3. **Struggle probes.** *New in v4.* Pass/fail correctness under capacity pressure and partial failure — eviction pressure, slack overflow, mid-run timeouts, dead islands, version churn. Exactly-once mutations hold or the probe fails. (`struggle.test.ts`)
4. Every code path obeys the prime directive: a broken Eden never breaks the agent. Default observe; enforcement opt-in; fail-open on every internal error.
5. Nothing goes live without human Approve (Workshop is the only place a tool turns On).
6. Modeled numbers are labeled modeled; measured numbers carry their benchmark file.

### Now / Next / Later

Execution proceeds in **waves** (§4): batches of benchmarking / testing / optimization / debugging phases that run in parallel within a wave and gate each other across waves.

| Horizon | Items |
|---|---|
| **Now — Wave 1** | Noise-floor calibration · suite-wide flake audit · coverage expansion (slow-tool, very-long-session, high-cardinality worlds) · failsafe property-fuzz seedling |
| **Next — Waves 2–3** | Token attribution → certified go-live pipeline → DC% instrumentation (Wave 2 lanes) ∥ compile-quality corpus, miner throughput, `maxGram` auto-tune, variant-tolerant clustering (Wave 3 lanes); wrap idle-path optimization and witness-economics debugging run alongside |
| **Later — Waves 4–8** | Concurrency matrix + multi-tenant arming store · S1 hardening and S1b suppression · cache/memory intelligence · governance export · multi-agent dedupe · production A/B with published negative results |

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
| **S1 · Transparent execution** ⭐ | See §2.1 | 0 tokens, 0 decisions | shipped (read-only; hardening next) |
| **S1b · Remainder suppression** | PreToolUse deny for calls 2..N of an already-served stretch | 0 tokens + short denial reason | next — see business case below |
| **S2 · Skill-native manifest** | SKILL.md bundle; plain `eden.tools.md` fallback | ~25 tok/program, read-once | shipped |
| **S3 · JIT injection** | Exactly one schema appended on matched turns; episode pinning; precision-gated | ≤1 schema on matched turns | wiring shipped; rollout gated |
| **S4 · MCP / hosted adapters** | Capped catalog, meta-tool, hosted dispatch; deferred-loading-compatible | legacy tax | shipped; permanent adapter tier |

**Ladder rules.**
1. Downward-only skipping: S1 silently covers S2's audience; S4 exists so no host is excluded.
2. One selection policy and one receipt format across all rungs.
3. Coverage is measured per workspace *across the ladder*, reported once Arc 1 lands.

**S1b business case (measured this edition).** The campaign's `oblivious-long` scenario — an agent that keeps issuing calls after a steered head returns the full result — shows Eden today costs **+2.8% cents and +3.2% wall** in that regime (island spend with no turn savings). S1b converts those wasted tail calls into suppressions, flipping the regime from loss to break-even-or-win for hosts that expose PreToolUse. No other roadmap item changes the sign of a measured loss; S1b does.

### 2.1 S1 — Transparent execution (spec)

**Flow.** Agent emits its natural loop → PostToolUse fires with `tool_name`, `tool_input`, `tool_response` → hookd records (always) → eligibility check → `/v1/play` executes the approved program (6 s timeout) → response merged: original output first, then `[eden:<program>] The remaining steps of this routine were already served (read-only). Facts: … Do not re-run this routine.` → returned as `updatedToolOutput`.

**Eligibility (fail closed):** plane attests `read_only === true`; sequence ≥2; call matches `sequence[0]`; input passes the witnessed envelope; kill switches `transparent_exec:false` / `EDEN_TRANSPARENT=0`; any error anywhere ⇒ `{ok:true}`.

**Risks & mitigations:** hook-path latency (capped 6 s, falls open); wrong-program serving (envelope + first-step match make it require two coincidences); silent replacement drops (R1 below — shape table + verification).

### 2.2 Research integrated — findings R1–R6

**R1 · Output replacement is shape-strict and silently lossy.** `updatedToolOutput` must mirror the tool's native result shape; mismatches are silently ignored (debug-log only). *Shipped:* Bash-native object form, 9,500-char merge cap. *Roadmap:* shape table + transcript-diff verification + degrade-to-`additionalContext`.

**R2 · One rewriter per matcher** — concurrent PostToolUse rewrites race. *Consequence:* setup owns exactly one managed entry.

**R3 · `additionalContext` always lands** — survives even `decision:"block"`. *Consequence:* guaranteed-delivery degrade path.

**R4 · Agent Skills crossed into shared infrastructure** — SKILL.md read by ~40 products; progressive disclosure; skills marketplaces are now indexing and grading community skills (SkillHub et al.). *Consequence:* S2 emits SKILL.md bundles; skills double as Eden's install surface; marketplace listing becomes a free distribution channel once numbers are publishable (Arc 8).

**R5 · Hook timing budgets** — command hooks default 600 s; PostToolUse timeout keeps tool result; timed-out hooks discarded. *Consequence:* self-caps at 1 s/8 s internally.

**R6 · Prompt-cache fragility is now a documented, common failure class.** Community issue trackers document resume paths breaking the cached prefix on every turn (~3.8K tokens re-billed per resume in Claude Code SDK; block-reordering bugs fixed by third-party interceptors that sustain 98.3% hit rates across 4,700+ intercepted calls). *Consequence:* (a) Eden's alphabetical/stable emission discipline is a moat worth advertising honestly; (b) new Arc 3 candidate: a **cache-guard** mode that normalizes volatile blocks on proxy paths — scoped to Eden-managed sessions first, generalization only if measured.

### 2.3 Surfacing backlog (deliverable-level)

| Item | Deliverables | Done when |
|---|---|---|
| S1 hardening: per-tool shape table | `TOOL_SHAPES` map (Bash done; Read/WebFetch/Glob/Grep/Write follow); unknown ⇒ string form + `additionalContext` duplicate | transcript-diff harness proves sentinel reaches the model on every built-in tool |
| S1 verification harness | scripted headless sessions assert model-visible output contains sentinel | CI job green; catches harness regressions within one release cycle |
| S1b remainder suppression | hookd session state mirroring wrap skipRest semantics (including the matched-calls budget semantics shipped this edition); deny reason cites program | replayed 3-call loop yields 1 real call + 2 suppressions, counted in ledger |
| S1 write-inclusive transparency | Approve-time checkbox + `EDEN_TRANSPARENT_WRITES=1` gate | mutating programs never serve transparently without both |
| S2 skill auto-refresh | Approve regenerates SKILL.md atomically when present | approve → file updated within one drain cycle |
| S2 when_to_use synthesis | island-generated one-liners rendered into manifest/skill entries | entries explain themselves without hand-written copy |
| S3 injection-rate guards | max injections/episode; auto-demote to S0 on poor conversion | telemetry gates enablement automatically |
| S4 hosted dispatch endpoint | POST transcript → ≤1 schema or empty; tenancy-isolated | parity with local JIT precision in shadow |
| S4 deferred-loading compatibility | manifest entries carry `defer_loading` metadata so S4 catalogs light up under Anthropic Tool Search without dual maintenance | one catalog serves both selection policies |

---

## 3. Arcs (work streams)

Arcs are queues, not schedules. Each closes with a `packages/measure` pass; LOSS = fix or roll back. The campaign tiers (§0 method) apply to every arc: positive gates for wins, negative gates for claims of harmlessness, struggle probes for anything touching suppression state.

**Catching scenarios (Wave 1.3).** Every item below names a running fixture in `benchmarks/campaign/ARC-REGRESSION.md`. The map is gated by `benchmarks/campaign/arc-catchers.test.ts` (every table row names a catcher). Product work for these items stays in later waves; Wave 1 only names what would catch a regression.

### Arc 1 — Measurement spine *(feeds every other arc; P0)*

Why first: every other arc claims numbers; this arc makes claims cheap and honest. **And as of this edition, Arc 1 unblocks revenue-relevant behavior: shadow cannot certify island-bearing programs without provider-reported usage (extrapolated tokens are refused by design — "honest numbers or absent"), so until usage attribution lands, ~1 in 5 go-lives installs UNCERTIFIED (simulated-usage path in the campaign harness; production equivalent is "approved but unmeasured").**

| Item | Deliverables | Facts / research anchor | UI/UX integration | Done when |
|---|---|---|---|---|
| Token attribution per run | Receipt fields tagging each turn `compiled`/`memoized`/`transparent`/`steered-skip`/`frontier` | Manus KV-cache spread makes attribution the difference between real and imagined savings | Metric strip gains "deterministic share"; drill-in colors steps by class | Ledger sums exactly to provider-reported usage |
| **Certified go-live pipeline** *(new)* | Wrap `usage.ts` scraper feeds per-run provider tokens into traces; shadow accepts scraped usage, retiring the extrapolated-token objection; UNCERTIFIED badge retires with it | Campaign finding: island programs were INCERTIFIABLE offline; prod integrations already scrape usage (`usage.ts`) — plumb it through | Workshop approval card shows "certified: measured" vs "uncertified" honestly | Campaign `assumeProviderUsage` flag deleted; certification rate ≥95% on campaign worlds without the flag |
| DC% per workspace/day + trend | Nightly aggregation; frozen definition; sparkline | North-star §0 | Metric-strip tile | Reproduces from raw runs by independent script |
| Skip ledger as accounted events | Every steer/suppression/serving/memo-hit/breaker-trip = counted row | Transparency is invisible in-transcript; the ledger is its only witness | Drill-in lists skips inline | Every S1 serving produces a row |
| Novelty feed | Rank uncompiled frequent patterns by wasted tokens | Popularity admission exists; novelty closes the loop | "Needs attention" panel | Top item compiles into a WIN-ing candidate |
| `cached_tokens` parsing | Parse provider cache fields in both dialects | Breakpoints (shipped) make these nonzero | Ledger line "provider cache hit %" | Reconciles with provider console |
| Activation funnel instrumentation | Redacted stage counters install→record→mine→knock→approve→first serving | Silent breakage killed funnels before | Internal | Each stage names its fix |

### Arc 2 — Zero-friction onboarding *(P0)*

Unchanged from v3.1 (single supervised daemon, first-stretch knock focus, honesty loop, doctor expansion, lane discipline, in-terminal approvals, `eden explain`, approval diff cards). New input from the campaign: the **honesty loop gains a "why didn't anything compile?" diagnosis set drawn from measured refusal causes** — sequence entropy too high (noise-world parity proves nothing was lost), repeats below support 3 (micro-world), width classes split (orders-world lesson: same-shape support needs ≥3), envelope coverage gaps (drift-world lesson). Each diagnosis names the exact count that fell short, because every one of those thresholds is now pinned by a campaign fixture.

### Arc 3 — Trajectory memoization & cache intelligence

Foundation shipped (ETag envelopes, public pool, scored warming). Remaining from v3.1: exact-key run cache, parameterized memoization, admission control, compression at rest, run single-flight, self-tuning TTLs. **New candidates from this edition's research:**

| Item | Deliverables | Facts / anchor | Done when |
|---|---|---|---|
| Cache-guard mode *(new)* | Proxy-path normalization of volatile prefix blocks (skill listings, timestamps) on Eden-managed sessions; opt-in | Community interceptors sustain 98.3% cache-hit on resumed sessions by relocating reordered blocks; upstream bugs re-bill ~3.8K tokens/turn | Measured hit-rate delta on replayed sessions; upstream fix ships → retire gracefully |
| PTC-complement emission *(new)* | When a host exposes code execution, emit compiled programs as callable functions (`allowed_callers`) so approved routines compose into PTC scripts | PTC cuts 38% billed input on fan-out shapes but costs 8% more on sequential reasoning — exactly where Eden's linear programs win; composition covers both | Fixture: approved program invoked from PTC script; receipts identical |

### Arc 4 — Envelope & island graduation

Thesis unchanged: convert fail-closed refusals from a wall into a gradient. **New items forced by measured certification failures this edition:**

| Item | Deliverables | Measured anchor | Done when |
|---|---|---|---|
| Witness-efficiency pipeline *(new)* | Go-live today needs ~13 witnesses (≥3 same-shape in training + 3 held out inside the envelope; sloppy variants dilute clusters below support). Deliverables: variant-tolerant clustering (variants vote for sequence but not envelope), rolling shadow (hold-out refreshes as receipts arrive instead of a fixed split), width-class envelope inheritance (a certified width-class extends its envelope to sibling widths after K clean live receipts) | Campaign: go-live SKIP/INCONCLUSIVE in 3/14 soak rounds and multiple campaign cells traced to exactly these three mechanisms | Campaign worlds certify at ≤8 witnesses with zero UNCERTIFIED inflation; soak certification ≥95% |
| Width-class envelope generalization *(new)* | Fan-out widths legitimately vary per entity; a program mined at width 10 should serve width 7 after supervised confirmation rather than falling back raw | orders/drift worlds: novel-width goals fall back raw despite identical shape | Drift scenario turns WIN at higher margin; OOD scenario narrows |
| Integration guidance: read-set exposure *(new)* | Documented pattern for SDK integrations: tools whose result includes the exact array a later loop will iterate (grepCode lesson: 12 hits returned, 6 read → loop unbindable) | research world compile failure reproduced and fixed in fixture | Guide published in SDK docs; miner warns on near-miss binding failures |
| Remaining v3.1 items | Witness-seeded islands · stability scoring · graduation proposals · zero-LLM badge · soft-match tier · refusal analytics · envelope editor · graduated rollout | unchanged | unchanged |

### Arc 5 — Governance, trust, compliance

Pieces shipped: drift fingerprints, deopt ledger, shadow measure. **Struggle probes are the first installment of the failsafe suite**: five pass/fail correctness probes covering eviction pressure, slack overflow, mid-run timeouts, dead islands, version churn — all born red, now green, kept forever. Remaining v3.1 items stand (fuzz suite scales the probes to property-tested fault seeds; drift auto-refresh; read-your-writes; canary deploys; bit-exact replay; audit export; retention surfaces; data-isolation page; SOC2 groundwork). New regulatory anchors (see §5.3): EU AI Act high-risk obligations enforceable since Aug 2, 2026 put the tool-calling layer squarely in scope for logging/human-oversight; NIST AI-agent interoperability profile expected Q4 2026; OWASP MCP Top 10 published. Consequence: the immutable audit export and data-isolation page move from Later toward Now — they are becoming compliance checkboxes buyers literally tick, and Eden's human-gate architecture is already the harder half.

### Arc 6 — Runtime depth

All v3.1 items stand (turn-boundary speculation, connection amortization, watch-time warming, first-wave streaming, island-miss batching, negative-space compilation, loop-breaker upgrades, budget forecasting, densify v2, scheduled programs, webhook invalidation, fork mining completion, program composition). **New from this edition:**

| Item | Deliverables | Anchor | Done when |
|---|---|---|---|
| Multi-tenant arming story *(new)* | The suppression map is bounded per wrapped surface (64 entries; capacity gate fails new stretches open beyond it — correct for single agents, a throughput ceiling for hosted multi-tenant dispatch). Deliverables: shared-memory or partitioned arming store keyed by session, load-tested at W≥100 concurrent stretches | Struggle P1: correctness now provable at 80; hosted dispatch needs it at 10× | Zero duplicate writes at W=100 on the probe harness; p50 steering latency flat |
| Concurrent-regime regression gate *(new)* | The interleaved-stretch scenario graduates from campaign to CI gate (it caught A1–A4) | concurrent scenario: 6.67× turns, zero duplicates | Runs on every wrap change; any violation blocks merge |

### Arc 7 — Multi-agent (W15)

v3.1 items stand (parent/child runs, shared-fetch dedupe, handoff compilation, org view, regional deployment, protocol negotiation, archival tiers). New evidence this edition: the concurrent-regime probes prove the suppression machinery survives overlapping goals on ONE surface — which is the primitive cross-agent dedupe needs. Sequencing note: Arc 7's shared-fetch dedupe should reuse the matched-calls budget semantics shipped in A4, not invent parallel machinery.

### Arc 8 — Proof to the market

v3.1 items stand (production A/B, whitepaper, case studies, digest). **Addition: the negative-control table publishes alongside the wins.** In a market where 88% of agent projects die before production and vendor ceilings (92.8%, 98.7%) are the default marketing language, publishing "here are the eight regimes where we measurably do nothing, and here is what our recording costs per call" is the cheapest trust available anywhere in this category. The whitepaper gets a parity section with the same rigor as the win section.

---

## 4. Execution waves — benchmarking, testing, optimization, debugging

**Eight waves, 32 phases. The invariant: within a wave, every phase is fully parallel — zero inter-phase dependencies, zero shared merge points that gate execution, disjoint surfaces or an explicit ownership split.** Where two pieces of work were sequentially coupled (attribution→certification, cache→compression, dedupe→attribution), they are merged into one phase with one owner rather than left as a hidden chain. Cross-wave gates exist and are shown in §4.10; inside a wave, work never waits.

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
| 5.2 S1b remainder suppression | B+T+O | hookd session state mirroring matched-calls budget semantics; PreToolUse deny cites program; ledger rows counted | Oblivious-regime scenario flips from measured −2.8% cents to ≥break-even through a real headless host; suppressions counted |
| 5.3 S2 skill refresh + marketplace prep | T | Atomic SKILL.md regeneration on Approve; listing draft withheld until Arc 8 numbers publish | Refresh within one drain cycle; content-hash logged; no public listing yet |
| 5.4 Negative-control rotation | B | Derive one NEW adversarial world from this wave's surface (e.g., a host that drops `updatedToolOutput` silently mid-session — R1 class) and add it to `bench-negative.ts` | New regime passes at parity; joins the permanent rotation |

Parallelism: fully parallel — 5.1/5.2 own different hook events (Post vs Pre) and coordinate only through the documented session-state shape, which is a typed contract, not a meeting; 5.3/5.4 independent.

### Wave 6 — Cache, memory & governance *(Arcs 3+5)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 6.1 Run cache: exact-key, admission, compressed envelopes | B+O | Envelope+params keyed read-cache; frequency-predicted writes; hit-rate telemetry day one; gzip+base64 envelope bodies >2KB (one envelope revision carries both) | Hit-rate reported from first run; write volume −X% with hit-rate loss <1pt on replays; size −30% with read-latency tax <10%; mutating steps disqualified (test-pinned) |
| 6.2 Drift auto-refresh pipeline | B+D | Canary drift → re-mine → shadow-compare → approval card; forced-upstream-rename fixture | Card approvable with zero manual mining on fixture |
| 6.3 Fuzz suite scale-up | T | Wave-1 seedling to 10k fault seeds × both schedulers; divergences = pinned bugs | 10k seeds, zero unexplained divergences |
| 6.4 Audit export + isolation truth page | T | JSONL/CSV export (approvals, versions, executions, refusals), tamper-evident; isolation claims each linked to code/test | Round-trip parses; EU-AI-Act-aligned logging story documented truthfully |

Parallelism: fully parallel — four disjoint surfaces (cache/playback, drift pipeline, probes, site export).

### Wave 7 — Multi-agent & hosted scale *(Arc 7)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 7.1 Fleet runs: cross-agent dedupe + parent/child attribution | B+T | Memo-store backed cross-agent claims reusing matched-calls semantics; trace tree with per-agent attribution; fleet-wide DC%; public pool already ships the unauthenticated slice | Duplicate fetches vanish under concurrent-agent replay ("shared across N agents" in ledger); attribution matches orchestrator spans on fixtures |
| 7.2 Hosted dispatch load-probe extension & anomaly forensics | T+D | Struggle probes against the multi-tenant store at W≥100 (from Wave 4) plus protocol-negotiation skew cases; any anomaly traced to root cause with pinned repro before the next probe round | Probes green at target tenancy; skew handled gracefully; zero unpinned anomalies open |
| 7.3 Handoff compilation spike | B | Repeated agent→agent patterns → composed program candidates; approve-gated | One composed handoff approved on fixtures |

Parallelism: fully parallel — 7.1 is runtime+site, 7.2 is probe harness, 7.3 is compile-side.

### Wave 8 — Proof to the market *(Arc 8 close-out)*

| Phase | Type | Deliverables | Done when |
|---|---|---|---|
| 8.1 Production A/B | B | The budgeted paired live study; every public claim cites it; claims that fail get retired publicly | Study published or claim retired — both count as done |
| 8.2 Whitepaper incl. negative results | B | Methodology, win table, **parity table**, limits section (OOD, oblivious agents, certification bounds) | Nothing public without methodology behind it |
| 8.3 Case studies | B | Customer-approved measured numbers only, one per vertical | Each links methodology |
| 8.4 Weekly digest | T | DC trend + savings + novelty items; mirrors dashboard exactly; opt-in | Honest zeros preserved in email |

### 4.9 Anti-overfit machinery (applies to every wave)

1. **Rotation obligation.** Each wave derives at least one new world/scenario from a source that did not inform the previous wave's tuning (production traces, failure reports, or a harness behavior class). A scenario may be a primary tuning target at most once; afterwards it is measurement-only.
2. **Pre-registered expectations.** Every scenario records its expected verdict *before* the run (`expect:` field already in the harness). Post-hoc expectation edits are logged, never silent.
3. **Hold-out alternation.** Tuning may target training worlds; the alternating world-set stays untouched until the wave closes, then swaps in.
4. **Materiality thresholds are registered once** (±1% for negative controls; MDE printed for everything else) and never adjusted after seeing a result.
5. **Determinism disclosure.** Simulator metrics (turn counts) are arithmetic, not statistics; only wall-clock carries sampling weight, and the A/A cells police it. Any quoted number states which kind it is.
6. **Red-team round per wave.** One session per wave explicitly tries to break the newest code the way the struggle probes did (they found four real bugs on their first firing) — findings feed either fixes or the pruned list, both of which are progress.

### 4.10 Dependency sketch (cross-wave only — inside a wave, nothing waits)

```
W1 ──► W2 ──► W5 ──► W8
 │      ▲
 │      └──► W6 ──► W8
 └──► W3 ──► W4 ──► W7 ──► W8
```

W1 gates everything (an uncalibrated instrument invalidates all claims). W2/W3 start in parallel after W1 (different surfaces: wrap/site vs compile). W4 consumes W3's corpus findings; W5 consumes W2's attribution (S1b's business case is measured in cents); W6 is independent of W3–W5 after W1; W7 consumes W4's multi-tenant store; W8 last. Two lanes persist throughout: a **wrap/runtime lane** (W2→W5→W7) and a **compile/mining lane** (W3→W4), so two teams never touch the same files in the same wave.

### 4.11 Modeled timeline *(labeled MODELED — sensitivity ±40% for staffing)*

Assumes two persistent lanes (wrap/runtime, compile/mining) plus one shared site/infra engineer, full-time. Waves are gates, not dates: a wave closes when its done-when criteria hold, not when the calendar says so.

| Wave | Modeled duration | Wall-clock if lanes run concurrently |
|---|---|---|
| W1 calibration & coverage | 2 wks | 2 wks (all phases parallel) |
| W2 measurement spine ∥ W3 compiler depth | 3 wks each | 3 wks total (lanes overlap) |
| W4 capacity ∥ W5 ladder hardening | 3 wks each | 3 wks total |
| W6 cache/governance ∥ W7 multi-agent | 4 wks each | 4 wks total |
| W8 proof to market | 4 wks | 4 wks (A/B needs live traffic time regardless) |
| **Total modeled** | | **~16 weeks** |

Critical path: W1 → W2 → W5 → W8 (the wrap lane carries S1b, whose business case is measured). The compile lane (W3→W4→W7) has ~3 weeks of slack against it — slack absorbs the debugging phases, which historically run over exactly once per wave (the struggle probes found four bugs on first firing; budget one such round per wave).


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
| `PostToolBatch` fires after parallel batch resolves | SDK reference | Batch-level suppression point (Arc 6) |
| Skills: SKILL.md open spec, ~40 products, progressive disclosure; marketplace indexers now grade skills | Ecosystem scan | S2 SKILL.md; marketplace distribution channel post-Arc 8 |
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
2. **NEGATIVE gates (new).** Eight adversarial regimes assert parity-within-materiality (+1%). Any regime where Eden claims harmlessness must carry a negative control, or the claim doesn't ship. Losses inside the band are printed as measured overhead, never silently dropped.
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
| Wrapped idle call overhead | ≤12 µs/call | ~31–37 µs → Wave 2.4 | idle micro-bench (Wave 2) |
| Steering decision p99 | <1 ms | not yet instrumented → Wave 4.3 | concurrency matrix |
| `compileTraces` on 500 traces | ≤2 s | not yet measured → Wave 3.2 | corpus CI job |
| Transparent serving added latency | ≤6 s ceiling, falls open on breach (harness keeps original output) | capped in code (`EDEN_TRANSPARENT_MS`) | S1 verification harness |
| Receipt `server_ms` | no regression wave-over-wave | playback benches | site suite |
| Soak heap drift | flat under forced GC (±15% band mid→late) | −33% observed (improving) | `soak.ts` exit code |
| Cache read-latency tax from compression | <10% vs uncompressed | n/a yet → Wave 6.1 | cache tests |
| Suite wall time | <5 min full suite (flake-audit runs may exceed) | ~184s | flake audit |

---

## 11. Threat model & security plan

STRIDE-lite over Eden's four surfaces. Existing mitigations cite their tests; planned items cite their wave.

| Surface | Threat | Existing control (+test) | Planned |
|---|---|---|---|
| Hook channel (agent ↔ hookd) | Injection via crafted tool output into sentinel/facts blocks; oversized payloads corrupting merges | 9,500-char cap; native-shape merging; hostile-payload tests (unicode, nesting, prototype pollution) | Facts rendered through a single escaping builder (S1 hardening); fuzz seeds include adversarial outputs |
| Control plane API | Cross-tenant reads/writes; auth bypass | Tenant-bound writes, auth UX, migration tests in site suite; ETag envelopes tenant-keyed | Immutable audit export (6.5); access-review exports |
| Public result pool | Cross-tenant contamination; cache poisoning via shared keys | Triple gate: host allowlist AND credential-free AND GET-ok; isolation tests provable | Pool allowlist review cadence; poisoning probes added to struggle tier |
| Island caller | Prompt injection through witnessed inputs; secret exfiltration via drafted text | Memo key covers input; witness-memo requires two agreeing outputs; redaction at record time (`redact.ts`, redact-regression tests) | Island stability scoring flags divergent glue (Arc 4); ZDR guidance doc for PTC/island paths |
| Egress (fetch steps) | SSRF via bound URLs; credential leakage to third parties | SSRF egress checks (site suite); credential-free gating for public pool | `EDEN_NET_ALLOW` allowlist audit in doctor; OWASP MCP Top 10 mapping page |
| Suppression state | Duplicate/dropped mutations under concurrency or failure | Struggle probes P1–P5; oblivious tests; partial-match + matched-calls semantics | Concurrency matrix as CI gate (Wave 4.1) |

Non-goal reminder: credential vaults remain out (§7); the public pool's credential-free gate exists precisely so no credentials ever touch shared infrastructure.

---

## 12. Compatibility & support matrix

| Host / integration | Install (recording) | S0 silent | S1 transparent | S1b suppression | S2 skills | S3 JIT | S4 MCP | Notes |
|---|---|---|---|---|---|---|---|---|
| Claude Code | ✓ managed hooks | ✓ | ✓ shipped (read-only) | next (PreToolUse) | ✓ SKILL.md | wiring shipped | ✓ stdio | Reference host; every ladder rung proves here first |
| OpenCode | ✓ plugin module | ✓ | partial* | via plugins when events exist | ✓ | gated | ✓ | *plugin event surface differs; degrade path applies |
| Codex CLI | ✓ TOML section | ✓ | partial* | — | ✓ | gated | ✓ | marker-based idempotent installer |
| Gemini CLI | ✓ settings write | ✓ | partial* | — | ✓ | gated | ✓ | as above |
| Cursor / Windsurf / Cline | manual skills copy | — | — | — | ✓ | — | ✓ | skills-only tier until hook surfaces exist |
| Generic MCP hosts | — | — | — | — | — | — | ✓ hosted dispatch | permanent adapter tier; deferred-loading metadata planned (§2.3) |
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
| failsafe-fuzz | probe | 1,000 generated programs × faults | Eden-absent-equivalent mutations | `failsafe-fuzz.test.ts` |
| P1b W=100 | probe | 100 concurrent distinct inputs | fail-open past 64; zero duplicate writes | `struggle.test.ts` |
| noise-floor | calibration | A/A wall_ms per scenario | MDE @ n=8/12/16 + stability | `calibrate.ts` / `NOISE-FLOOR.md` |
| flake-audit | calibration | shuffled suite + clock jump ±30% + load | 20 consecutive green | `scripts/flake-audit.sh` |

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
| `EDEN_TIMEOUT_MS` (60s) / `EDEN_TRANSPARENT_MS` (6s) | as stated | compiled-run / serving ceilings | timeout defaults justified by Wave 4.4 data |
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

---

## 17. Glossary

**Stretch** — one agent goal-execution: the ordered tool calls serving a single intent. **Compiled tool / program** — an Approved deterministic routine mined from witnessed stretches. **Witness** — a recorded stretch that evidence-trained a program; also bounds the envelope. **Envelope** — the witnessed input-value distribution a program accepts (`inDistribution`). **Island** — a judgment step executed by a cheap model inside a program; graduates to code when stable. **Arming** — runtime record that a stretch's tail is being served, absorbing sibling raw calls. **Steered-skip** — a raw call suppressed because a compiled run performed its work. **Deopt** — structured bail-out carrying exactly what ran (`toolCalls`); replay-safe iff nothing ran. **Shadow** — sandboxed replay validation of a candidate against held-out witnesses. **UNCERTIFIED** — live program whose savings rest on extrapolated island tokens (retires with Arc 1). **DC%** — Determinism Coverage, the north star (§13). **S0–S4** — the Surfacing Ladder rungs (§2). **Wave / Phase** — parallel execution batch / unit of work typed B·T·O·D (§4).

