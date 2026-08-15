# Iteration method

## The order

1. Spec + all 10 prompts (read in order, once).
2. Migrations (A) → routes (B) → sidecar (E) → hot-path hooks (F) →
   tests (G) → spec section (H).
3. Within tests: integration → e2e → No-Drop Invariant fixture.
4. After baseline wires end-to-end: pick ≥3 enhancements from
   `09_enhancement_charter.md`, ship them via the Enhancement
   Charter loop.

## Per-step discipline

1. Implement the smallest unit.
2. Run `pytest` (relevant subset).
3. Measure latency (use `tests/load/pytest_benchmark` or just
   `time pytest`).
4. Commit (with a spec section, per `08_spec_propagation.md`).
5. Move on.

## Decomposition rule

If a single deliverable would take >8 hours of focused work,
decompose into 2-3 smaller deliverables. Examples:

- Migration 071 + tenant seeding → 071 schema + 071 seed + 071
  test (3 deliverables).
- Sidecar worker → offset poll + 5-step compute + persist + DLQ +
  Prometheus + health endpoint (6 deliverables).
- Hot-path hooks → one PlanningFramework subclass at a time (5
  deliverables).

## Run order per enhancement

```
1. Pre-register in §29 (no code yet).
2. Branch: git checkout -b enhancement/<slug>
3. Run no-drop: pytest tests/experiments/test_v2_6_acceptance_contract.py
4. Implement on the branch.
5. Run enhancement benchmark: pytest tests/experiments/test_<slug>.py
6. Compute decision rule (≥1 metric ↑, 0 regressions, No-Drop passes).
7a. SHIPPED → merge to main; tag v2.6-baseline-<component>.
7b. REVERTED → close branch; document in §29 enhancement log why.
8. Append row to §29 enhancement log.
```

## Memory rules

- **Favour batch tool calls.** One message with multiple reads /
  greps is faster than serial.
- **Favour `semble` MCP for code search** over raw grep.
- **Mark completed work explicitly.** Each commit / spec section
  lists the files it changed + the test count after the change.
- **If a deliverable is too big for one session**, write a
  checkpoint in §29 with "What is done; what is next; what is
  blocked" and stop.

## Progress reporting

End each session / major step with a 3-paragraph summary:

1. What you shipped (files + tests + spec section).
2. What's left in the dependency graph.
3. Anything you intentionally deferred (with the reason).

If you get blocked, **stop and explain**. The spec + supplementaries
should cover everything.

## What I am NOT asking you to do

- LLM-as-judge at runtime.
- New analytics categories beyond 11 phases + Cat 22.
- Frontend changes. No portal updates.
- A shadow period. The system goes live.
- Auto-apply of high-severity mutating actions by default.
- Speculative features not in the spec.
- Speculative "AI-powered" anything at runtime.
- Replacing a v2.6 component before the No-Drop Invariant fixture
  passes parity check.
- Promoting an enhancement whose metrics didn't all hit the ≥5%
  improvement threshold with 0 regression.

## Stop signal

DONE when the 7 stop conditions in `03_stop_conditions.md` are all
TRUE. Write the §29 handoff note containing (a) what is live, (b)
kill switches OFF by default list, (c) explicitly deferred, (d)
enhancements shipped, (e) final `pytest ... | tail -3` output + `git
status`, then stop.

If you finish and the 7 are NOT all true, you're not done. Continue
until they are.
