"""SLO definitions + error budget tracking (closes part of §10.3).

SLOs are published targets for reliability. The SLO module:

  1. Defines the SLOs per endpoint category (see SLO_TARGETS).
  2. Exposes :func:`error_budget` to compute how much budget is
     remaining for a window.
  3. Exposes :func:`is_slo_violated` to drive alerts from the
     existing :mod:`eden.observability.alerts` engine.

The full SLO doc (rationale + per-endpoint targets) lives at
``docs/slo.md`` (generated from this module on every release).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SLOTarget:
    """A single SLO target."""

    name: str
    category: str  # api, kb, sandbox, llm, pipeline
    description: str
    target: float  # e.g. 0.999 for 99.9% availability
    window: timedelta


# Published SLOs. Updated when the platform gains new endpoint
# categories; the doc generator picks this up.
SLO_TARGETS: tuple[SLOTarget, ...] = (
    SLOTarget(
        name="api_availability",
        category="api",
        description="Public API requests succeed (2xx/3xx) excluding 4xx.",
        target=0.999,
        window=timedelta(days=30),
    ),
    SLOTarget(
        name="api_p95_latency",
        category="api",
        description="Public API p95 latency under 200ms.",
        target=0.95,
        window=timedelta(days=30),
    ),
    SLOTarget(
        name="kb_retrieval_p95",
        category="kb",
        description="KB retrieval p95 latency under 100ms.",
        target=0.95,
        window=timedelta(days=30),
    ),
    SLOTarget(
        name="sandbox_boot_p95",
        category="sandbox",
        description="Sandbox boot p95 latency under 200ms (test runs only).",
        target=0.95,
        window=timedelta(days=30),
    ),
    SLOTarget(
        name="llm_provider_error_rate",
        category="llm",
        description="LLM provider error rate under 0.1%.",
        target=0.999,
        window=timedelta(days=30),
    ),
    SLOTarget(
        name="pipeline_timeout_rate",
        category="pipeline",
        description="Pipeline jobs that timeout under 2%.",
        target=0.98,
        window=timedelta(days=30),
    ),
)


@dataclass(frozen=True)
class ErrorBudget:
    slo_name: str
    target: float
    window: timedelta
    actual: float
    remaining_pct: float
    is_violated: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "slo_name": self.slo_name,
            "target": self.target,
            "window_seconds": int(self.window.total_seconds()),
            "actual": self.actual,
            "remaining_pct": round(self.remaining_pct, 4),
            "is_violated": self.is_violated,
        }


def error_budget(slo: SLOTarget, *, success_count: int, total_count: int) -> ErrorBudget:
    """Compute the remaining error budget for ``slo``."""
    if total_count <= 0:
        # No signal — flag as not violated (not enough data to judge).
        return ErrorBudget(
            slo_name=slo.name,
            target=slo.target,
            window=slo.window,
            actual=1.0,
            remaining_pct=1.0,
            is_violated=False,
        )
    actual = success_count / total_count
    allowed_failure = 1.0 - slo.target
    actual_failure = 1.0 - actual
    if allowed_failure == 0:
        remaining = 0.0 if actual_failure > 0 else 1.0
    else:
        remaining = max(0.0, 1.0 - actual_failure / allowed_failure)
    return ErrorBudget(
        slo_name=slo.name,
        target=slo.target,
        window=slo.window,
        actual=actual,
        remaining_pct=remaining,
        is_violated=actual < slo.target,
    )


def is_slo_violated(slo: SLOTarget, *, success_count: int, total_count: int) -> bool:
    """Quick boolean check used by the alerts engine."""
    return error_budget(slo, success_count=success_count, total_count=total_count).is_violated


def published_slos() -> list[dict[str, Any]]:
    """Return the published SLOs as a list of dicts (for the docs + UI)."""
    return [
        {
            "name": s.name,
            "category": s.category,
            "description": s.description,
            "target": s.target,
            "window_days": s.window.days,
        }
        for s in SLO_TARGETS
    ]


__all__ = [
    "ErrorBudget",
    "SLOTarget",
    "SLO_TARGETS",
    "error_budget",
    "is_slo_violated",
    "published_slos",
]
