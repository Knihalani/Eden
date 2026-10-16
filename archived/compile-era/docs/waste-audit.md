# Wasted computation in LLM agents — the full map, and where Eden stands

*Waste audit. Sources merged from three research legs (August 2026): redundant
execution & loops, context/token-level waste, and orchestration/systems-level
waste — plus a fourth leg on domain-general workflow induction (AWM
arXiv:2409.07429, Voyager arXiv:2305.16291, SkillWeaver arXiv:2504.07079,
FlashFill/version-space algebra for slot abstraction, process mining). Key
finding from that leg: admission gates matter more than induction cleverness,
and slot abstraction is the weakest link in every published system — which is
why Eden's compiler keys on token classes (numbers/hashes/prefixed ids/quoted
strings) rather than vendor tables.*

## Status legend

- ✅ **Solved** — mechanism exists and adversarial tests pass.
- 🟡 **Partial** — mechanism exists; a gap was found and fixed, or a residual
  tradeoff is documented.
- ⚪ **By design** — not intercepted on purpose; the spec forbids it.
- ❌ **Open** — no mechanism; listed honestly.

## The taxonomy

| # | Cause of waste | Evidence | Eden's answer | Status |
|---|---|---|---|---|
| W1 | Byte-identical repeated calls re-execute / double-recorded | SWE-agent ACI re-reads; TRAIL annotations | `cleanEvents` adjacent-dedupe, mutation-safe | ✅ |
| W2 | Loops & thrash burn cycles until timeout | FLARE (56 MAS loop failures), Manus trap detector, MAST | `repeat_ngram` → steer/halt + **progress-aware suppression** + read-poll grace + `repeat_visits` spaced-spin detector; **−86% spend gated** | ✅ fixed |
| W3 | Consecutive failures keep spending | BFCL retry tails, τ-bench pass^8 < 25% | `fail_streak` circuit breaker + live pause | ✅ |
| W4 | Repeats that return nothing new | Context rot: duplicates also *degrade* accuracy | `low_gain` via `valueOverlap`/`pairGain` | ✅ |
| W5 | Same stretch re-solved every session | Voyager 3.3×, AWM −steps/+51% SR, ExpeL | mine → compile → MCP compiled tools | ✅ |
| W6 | Independent steps run sequentially | LLMCompiler 3.7× latency / 6.7× cost; Anthropic ~90% research-time cut | DAG `layers`; commuting reads share waves | ✅ |
| W7 | Read-only loops run serially | same as W6 | `loopConcurrency` fan-out — bench gate **WIN**, up to 7.9× | ✅ |
| W8 | Oversized tool outputs flood context | Code-exec-with-MCP: 10k rows → 5; +50k copy-through tokens | densify columnar + `modelFacing` facts receipt | 🟡 fixed |
| W9 | Old stretch runs raw after a compiled tool exists | AWM step-reduction mechanism | arming/skipRest suppression + prefix/argshape steer | ✅ |
| W10 | Verification skipped → expensive rework later | MAST task-verification modes; Eden receipts show naive skipVerify ≈ 0.2 | evidence ledger, finalize block, checks pinned at compile | ✅ |
| W11 | Run exceeds its budget and keeps going | METR failed-trajectory economics | budget guard steers only to programs that fit, else halts | ✅ tested |
| W12 | Spend continues after first warning | post-warning spend as failure metric | `postWarningSpend` measured on traces; killAfterWarning | ✅ |
| W13 | Tool-definition bloat in the prompt | 150k → 2k tokens (98.7%) progressive disclosure | `selectMcpTools` cap (6) + bounded instructions (1200 chars) | ✅ |
| W14 | Tool-list churn invalidates agent KV-cache | Manus: cache hit rate = #1 metric; ~10× price spread | **emit list alphabetically; admission stays popularity-based** | ✅ fixed |
| W15 | Multi-agent duplicated work / no blackboard | Anthropic 15× tokens; MAST inter-agent misalignment; Cognition essay | none — Eden sits on one agent's tool path | ❌ |
| W16 | Overthinking / verbose deliberation tokens | Chain of Draft −92%; process efficiency often < 20% | islands run on a cheap model (gpt-5.6-luna, temp 0) with transient-error retries — cascade routing | 🟡 partial |
| W17 | Live duplicate reads within a session | context-rot re-read spiral | by design not suppressed (spec: ordinary calls must not wait on Eden); warnings only | ⚪ |
| W18 | LLM used as CPU (determinism waste) | OpenAI latency guide: "don't default to an LLM" | compiled steps are code; island LLM only for semantic glue | ✅ |
| W19 | Retry amplification from invalid args | BFCL AST/exec gap; ±10% temp sensitivity | witness-envelope gate (`inDistribution`) refuses out-of-distribution inputs instead of executing blind | ✅ |
| W20 | Serving-side prefill/cache waste | RadixAttention/PagedAttention; WebSocket ~40% E2E gains | out of scope for the tool path | ❌ |
| W21 | HITL approval gates block/idle agents | Anthropic sync-subagent bottleneck | async knock + browser approve; raw path never waits (spec) | ✅ |

