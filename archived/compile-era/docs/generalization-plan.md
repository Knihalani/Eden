# Eden: complete generalization — the full plan

*Status: v1.0 — research-complete. Four research legs merged: redundant
execution & loops, context/token waste, orchestration waste (sessions 1),
plus workflow-induction/branching, sandboxed execution, and benchmark
methodology (this session). Supersedes the roadmap sketch in
docs/waste-audit.md. This document is the contract: every phase has
acceptance gates that are executable or observable, and nothing ships on
assertion.*

---

## 0. Mission statement

Eden abstracts away repeated computation from any agent doing anything.
Concretely: **an agent running any tool surface, on any domain, through any
in ingestion path, gets its recurring stretches compiled into single calls
that are validated before they exist, steered to when the agent relapses,
and measured honestly after they run.**

Not goals (anti-goals, revisited every phase):

- No vendor tables anywhere in admission, naming, steering, or safety.
- No fuzzy/semantic matching where a deterministic gate exists.
- No auto-approval expansions. The human gate is why aggressive compilation
  is safe.
- No benchmark we cannot fail.

## 1. Definition of done — five testable claims

| # | Claim | Verified by |
|---|---|---|
| C1 | Any tool surface is minable | Fixture suite F6 (§4): six unrelated domains compile end-to-end |
| C2 | Programs express what agents repeat | Branch + loop + template coverage tests; refusal-rate < 20% on fixture suite |
| C3 | Compiled tools execute wherever the agent runs | Local registry ✓ today; hosted runner gate H1 (§5) |
| C4 | Safety is structural | Zero vendor lookups in admission path (grep-gate in CI); dry-run gate for first execution of write tools |
| C5 | Generality is proven, not asserted | Benchmark B1 (§6): paired A/B on ≥3 unrelated domains, real agents, WIN or INCONCLUSIVE-with-MDE reported |

**C5 is the master gate.** Everything else exists to make it pass honestly.

## 2. Current state (post audit sessions 1–3)

Working and tested (829 green):

- Ingestion: hook → ingest → islands (generic CLI shapes, cloud URLs, MCP
  verbs); control-plane traces → shape-aware mining (`Bash:kubectl.get.pods`);
  wrap SDK proxy (OpenAI-compatible) with steer/suppress/guard.
- Compiler: sequences, loops (data-driven), templated commands via witnessed
  bindings, envelopes (witness distributions), shadow validation on tape,
  human approval, receipts.
- Guard: progress-aware loop detection, read-poll tolerance, fail-streak
  breaker, low-gain + spaced-spin detectors, budget halt, evidence ledger.
- Serving: generic schemas (any template key), stable ordering, bounded
  instructions, batch fan-out over any plural key.

