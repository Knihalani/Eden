"""Intelligent model routing — W4-1 compat shim.

The routing implementation now lives in :mod:`eden.llm.client` (W4-1
consolidation).  This module re-exports every public symbol so existing
importers continue to work unchanged.

Dead code removed vs. the pre-W4-1 version:
  - TaskClassifier._llm_classify      (unreachable: T1/T2/T3 share model)
  - TaskClassifier._record_routing    (unreachable: guard always returns early)
  - ModelRouter._get_fallback_chain   (unreachable: tiers_to_try always len-1)
  - Dead branch in classify() for diverged-tier case
"""
from __future__ import annotations

# ── Re-export everything callers depend on ────────────────────────────────────
from eden.llm.client import (
    ClassificationResult,
    ModelRouter,
    ModelTier,
    PipelineTask,
    QualityValidator,
    TaskClassifier,
    TIER_MODELS,
    ValidationResult,
    _chat_tiers_share_model,
    _resolve_cost_attribution,
    _TIER_ORDER,
)

# MaxRetriesExceededError is also defined in eden.llm.client; re-export the
# same object so ``from eden.optimization.model_router import
# MaxRetriesExceededError`` keeps working.
from eden.llm.client import MaxRetriesExceededError  # noqa: F401

__all__ = [
    "ClassificationResult",
    "MaxRetriesExceededError",
    "ModelRouter",
    "ModelTier",
    "PipelineTask",
    "QualityValidator",
    "TaskClassifier",
    "TIER_MODELS",
    "ValidationResult",
    "_TIER_ORDER",
    "_chat_tiers_share_model",
    "_resolve_cost_attribution",
]
