"""Tool Intelligence (Cat 7) — services package.

Four services that turn raw tool telemetry into actionable
intelligence for the operator and the closed-loop:

* :class:`ToolAttributionScorer` — per-tool success rate,
  latency, contribution score, and drift alerts.
* :class:`ToolComparator` — A vs B in production with
  Bayesian-style winner selection.
* :class:`ToolRecommender` — top-K tools for a given task,
  weighted by success + material + latency + cost.
* :class:`ToolRegistryTaxonomy` — the org's tool catalog
  with co-occurrence matrix.

A real implementation reads from the existing
``telemetry_events`` table (written by
:class:`eden.observability.telemetry_collector.TelemetryCollector`)
filtered by ``event_type IN (tool.*)``. Empty
``telemetry_events`` for the org gives a "no tool
telemetry" envelope. The two persistence tables
(``tool_attributions``, ``tool_comparisons``) live in
migration 020.

The package uses **lazy re-exports** so that
``from eden.services.tool_intel import ToolAttributionScorer``
does not eagerly import the heavy transitive deps (Postgres
client, the shared helpers). Routes that need a specific
service can rely on the lazy re-export or import the
service module directly:

    from eden.services.tool_intel.services import ToolAttributionScorer

The :class:`ToolAttributionScorer` and :class:`ToolComparator`
fire the closed-loop
:func:`eden.llmops.promotion_hooks.PromotionHook.on_drift_alert`
hook on a material drop in success rate. The hook is a
no-op logger in stub mode; a real implementation would
let the canary auto-rollback.

See ``docs/observability-gap/07-tool-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "ToolAttributionScorer",
    "ToolComparator",
    "ToolRecommender",
    "ToolRegistryTaxonomy",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .services import (
        ToolAttributionScorer,
        ToolComparator,
        ToolRecommender,
        ToolRegistryTaxonomy,
    )


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and the
# import spec stay in sync. Adding a new service means adding
# two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "ToolAttributionScorer": (".services", "ToolAttributionScorer"),
    "ToolComparator": (".services", "ToolComparator"),
    "ToolRecommender": (".services", "ToolRecommender"),
    "ToolRegistryTaxonomy": (".services", "ToolRegistryTaxonomy"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``ToolAttributionScorer``
    to the implementation in the corresponding submodule.
    The submodule is imported on first access and cached
    in ``sys.modules``, so subsequent accesses are O(1).
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
    """Make ``dir(eden.services.tool_intel)`` show the public
    surface — useful for REPL auto-completion and for the
    test suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