## Fixes made during this audit

1. **Progress-aware loop detection** (`packages/ir/src/signals.ts`).
   `repeat_ngram` fired on any repeated name n-gram regardless of what the
   calls returned, so the guard hard-stopped an agent polling CI the moment
   before its poll would have shown success — while pure thrash made of two
   consecutive identical calls slipped through the guard's `size >= 2` check.
   Now: changed arguments or materially changed results (overlap < 0.9)
   suppress the warning that cycle; unobservable pairs (two result-less
   failures) fail closed toward detection; all-read n-grams need three
   identical cycles to warn (`READ_NGRAM_REPEAT_AT`).

2. **All-read loops are never hard-stopped**
   (`packages/wrap/src/guard.ts`). The halt lands on the next loop call —
   exactly the observation that would have shown progress. Reads are cheap;
   wrong halts yank a human back into the loop. Read-only loops keep
   accumulating warnings (honoured by `killAfterWarning` and the budget
   guard) but are not executed into a dead stop. Mixed/mutating loops still
   halt.

3. **Silent depth-drop honesty fix** (`packages/core/src/compact.ts`).
   `modelFacing` recurses into nested objects only above depth 2; deeper
   subtrees vanished from the facts with `truncated: false`. The agent read
   a projection missing whole branches and had no way to know. Dropped-for-
   depth keys now set the truncation flag.

4. **Stable MCP tool-list order** (`packages/core/src/plan.ts`).
   `selectMcpTools` emitted tools ordered by live `uses_count`, so the list
   reshuffled between turns and invalidated the provider KV cache from the
   tool-list position onward (~90% of input-token discount lost). Admission
   is still popularity-based; emission is alphabetical.

## Session two additions

5. **Spaced-spin detection — `repeat_visits`**
   (`packages/ir/src/signals.ts`). Adjacent-pair `low_gain` sees only
   back-to-back same-tool calls and `repeat_ngram` only contiguous name runs,
   so `grep → edit → grep(variant) → write → grep(variant2)` — re-searching
   for something already found — evaded both. A tool whose three most recent
   successful calls returned materially identical results (args may differ;
   that is the point) now warns. Telemetry-only by design: a batch of writes
   returning `{ok:true}` each looks identical from outside, so this signal
   feeds traces/failure-clustering but never drives a halt.

6. **Island transient-failure retries** (`packages/wrap/src/island.ts`).
   An island throwing mid-program is a non-replay-safe deopt: earlier steps
   may have written, so the caller either wastes the compiled work or risks
   raw replay. 429/5xx/network blips now get bounded retries (2 extra
   attempts, linear backoff, per-attempt timeout, caller abort honoured);
   schema rejections fail immediately. Cheapest failure recovery available.

