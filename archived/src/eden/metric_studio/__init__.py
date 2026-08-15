"""Custom-Metric Studio (Cat 21, v1.3) — new top-level package.

The Custom-Metric Studio closes the rubric + LLM-as-judge gap
that Braintrust (``generate_scorer``), Langfuse (custom Python
evaluators), and pre-Luna Galileo (CLHF, "metric store") all
ship. Four services:

* :class:`RubricTemplateLibrary` — a curated catalog of
  ready-to-use rubric templates across six domains
  (safety, compliance, marketing, legal, factual, tone).
* :class:`RubricSynthesiser` — from 2-5 user-labelled examples,
  generate a rubric prompt via the existing
  :class:`OpenRouterClient`. The synthesised rubric is
  capped at 1,500 tokens, persisted to ``custom_metric_runs``,
  and gates on a human-in-the-loop approval before it can be
  used as a runtime judge.
* :class:`JudgeFactory` — wraps an approved rubric as a
  :class:`Judge` subclass (``RubricJudge``) and registers it
  in the global :class:`JudgeRegistry`. The judge runs as
  any other LLM-as-judge scorer on the
  :class:`TelemetryEvent` stream — but only after the
  per-tenant opt-in gate (``_check_auto_judge_policy``) is
  satisfied.
* :class:`CustomMetricRegistry` — the per-tenant metric store
  (Galileo "metric store" parity). One team's
  "hallucination detector" becomes the whole org's standard.
  The registry is backed by ``organizations.features`` JSONB
  (no new table needed) so the versioning + cross-team
  reuse + audit log work without a schema change.

A real implementation reads from the production-grade
``telemetry_events`` table (when the registered judge runs on
a trace event), calls the LLM via the existing
:mod:`eden.llm.client` client, and persists the per-score
run to ``custom_metric_runs``. The approval gate fires
``MetricStudioHook.on_metric_promotion`` (Cat 17b closed-loop
wiring) so a Cat 3 judge regression can auto-roll-back a
promoted custom metric.

The package uses **lazy re-exports** so that
``from eden.metric_studio import RubricTemplateLibrary`` does
not eagerly import the synthesiser (which pulls in the LLM
client, the judge registry, and the closed-loop hooks).
Routes that need a specific service should either rely on
the lazy re-export or import the service module directly:

    from eden.metric_studio.synthesiser import RubricSynthesiser

See ``docs/observability-gap/21-custom-metric-studio.md`` and
the v1.4 SLM-as-judge plan at ``docs/eden-judge-v2-plan.md``
(the Luna-Studio fine-tuner is a separate deferred initiative).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "CustomMetricRegistry",
    "JudgeFactory",
    "RubricSynthesiser",
    "RubricTemplateLibrary",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy, pyright)
# happy without importing the implementations at runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .judge_factory import JudgeFactory
    from .registry import CustomMetricRegistry
    from .synthesiser import RubricSynthesiser
    from .templates import RubricTemplateLibrary


# Map public name -> (module, attribute) for the lazy ``__getattr__``.
# Centralised so the public surface and the import spec stay in
# sync. Adding a new service means adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "CustomMetricRegistry": (".registry", "CustomMetricRegistry"),
    "JudgeFactory": (".judge_factory", "JudgeFactory"),
    "RubricSynthesiser": (".synthesiser", "RubricSynthesiser"),
    "RubricTemplateLibrary": (".templates", "RubricTemplateLibrary"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``RubricSynthesiser`` to the
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
    """Make ``dir(eden.metric_studio)`` show the public surface —
    useful for REPL auto-completion and for the test suite's
    introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
