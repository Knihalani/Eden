# Competitive Report: ReasonBlocks vs. Eden

**Date:** August 25, 2026
**Scope:** Full teardown of ReasonBlocks (YC Spring 2026), overlap analysis with Eden's compiled-tools platform, and a prioritized plan to use these findings to improve product and demand.

---

## 0. Executive Summary

ReasonBlocks is the closest strategic competitor Eden has encountered to date — closer than any observability vendor (Laminar, LangSmith, Raindrop) ever was. They are a **2-person, YC-backed (Spring 2026, $500K, partner: Aaron Epstein)** San Francisco company building a **runtime layer that makes AI agents cheaper and more reliable**, founded by Sajeev Magesh (ex-Stanford) and Rohan Vij (ex-CMU), who have built together for 11 years.

Their pitch — *"Most production agent failures are repeats: same loops, same dead ends, same wasted tokens"* — is **Eden's exact problem statement**. Their claimed results: **52% token reduction, 42% accuracy lift, 24% latency reduction on SWE-bench Pro** (paired runs, Claude Sonnet/Opus), plus **70% fewer budget cap-hits**.

The critical finding: **ReasonBlocks is converging toward Eden's thesis from the probabilistic side.** They launched (April–Aug 2026) with soft pattern injection — retrieving past reasoning traces and injecting them as hints. Their current docs (`docs.reasonblocks.com`) describe a newer direction: mining golden traces, training a **task-specific cheaper model per tenant**, and **relegation routing** (cheap model first, frontier fallback). That is structurally the same idea as Eden's record → compile → serve-cheaper-path loop, implemented with fine-tuning instead of deterministic compilation.

**Eden retains real, defensible advantages:** determinism (compiled programs vs. injected hints), the human Approve gate, fail-closed input envelopes, honest measured benchmarks, and MCP-native serving. **ReasonBlocks currently wins on distribution, onboarding friction, marketing firepower, and speed.** They got a Forbes feature, a polished site with live animated demos, one-env-var integration, a LangChain middleware SDK, and headline benchmark numbers — all before Eden has shipped pricing or published its own benchmark page.

The report below details their product, architecture, benchmarks, and GTM; maps overlap head-to-head; identifies their exploitable weaknesses; and closes with a prioritized roadmap (Section 8) of what to build, say, and ship to take Eden to the next level.

---

## 1. Company Profile

| Attribute | Detail |
|---|---|
| Name | ReasonBlocks (YC P26) |
| Founded | 2026 |
| HQ | San Francisco, CA |
| Founders | Sajeev Magesh (CEO, ex-Stanford CS, ML×agriculture research, UN Best Paper) · Rohan Vij (CTO, CMU Information Systems + AI, ENGIE distributed energy, UC Davis IoT research) |
| Team size | 2–3 |
| Funding | $500K (Y Combinator, Spring 2026). Pre-seed. No other rounds tracked. |
| YC partner | Aaron Epstein |
| Positioning v1 (Apr 2026) | "The reasoning reuse layer for AI agents" |
| Positioning v2 (current) | "The runtime layer that makes AI agents cheaper and more reliable"; Rohan's LinkedIn now says "the token efficiency layer for AI agents" |
| Target buyers | Teams running **vertical AI agents at scale: legal, finance, healthcare, security, research** — plus coding-agent users (SWE-bench focus) |
| Business model | Usage-based; **no public pricing, no self-serve free tier, no trial** — contact-sales via Cal.com booking |
| Traction signals | Launch YC post (~23 upvotes), Forbes mention (June 2026, "most promising YC companies in the batch"), ~400 LinkedIn followers, listed by multiple tracker/review sites. Third-party "agent readiness" score: 35/100 (no MCP server, no public API, no webhooks, no OAuth as of review date) |

**Assessment:** tiny, early, but extremely fast-moving with strong founder narrative ("11 years building together since 2nd grade") and YC-grade distribution. Their third-party readiness score (35/100) suggests the product surface is thinner than the marketing — which is exactly the gap Eden can attack.

