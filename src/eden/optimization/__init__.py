"""Eden Cost Optimization Layer (Phase 6.1).

Provides:
- Intelligent model routing with tiered fallback (T1→T2→T3)
- Multi-layer caching (L1 exact-match Redis, L2 semantic Qdrant)
- Token optimization (prompt compression, context window management)
- Request coalescing and deduplication
- Granular cost tracking and attribution
"""

from eden.optimization.cache import ExactMatchCache, SemanticCache
from eden.optimization.coalescer import RequestCoalescer
from eden.optimization.cost_tracker import BudgetExceededError, BudgetStatus, CostEvent, CostTracker
from eden.optimization.model_router import (
    ModelRouter,
    ModelTier,
    QualityValidator,
    TaskClassifier,
    ValidationResult,
)
from eden.optimization.token_optimizer import ContextWindowManager, PromptCompressor

__all__ = [
    "ModelRouter",
    "ModelTier",
    "TaskClassifier",
    "QualityValidator",
    "ValidationResult",
    "ExactMatchCache",
    "SemanticCache",
    "PromptCompressor",
    "ContextWindowManager",
    "RequestCoalescer",
    "CostTracker",
    "CostEvent",
    "BudgetStatus",
    "BudgetExceededError",
]