7. **Guarded-thrash benchmark** (`packages/runtime/src/bench-guard.ts`,
   `bun run bench:guard`). States the dashboard claim in units and gates it:
   paired, counterbalanced, replicated, A/A-checked. Result: **86% less
   spend** on runaway-loop workloads (5–12× per shape), p=0.0001, clean A/A.

8. **Demo repaired end-to-end + pinned by a test**
   (`apps/control/src/demo.ts`, `packages/runtime/src/ticketship.ts`,
   `apps/control/src/golden.test.ts`). `bun run demo` had broken twice
   invisibly: the auth hardening made `/v1/inbox` require the credential the
   demo never sent, and the ship gate began rejecting the demo's synthetic
   fixture clock (`200 × llmCalls`) — correctly, since an estimate is not a
   measurement. The demo now wires the same tape-replay sandbox as
   `eden wrap`, carries real per-event durations from the TicketShip runner,
   and the full narrative — ingest → compile → 8× LLM reduction → approve →
   compiled run → OOD deopt → sibling refused — is pinned by an HTTP-level
   regression test so it cannot silently break again.

## Session three: removing the GitHub hyperfixation

The compiler qualified stretches by *vendor*, not by *repetition*. Fixed by
making repetition and shape the only admission criteria:

9. **Domain-general command shapes** (`packages/core/src/shapes.ts`). Any
   recorded CLI command — kubectl, aws, stripe, psql, terraform, anything —
   is reduced to a shape (binary + subcommand path + flag names) with
   identifier-valued tokens abstracted to parameter slots. Slot classes:
   numbers, hex hashes, uuids, prefixed entity ids (`in_123`, `PROJ-42`),
   quoted strings. Read classification fails conservative: an unknown binary
   never counts as a read, so it is never reordered or deduped — worst case
   it compiles sequential, exactly what the agent did by hand.

10. **Islands accept unknown CLIs** (`packages/core/src/islands.ts`). The
    old `isGenericBash` exclusion made every non-gh/curl command
    uncompilable. Now only session plumbing (cd/ls/echo/…) is excluded.
    Pure-runner islands compile with `allowRunnerOnly` — enabled on laptop
    registries (`eden wrap`), off for hosted MCP which cannot play them.

11. **Resource-chain naming** (`packages/core/src/urls.ts`). Names come from
    the URL resource chain anchored after the last identifier slot
    (`pulls_reviews_status`, `stripe_invoices_lines`, `acme_orders_products`)
    — no vendor table. PR-bundle enrichment now keys off fetched URLs, not a
    name prefix; bundle canonicalization happens before naming so repeated
    compositions merge into one tool instead of forking.

12. **Generic served schemas** (`apps/site/src/mcp.ts`). Every template key
    a compiled tool actually uses becomes an MCP argument with a CSV plural;
    any `<key>s` csv routes into the concurrent batch machinery. A compiled
    `{order}` tool accepts `orders="11,12"` without the server knowing what
    an order is.

12. **Generic served schemas** (`apps/site/src/mcp.ts`). Every template key
    a compiled tool actually uses becomes an MCP argument with a CSV plural;
    any `<key>s` csv routes into the concurrent batch machinery. A compiled
    `{order}` tool accepts `orders="11,12"` without the server knowing what
    an order is.

13. **Shape-aware mining and steering through the SDK pipeline**
    (`packages/compile/src/mine.ts`, `compile.ts`,
    `packages/wrap/src/steer.ts`). The third ingestion path — traces posted
    to the control plane — clustered on raw event names, where every shell
    call is just "Bash", making CLI stretches invisible. Mining now clusters
    on shape-derived identities (`Bash:kubectl.get.pods`), emits steps that
    call the real registry tool with the command bound as a witnessed
    template (`kubectl get pods -n {namespace}`), refuses commands whose
    varying parts the witnesses cannot explain, and the proxy steers a live
    raw shell call back to its compiled tool by recovering the slot value
    from the envelope. Unseen values fail closed.

