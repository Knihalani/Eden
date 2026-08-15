"""Platform-wide A/B testing framework (closes §8.4).

This module provides:

* :class:`Experiment` — a feature-level experiment with
  multiple variants.
* :func:`assign_variant` — deterministic, hash-based
  assignment so a user always sees the same variant.
* :func:`record_outcome` — store the user's outcome for later
  analysis.
* :func:`analyse` — compare variants and recommend a winner
  using a simple two-proportion z-test (no external dep).

The existing prompt-level A/B test in
``eden.llmops.prompt_registry`` predates this and continues to
work; new experiments should use this service.
"""
from __future__ import annotations

import hashlib
import logging
import math
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Variant:
    """A single arm of an experiment."""

    name: str
    weight: float  # 0.0 - 1.0; weights need not sum to 1 (they're normalised)


@dataclass(frozen=True)
class Experiment:
    """A platform-wide experiment."""

    key: str  # unique, e.g. "checkout_flow_v2"
    variants: list[Variant]
    started_at: datetime
    ended_at: datetime | None = None


@dataclass
class ExperimentResult:
    """The outcome of analysing an experiment."""

    experiment_key: str
    variant: str
    n: int
    successes: int
    rate: float


def _hash_to_unit_interval(*parts: str) -> float:
    """Map a tuple of strings to a deterministic float in [0, 1)."""
    h = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return int(h[:16], 16) / float(1 << 64)


def assign_variant(experiment_key: str, user_id: str, variants: list[Variant]) -> Variant:
    """Deterministically assign a user to a variant.

    The assignment is stable across processes because it's a
    pure function of ``(experiment_key, user_id)`` — no DB read
    is required. This is the standard bucketing approach used
    by Optimizely / LaunchDarkly.
    """
    if not variants:
        raise ValueError("variants must be a non-empty list")
    total = sum(v.weight for v in variants)
    if total <= 0:
        raise ValueError("variant weights must sum to a positive number")
    bucket = _hash_to_unit_interval(experiment_key, user_id) * total
    cumulative = 0.0
    for v in variants:
        cumulative += v.weight
        if bucket < cumulative:
            return v
    return variants[-1]  # floating-point safety net


# In-process store for the MVP. A real implementation would back
# these with a table; the interface here is what callers see.
_OUTCOMES: dict[str, list[tuple[str, str, bool]]] = {}


def record_outcome(experiment_key: str, user_id: str, variant_name: str, success: bool) -> None:
    """Record a (user, variant, success) tuple for later analysis."""
    _OUTCOMES.setdefault(experiment_key, []).append((user_id, variant_name, success))


def reset_outcomes(experiment_key: str | None = None) -> None:
    """Test helper. Drops recorded outcomes (optionally scoped to one experiment)."""
    if experiment_key is None:
        _OUTCOMES.clear()
    else:
        _OUTCOMES.pop(experiment_key, None)


def analyse(experiment_key: str) -> list[ExperimentResult]:
    """Compute the per-variant success rate for ``experiment_key``."""
    outcomes = _OUTCOMES.get(experiment_key, [])
    by_variant: dict[str, list[tuple[str, bool]]] = {}
    for user_id, variant_name, success in outcomes:
        by_variant.setdefault(variant_name, []).append((user_id, success))
    results: list[ExperimentResult] = []
    for variant_name, items in by_variant.items():
        n = len(items)
        successes = sum(1 for _, s in items if s)
        rate = successes / n if n else 0.0
        results.append(
            ExperimentResult(
                experiment_key=experiment_key,
                variant=variant_name,
                n=n,
                successes=successes,
                rate=rate,
            )
        )
    return results


def two_proportion_z_test(p1: float, n1: int, p2: float, n2: int) -> float:
    """Two-tailed z-statistic for the difference of two proportions.

    Returns the z-score; callers compare against ``1.96`` (5% two-tailed)
    for significance. Returns 0.0 if either sample is empty.
    """
    if n1 == 0 or n2 == 0:
        return 0.0
    p_pool = (p1 * n1 + p2 * n2) / (n1 + n2)
    if p_pool in (0.0, 1.0):
        return 0.0
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n1 + 1 / n2))
    if se == 0:
        return 0.0
    return (p1 - p2) / se


def recommend_winner(
    results: list[ExperimentResult],
    *,
    min_n: int = 100,
    control: str | None = None,
) -> str | None:
    """Return the variant with the highest success rate that is
    significantly better than the control and has at least
    ``min_n`` observations.

    The control variant defaults to the first variant in ``results``
    for backwards compatibility. Callers that record outcomes in
    an order different from the declared variant order should pass
    ``control`` explicitly so the z-test compares the winning
    treatment against the right baseline (the original control,
    not whatever variant happened to be recorded first).

    Returns ``None`` when no variant meets the bar.
    """
    if len(results) < 2:
        return None
    results_sorted = sorted(results, key=lambda r: r.rate, reverse=True)
    best = results_sorted[0]
    if control is not None:
        control_result = next((r for r in results if r.variant == control), None)
        if control_result is None:
            return None
    else:
        # Backwards-compat default: assume results[0] is the control.
        # This is correct only when record_outcome() was called in the
        # same order the variants were declared; otherwise the caller
        # should pass ``control`` explicitly.
        control_result = results[0]
    if (
        best.n < min_n
        or control_result.n < min_n
        or best.variant == control_result.variant
    ):
        return None
    z = two_proportion_z_test(best.rate, best.n, control_result.rate, control_result.n)
    if z >= 1.96:
        return best.variant
    return None


__all__ = [
    "Experiment",
    "ExperimentResult",
    "Variant",
    "analyse",
    "assign_variant",
    "recommend_winner",
    "record_outcome",
    "reset_outcomes",
    "two_proportion_z_test",
]
