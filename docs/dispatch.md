# Dispatch — many tools, zero catalog

**Status:** Wave 11 shipped the JIT catalog endpoint: `tools/list` and wrap `resources/list` are empty; `tools/dispatch` / `POST /v1/dispatch` return ≤1 schema or `[]`. Same scorer as local JIT (`dispatchPrograms`). Hosted load-probe still W=100 zero dups (`benchmarks/campaign/hosted-dispatch.ts`). `EDEN_SURFACE` default stays `all` — Wave 19 remeasured `bun run bench:jit-soak` as FAIL (`precision=0.789 n=38`). MCP is the adapter. A known `resources/read` URI still serves the program JSON; listing does not enumerate it.

---

## 1. The problem, evidenced

Putting a tool catalog in front of a model degrades along two axes at once:

| Symptom | Evidence |
|---|---|
| Token tax | A function schema costs 150–400 tokens. 50 tools ≈ 15k tokens **per request**, before any task work. Multi-server setups routinely carry 50k–200k schema tokens. |
| Selection accuracy cliff | Selection error rises non-linearly past ~20–30 visible schemas; one instrumented benchmark measured **13.6% baseline selection accuracy** on a large catalog, recovering to 43% only by retrieving a small subset first. Anthropic's own Tool Search data shows accuracy drops sharply beyond 30–50 visible tools. |
| Attention dilution | Schemas compete with task content for attention; agents hedge, double-call, hallucinate parameter chimerae. |
| Cache churn | A catalog reordered by anything volatile (usage counts!) invalidates provider KV-cache from that position back — the reason `plan.ts` emits alphabetically. |
| The search-tax paradox | Dynamic discovery ("tool search") fixes tokens but adds a failure mode: **the model forgets to search**, or searches badly, then hallucinates a call to a tool that isn't loaded. |

Eden had the same disease in two places:

- `apps/site/src/mcp.ts` used to cap `tools/list` at **6** (`MCP_LIST_LIMIT`) — a hard ceiling that starved the library. Wave 11 emptied `tools/list` and scores the **whole** live set on `tools/dispatch` (still ≤1 schema out).
- `packages/wrap/src/steer.ts :: injectTools()` appends **every live program** when `EDEN_SURFACE=all` (still the default after jit-soak FAIL). Ten approved programs are fine; two hundred are the 15k-token tax. Opt into `jit` / `none` to stop paying it.

So today Eden must choose: serve few tools (starve the library) or many tools (pay the tax). Both halves of that trade are wrong, because both assume **the model must be able to see a tool to call it**.

## 2. The core insight

Eden does not need the model to choose its tools, and largely already doesn't.

**Industry validation (Aug 2026):** the catalog-in-context model is failing everywhere at once. Anthropic Tool Search: 77k → 8.7k tokens (−85%) with accuracy *rising* (Opus 4: 49%→74%; Opus 4.5: 79.5%→88.1%). Cloudflare Code Mode: −98.7% tokens by replacing schemas with agent-written code. Cursor dynamic context: −46.9% total agent tokens. BFCL v4: every model drops 5–10 pts multi-turn vs single-turn. The field is converging on progressive disclosure — metadata thin, capability on demand. Dispatch is Eden's version, with one structural advantage none of those have: **our runtime can rewrite the call after the fact**, so routing correctness never depended on the model's choice to begin with.

`steerToolCalls()` intercepts the model's *natural* behavior — the loop it was about to write by hand — and rewrites it into the compiled call, gated by witness envelopes that fail closed. Matching is structural (name prefix, exact argument-shape signature, shell-template slot recovery), never fuzzy, and every rewrite is stamped `matched_by` on the wire. The routing layer already knows which program a moment calls for **without asking the model**.

That means the catalog can live entirely in the runtime. The model's context carries (almost) nothing; the correct compiled call happens anyway; and when the model's own choice would be wrong, the envelope refuses instead of guessing.

**Dispatch is the generalization of steering from "correct the call after" to "route the moment before."**

### Hypothesis register (each validated through `packages/measure` before any claim)

