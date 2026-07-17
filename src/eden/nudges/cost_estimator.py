"""CostEstimator — projected inject $/mo and value score for Artifacts."""

from __future__ import annotations

from dataclasses import dataclass

from eden.config import get_settings
from eden.llmops.inject_budget import estimate_tokens


@dataclass
class CostEstimate:
    tokens_per_match: int
    est_usd_per_match: float
    est_usd_per_month: float
    value_score: float
    fires_per_month: int = 1000


class CostEstimator:
    """Estimate user inject cost and EvidenceGate value score."""

    def __init__(self, *, price_per_1k_tokens: float = 0.003) -> None:
        self.price_per_1k = price_per_1k_tokens

    def estimate(
        self,
        content: str,
        *,
        success_lift_pp: float = 0.0,
        fires_per_month: int = 1000,
    ) -> CostEstimate:
        tokens = estimate_tokens(content)
        usd_match = (tokens / 1000.0) * self.price_per_1k
        usd_month = usd_match * fires_per_month
        value = success_lift_pp / max(tokens, 1) * 100.0
        return CostEstimate(
            tokens_per_match=tokens,
            est_usd_per_match=round(usd_match, 6),
            est_usd_per_month=round(usd_month, 4),
            value_score=round(value, 4),
            fires_per_month=fires_per_month,
        )

    def passes_value_floor(self, value_score: float) -> bool:
        settings = get_settings()
        return value_score >= settings.min_lift_per_100_tokens
