"""Triggers — incident-driven + scheduled PR generation flows.

The brief is explicit: PRs should be generated only
through disciplined, evidence-backed workflows. This
package wires together the discipline layer
(:mod:`eden.code_change.discipline`) + the repo-graph
(:mod:`eden.code_change.graph`) + the PR-agent
(:mod:`eden.code_change.agent`) into the two entry
points the brief calls for:

* :func:`incident_trigger.run` — fired when Eden
  detects an outage / quality degradation. Spawns a
  lightweight context-gathering pass, asks the graph
  for affected areas, runs the gate, and only opens
  a PR if the gate clears. Otherwise writes a report.
* :func:`scheduled_trigger.run` — the daily / hourly
  optimization pass. Reviews Eden data collected
  since the last run, identifies improvements with
  evidence, runs the gate, batches related
  improvements into a single PR.

Both flows share the same discipline chokepoint so
the same evidence produces the same verdict in both
contexts.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "incident_trigger",
    "scheduled_trigger",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from . import incident_trigger, scheduled_trigger


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "incident_trigger": (".incident_trigger", "incident_trigger"),
    "scheduled_trigger": (".scheduled_trigger", "scheduled_trigger"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access."""
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module
        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
