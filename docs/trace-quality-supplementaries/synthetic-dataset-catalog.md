# Synthetic Trace Dataset — Catalog & Test Harness Reference

**Purpose:** Single canonical reference for the 30-trace synthetic dataset
(`tests/fixtures/traces/synthetic/`) that anchors Phase 0–11 testing.
The main spec §7 references this dataset but does not enumerate it.

**Audience:** Engineers implementing or extending any of the 11 phases.
Read this before writing tests.

**Status:** v1.0 — ready for use.

---

## 0. Why a Catalog

The 30 traces × 10 archetypes × 3 variants are the *only* ground-truth
artefact the entire system shares. Every phase reads from these to verify
its detector works on the canonical failure modes. A wrong reading here
breaks F1 across all phases.

This document enumerates every trace, its archetype, the ground-truth
fields, and the failure mode it stresses. It also documents the schema
for adding new traces and the test-harness invariants that must hold.

---

## 1. Directory Layout

```
tests/fixtures/traces/
    __init__.py                # loader API (load_trace, load_ground_truth)
    synthetic/
        README.md              # generator overview
        traces/
            01_efficient-good-support_01.json
            01_efficient-good-support_02.json
            ...
            10_adversarial-paraphrase-loop_03.json
        ground_truth/
            01_efficient-good-support_01.json
            ...
        _generator/
            generate.py        # deterministic regenerator
        test_loader.py         # 17 smoke tests
```