## Session four: executing the generalization plan (P1)

Plan: `docs/generalization-plan.md`. Phase 1 complete — 848 tests, 0 fail,
typecheck clean, benches WIN, demo verified.

- **G13** variation-driven slot abstraction — mining aligns shell events
  ordinally across structurally identical traces and votes tokens constant
  vs varying (`buildShellNames`); the ingest path re-derives island step
  identities with peer commands from prior runs, so `kubectl logs <pod>`
  stretches cluster instead of forking per pod name.
- **G4** multi-slot steering recovery — `recoverShellInput` enumerates
  witnessed slot combinations (capped at 200) so multi-slot templates steer.
- **G8** `explodeShellLoop` — generic `for` loops decompose into per-item
  events (2–100 items, single plain loop, variable referenced in body),
  running BEFORE named-CLI extraction so substitution always wins.
- **G3** `rewriteForLoop` parallelizes unknown-binary loops whose every body
  segment is positively-read; word-valued lists welcome; mutating or
  unrecognized bodies stay sequential.
- **G9** dry-run rehearsal — `eden play --dry-run` / `playTool(…, {dryRun})`:
  reads execute (templates + cache exercised), mutating steps resolve to
  `{skipped:"dry_run", url}` and never fetch; receipts carry `dryRun: true`;
  rehearsals skip uses_count and the batch aggregate keeps the flag.
- **G11** PowerShell token classes — Verb-Noun cmdlets normalize to
  `powershell.<verb>.<noun>` identities and classify by approved-verb
  vocabulary (`Get-*` reads, `Remove-*` writes); `$variables` are slots.
- **F6** six-domain fixture suite (kubernetes / aws s3 / stripe-style REST /
  psql / Notion MCP verbs / web research loops) green in CI — claim C1's
  offline gate.
- **Bug found & fixed by F6**: `toStepFromParsed` assigned every curl in a
  multi-call line the FIRST call's URL (trailing `;` included), collapsing
  distinct resources in dedupe. Steps now bind their own positional URL.

### Probe round 1 — five adversarial probes, ~21 findings, all fixed

Four probes attacked steering, mining abstraction, guard/dry-run, and six
untested domains; a fifth re-probed the fixes themselves.

Steering probe: recovery fill used multi-pass string replace while the
runtime interpolates single-pass — a witness value containing another slot's
placeholder validated a rendering the program could never produce; recovery
matched ANY string argument instead of the command; skeleton sanitizer merged
distinct binaries (`my-tool`/`mytool`) and truncated mid-placeholder.
→ single-pass `interpolate` fill; matching restricted to the `command`
argument; token-boundary truncation with raw-skeleton hash disambiguation.

Mining probe: loop-emission branches shipped decorated skeleton identities as
step tools (`Bash:kubectl.get.pods…`) → runtime `unknown tool` crash at
replay — all emission paths now rewrite to the real registry tool;
truncation-collision false refusals fixed by the same hash naming;
cross-cohort skeleton clobbering now falls back to plain shape names on
conflict; numeric/boolean witnessed values can template commands.

Guard/dry-run probe: `warmWorkspaceBundle` executed write-performing tools'
POSTs unattended on every MCP handshake → now always dry-runs; progress
detection was defeatable by one drifting field or nonce argument, buying
unbounded mutating cycles → stricter material-change rule + an unconditional
executed-call ceiling (`EDEN_MAX_STEPS`, default 150); batch dry-run receipts
lost their flag; rehearsals inflated uses_count → counted no longer.

Cross-domain probe: byte-identical repeats of mutating shell commands
(`terraform destroy` ×2) collapsed in cleanEvents for any non-curl/gh binary
→ shells now fail closed (must prove read via shape); compound MCP heads
embedding mutations after a read verb (`fetchAndChargeCard`) commuted and
their siblings were DROPPED in dedupe → name vocabulary checks mutating words
anywhere while keeping dotted product verbs (`order.view`) commutable;
method-override headers smuggled DELETEs past the curl mutation gate;
loop-explosion order fixed so per-item substitution wins over template
extraction; quote-aware tokenizer stops multiline SQL fragments leaking into
shape identities.