- **H1 — Abstention beats always-answer.** A deterministic gate that stays silent without structural evidence, plus reactive steering backstop, yields higher end-to-end precision than any always-surface router. Measure: routing precision + wasted-schema-token rate vs an always-top-k baseline.
- **H2 — Instructions convert.** A surfaced schema carrying a one-line "replaces: <the loop>" converts surfaced→executed meaningfully better than a bare schema. Measure: conversion A/B (roadmap 67).
- **H3 — Episodes, not turns.** Pinning the route per episode (roadmap 66) recovers most of the multi-turn degradation BFCL documents, because Eden removes per-turn decisions entirely. Measure: re-route churn per episode ≈ 0; precision stable across turn count.
- **H4 — Code beats catalogs for coding agents.** Exposing programs as a readable reference + one typed function (code-mode dispatch, roadmap 70) matches JIT precision at lower token cost, because coding agents already live in files — disclosure is free. Measure: parity gate then token arm.
- **H5 — Tasks declare themselves.** Scoring the first user message alone surfaces correctly in the large majority of eventual routes; speculative first-turn surfacing (roadmap 69) therefore pays for its cache cost. Measure: first-turn recall of eventual best program.
- **H6 — Routing quality is maintainable copy.** Treating `when_to_use`/instruction text as versioned, Approved artifacts (roadmap 71) raises precision week over week; frozen metadata decays. Measure: precision trend after the copy loop ships.

## 3. Architecture: four tiers, one guarantee

### Tier 0 — Silent catalog (0 schema tokens) — **shipped** (`EDEN_SURFACE=none`)

All approved programs live only in the proxy/runtime. The model sees **zero** Eden schemas. Routing is purely reactive: the model works naturally; when a raw call matches a program (existing gates: name prefix → arg-shape → template-slot recovery), the proxy steers. Verified end-to-end: under `none`, a proxied request carries only the client's own tools upstream while steering still fires on raw calls (pinned in `packages/wrap/src/intent.test.ts`).

- Cost to context: **0 tokens**, always. KV-cache untouched.
- Coverage: every stretch whose first step the agent writes naturally — which is exactly the population compilation mines from.
- Ships from existing code: this is `injectTools()` returning `tools` untouched plus `steerToolCalls()` active. The feature is the *default*, not the machinery.

### Tier 1 — Just-in-time single-tool surfacing (~150–400 tokens, only when it pays) — **scorer shipped** (`EDEN_SURFACE=jit` / `jit-shadow`)

Reactive steering alone wastes the first few steps: the model starts writing the loop before any raw call matches. The proxy sees the full message stream on every request (it already parses bodies for both dialects), so it can predict. Implemented as a **deterministic scorer** in `packages/wrap/src/intent.ts` — no embeddings, no model call, test-pinned:

| Evidence | Score | Notes |
|---|---|---|
| Shape hit — a URL/CLI shape from recent messages equals one of the program's first-step witness shapes | +4 | Same extraction pipeline steering uses, so both sides land on one spelling |
| Template fit — program's shell template structurally fits a command in the conversation | +3 | Same binary, arity, flags (`templateFits`) |
| Token overlap — informative words shared between program name/sequence and text | ≤ +2 | Stop-worded; **alone can never surface anything** |

`MIN_SCORE = 3`: concrete structural evidence required. Exactly **one** schema injected per request, appended after client tools. No evidence → inject nothing. `jit` without a readable conversation → silence, never the catalog. A scorer fault inside selection → silence; a fault inside the handler entry (`selectForRequest`) → degrade to the historic full catalog (steering unaffected either way). Shadow mode (`jit-shadow`) behaves as `none` and logs `[eden] intent-shadow: would surface <name>` — the precision telemetry that earns jit's rollout (target ≥ 95% before enabling anywhere).

This is the anti-tool-search: instead of teaching the model to fetch its own tools (and trusting it to remember), the **runtime decides visibility deterministically**. The model simply finds the right tool already there at the moment of need — which is also why the "forgot to load it" failure mode cannot occur.

### Tier 2 — Deterministic correction (already shipped)

If the model ignores the surfaced tool and writes the loop by hand anyway: `steerToolCalls()` rewrites it, siblings naming later steps are suppressed, the envelope validates input, and the receipt records `matched_by: name | argshape | template`.

### Tier 3 — The escape hatch (~100 tokens, opt-in)

One permanent meta-tool, `eden_find`, with a one-line description ("Eden compiles repeated sequences; describe the job to find a compiled tool"). Returns ≤ 3 compact cards (name, one-line what-it-replaces, arg names). For long-tail moments the scorer misses. Disabled by default; enabled per workspace.