Loader API (canonical — used by every phase's test suite):

```python
from tests.fixtures.traces import (
    load_trace,
    load_ground_truth,
    load_all_traces,
    load_all_ground_truth,
    SYNTHETIC_TRACES_DIR,    # absolute path
)

trace = load_trace("01_efficient-good-support_01")
gt = load_ground_truth("01_efficient-good-support_01")
all_traces = load_all_traces()          # list[UnifiedTrace]
all_gts = load_all_ground_truth()       # list[GroundTruth]
```

---

## 2. Ground-Truth Schema

Every ground-truth file has 8 fields:

```python
@dataclass(frozen=True)
class GroundTruth:
    trace_id: str                          # "trace_efficient_good_01"
    archetype_id: str                      # see §3 enum
    expected_TAS: int                      # 0-100
    expected_intervention: str             # see §4 enum
    expected_loop_detected: bool
    expected_hallucination_detected: bool
    expected_redundancy_pct: float         # 0.0-1.0
    notes: str                             # human-readable rationale
```

`expected_TAS` is the **post-composite ground truth** (already accounts for
task value score); tests assert `|computed_avs - expected_TAS| <= 5`.

`expected_intervention` uses the 14-action taxonomy from
`guardrails/policy.py` `VALID_ACTIONS` (extended in Phase 4):

```python
INTERVENTIONS: set[str] = {
    "allow",        # no action; metric passes
    "warn",         # tag for review; no block
    "redact",       # PII / sensitive scrub
    "block",        # stop the agent loop
    "escalate",     # notify user/admin
    "skip_step",    # silently skip this step
    "summarize",    # condense before continuing
    "anchor",       # insert grounding reference
    "lazy_recall",  # defer to KB on next step
    "coalesce",     # merge with prior result
    "rewrite",      # typed refusal + retry
    "truncate",     # drop trailing tokens
    "replan",       # back to planner
    "cache",        # memoize the response
}
```

---

## 3. The 10 Archetypes

Each archetype is a *failure mode category*. The 3 variants per archetype
exercise different parameter values (tool names, payload sizes, retry
counts) to verify the detector isn't accidentally tuned to one shape.

| # | Archetype ID | Failure mode | Stress target |
|---|---|---|---|
| 01 | `efficient-good-support` | Healthy agent (control case) | TAS ≥ 85; no intervention |
| 02 | `redundant-repeated-context` | Agent re-sends full context each step | CCE metric; TAS 50-65 |
| 03 | `loop-stuck` | Agent retries same call 5-7× in a row | LoopDetector (Phase 3, 4) |
| 04 | `hallucinating` | LLM invents a number not in source context | HHEM (Phase 5); TAS 60-72 |
| 05 | `slow-cost-overrun` | Single LLM call uses way more tokens than needed | OBS + per-step z-score (Phase 8) |
| 06 | `failing-tool` | Tool consistently errors | TCA metric; TAS 35-50 |
| 07 | `optimal-path-exists` | Agent takes 18 steps where 8 would do | SRR + OBS; TAS 45-55 |
| 08 | `efficient-multi-agent-handoff` | Smooth handoff between 2-3 agents | Cat 6 (Phase 10) — handoffs visible |
| 09 | `output-truncation` | Output cut off mid-response | Finish-reason monitor; TAS 30-45 |
| 10 | `adversarial-paraphrase-loop` | 5 tool names × 5 arg keys; semantically identical | LoopDetector — *the canary test* |

### 3.1 Per-Archetype Failure Mode Detail

**01 — efficient-good-support** (control)
- 1 LLM call, 3 tool lookups, <2K total tokens, <5s end-to-end.
- Expected TAS = 89 (high). No intervention.
- Tests: every detector returns the *trivial-pass* result.

**02 — redundant-repeated-context**
- Each LLM call re-sends the entire conversation history (no delta-only).
- 4-6 LLM calls; each prompt >8K tokens; >40% bloat.
- Expected TAS = 50-65; intervention = `warn`.
- Tests: CCE metric flags bloat; SRR is fine (steps aren't similar, just verbose).

**03 — loop-stuck**
- Agent calls `weather.lookup("sf")` 7 times in a row with identical args.
- Expected TAS = 15-25; intervention = `block`.
- Tests: HashRing + Jaccard + SemanticCosine + Page-Hinkley all trip; ensemble
  verdict = `loop`; LDI ≤ 0.3.

**04 — hallucinating**
- User asks: "What's our NRR?" Source context says 122%. LLM answers
  "144% (top decile)".
- Expected TAS = 67; intervention = `warn` (groundedness check flags,
  but the response is still useful as a draft — human review required).
- Tests: HHEM ≥ 0.5; DeBERTa-NLI flags contradiction; Phase 5 quality score
  says "groundedness = low".

**05 — slow-cost-overrun**
- A single LLM call with max_tokens=8192 for a 200-token question.
- Expected TAS = 55-70; intervention = `warn` (cost z-score fires;
  semantic cache would have caught a near-duplicate).
- Tests: per-step cost z-score (Phase 8d) flags; OBS metric unaffected.

**06 — failing-tool**
- Tool `db.query` returns `crash` 5× in a row with the same args.
- Expected TAS = 35-50; intervention = `block`.
- Tests: TCA metric penalized; CircuitBreaker (Phase 4) opens; finish-reason
  = `crash`.

**07 — optimal-path-exists**
- 4× `github.search` calls before 1× `github.trending`. The answer could be
  reached in 1 search + 1 answer (8 steps not 18).
- Expected TAS = 49; intervention = `warn` (suggest a "shortcut" tool).
- Tests: SRR ∈ [0.40, 0.60] (some redundancy, not a loop); OBS metric
  fine; intervention = warn not block.

**08 — efficient-multi-agent-handoff**
- 3 agents (planner → researcher → critic). Each handoff is clean,
  with `parent_agent_id` set, shared `trace_id`, ≤3s gap between handoffs.
- Expected TAS = 80-90; intervention = `allow`.
- Tests: Cat 6 AgentRelationshipGraph shows 3 nodes + 2 edges; Cat 5 memory
  shows 3 distinct memory writes (no conflict).

**09 — output-truncation**
- LLM response hits max_tokens mid-sentence. Finish reason = `length`.
- Expected TAS = 30-45; intervention = `warn` (or `replan`).
- Tests: FinishReasonMonitor fires; Coherence drops on the truncated tail;
  Phase 9 reasoning score flags incomplete.

**10 — adversarial-paraphrase-loop** (the canary)
- 6 semantically-identical email-send calls with:
  - 5 tool names: `send_email`, `dispatch_mail`, `post_message`,
    `transmit_message`, `deliver_note`
  - 5 arg keys: `to`/`recipient`/`addr`/`address`/`target`
  - 5 arg value keys: `subject`/`title`/`re`/`topic`/`heading`
- Naive exact-hash detectors MISS this. Synonym-canonicalisation
  (`_SYNONYM_MAP` in algorithm-detail-tracerazor.md §1.3) CATCHES it.
- Expected TAS = 27; intervention = `block`.
- Tests: SRR ≤ 0.4; LoopDetector ensemble trips via Jaccard + SemanticCosine
  (detectors 2 + 3) — Detector 1 alone MISSES it.

---

## 4. Test Harness Invariants

The 17 smoke tests in `test_loader.py` enforce:

1. **Exactly 30 traces** in `traces/` (10 archetypes × 3 variants).
2. **Exactly 30 ground-truth files** in `ground_truth/`.
3. **All `trace_id` fields unique**.
4. **Every `archetype_id` is in the canonical 10-element set**.
5. **Every `expected_TAS` ∈ [0, 100]**.
6. **Every `expected_intervention` is in the 14-element set** (§2).
7. **Schema-valid**: `load_trace()` returns a `UnifiedTrace` per
   `insights/unified_trace_model.py`.
8. **Deterministic regeneration**: running `_generator/generate.py` twice
   produces byte-identical output.
9. **At least one trace per archetype exercises the failure mode** (e.g.,
   `_03_loop-stuck_*.json` actually contains ≥3 identical consecutive
   tool calls).
10. **Variant diversity**: across 3 variants of one archetype, at least 2
    of {tool_name, arg_keys, retry_count, payload_size} differ.

Phases 2-9 ADD additional tests on top of these 17; the smoke tests are
the floor.

---

## 5. Per-Archetype Test Matrices

The 30 traces × 11 phases = 330 potential test cases. The table below
distills which combinations are required (✅) vs optional (🟡).

| Archetype | Phase 1 schema | Phase 2 TAS | Phase 3 loop | Phase 4 guard | Phase 5 quality | Phase 6 stat-gate | Phase 7 detect | Phase 8 cost | Phase 9 reason | Phase 10 mem/multi | Phase 11 bench |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 efficient-good | ✅ | ✅ | ✅ (false positive test) | ✅ (false positive test) | ✅ (false positive test) | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 02 redundant-ctx | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | 🟡 | ✅ (CCE penalty) | 🟡 | ✅ | ✅ |
| 03 loop-stuck | ✅ | ✅ | ✅ (must trip) | ✅ (must trip) | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| 04 hallucinating | ✅ | ✅ | ✅ | ✅ (warn) | ✅ (must flag) | 🟡 | ✅ (sycophancy) | 🟡 | ✅ (low goal-align) | ✅ | ✅ |
| 05 slow-cost-overrun | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | 🟡 | ✅ (z-score must fire) | 🟡 | 🟡 | ✅ |
| 06 failing-tool | ✅ | ✅ | 🟡 | ✅ (circuit break) | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| 07 optimal-path | ✅ | ✅ (45-55) | ✅ | 🟡 | ✅ | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | ✅ |
| 08 multi-agent | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | ✅ (handoff) | 🟡 | ✅ (handoff reasoning) | ✅ (must register 3 handoffs) | ✅ |
| 09 output-truncation | ✅ | ✅ | ✅ | ✅ (finish monitor) | ✅ | 🟡 | 🟡 | 🟡 | ✅ (coherence drop) | 🟡 | ✅ |
| 10 adversarial-para | ✅ | ✅ | ✅ (the canary) | ✅ (must NOT pass through block silently) | ✅ | 🟡 | ✅ (multi-turn escalation) | 🟡 | ✅ | 🟡 | ✅ |

Required (✅) combinations are tested in the per-phase test file. Optional
(🟡) combinations are sanity checks — they catch regressions but a
detector can pass without strictly covering them.

---

## 6. Adding New Traces (Extension Pattern)

To add a new archetype (e.g., `11-confused-multi-tool`):

1. Write 3 trace variants to `traces/11_confused-multi-tool_{01,02,03}.json`
   following `UnifiedTrace` schema.
2. Write 3 ground-truth files to `ground_truth/` with all 8 fields.
3. Update `_generator/generate.py` with the new archetype's recipe.
4. Add a row to §3 of THIS document.
5. Add a row to §5 of THIS document.
6. Re-run `test_loader.py` — must still pass all 17 smoke tests + the
   new variant checks.

To add a new variant to an existing archetype (e.g., a 4th `_03` variant):

1. Write `traces/03_loop-stuck_04.json` + `ground_truth/03_loop-stuck_04.json`.
2. Re-run `test_loader.py` — the variant-diversity check (invariant #10)
   now requires ≥2 of {tool_name, arg_keys, retry_count, payload_size}
   to differ across the 4 variants (so at least 1 must be a *new* shape).
3. Update §5 row for archetype 03 if the new variant covers new phases.

---

## 7. Generator Determinism

`_generator/generate.py` is **deterministic** — no `random.random()`
without a seeded `random.Random(seed)`. Every run with the same seed
produces byte-identical output. This is verified by:

```bash
python tests/fixtures/traces/synthetic/_generator/generate.py > /tmp/a.json
python tests/fixtures/traces/synthetic/_generator/generate.py > /tmp/b.json
diff /tmp/a.json /tmp/b.json  # must be empty
```

If a generator change causes non-determinism, `test_loader.py:14` fails.

---

## 8. Failure Mode Coverage Matrix (Risk Coverage)

The 10 archetypes map to risk categories. Each risk must be covered by
*at least one* trace or the system has a blind spot.

| Risk | Archetype(s) | Detector | Phase |
|---|---|---|---|
| Runaway cost | 05 | Per-step cost z-score | 8d |
| Runaway loop | 03, 10 | LoopDetector ensemble | 3 |
| Hallucination to user | 04 | HHEM + DeBERTa-NLI | 5 |
| Sensitive data leak | (not covered — add `12-pii-leak`) | PIIFirewall (existing Cat 10) | (existing) |
| Stalled agent | 03, 09 | StuckDetector + FinishReasonMonitor | 4 |
| Adversarial bypass | 10 | LoopDetector + multi-turn escalation | 3, 7d |
| Suboptimal path | 07 | SRR + CCE | 2 |
| Tool failure | 06 | TCA + CircuitBreaker | 4 |
| Multi-agent deadlock | 08 (and add `13-multi-agent-deadlock`) | BlackboardUtilizationAnalyzer | 7i |
| Reasoning failure | 04, 09 | Phase 9 reasoning | 9 |
| Memory bloat | (not covered — add `14-memory-bloat`) | MemoryBloatMonitor | 7h |
| Output truncation | 09 | FinishReasonMonitor + Phase 9 coherence | 4, 9 |

**Open gaps** (as of v2.0):
- PII leak archetype (gap from existing Cat 10 governance, not Phase 7)
- Multi-agent deadlock archetype
- Memory bloat archetype

These should be added in a Phase 0.5 follow-up before customer pilots.

---

## 9. Per-Trace Quick-Reference (30 traces)

For fast lookup during debugging. Every row links to the canonical file.

| File | Archetype | TAS | Intervention | Loop | Halluc | Notes |
|---|---|---|---|---|---|---|
| 01_efficient-good-support_01 | efficient-good | 89 | allow | false | false | 1 LLM + 3 tool lookups |
| 01_efficient-good-support_02 | efficient-good | 88 | allow | false | false | 2 LLM + 2 tool lookups |
| 01_efficient-good-support_03 | efficient-good | 91 | allow | false | false | 0 LLM (cache hit) + 1 tool |
| 02_redundant-repeated-context_01 | redundant-ctx | 52 | warn | false | false | 5 LLM, 12K tokens each |
| 02_redundant-repeated-context_02 | redundant-ctx | 55 | warn | false | false | 4 LLM, 8K tokens each |
| 02_redundant-repeated-context_03 | redundant-ctx | 60 | warn | false | false | 3 LLM, mixed sizes |
| 03_loop-stuck_01 | loop-stuck | 18 | block | true | false | 7× weather.lookup retries |
| 03_loop-stuck_02 | loop-stuck | 22 | block | true | false | 5× db.query retries |
| 03_loop-stuck_03 | loop-stuck | 15 | block | true | false | 8× email.send retries |
| 04_hallucinating_01 | hallucinating | 67 | warn | false | true | 144% NRR vs source 122% |
| 04_hallucinating_02 | hallucinating | 64 | warn | false | true | 3 fabricated citations |
| 04_hallucinating_03 | hallucinating | 70 | warn | false | true | Wrong date (off by 1 year) |
| 05_slow-cost-overrun_01 | slow-cost-overrun | 58 | warn | false | false | 8192 tokens for 200-token Q |
| 05_slow-cost-overrun_02 | slow-cost-overrun | 62 | warn | false | false | 4096 tokens for 300-token Q |
| 05_slow-cost-overrun_03 | slow-cost-overrun | 67 | warn | false | false | 16384 tokens (tool result echo) |
| 06_failing-tool_01 | failing-tool | 38 | block | false | false | 5× db.query crash |
| 06_failing-tool_02 | failing-tool | 42 | block | false | false | 3× http.get 503 + 2× retry |
| 06_failing-tool_03 | failing-tool | 35 | block | false | false | 4× auth.timeout + 1× success |
| 07_optimal-path-exists_01 | optimal-path | 49 | warn | false | false | 4× github.search + 1× trending |
| 07_optimal-path-exists_02 | optimal-path | 47 | warn | false | false | 5× slack.search + 1× message |
| 07_optimal-path-exists_03 | optimal-path | 53 | warn | false | false | 3× web.search + 1× summary |
| 08_efficient-multi-agent-handoff_01 | multi-agent | 84 | allow | false | false | planner→researcher→critic |
| 08_efficient-multi-agent-handoff_02 | multi-agent | 87 | allow | false | false | 2-agent cooperation |
| 08_efficient-multi-agent-handoff_03 | multi-agent | 81 | allow | false | false | orchestrator + 3 workers |
| 09_output-truncation_01 | truncation | 32 | replan | false | false | max_tokens hit mid-sentence |
| 09_output-truncation_02 | truncation | 38 | warn | false | false | JSON parse cut |
| 09_output-truncation_03 | truncation | 30 | replan | false | false | code block cut |
| 10_adversarial-paraphrase-loop_01 | adv-para | 27 | block | true | false | 6× email.send (5 names × 5 keys) |
| 10_adversarial-paraphrase-loop_02 | adv-para | 25 | block | true | false | 7× with mixed tool names |
| 10_adversarial-paraphrase-loop_03 | adv-para | 29 | block | true | false | 5× + 2× legit + 3× adv |

---

## 10. References

- `tests/fixtures/traces/synthetic/README.md` — generator overview
- `tests/fixtures/traces/synthetic/_generator/generate.py` — regenerator
- `tests/fixtures/traces/synthetic/test_loader.py` — 17 smoke tests
- `src/eden/insights/unified_trace_model.py` — `UnifiedTrace` schema
- `src/eden/guardrails/policy.py:82` — `VALID_ACTIONS` (extended by Phase 4)

**Status:** Ready for use. Add `expected_reasoning_score: float` field to
ground-truth schema when Phase 9 lands.