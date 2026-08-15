# Evolution iteration protocol

1. Run `python -m bench.evolution.run --suite smoke` on every PR touching evolution/Artifacts/Ledger.
2. Run `--suite full` nightly; archive scorecard JSON in CI artifacts.
3. Auto-backlog rules:
   - success lift < 5% **or** user $/success > threshold → tighten composer / retrieval k / author.
   - FP fires > 10% → raise EvidenceGate n / tighten triggers.
   - Ledger tokens high, lift flat → lower soft cap / raise similarity floor.
   - Eden ops $/candidate > $0.05 → force more template paths, less LLM.
   - value score median falling → demote weak Artifacts, raise merge aggressiveness.
4. Each iteration = small PR + before/after scorecard in PR body.
5. Wider preview only after **2 consecutive** full runs pass gates.

Cost gates (smoke):
- Combined inject never exceeds `inject_budget_hard_tokens` (default 1200).
- Hot-path gateway filters perform 0 LLM calls in harness.