### The always-right guarantee (layered, not hopeful)

No single mechanism carries the claim; five independent layers do:

1. **Precision** — a program executes only inside its witnessed envelope; out-of-distribution input fails closed with a structured, named reason. A wrong route is *refused*, never guessed.
2. **Recall ladder** — name prefix → arg-shape equality → shell-template slot recovery → intent scorer → optional gpt-5.6-luna classifier behind a confidence gate (Tier 1.5, flag-gated, shadowed before enablement).
3. **Correction** — even a missed surfacing is recovered reactively by steering.
4. **Suppression** — sibling calls that name later steps of the matched stretch cannot double-execute the work.
5. **Auditability** — every route decision (surfaced, steered, suppressed, refused) is a `TraceEvent.skipped` / receipt entry carrying `matched_by` and the program version hash. "Always right" is therefore *measurable*: **routing precision** = steered-or-surfaced-and-executed / total route opportunities, reported per workspace alongside DC%.

## 4. Efficiency math (honest accounting)

Scenario: 120 approved programs, typical session touching 6 of them.

| Strategy | Schema tokens/request | Selection risk |
|---|---|---|
| Static catalog (MCP or `injectTools`) | ~24k–48k, every request, all 120 impossible → capped at 6 | Cliff territory; library starved |
| Tool search / deferred loading | ~500 flat + retrieval round-trips; risk: forgot-to-search | Medium |
| **Dispatch Tier 0** | **0** | None (model never chooses) |
| **Dispatch Tier 1** | **0** on unmatched turns; ~150–400 on matched turns | Low (one schema, at the moment of need, envelope-gated) |

Per-session schema-token spend drops from tens of thousands to hundreds, the 6-tool ceiling is gone (all 120 routable), and selection quality improves because the model's decision space is one tool it demonstrably needs rather than dozens it might.

## 5. What happens to MCP

Demoted to an **adapter**, kept for three legitimate audiences: third-party agent hosts we can't proxy, the official registry listing (discovery of Eden itself), and enterprise gateways. Changes:

- The hosted server gains a **dispatch profile**: `tools/list` exposes the Tier 3 meta-tool plus at most the current popularity-capped six; a `listChanged` flow can swap the surfaced tool mid-session for clients that support it (capability is already declared in `mcp.ts`).
- Server Card (SEP-2127) advertises Eden as a dispatch server so sophisticated clients negotiate the thin surface deliberately.
- No new capability is MCP-first again. If a feature can only be delivered through a fat catalog, that is a sign it belongs in the proxy.

## 6. UX integration

