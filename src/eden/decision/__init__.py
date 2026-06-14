"""Decision Intelligence (Cat 16) — new top-level package.

Article 1's "biggest gap": users cannot understand why agents
choose actions. Five services:

* :class:`DecisionPathReconstructor` — rebuild the step-by-step
  decision path of a trace.
* :class:`ReasoningTraceExplainer` — explain in natural language
  why the agent chose action X over Y.
* :class:`DecisionAlternatives` — list the actions the agent
  considered and didn't take.
* :class:`DecisionScorer` — score the quality of a single
  decision using the 3 Galileo Luna-2 metrics
  (ActionCompletionJudge, ToolSelectionQualityJudge,
  ReasoningCoherenceJudge).
* :class:`AgentTrajectoryAnalyzer` — Phoenix-style multi-step
  trajectory analysis.

A real implementation reads the ``telemetry_events`` table for one
trace and either aggregates the events directly (path, explainer,
alternatives, trajectory) or runs the registered judges per event
and aggregates their scores (scorer). The scorer also fires the
Cat 17 closed-loop hooks (``GuardrailHook.on_judge_below_floor``,
``PromotionHook.on_judge_regression``) when component scores
degrade.

The package uses **lazy re-exports** so that
``from eden.decision import DecisionPathReconstructor`` does not
eagerly import :mod:`eden.decision.decision_scorer` (which pulls
in the LLM client, the judge registry, and the closed-loop
hooks). Routes that need a specific service should either rely on
the lazy re-export or import the service module directly:

    from eden.decision.decision_scorer import DecisionScorer

See ``docs/observability-gap/16-decision-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "AgentTrajectoryAnalyzer",
    "DecisionAlternatives",
    "DecisionPathReconstructor",
    "DecisionScorer",
    "ReasoningTraceExplainer",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy, pyright)
# happy without importing the implementations at runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .alternatives import DecisionAlternatives
    from .decision_scorer import DecisionScorer
    from .path_reconstructor import DecisionPathReconstructor
    from .reasoning_explainer import ReasoningTraceExplainer
    from .trajectory_analyzer import AgentTrajectoryAnalyzer


# Map public name -> (module, attribute) for the lazy ``__getattr__``.
# Centralised so the public surface and the import spec stay in
# sync. Adding a new service means adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "AgentTrajectoryAnalyzer": (".trajectory_analyzer", "AgentTrajectoryAnalyzer"),
    "DecisionAlternatives": (".alternatives", "DecisionAlternatives"),
    "DecisionPathReconstructor": (".path_reconstructor", "DecisionPathReconstructor"),
    "DecisionScorer": (".decision_scorer", "DecisionScorer"),
    "ReasoningTraceExplainer": (".reasoning_explainer", "ReasoningTraceExplainer"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``DecisionScorer`` to the
    implementation in the corresponding submodule. The submodule
    is imported on first access and cached in ``sys.modules``,
    so subsequent accesses are O(1).
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
    """Make ``dir(eden.decision)`` show the public surface — useful
    for REPL auto-completion and for the test suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
