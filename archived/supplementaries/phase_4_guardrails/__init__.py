"""Phase 4 — TrajectoryGuardrail orchestrator.

8 hot-path checks (<1ms CPU target each):
  CostGuard, TokenGuard, LoopGuard, ToolDedup, RetryStormGuard,
  SchemaValidator, LatencyGuard, ConfidenceGuard.

4 async advisory (fire-and-forget per step):
  OutputEmbeddingAnomaly, ReasoningSelfSimilarity,
  OutputLengthGuard, UserPromptDedup.

Action precedence (most-restrictive-first):
  ``BLOCK > STOP > ESCALATE > TRUNCATE > REPLAN > REWRITE >
   COALESCE > SUMMARIZE > CACHE > SKIP_STEP > WARN > OK``.

Also hosts the ``§12.6`` ``policy_extension`` helper that widens
``eden.guardrails.policy.VALID_ACTIONS`` from the legacy 5-action
set to the 14-action spec set.
"""