---

## 2. Product Teardown

### 2.1 What they launched with (April 2026)

A runtime/SDK doing three things:

1. **Catch failures mid-run** — six monitors watch every agent call for loops, redundant work, second-guessing; when one fires, a corrective hint is injected *before* more tokens burn.
2. **Compress what doesn't matter** — stale tool outputs and redundant context cut from message history automatically.
3. **Capture every lesson into a private "reasoning library"** — after each run, extract what worked; match and inject patterns into future runs automatically.

Narrative: *"Your 10,000th run is smarter than your 1st."* Gains compound across runs.

### 2.2 The six marketed capabilities

1. **Reasoning reuse** — embedding retrieval over a trace library (site demo claims "190k traces indexed"); surfaces past solutions when a similar problem returns; **the LLM keeps judgment** on whether to use it.
2. **Semantic file memory** — semantic index of files ("218 files indexed"); recalls what a file *means* without re-reading bytes ("27kb saved").
3. **Loop detection** — sliding-window monitor (e.g., 6 turns); detects doom loops mid-run and injects a redirect, sometimes pointing at a matched resolved run.
4. **Tool supervision** — flags redundant fetches/searches still in-context ("work with what you have").
5. **Context compression** — folds older turns into summaries ("18 turns folded, 74% less context").
6. **Reasoning-aware context pruning** (preview) — logic-based pruning vs. semantic pruning.

### 2.3 What their docs show today (the important part)

The current docs homepage describes a materially evolved — and much more Eden-like — product:

> "Set one environment variable, capture your agent's workflow, and **train a cheaper task-specific model** with automatic fallback to your frontier model when coverage runs out."

Pipeline:

1. **Route traffic through their hosted gateway**: `export ANTHROPIC_BASE_URL="https://gateway.<tenant>.reasonblocks.com"` — byte-transparent, **fail-open**, pass-through of your own API key. Multi-provider endpoint compatibility (Anthropic, OpenAI, Gemini paths).
2. **Trace reconstruction** — raw traffic rebuilt into verified runs on hosted storage; steps ordered, tool calls paired to results, injected corrections identified structurally. Runs labeled **golden** (complete, no violations) or not. Only golden runs are minable. *"Completeness is proven, not assumed."*
3. **Policy mining from golden traces** — tool vocabulary, helper scripts, flat (state → action) pairs extracted from your traffic, not hand-configured. Mining starts automatically when enough golden traces accumulate.
4. **Task-specific model training** — hosted pipeline fine-tunes a smaller model per tenant on their workflow. Opt-in, tenant-scoped weights.
5. **Relegation routing** — gateway routes to the cheaper model first; falls back to frontier on low coverage; fallback episodes become new training signal.

Plus engineering discipline worth noting: action validation against mined vocabularies, whole-action rejection sampling, spend ceilings on training jobs, a self-hosting appendix, and Tier A/B/C client-integration depth options.

### 2.4 Integration surface

- **One env var** (`ANTHROPIC_BASE_URL` swap) — zero code changes.
- **Python SDK with framework middleware**: literally `rb.middleware(agent_name=...)` dropped into LangChain's `create_agent(middleware=[...])`; `TokenSavingMiddleware`, `GeneralMonitorMiddleware` with rule packs (`pack="v1"`), configurable verify/submit tool sets.
- Built-in **A/B evaluation harness** (`mw.arm = "on"/"off"`) producing per-arm cost/accuracy reports.

### 2.5 Benchmarks & claims (with critique)

Two published bodies of evidence:

**A. Whitepaper v2.0** — SWE-bench **Verified**, 50 problems, Haiku/Sonnet/Opus, paired runs, results reported **only on "high-confidence matches"** (~40–75% match rate):

| Model | Baseline | +RB | Gain |
|---|---|---|---|
| Haiku | 60% | 75% | +25% |
| Sonnet | 75% | 80% | +6.7% |
| Opus | 70% | 90% | +28.6% |

