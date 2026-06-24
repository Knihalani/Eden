"""Cat 22 — APM Depth + Tracing Depth (v1.4).

ponytail: per upgradespec §D.1 (Phase 1 cut), the bespoke
in-process tail-sampling / K8s-enrichment / Pyroscope
correlation code was deleted and replaced by the OTel
Collector + K8s Downward API path. See
``deploy/otel-collector-config.yaml`` for the OTel Collector
``tail_sampling`` + ``k8sattributes`` processor config.

The surviving surface is the protocol-level + per-step
enrichment + metrics layer (not the bespoke sampler/k8s/profiler):

* :class:`OtelV141Enricher` (in :mod:`eden.apm_depth.otel_v141`)
* :class:`StepJudgeStamper` (in :mod:`eden.apm_depth.step_judges`)
* :class:`DecisionPathDepthMetric`,
  :class:`ToolCallSuccessRateMetric`,
  :class:`CostPerStepMetric` (in :mod:`eden.apm_depth.metrics`)
* :class:`AgentMetricsCollector` (in :mod:`eden.apm_depth.metrics`)

Removed (per §D.1):
* ``eden.apm_depth.sampling`` — replaced by OTel Collector
  ``tail_sampling`` processor
* ``eden.apm_depth.k8s`` — replaced by OTel Collector
  ``k8sattributes`` processor + K8s Downward API env vars
* ``eden.apm_depth.profiling`` — replaced by Grafana Phlare

The :mod:`eden.apm_depth._common` module is imported eagerly
because the v1.41 / v1.36 mapping + the per-step envelope
helpers are used by multiple services.

The route file :mod:`eden.api.routes.intelligence_apm_depth`
imports the symbols from this package; the lazy re-exports
mean the route file keeps working unchanged.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ._common import (
    STEP_INDEX_ATTR,
    STEP_JUDGES_ATTR,
    dual_emit_attributes,
    enrich_step_attributes,
    extract_step_index,
    extract_step_judges,
)

__all__ = [
    # OTel v1.41 dual-emit
    "OtelV141Enricher",
    # Per-step evaluation
    "StepJudgeStamper",
    # Agent metrics
    "DecisionPathDepthMetric",
    "ToolCallSuccessRateMetric",
    "CostPerStepMetric",
    "AgentMetricsCollector",
    # Shared helpers (eager)
    "dual_emit_attributes",
    "enrich_step_attributes",
    "extract_step_index",
    "extract_step_judges",
    "STEP_INDEX_ATTR",
    "STEP_JUDGES_ATTR",
]


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "OtelV141Enricher": (".otel_v141", "OtelV141Enricher"),
    "StepJudgeStamper": (".step_judges", "StepJudgeStamper"),
    "DecisionPathDepthMetric": (".metrics", "DecisionPathDepthMetric"),
    "ToolCallSuccessRateMetric": (".metrics", "ToolCallSuccessRateMetric"),
    "CostPerStepMetric": (".metrics", "CostPerStepMetric"),
    "AgentMetricsCollector": (".metrics", "AgentMetricsCollector"),
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