### Probe round 2 — re-probing the fixes: 7 findings, all addressed

Re-probe targeted the fix code itself:

- **CRITICAL**: the max_steps halt wedged WrapState permanently (halt pushed
  no event → emitTrace's early-return skipped the counter reset). Now the
  halt pushes a marker through the flush path and explicitly resets —
  sustained thrash re-arms the ceiling per window instead of bricking.
- **HIGH**: PROGRESS_RESULTS_OVERLAP flagged legitimate growth-polls as
  thrash (job list 9→10 items scores 0.9). Inherent limit of token-overlap
  heuristics: bounded by the generous ceiling + `EDEN_MAX_STEPS` override;
  documented rather than hidden.
- **MEDIUM**: dotted-path templates (`{db.host}`) never steered — slot regex
  missed dots AND recovery built flat records interpolate cannot resolve.
  Recovery now builds nested records and matches dotted slots.
- **LOW-MEDIUM**: fail-closed shell rule over-retains reads outside the verb
  vocabulary (`terraform plan`, `kubectl logs`) — accepted tradeoff
  (over-retention never under-executes).
- **LOW**: sub-flush caps were unreachable dead zone — explicit reset fixed.


## Session five: BranchStep IR + runtime execution + fork mining

- **G2 capability**: `BranchStep { expr, then[], else[] }` added to the IR.
  The runtime evaluates assert-style predicates against prior results and
  executes only the selected arm — deterministically, without touching the
  skipped arm. Arms are flat step references (same shape as loop bodies);
  validation checks arm-id existence and non-empty then-arms.
- **G2 fork mining**: `findForkedGroups` detects where traces share a
  prefix then split into two witnessed arms with a cleanly separating
  result-field predicate (`state=failure → fix_build+notify` vs
  `state=success → notify`). Three gates enforced: both arms ≥ minSupport,
  clean separation across ALL members, no free-form predicates.
  **Remaining P2 work**: assembling fork candidates into executable programs
  with proper bindings for each arm's steps (requires refactoring the
  linear-sequence builder to support non-linear sequences).

- **G2 capability**: `BranchStep { expr, then[], else[] }` added to the IR.
  The runtime evaluates assert-style predicates against prior results and
  executes only the selected arm — deterministically, without touching the
  skipped arm. Arms are flat step references (same shape as loop bodies);
  validation checks arm-id existence and non-empty then-arms. Three golden
  tests prove: failure→fix arm, success→notify arm, and skipped-arm
  isolation (the world is never touched by the unselected path).
  **Auto-mining** from diverging traces remains P2 work — its design
  (HeuristicsMiner thresholds + DHM guard mining + FlashFill witness
  theorem) is fully specified in `docs/generalization-plan.md` §6.

## Verification

- Full suite: **848 pass, 0 fail** across 64 files (baseline 780).
- F6 fixture suite: six unrelated domains, zero vendor knowledge.
- Benches: compile gates (llm 8× / ms / cents), loop parallelization WIN,
  guarded-thrash −86% spend — re-run after every phase.
- Demo narrative verified end-to-end after each phase.
- New regression tests: guard branches, progress-aware loop signals,
  spaced-spin signals, executed-call ceiling + unwedge, dotted-slot steering,
  dedupe fail-closed edges, modelFacing depth honesty, tool-list order
  stability, island retry policy, HTTP-level demo narrative, domain-general
  command shapes, runner-island opt-in, SaaS resource-chain naming, MCP
  product-tool compilation, generic shell mine→replay→steer.


- `bench:loop`: WIN verdict, parallel read loops 4–7.9× faster, A/A clean.
- `bench:guard`: WIN verdict, guarded thrash −86% spend (−103..−71% CI),
  A/A clean.
- `typecheck.sh`: clean.
