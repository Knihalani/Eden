"""Cat 12 — Simulation surface (Article 1's "biggest gap").

The :class:`~eden.experiments.simulation.scenario.Simulator`
class ships four methods that close the gap between "ship
a prompt change" and "see the answer in 5 minutes":

* ``simulate_scenario`` — load a saved scenario and re-run
  it with new parameters.
* ``replay_production_in_staging`` — the headline: replay
  ``sample_size`` production traces against a candidate
  prompt version and return the per-judge comparison plus
  the regression / improvement lists.
* ``what_if_analysis`` — "what would happen to my judge
  scores if I switched from gpt-4o to claude-haiku?" A
  pure-analytics answer (no LLM re-run).
* ``load_simulation`` — synthetic-load projection of
  latency / cost / error rate at a target RPS.

The package uses **lazy re-exports** so that
``from eden.experiments.simulation import Simulator``
does not eagerly import the heavy transitive deps (the
Cat 17 closed-loop hooks, the lazy Postgres client). Routes
that need a specific service can rely on the lazy re-export
or import the service module directly:

    from eden.experiments.simulation.scenario import Simulator

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = ["Simulator"]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .scenario import Simulator


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "Simulator": (".scenario", "Simulator"),
}


def __getattr__(name: str) -> Any:
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module

        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value  # cache for next access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
