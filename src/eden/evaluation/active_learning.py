"""Active-learning sample selection for the labeling queue (FEAT-163).

Ranks candidate labeling items so annotators spend time where labels
add the most information:

1. **Disagreement** — low IAA agreement / high annotator disagreement
   (from ``compute_iaa`` ``per_item``) ranks highest.
2. **Single annotation** — items with exactly one annotation are the
   preferred tiebreaker (second label unlocks IAA); prefer over 0 or
   many.
3. **Model uncertainty** — when a confidence score exists on the item
   payload, prefer lower confidence.

Default queue pop remains FIFO; pass ``strategy=active_learning`` to
opt in (see :meth:`LabelingService.pop`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

PopStrategy = Literal["fifo", "active_learning"]


@dataclass(frozen=True, slots=True)
class RankableLabelingItem:
    """Minimal fields needed to score a labeling candidate."""

    item_id: str
    annotation_count: int = 0
    #: Pairwise agreement in ``[0, 1]`` when 2+ annotations exist.
    agreement: float | None = None
    #: Model / auto-score confidence in ``[0, 1]`` if present on payload.
    model_confidence: float | None = None


def _annotation_count_bonus(count: int) -> float:
    """Prefer exactly one annotation (second label unlocks IAA)."""
    if count == 1:
        return 1.0
    if count == 0:
        return 0.55
    if count == 2:
        return 0.35
    # Many labels already → diminishing value.
    return max(0.05, 0.25 / count)


def _disagreement_score(agreement: float | None, annotation_count: int) -> float:
    """High when annotators disagree; neutral when IAA not yet computable."""
    if agreement is None or annotation_count < 2:
        return 0.35  # no pairwise signal yet — mild prior
    # Clamp then invert: agreement 0 → 1.0 disagreement.
    a = max(0.0, min(1.0, float(agreement)))
    return 1.0 - a


def _uncertainty_score(model_confidence: float | None) -> float:
    if model_confidence is None:
        return 0.4  # neutral prior when no model score
    c = max(0.0, min(1.0, float(model_confidence)))
    return 1.0 - c


def active_learning_score(item: RankableLabelingItem) -> float:
    """Higher score → label sooner.

    Weights favour disagreement, then model uncertainty, then the
    single-annotation tiebreaker (see module docstring).
    """
    disagreement = _disagreement_score(item.agreement, item.annotation_count)
    uncertainty = _uncertainty_score(item.model_confidence)
    ann_bonus = _annotation_count_bonus(item.annotation_count)
    return (3.0 * disagreement) + (1.5 * uncertainty) + (1.0 * ann_bonus)


def rank_for_active_learning(
    items: list[RankableLabelingItem],
) -> list[RankableLabelingItem]:
    """Return items sorted highest-priority first (stable on ties by id)."""
    return sorted(
        items,
        key=lambda it: (-active_learning_score(it), it.item_id),
    )


def select_next_items(
    items: list[RankableLabelingItem],
    *,
    limit: int,
    strategy: PopStrategy = "fifo",
) -> list[RankableLabelingItem]:
    """Select up to ``limit`` items under ``strategy``.

    * ``fifo`` — preserve input order (caller already ordered by created_at).
    * ``active_learning`` — re-rank via :func:`rank_for_active_learning`.
    """
    if limit <= 0:
        return []
    if strategy == "active_learning":
        ranked = rank_for_active_learning(items)
        return ranked[:limit]
    return items[:limit]


def extract_model_confidence(payload: dict[str, Any] | None) -> float | None:
    """Pull a confidence-like score from a labeling item payload if present."""
    if not isinstance(payload, dict):
        return None
    for key in (
        "model_confidence",
        "confidence",
        "score_confidence",
        "auto_confidence",
    ):
        raw = payload.get(key)
        if raw is None:
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return None


def agreement_from_iaa_per_item(
    per_item: dict[str, dict[str, float]] | None,
    item_id: str,
) -> float | None:
    """Read agreement (preferring explicit ``agreement``) from IAA per_item."""
    if not per_item:
        return None
    entry = per_item.get(item_id)
    if not entry:
        return None
    if "agreement" in entry:
        try:
            return float(entry["agreement"])
        except (TypeError, ValueError):
            return None
    if "kappa" in entry:
        # Map kappa from [-1, 1] roughly into [0, 1] for ranking only.
        try:
            k = float(entry["kappa"])
            return max(0.0, min(1.0, (k + 1.0) / 2.0))
        except (TypeError, ValueError):
            return None
    return None