Token savings 21–25% average (up to 62% peak on Opus). Pattern format: **Format D** — situation / dead ends explored / unlock — selected as highest-signal injection format. Critically, the whitepaper says the pattern library is **collective**: *"patterns that work for one team's agents improve results for everyone on the platform."*

**B. SWE-bench Pro paired study** (n=75, claude-sonnet-4-6, Docker grading, same task IDs both arms):

| Arm | Pass rate | Mean input tokens | Delta |
|---|---|---|---|
| Baseline | 25.3% | 1,257,316 | — |
| TokenSavingMiddleware | 25.4% | 606,212 | **−51.8% tokens, flat accuracy** |
| + general monitor | 36.0% | 1,136,946 | +10.7pp accuracy, −9.6% tokens |

Marketing headlines ("52% token reduction, 42% accuracy lift") splice these two arms together. Cost-model example: ~$7K/month saved at 10k Opus tasks/month.

**Methodological soft spots (useful to know, useful to say carefully):**
- Headline numbers mix two different experimental setups; the −52% arm explicitly has *flat* accuracy.
- Whitepaper reports only on high-confidence-match subsets (selection effect).
- Small n (50–75 problems), single-domain (Python repos).
- Accuracy gains are relative percentages off small bases (+6.7% on Sonnet = +5pp).
- The shared/collective library claim in the whitepaper **contradicts** the launch-post claim "**Your library is yours**, private" and the LinkedIn copy. This is their most attackable inconsistency.

---

## 3. Architecture Comparison

| Dimension | Eden | ReasonBlocks |
|---|---|---|
| Core unit of reuse | **Compiled StretchProgram** — deterministic IR (tool/island/loop/assert/branch), version-hashed, contract-declared | Soft **reasoning patterns** (Format D text hints) injected into prompts; moving toward **fine-tuned task models** |
| Who decides to reuse | Deterministic steering + witnessed input envelopes (**fail closed** — refuses out-of-distribution inputs) | Embedding similarity match; **LLM keeps judgment** (probabilistic, can ignore or misuse) |
| Human control | Central ritual: nothing goes live without browser **Approve**; keys never turn tools on | None marketed; corrections auto-injected; training opt-in |
| Runtime intervention point | Local proxy on the tool/model path (`eden wrap`, OpenAI + Anthropic dialects, SSE re-framing) | Hosted gateway via base-URL swap + in-process LangChain middleware |
| Failure posture | "A broken Eden never breaks your agent" — pinned failsafe tests, observe-mode default | Gateway explicitly **fail-open** (traffic flows if capture breaks) |
| Waste detection | Signals: repeat_ngram, repeat_visits, low_gain, fail_streak breaker, budget halt, evidence ledger, EDEN_MAX_STEPS; W1–W21 taxonomy | Six monitors: loop detection, tool supervision, verification-skip, etc. (v1 rule pack) |
| Context reduction | **Densification** — lossless columnar compaction with model-facing facts receipt (provably lossless) | Summarization-based folding (lossy by construction; "74% less context") |
| Serving | Hosted **MCP server** (batch fan-out, KV-cache-friendly alphabetical emission, ≤6 tools cap) | No MCP server (per third-party audit); gateway routing instead |
| Cheap-compute lane | **Islands**: gpt-5.6-luna @ temp 0 as semantic glue inside deterministic programs | Fine-tuned per-tenant small model with frontier fallback ("relegation routing") |
| Data boundary | Tenant-scoped; redaction enforced server-side at every ingest boundary | Ambiguous — launch copy says private; whitepaper says collective library improves everyone |
| Measurement | Shadow counterfactual ship gate; gated benchmark suite (paired, counterbalanced, replicated, A/A-checked); "honest numbers or absent" | Paired A/B arms with per-arm reports (good!) but headline splicing + subset reporting (weak) |
| Verification of reuse candidates | Witnessed envelopes, contract strip (reads/writes/auth declared) | Confidence gate (threshold undisclosed) |
| Stack | TypeScript/Bun monorepo; Next.js ×2; Neon Postgres; Vercel; Clerk | Python SDK; hosted multi-tenant gateway; hosted training pipeline |

