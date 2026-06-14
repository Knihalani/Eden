"""Cost Intelligence (Cat 8) — new top-level package.

Four services:

* :class:`CostEfficiencyScorer` — cost per ticket, per report,
  per goal. JOINs ``usage_events`` cost-by-group with
  ``outcomes`` count-by-group to compute ``cost_per_outcome``.
* :class:`ROIAnalyzer` — spend vs value. ``roi = (value -
  spend) / spend``, with null ROI when spend is 0.
* :class:`CostAnomalyDetector` — z-score on the daily cost
  series. Flags |z| > 2.5 as anomalies; |z| > 4 is "high"
  severity and fires the :func:`PromotionHook.on_drift_alert`
  closed-loop hook.
* :class:`CostForecast` — OLS linear regression on the 90-day
  daily cost series; < 14 days of history falls back to the
  window mean with an ``insufficient_history`` warning.

A real implementation reads from the production-grade
``usage_events`` table (``src/eden/services/usage_service.py``
already writes to it) and the ``outcomes`` table (Cat 11,
currently empty). Both dependencies degrade gracefully — an
empty ``outcomes`` table gives ``null`` cost_per_outcome and
``null`` ROI; an empty ``usage_events`` table gives an empty
result with a ``"no usage data"`` message.

The package uses **lazy re-exports** so that
``from eden.services.cost_intel import CostEfficiencyScorer``
does not eagerly import the heavy transitive deps
(Postgres client, the shared helpers). Routes that need a
specific service can rely on the lazy re-export or import the
service module directly:

    from eden.services.cost_intel.efficiency import CostEfficiencyScorer

See ``docs/observability-gap/08-cost-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "CostAnomalyDetector",
    "CostEfficiencyScorer",
    "CostForecast",
    "ROIAnalyzer",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .efficiency import (
        CostAnomalyDetector,
        CostEfficiencyScorer,
        CostForecast,
        ROIAnalyzer,
    )


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and the
# import spec stay in sync. Adding a new service means adding
# two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "CostAnomalyDetector": (".efficiency", "CostAnomalyDetector"),
    "CostEfficiencyScorer": (".efficiency", "CostEfficiencyScorer"),
    "CostForecast": (".efficiency", "CostForecast"),
    "ROIAnalyzer": (".efficiency", "ROIAnalyzer"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``ROIAnalyzer`` to the
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
    """Make ``dir(eden.services.cost_intel)`` show the public
    surface — useful for REPL auto-completion and for the test
    suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