- **Workflow settings → Surface policy:** `Silent (recommended)` / `Just-in-time` / `Always visible` / per-workflow override of the workspace default. Copy explains the token trade in one sentence; the setting renders next to Pause/Resume on the canvas header.
- **Receipt drill-in (row 51 convention):** routed runs show "routed by: arg-shape · version 9f3c…" inline; refused routes show the named envelope miss. Same screen, same words (skipped / degraded / failed).
- **Dashboard:** two numbers join the strip — **routing precision %** and **schema tokens avoided** (measured: client's tool count × avg schema size × requests, minus actual injections; labeled estimate until measured end-to-end).
- **Requests inbox:** a scorer-miss that steering later caught becomes a card ("we surfaced nothing; the steer caught it — tighten `when_to_use`?"), turning routing failures into copy-improvement tasks for the human. Approval ritual extended, not bypassed: improving `when_to_use` text is a versioned, re-approved edit like any other.
- **Setup prompt (13):** three lanes — `eden init` (hooks), base-URL proxy (**dispatch default**), MCP adapter. One line each; the proxy lane states "your tools stay invisible until the moment they're needed."
- **Canvas node detail:** adds a "routes" section — recent matched_by breakdown for this program (name / shape / intent), feeding directly into envelope-editor work (roadmap 44).

## 7. Rollout & failsafes

**Implementation status:** Tier 0, the Tier 1 scorer, both proxy wirings, injection-rate guards (`EDEN_JIT_MAX`), and hosted POST-transcript dispatch are shipped. Default remains `all` because Wave 19 jit-soak printed FAIL (`precision=0.789 n=38`). Unique-work empty-catalog held. Remaining: live shadow-precision aggregation on production traffic (stderr + soak fixture exist; two-week live window is still the flip gate).

1. **Ship Tier 0 as default-off flag** (`EDEN_SURFACE=none`) — done; observe-mode doctrine intact: with the flag off, nothing changes for existing users.
2. Shadow the intent scorer for two weeks against live traffic: log what it *would* surface; precision target ≥ 95% before Tier 1 enables anywhere. The scorer is deterministic and test-pinned; the LLM classifier (1.5) is opt-in per workspace and only ever *adds* candidates that the envelope still gates.
3. Injection budget guards: max injections/episode, min turns-between-injections, auto-disable per workflow if surfaced-tool-execution rate falls below threshold (surfacing that never converts is pure cache cost — measure and stop).
4. Prime directive holds throughout: scorer throw, matcher bug, corrupt metadata → degrade, never fail the request (pinned: corrupt programs score zero and are skipped; a throwing program list still serves traffic). A broken Dispatch costs savings, never correctness.
5. Benchmarks extend `packages/measure`: a routing suite (precision/recall of the ladder over recorded traffic replays, token counts per arm) gated like every other number before any landing-page claim.

## 8. Non-goals

- No embedding index over tool descriptions in v1 (deterministic signals first; add semantic retrieval only if the recall data demands it, shadowed).
- No mega-tool (`eden_execute(intent)`-style union schemas) — they trade catalog bloat for schema ambiguity and worse validation errors.
- No autonomous tool-authoring surface; Dispatch routes *approved* programs, full stop.
- Not a replacement for the client's own tools; Dispatch only ever manages Eden's.

---

## 9. Shadow precision telemetry — event schema (roadmap 65)

Every scorer decision becomes one counted event. Stderr logging was the scaffold; this is the instrument.

```jsonc
// dispatch.shadow_event  — one per request where a surface decision was made
{
  "ts": 1756166400000,
  "workspace": "ws_…",            // tenant-scoped like everything else
  "mode": "jit-shadow",           // policy in force at decision time
  "episode": "ep_…",              // stable id across one task/session
  "turn": 3,

  "decision": {
    "surface": "github_pr_bundle" | null,   // ≤1 name; null = silence
    "runner_up": "kubectl_get_pods",        // for threshold tuning only
    "score": 7,
    "via": "shape" | "template" | "tokens",
    "margin": 4                              // score gap to runner-up
  },

  "outcome": {                    // filled by later events in the episode
    "surfaced_executed": true|false|null,   // did the model call what we surfaced?
    "steered_anyway": true|false|null,      // did reactive steering rewrite a raw call?
    "envelope_refused": false,              // wrong-route attempt that fail-closed
    "raw_loop_written": false               // agent wrote the loop by hand uncorrected
  },

  "program_version": "9f3c…",     // metadata version when decided (71 edits bump this)
  "schema_tokens": 214             // what injection would have cost this turn
}
```

**Pairing rule:** an outcome attaches to the *latest* prior decision event in the same episode mentioning the same program. Unpaired decisions after N turns count as `no_interest` — surfaced and ignored with no steering either way, the worst outcome class.

**Aggregations (per program / day):**
- **Precision** = surfaced_executed ÷ (surfaced_executed + raw_loop_written + envelope_refused). The rollout gate number.
- **Recall proxy** = (surfaced_executed + steered_anyway) ÷ all route opportunities. Feeds the copy loop (71).
- **Silence quality** = decisions with `surface: null` that produced no Eden-relevant activity. High and rising = the gate is honest.
- **Margin distribution** — if most correct surfaces win by ≤1 point, the threshold is too low; if misses had high runner-up scores, the ranking needs work.

**UX:** internal dashboard view first (per-program precision bars, worst-offenders list). Public aggregate only once the numbers are real. Every display obeys rule 1: counts or "not enough data yet."

---

## 10. Code-mode dispatch — `eden.tools.md` spec (roadmap 70)

For coding agents the schema never enters the request at all. Eden generates one file into the workspace:

```markdown
<!-- ~/.eden/tools.md — generated by eden v<hash>. Do not edit; regenerate. -->
# Compiled tools (human-approved, deterministic)

Call via `eden.run(name, args)` (CLI: `eden run <name> '<json>'`).
Results carry receipts; out-of-envelope inputs are refused, not guessed.

## github_pr_bundle — replaces: looping gh pr view/reviews/status per PR
args: { repo: string, ids: string }   // ids: csv of PR numbers
returns: rows[{ number, title, reviews, status }]
witnessed on: repos/acme/* · freshness: live every call

## kubectl_get_pods — replaces: kubectl get pods parsing loops
args: { namespace: string }
...
```

**Properties:**
- **One line of context per program**, and only when the agent opens the file — progressive disclosure with zero request-time cost. A 200-program library costs nothing until read, then ~10–30 tokens each.
- The `replaces:` line is the H2 instruction, authored at Approve (roadmap 67) and versioned with the program.
- `eden.run` hits the identical execution path as MCP/wrap: envelope check → runtime → receipt → skip ledger. One engine; the file is just another front door.
- **Regeneration is content-addressed**: file header carries the program-set hash; agents can detect staleness (`eden tools --check`). Regenerated on Approve/pause/rollback.
- **Security:** the file contains arg shapes and witnesses' *shapes*, never witness values beyond what the contract strip already declares; secrets stay redacted at the same boundary as everywhere else.
- **Done-when:** parity with JIT on routing precision in the measure suite, at strictly lower schema-token cost; coding-registry agents pick the file up unprompted in dogfood runs.

---

## 11. Rollout gates & kill criteria

| Tier | Gate to advance | Kill criteria (auto-demote to previous tier) |
|---|---|---|
| jit-shadow → jit | Precision ≥ 95% over ≥ 2 weeks of real traffic; ≥ 100 decisions; margin analysis clean | Precision < 90% trailing week, or any envelope_refused cluster traceable to one program |
| jit healthy | Surfaced→executed conversion ≥ 50% | Conversion < 25% trailing week (surfacing that never converts is pure cache cost), or > 3 injections/episode observed |
| semantic tier on top | Recall lift ≥ +5pts at equal precision in shadow | Any precision regression vs deterministic-only arm |
| speculative first-turn | First-turn recall ≥ 70% of eventual routes | Cache-cost-per-converted-surface exceeds jit-reactive cost |
| code-mode | JIT-parity precision, lower tokens | Agents ignore/can't find the file in dogfood (discoverability failure ≠ feature failure — fix placement before killing) |

All gates computed from §9 aggregations — never from opinion. Demotion is automatic and visible ("Dispatch demoted to Silent: precision fell below floor" banner on the workflow).

---

## 12. Benchmark suite design (extends `packages/measure`)

New arms, same discipline (paired blocks, counterbalancing, A/A checks, permutation p):

| Arm | Setup | Measures |
|---|---|---|
| catalog-N | N ∈ {6, 20, 50} schemas statically injected (the old world) | tokens/request, selection accuracy, wrong-tool rate |
| tool-search | deferred loading + search primitive | tokens, forgot-to-search rate |
| dispatch-none | silent catalog + steering only | tokens, end-to-end savings, first-waste latency |
| dispatch-jit | scorer + single injection | precision, conversion, tokens vs catalog arms |
| dispatch-code | tools.md + eden.run | precision parity, token floor |

Paired on recorded traffic replays plus the synthetic campaign worlds. Headline candidates (only after WIN): *"0–400 schema tokens instead of 15,000"* and *"routing precision X% at Y× fewer selection decisions."* LOSS anywhere = fix or roll back before any landing-page word changes (rule: 26 owns public claims).

---

## 13. Edge cases & abuse

- **Prompt-injected tool bait:** a malicious web page instructs the agent to call `eden.run("send_money", …)`. Answer: envelopes still refuse unseen inputs; mutating programs keep their contract strip and exactly-once guarantees; Dispatch adds no new authority — it only chooses among already-approved programs. Documented, test-pinned.
- **Scorer gaming via conversation text:** an attacker salts messages with URL shapes to force a surfacing. Worst case: the wrong-but-approved tool's envelope refuses the input (fail closed) and the event lands in the precision denominator. No path from salted text to execution outside witnessed distributions.
- **Metadata staleness:** programs whose `when_to_use` predates a world change will miss (recall loss, not precision loss); drift fingerprints (52) demote them, the novelty feed re-mines them, and the copy loop (71) repairs them.
- **Multi-tenant leakage:** selection inputs are the requester's own conversation; program metadata is workspace-owned. Nothing cross-tenant enters a scoring pass (same isolation page claims as 59).
- **Cold start:** zero approved programs → Dispatch is a no-op by construction; setup prompt stays honest ("nothing compiled yet — run your agent normally").