**Net read:** Eden's stack is deeper and more defensible (determinism, approval, lossless compression, MCP). ReasonBlocks' stack is shallower but wrapped in a smoother, lower-friction adoption path.

---

## 4. Where We Compete Head-to-Head

### Direct collisions
1. **Waste detection & interruption.** Eden's guard signals ≈ RB's monitor pack. Both catch loops/redundancy mid-run. RB injects LLM-written hints; Eden warns/steers/halts with circuit breakers. Near-parity; RB markets it better.
2. **Proxy/gateway position.** `eden wrap` vs. their base-URL gateway. Same interception point, same "no agent code changes" goal — theirs requires less setup.
3. **Context/token reduction.** Densification vs. summarization compression. Eden is lossless (a provable claim RB cannot make); RB claims bigger headline numbers because lossy compression compresses more.
4. **Reuse of past successful runs.** This is the heart of it. Eden: compile → approve → serve deterministic tool over MCP. RB: retrieve similar trace → inject hint (now: distill into a fine-tuned model). Two answers to the same question: *"should the 10,000th run pay frontier prices to re-derive the 1st run's answer?"*
5. **Coding agents as beachhead.** They benchmark on SWE-bench and target coding agents; Eden records Claude Code via hooks. Same entry market.
6. **Budget protection.** Their "70% fewer budget cap-hits" ≈ Eden's budget halt + fail_streak breaker.

### Non-overlaps (today)
- Eden-only: human Approve gate, MCP tool serving, canvas graph editor, shadow ship gate, laptop runner for fs/docker, exactly-once mutation guarantees, evidence ledger, drift fingerprints (partial).
- RB-only: fine-tuned task models + relegation routing, semantic file memory, LangChain middleware distribution, collective cross-tenant pattern library, hosted A/B eval reports.

### Strategic threat level: **HIGH and rising**
They are validating Eden's category with YC money and mainstream press. If "runtime layers for cheaper agents" becomes a funded category with RB as the named player, Eden fights for definition of the category. But their convergence toward distillation also validates Eden's originality — and leaves the *deterministic, approved, inspectable* flank wide open.

---

## 5. Their Strengths (what's genuinely good)

1. **Frictionless onboarding.** One env var → value in minutes. Eden needs CLI install, hooks config, wrapping. This is the single biggest demand-side gap.
2. **Distribution where agents already are.** LangChain/LangGraph middleware means their logo sits in the exact dependency list of the target user. Zero new mental model.
3. **Benchmark-led marketing.** Public benchmark + whitepaper page + big numbers + live animated site demos. Buyers see "$3.39 → $1.63 per run" instantly. Eden has better internal benchmarks (gated, counterbalanced) that nobody outside the repo can see.
4. **Compounding narrative.** "Your agent gets smarter with every run" is emotionally sticky and board-explainable. "More deterministic" is safer but colder.
5. **Founder brand & velocity.** YC badge, Forbes feature, coherent founder mythos, weekly-ish cadence of positioning refinement (three distinct one-liners in four months — they iterate messaging aggressively).
6. **Sound engineering instincts.** Golden-run completeness proofs, rejection sampling on whole actions, spend ceilings, fail-open gateway, self-hosting appendix. For 2 people, this is disciplined infrastructure thinking — do not underestimate them.

---

## 6. Their Weaknesses (Eden's openings)