Known gaps (the plan's scope): G1–G12 in §3.

## 3. Gap register

| # | Gap | Layer | Size | Depends on | Phase |
|---|---|---|---|---|---|
| G4 | Multi-slot template steering | wrap/steer | S | — | P1 |
| G8 | Shell-loop decomposition at ingest (`for id in …`) | islands/mine | M | — | P1 |
| G3 | Generic `for`-loop rewriting at playback (any binary) | core/playback | M | G8 | P1 |
| G9 | First-execution dry-run / propose-confirm for write tools | guard/site | S | — | P1 |
| G12 | When-to-use synthesis for arbitrary domains (steering quality) | site/MCP | M | island caller | P1 |
| G2 | Conditionals in mined programs | IR/compiler/runtime | L | — | P2 |
| G5 | Structured-body binding (JSON POST payloads) | compile/bind | M | — | P2 |
| G6 | Compiled-tools-calling-compiled-tools (composition) | runtime/registry | M | G2? no — independent | P2 |
| G11 | Non-POSIX shells (PowerShell token classes) | core/shapes | S | — | ~~P2~~ ✅ done P1 |
| G13 | Variation-driven slot abstraction for positional CLI args (FlashFill-style: literals = tokens consistent across witnesses; varying spans = slots). Without it, `kubectl logs <pod>` stretches don't cluster — the pod name is misread as a subcommand token | core/shapes + mine | M | — | P2 |
| G1 | Hosted runner execution — **split into G1a laptop bridge (P3 early, small) and G1b cloud microVM (P3 late, XL)** | new service | M→XL | sandbox research ✓ merged §5 | P3 |
| G7 | Anthropic-native proxy dialect | wrap | M | — | P3 |
| G10 | Live multi-domain A/B benchmark — design merged §7 | measure/fixtures | L | all of P1–P2 | P4 |

*(research legs filling in design constraints for G1, G2, G10 — see §5–7)*

## 4. The fixture suite F6 (builds first, gates everything)

Six unrelated domains, each with: recorded traces (≥3 witnesses), a compiled
program, steering probes, OOD probes, replay assertions. All offline
(forge-backed HTTP + plain registries). This suite IS claim C1/C2.

| # | Domain | Surface | Stretches it must mine |
|---|---|---|---|
| F1 | Kubernetes ops | shell | get pods/svc/deployments per namespace; rollout status loop |
| F2 | Cloud storage (aws s3) | shell | list/list/get object loops; cp refused as mutating |
| F3 | Payments API (stripe-style REST) | curl/cloud | invoice+lines bundle per customer |
| F4 | SQL analytics (psql) | shell | query variants; refused when under-determined |
| F5 | Notion/MCP product verbs | MCP names | query→update→comment flow (exists) |
| F6 | Web research | WebFetch/search | fetch+extract loops |

Gate: `bun test` runs F1–F6 end-to-end (mine → validate → steer → replay →
deopt) in CI; each fixture also asserts honest refusals for its mutating /
under-determined variants.

## 5. Hosted runner execution (G1) — merged from sandbox research

*Sources: Anthropic sandbox-runtime + "How we contain Claude";
Firecracker/gVisor/Kata isolation numbers (safeguard.sh, Northflank);
UK AISI SandboxEscapeBench arXiv:2603.02277; AI-sandbox security study
arXiv:2606.08433; GitHub Actions/TFC OIDC patterns; Cilium FQDN egress;
microsandbox DNS-pin model; Fly Sprites / E2B snapshot economics;
ngrok/Tailscale MCP tunnel-back precedents.*

**Strategic finding: build the bridge before the bunker.** Tunnel-back is
established prior art (ngrok-as-MCP-gateway, Tailscale Aperture, Daytona's
polling compute-plane runners). Eden's local registry already executes runner
steps — so hosted CLI support ships in two increments:

**G1a — Laptop runner bridge (weeks, no new infra).** A small `eden runner`
daemon: authenticates to the control plane, polls for pending runner steps of
approved tools only, executes them through the same coding registry, posts
receipts. Capabilities mirror the approval model exactly — a tool the human
turned On locally can play from the cloud brain through the user's hands.
Precedent: Daytona runners; ngrok MCP gateways. Acceptance gate H1a:
hosted-MCP-compiled kubectl stretch plays end-to-end through a running
`eden runner`, receipt lands, OOD input deopts.

**G1b — Cloud microVM execution (later, real infra).** Only if customers
need headless execution. Design constraints from research:

- Isolation: **hypervisor minimum** (Firecracker; snapshot-pool restore
  5–30 ms, cold ~125 ms). Plain containers are disqualified by evidence:
  UK AISI shows frontier models escaping misconfigured Docker at up to 100%
  on their escape bench; NCSC guidance says hypervisor is the floor.
  gVisor acceptable where Kubernetes-native (RuntimeClass) — 53 syscalls
  reachable, ~20–40 MB overhead.
- Credentials: **never co-resident with executed code.** Short-lived,
  context-bound issuance (OIDC → STS AssumeRoleWithWebIdentity pattern,
  15–60 min TTL); or the Anthropic broker pattern — proxy validates target +
  attaches real token, sandbox holds only a scoped pseudo-credential.
  Host-scoped injection gated on TLS SNI + DNS pin set (microsandbox model).
- Egress: default-deny; remove the network namespace entirely and force all
  traffic through host-side proxies over Unix sockets (Anthropic
  sandbox-runtime); FQDN allowlists via Cilium toFQDNs; NXDOMAIN-rewrite
  private ranges; block IMDS 169.254.169.254 at network layer; fail closed
  if redirect rules cannot install.
- Economics/latency: sub-300 ms provisioning P99 (agents fan out; slowest
  sandbox gates the turn); scale-to-zero billing (~$0.05–0.11/sandbox-hour
  active across vendors); warm-pool restore instead of boot-on-demand.

Acceptance gate H1b: same kubectl stretch plays against an ephemeral microVM
with brokered read-scoped credentials; escape-bench-style negative tests
(privileged-mode off, no docker.sock, IMDS blocked) all fail closed.

## 6. Conditionals in mined programs (G2) — merged design

*Sources: HeuristicsMiner (Weijters/van der Aalst 2006) dependency thresholds;
Data-aware Heuristic Miner (De Leoni et al., CAiSE 2017); FlashFill/BlinkFill
branch-evidence theory (POPL 2011 / PVLDB 2016); FrAngel angelic conditions
(POPL 2019); AWM/SkillWeaver/Voyager/FRIDAY branch-gap analysis;
Temporal durable-execution constraints; shadow→canary staged rollout practice.*

**The opening:** no surveyed system mines *witnessed* branches. AWM keeps
only the intersection of trajectories (divergence is dropped); FRIDAY's DAG
has AND-parallelism but no XOR-choice; SkillWeaver/Voyager emit `if`
statements whose alternate arm was **never executed** — LLM extrapolation
wearing a program's clothes. Eden can be first because it already owns all
three missing components: tape replay (= shadow witnesses), witness
envelopes (= per-arm evidence), and data-rich receipts (= guard-mining
attributes).

**Design — three gates a branch must clear to ship:**

1. **Statistical confirmation** (HeuristicsMiner discipline). A fork point
   becomes an XOR-split only when: dependency
   `(|A>B| − |B>A|) / (|A>B| + |B>A| + 1) ≥ 0.9` (>10 supporting transitions
   even at zero noise), absolute support ≥ `minSupport`, and the split beats
   the merged-hypothesis within the relative-to-best margin (0.05).
   AND-vs-XOR decided by the standard discrimination statistic. Below
   threshold: no branch — the minority path stays uncompiled raw.

2. **Guard mining from data attributes** (DHM pattern). The fork's
   *condition* is learned from attributes Eden already records on receipts:
   prior-step result fields (`state`, `conclusion`, presence/absence),
   argument equality against witnessed values, CI-style rollups. The
   predicate vocabulary is structural (equality/presence/rollup over prior
   results) — an LLM may *execute* inside an arm but never authors the
   guard. The candidate guard must classify held-out traces cleanly
   (fitness + precision, conformance-check style); otherwise refuse.

3. **Witness-per-arm plus negative witness** (FlashFill's "]" theorem).
   Each arm ships only with ≥1 successful taped execution of that arm AND
   the ≥1 negative witness that made the unconditional program wrong.
   Unwitnessed arms are the SkillWeaver failure mode; they refuse here.

**Execution & deployment.** Branch decisions are journaled on receipts (the
Temporal journal/replay discipline, without adopting Temporal — Eden's
receipt ledger already replays). First deployment runs **shadow-mode**: the
compiled branched tool mirrors traffic while results diff offline,
collecting witnesses for arms production inputs actually exercise — closing
partial observability with real inputs before any arm fires live. Sticky
per-session routing during canary; auto-pause on fail-streak already exists
in the guard.

**IR change:** `BranchStep { predicate: AssertExpr; thenId; elseId }` —
validated by `assertValid`, evaluated by the runtime's existing assert
engine, replayed by shadow's tape. Downstream (steering, envelopes,
receipts) treats it as a barrier step.

Acceptance gate B1: a fixture where traces diverge on a CI-state field
(`success` → notify vs `failure` → retry) compiles into a witnessed branch,
refuses when either arm lacks tape coverage, and replays both arms
correctly against tape.

## 7. Benchmark design (G10) — merged from methodology research

*Sources: METR arXiv:2503.14499 (8 rollouts/task, human-time pairing,
logistic fits); HAL arXiv:2510.11977 ($40K/21,730 rollouts ≈ $1.84 avg,
cost CIs, Pareto reporting); τ-bench pass^k (arXiv:2406.12045) +
τ²-bench (arXiv:2506.07982); SWE-rebench contamination controls
(arXiv:2505.20411); ABC benchmark-validation checklist (arXiv:2507.02825);
CUPED variance reduction; Copilot acceptance-rate lessons.*

**Design.** Two arms — pinned baseline scaffold vs Eden-wrapped — identical
models, fixed scaffold otherwise (HAL lesson: uncontrolled scaffolds measure
themselves). Every task attempted by BOTH arms (per-task pairing); blocks =
domain × difficulty bucket (METR human-time labels) × model. k ≥ 5 rollouts
per arm/task; report pass^k and cost CIs, never point estimates.

**Joint decision rule** (the gate that makes savings claims honest):

> Ship the claim iff Δpass^k ≥ −ε under TOST equivalence AND
> Δ$/successful-task ≤ −δ with power ≥ 80%.

**Metrics per successful task:** dollars (cache-correct pricing), wall-clock
p50/p95, tokens (in/out/cache split), turns/tool-calls, **human interventions**
(the Copilot acceptance-rate analogue). Pareto frontier, not a scalar.

**Variance reduction:** CUPED with the baseline arm's cost on the same task
as covariate (~40–50% n reduction at ρ≈0.7); always-valid sequential tests
for peeking.

**Validity controls:** fresh/post-cutoff tasks only + recency-slice check;
ABC task validation (verifier tested against known-good AND known-bad);
human-time labels so savings read as "engineer-minutes saved"; full log
release + reward-hacking audit (HAL found agents searching for the benchmark).

**Budget anchor:** HAL ran 21,730 rollouts for ~$40K. A credible v1 campaign:
3 domains × 20 tasks × 2 arms × 5 rollouts = 600 rollouts ≈ $1.1K at HAL's
mean — cheap enough to repeat every release.

## 8. Sequencing & effort

**P1 — Expressiveness floor: ✅ COMPLETE.**
G4 ✓ multi-slot recovery (combo-capped), G13 ✓ variation-driven slot
abstraction, G8 ✓ generic shell-loop decomposition,
G3 ✓ loop parallelization generalized to unknown binaries,
G9 ✓ dry-run rehearsal (`eden play --dry-run`),
G12 ✓ when-to-use names its template parameters generically,
G11 ✓ PowerShell verb-noun token classes,
**F6 ✓ six-domain fixture suite in CI**.
*Gate passed: F1–F6 compile → steer → replay → deopt green; honest refusals
asserted; suite 840/0; benches WIN.*
*Gate passed: F1–F6 compile → steer → replay → deopt green; honest
refusals asserted; suite 840/0; benches WIN.*

Also fixed en route (found by F6): `toStepFromParsed` gave every curl in a
multi-call line the FIRST call's URL, so distinct resources collapsed in
dedupe — now each step binds its own positional URL, trailing punctuation
stripped.

**P1 — Expressiveness floor: ✅ COMPLETE.**
G4 ✓ multi-slot recovery (combo-capped), G13 ✓ variation-driven slot
abstraction (ordinal-aligned peers in mining `buildShellNames`; peer-voted
renaming on the ingest path incl. cross-run peers), G8 ✓ generic shell-loop
decomposition (`explodeShellLoop`, 2–100 items, single plain for-loop),
G3 ✓ loop parallelization generalized to unknown binaries whose bodies are
positively-read (mutating/unrecognizable stay sequential),
G9 ✓ dry-run rehearsal (`eden play --dry-run` / playTool opts.dryRun:
mutating steps resolved-and-reported, never executed; reads still exercise
templates/cache), **F6 ✓ six-domain fixture suite in CI**, G12 ✓ when-to-use
names its template parameters generically, G11 ✓ PowerShell verb-noun
token classes.
*Gate passed: F1–F6 compile → steer → replay → deopt green; honest
refusals asserted; suite 840/0; benches WIN.*

Also fixed en route (found by F6): `toStepFromParsed` gave every curl in a
multi-call line the FIRST call's URL, so distinct resources collapsed in
dedupe — now each step binds its own positional URL, trailing punctuation
stripped.

**P2 — Expressiveness depth (in progress).**
G2 ✓ BranchStep IR + runtime execution + fork mining detection shipped
(see `packages/compile/src/fork.ts`, `packages/runtime/src/branch.test.ts`).
Remaining: fork-candidate→program assembly (arms need bindings from their
own witnesses), G5 structured-body binding, G6 composition,
G11 ✓ done (PowerShell token classes shipped in P1).
*Gate: branch fixture B1 green; composed-tool fixture compiles and replays;
no regression in refusal honesty.*

**P3 — Surfaces.**
G1a laptop runner bridge first (weeks; prior art: Daytona runners, ngrok/
Tailscale MCP gateways; gate H1a), G7 Anthropic dialect, G1b cloud microVM
only on customer demand (gate H1b; hypervisor floor, brokered credentials,
default-deny egress — §5).
*Gate: hosted-compiled kubectl stretch plays via runner bridge end-to-end.*

**P4 — Proof.**
G10 campaign per §7: 3 domains × 20 tasks × 2 arms × 5 rollouts ≈ 600
rollouts (~$1.1K at HAL's mean cost) — cheap enough to re-run every release.
*Gate: TOST pass^k equivalence + significant $/task reduction, Pareto
reported with CIs, logs released.*

## 9. Why this wins

Every surveyed competitor is missing at least one of the three components
Eden already has running in production code:

| Capability | AWM | SkillWeaver | FRIDAY | **Eden** |
|---|---|---|---|---|
| Witnessed arms before a branch ships | ✗ drops branches | ✗ extrapolates | ✗ AND-only | **✓ tape + envelopes** |
| Statistical branch confirmation | ✗ | ✗ | ✗ | **✓ HeuristicsMiner thresholds** |
| Guard mined from logged attributes | ✗ prompted | ✗ guessed | ✗ scored | **✓ DHM over receipts** |
| Deterministic replay validation | ✗ | honing only | critic score | **✓ shadow on tape** |
| Human approval as admission gate | ✗ | ✗ | score ≥ 8 | **✓ the whole product** |
| Domain-general slot abstraction | LLM-prompted | implicit in code | ✗ | **✓ token classes + templates** |

The plan's bet: generalization is not one feature — it is refusing to have
vendor tables while making every admission decision structural, witnessed,
and human-gated. That combination does not exist elsewhere, and each phase
above strengthens it rather than trading it away.

## 10. Cold-start elimination: observability ingestion

**Solved.** Users no longer wait days for repetition to accumulate naturally.
Five format adapters normalize existing trace history into Eden's pipeline:

| Format | Source | Adapter |
|---|---|---|
| Generic JSONL | Any log file with `{name, args, result, ok}` per line | `parseGenericJsonl` |
| OpenTelemetry GenAI spans | OTLP exports (GenAI semconv + OpenInference/Phoenix) | `parseOtelSpans` |
| LangSmith runs | LangSmith API `/runs` export (`run_type=="tool"`) | `parseLangSmithRuns` |
| Langfuse observations | Trace observations (`type=="TOOL"`) | `parseLangfuseObservations` |
| OpenAI chat completions | Raw API logs with `tool_calls[]` + `role:"tool"` messages | `parseOpenAIToolCalls` |

Auto-detection sniffs the content and routes to the right adapter. Imported
traces flow through the standard compile pipeline identically to live
recordings — cutIslands, skeleton abstraction, cloud islands all work.

Attribute names verified against research-confirmed GenAI semantic
conventions (`gen_ai.tool.call.arguments`, not the older `gen_ai.tool.args`),
Phoenix/OpenInference kind markers, and both JSON-string vs object argument
payload styles. Error flags from OTel status codes, LangSmith error field,
Langfuse level, and Anthropic `is_error`.

Tests: `packages/core/src/ingest.test.ts` (14 tests including end-to-end
import→compile proof across three platforms).
