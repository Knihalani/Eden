"""Cat 12 — Experimentation Intelligence (base surface).

Four services that close the A/B/n + auto-eval + recommend
+ winner-detect loop:

* :class:`~eden.experiments.experiment_intel.splitter.TrafficSplitter`
  — A/B/n traffic splitting at the user level.
* :class:`~eden.experiments.experiment_intel.auto_eval.AutoEvaluator`
  — auto-run the Cat 3 judge set on every variant.
* :class:`~eden.experiments.experiment_intel.recommender.ExperimentRecommender`
  — the ship-it / don't-ship-it decision.
* :class:`~eden.experiments.experiment_intel.winner.ExperimentWinnerDetector`
  — declare a winner with Bayesian confidence and fire the
  :func:`ExperimentHook.on_winner` closed-loop hook.

The package uses **lazy re-exports** so that
``from eden.experiments.experiment_intel import TrafficSplitter``
does not eagerly import the heavy transitive deps (Postgres
client, the Cat 17 closed-loop hooks). Routes that need a
specific service can rely on the lazy re-export or import
the service module directly:

    from eden.experiments.experiment_intel.splitter import TrafficSplitter

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "AutoEvaluator",
    "ExperimentRecommender",
    "ExperimentWinnerDetector",
    "TrafficSplitter",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .auto_eval import AutoEvaluator
    from .recommender import ExperimentRecommender
    from .splitter import TrafficSplitter
    from .winner import ExperimentWinnerDetector


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "AutoEvaluator": (".auto_eval", "AutoEvaluator"),
    "ExperimentRecommender": (".recommender", "ExperimentRecommender"),
    "ExperimentWinnerDetector": (".winner", "ExperimentWinnerDetector"),
    "TrafficSplitter": (".splitter", "TrafficSplitter"),
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