1. **Probabilistic reuse is fundamentally un-inspectable.** An injected hint can be wrong, stale, or actively harmful; there is no contract, no version hash, no approval, no audit trail. Every buyer in their stated target verticals (legal, finance, healthcare) has compliance officers who will ask *"who approved this change in behavior?"* — and RB has no answer. Eden's entire approval/contract/evidence-ledger design is the answer.
2. **The privacy contradiction.** Launch post: "your library is yours." Whitepaper: "patterns that work for one team's agents improve results for everyone." If a competitor or skeptical customer notices (it took one search), trust takes a real hit. Eden can make tenant isolation + redaction a loud, provable headline.
3. **Lossy compression without receipts.** Summarization folding can silently drop the fact that mattered (their own site demo celebrates dropping a 47k→12k fold — the "small words" example shows they know detail matters). Eden's densification is lossless with facts receipts — a provable superiority that is currently invisible.
4. **No MCP strategy.** Third-party audits note no MCP server, no webhooks, no OAuth. The agent ecosystem standard is MCP; Eden is MCP-native.
5. **Thin product surface behind the marketing.** 35/100 agent-readiness score; no public API; contact-sales-only pricing with no trial. Developers can't kick the tires — a self-serve Eden free tier wins the bottom-up motion by default.
6. **Benchmark hygiene.** Subset-reported gains, spliced headline arms, small n. Eden's gated, counterbalanced, A/A-checked methodology — once published — can own the "numbers you can actually trust" position *while still showing big numbers*, capturing both credibility and excitement.
7. **Training-data cold start.** Distillation needs "a few dozen recorded sessions" per task and GPU pipeline latency. Eden compiles from a handful of recorded stretches with no training run at all — instant value, zero GPU cost, no weights to govern.
8. **Multi-agent blind spot.** Like nearly everyone, they don't address W15-class multi-agent waste. Whoever cracks it first owns a fresh sub-category.

---

## 7. Lessons: What Eden Should Steal

1. **The env-var onboarding bar.** Time-to-first-value must approach zero. Eden's equivalent: `npx eden init` detecting Claude Code / OpenAI-compatible clients, installing hooks, starting the proxy, and printing "recording — run your agent normally." Also support pure base-URL-swap mode of `eden wrap` so any app that accepts a custom base URL gets recording+steering with zero code.
2. **Middleware as a distribution channel.** Ship `eden-middleware` packages (LangChain/LangGraph middleware mirroring `rb.middleware()`, plus OpenAI Agents SDK and Vercel AI SDK adapters) so Eden appears in the same dependency lists. The Python SDK skeleton already exists (`packages/sdk-py`).
3. **Benchmark page as a marketing weapon.** Publish a whitepaper-style page: methodology, paired arms, per-model tables, limitations section (honesty *is* the differentiator — copy their format, exceed their rigor). Run the already-budgeted ~$1.1K live A/B production benchmark to add real-world numbers. Lead with one sticky stat pair, e.g. "8× fewer LLM calls, 86% less spend on runaway loops — full methodology inside."
4. **Live-demo landing sections.** Their animated capability cards (trace lookup firing, loop detected at turn 23…) convert. Build the Eden versions: a stretch being mined from live tool calls; the Approve knock; a relapse being steered back; the densified receipt shrinking a 47k-token blob. Show waste dying.
5. **The compounding narrative — told honestly.** Adopt the emotional arc without abandoning doctrine: *"Your agent's best day becomes its default. Every approved run makes the next ones cheaper, faster, and identical."* Compounding through determinism, not hints.
6. **A/B report artifact as product.** Their per-arm experiment reports are genuinely good UX. Eden's shadow ship gate produces equivalent data — surface it as a first-class dashboard object ("Candidate #1842: −71% tokens, quality unchanged across 214 replays → Review → Approve").
7. **Naming the enemy clearly.** Their rise lets Eden sharpen copy: *"Hints hope the model listens. Programs don't."* / "Reasoning reuse guesses. Eden proves."

---

## 8. Action Plan (prioritized)

