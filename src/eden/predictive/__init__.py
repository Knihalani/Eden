"""Predictive Intelligence (Cat 13) — new top-level package.

Six services:

* :class:`QualityPredictor` — per-request judge-score
  forecast (trailing-window mean over recent
  ``judge_scores``).
* :class:`CostPredictor` — per-request cost forecast
  (median of recent per-request ``cost_usd`` from
  ``usage_events``). Extends the Cat 8 ``CostForecast``
  with a per-request dimension.
* :class:`CapacityPredictor` — N-day GPU-hour projection
  (linear regression on daily call + token series).
* :class:`RiskScorer` — composite per-request risk from
  judge-score / cost-CV / latency-p95.
* :class:`DriftDetector` — output (judge-score) +
  embedding (response-text) drift detection via the
  Population Stability Index (PSI).

All services read from the production-grade
``telemetry_events``, ``usage_events``, and
``judge_scores`` tables and persist to the 5 Cat 13
tables declared in migration 020
(``quality_predictions``, ``cost_predictions``,
``capacity_forecasts``, ``risk_scores``,
``drift_alerts``). All dependencies degrade gracefully —
an empty table gives an ``ok`` envelope with a clear
``message`` and a ``null`` prediction.

The package uses **lazy re-exports** so that
``from eden.predictive import QualityPredictor`` does not
eagerly import the heavy transitive deps (Postgres
client, the shared helpers). Routes that need a specific
service can rely on the lazy re-export or import the
service module directly:

    from eden.predictive.quality import QualityPredictor

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "CapacityPredictor",
    "CostPredictor",
    "DriftDetector",
    "QualityPredictor",
    "RiskScorer",
    "annotate_change_points",
    "cusum_classify_trend",
    "cusum_detect",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .capacity import CapacityPredictor
    from .cost import CostPredictor
    from .cusum import annotate_change_points, cusum_classify_trend, cusum_detect
    from .drift import DriftDetector
    from .quality import QualityPredictor
    from .risk import RiskScorer


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and the
# import spec stay in sync. Adding a new service means adding
# two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "CapacityPredictor": (".capacity", "CapacityPredictor"),
    "CostPredictor": (".cost", "CostPredictor"),
    "DriftDetector": (".drift", "DriftDetector"),
    "QualityPredictor": (".quality", "QualityPredictor"),
    "RiskScorer": (".risk", "RiskScorer"),
    "cusum_detect": (".cusum", "cusum_detect"),
    "cusum_classify_trend": (".cusum", "cusum_classify_trend"),
    "annotate_change_points": (".cusum", "annotate_change_points"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``QualityPredictor`` to the
    implementation in the corresponding submodule. The
    submodule is imported on first access and cached in
    ``sys.modules``, so subsequent accesses are O(1).
    """
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module

        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value  # cache for next access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    """Make ``dir(eden.predictive)`` show the public
    surface — useful for REPL auto-completion and for the
    test suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
