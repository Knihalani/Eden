"""Phase 11 — 8-category benchmark suite.

Categories and their single-letter aliases in the spec:
  F — FuncCallScore      (function-call accuracy)
  P — PolicyScore         (policy state-diff)
  W — WebScore            (web tool accuracy)
  C — CodeScore           (code patch quality)
  D — DriftScore          (output distribution drift)
  R — RecoveryScore       (recovery after error)
  T — TrustScore          (verification marker density)
  K — CostScore           (cost efficiency)

``run_aggregate_benchmark`` folds the eight category scores into
one ``BenchmarkResult`` with a single headline number and per-axis
breakdowns.
"""