### P0 — Next 30 days (demand-side unlocks)
1. **Publish the benchmark whitepaper page** on the marketing site using `packages/measure` + `benchmarks/campaign` results; include methodology, tables, and a limitations section. Kick off the Phase 6.3 live A/B (~$1.1K) in parallel so production numbers land within the month.
2. **Ship `eden init` one-command onboarding** + zero-code base-URL mode for the wrap proxy. Target: <5 minutes from npm install to "first stretch mined."
3. **Launch a self-serve free tier** using existing metering (`billable_ms`, `densified_bytes` panels already exist). Undercut RB's contact-sales wall. Metered usage-based pricing above the free line — bill densified bytes and compiled-tool invocations.
4. **Rewrite landing hero** around the collision: keep "Making your agents more deterministic," add the compounding line and one measured stat with a methodology link. Add two live-animated demos (mining; steer-back).

### P1 — Next 60 days (product moat)
5. **Python middleware packages** (`eden.middleware()` for LangChain/LangGraph; adapter for OpenAI Agents SDK). Parity with their distribution channel; the wrap proxy remains the power path.
6. **Productize recall/fulfill as "Semantic memory, with receipts"** — the deterministic answer to RB's semantic file memory and lossy compression. Market the facts receipt explicitly against summarization.
7. **Make tenant isolation a headline feature page**: redaction pipeline, tenant-scoped everything, "your traces never improve anyone else's agent — ever," contrasted (without naming) with collective-library approaches. Sales collateral for legal/finance/healthcare: audit trail, contract strip, version hashes, evidence ledger → compliance story RB cannot tell.
8. **Finish drift fingerprint UI hole** (REBUILD row 51) — "know when your compiled tool stops matching reality" closes the last big governance gap vs. any runtime competitor.

### P2 — Next quarter (category leadership)
9. **MCP ecosystem play**: publish compiled tools to the MCP registry narrative; "the only agent-efficiency layer that speaks the protocol agents already use." RB has no MCP story.
10. **Answer the distillation convergence publicly**: a short essay — "Why we compile instead of fine-tune" — instant value, no GPUs, inspectable programs vs. opaque weights, approval gates vs. opt-in training, witnessed envelopes vs. confidence thresholds. Own the debate before they force it.
11. **Optional 'model lane' roadmap item**: extend islands toward relegation-style routing (high-confidence program → deterministic path; else frontier) using the market's vocabulary — but keep it approval-gated and measurable.
12. **Attack multi-agent waste (W15)** as an R&D bet. It's explicitly unsolved industry-wide; first mover names the category.

### Watch items
- Any RB move toward MCP, self-serve pricing, or an approval/HITL feature → they read the same gaps.
- Their Series Angel/Seed (post-Demo Day) → expect 3–5 hires and a security/compliance push.
- Model-lab absorption risk: Anthropic/OpenAI shipping native prompt-cache + steering features erodes the generic "token efficiency layer" framing — Eden's approval+compilation+audit depth is the durable part; keep investing there.

---

## 9. Bottom Line

ReasonBlocks validates Eden's thesis with venture money and press — and is drifting toward it technically (golden traces → mined policies → cheaper execution path). But they chose the probabilistic road: hints the model may ignore, lossy summaries, opaque distilled weights, no human approval, ambiguous data boundaries. Eden chose the deterministic road: compiled programs, witnessed inputs, human approval, lossless receipts, honest measurement.

That choice is Eden's entire go-to-market. The gaps are execution gaps, not thesis gaps: **onboarding friction, invisible benchmarks, absent pricing, quiet distribution.** Close those four in the next 60 days while amplifying the determinism/approval/isolation story, and ReasonBlocks becomes the foil that makes Eden's category definition inevitable — rather than the company that defines it first.

---

*Sources: reasonblocks.com (site + whitepaper v2.0), docs.reasonblocks.com (incl. llms-indexed guides), YC company profile + Launch YC post, LinkedIn company/founder pages, Forbes (via LinkedIn repost), PitchBook/CB Insights/Tracxn/F6S listings, neuronfeed.com, hokai.io, zeitgeist.bot, yctierlist.com, third-party LangSmith/observability landscape coverage. Eden-side analysis from repository audit: README.md, spec.md, PRODUCT.md, REBUILD.md, docs/{audit-plan,generalization-plan,waste-audit}.md, packages/*, apps/*.*
