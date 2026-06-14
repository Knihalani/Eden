"""Cat 22 — APM Depth + Tracing Depth (v1.4).

Public surface (lazy re-exports so that
``from eden.apm_depth import OtelV141Enricher`` does not
eagerly import the metrics service which pulls in
postgres):

* :class:`OtelV141Enricher` (in :mod:`eden.apm_depth.otel_v141`)
* :class:`StepJudgeStamper` (in :mod:`eden.apm_depth.step_judges`)
* :class:`DecisionPathDepthMetric`,
  :class:`ToolCallSuccessRateMetric`,
  :class:`CostPerStepMetric` (in :mod:`eden.apm_depth.metrics`)
* :class:`AgentMetricsCollector` (in :mod:`eden.apm_depth.metrics`)
* :class:`TailSampler`, :class:`SamplingPolicy`,
  :class:`TailSamplingBuffer`, :func:`get_tail_sampler`,
  :func:`get_sampling_stats`, :func:`compute_num_traces`,
  :func:`estimate_memory_gb` (in :mod:`eden.apm_depth.sampling`)
* :class:`K8sEnricher`, :class:`ServiceAccountClaims`,
  :func:`parse_service_account_jwt` (in :mod:`eden.apm_depth.k8s`)
* :class:`ProfilingClient`, :class:`ProfileLink`,
  :func:`make_profile_id`, :func:`build_pyroscope_url`,
  :func:`profile_sample_decision` (in :mod:`eden.apm_depth.profiling`)

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
    # Tail-based sampling (v1.4.1 add-on)
    "TailSampler",
    "SamplingPolicy",
    "TailSamplingBuffer",
    "SamplingDecision",
    "get_tail_sampler",
    "get_sampling_stats",
    "compute_num_traces",
    "estimate_memory_gb",
    "probabilistic_verdict",
    "reset_tail_sampler",
    # K8s attribute enrichment (v1.4.1 add-on)
    "K8sEnricher",
    "ServiceAccountClaims",
    "parse_service_account_jwt",
    # Pyroscope continuous profiling (v1.4.1 add-on)
    "ProfilingClient",
    "ProfileLink",
    "make_profile_id",
    "build_pyroscope_url",
    "profile_sample_decision",
    "DEFAULT_SAMPLE_RATE",
    "DEFAULT_PYROSCOPE_HOST",
    "PROFILE_ID_PREFIX",
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
    # v1.4.1
    "TailSampler": (".sampling", "TailSampler"),
    "SamplingPolicy": (".sampling", "SamplingPolicy"),
    "TailSamplingBuffer": (".sampling", "TailSamplingBuffer"),
    "SamplingDecision": (".sampling", "SamplingDecision"),
    "get_tail_sampler": (".sampling", "get_tail_sampler"),
    "get_sampling_stats": (".sampling", "get_sampling_stats"),
    "compute_num_traces": (".sampling", "compute_num_traces"),
    "estimate_memory_gb": (".sampling", "estimate_memory_gb"),
    "probabilistic_verdict": (".sampling", "probabilistic_verdict"),
    "reset_tail_sampler": (".sampling", "reset_tail_sampler"),
    "K8sEnricher": (".k8s", "K8sEnricher"),
    "ServiceAccountClaims": (".k8s", "ServiceAccountClaims"),
    "parse_service_account_jwt": (".k8s", "parse_service_account_jwt"),
    "ProfilingClient": (".profiling", "ProfilingClient"),
    "ProfileLink": (".profiling", "ProfileLink"),
    "make_profile_id": (".profiling", "make_profile_id"),
    "build_pyroscope_url": (".profiling", "build_pyroscope_url"),
    "profile_sample_decision": (".profiling", "profile_sample_decision"),
    "DEFAULT_SAMPLE_RATE": (".profiling", "DEFAULT_SAMPLE_RATE"),
    "DEFAULT_PYROSCOPE_HOST": (".profiling", "DEFAULT_PYROSCOPE_HOST"),
    "PROFILE_ID_PREFIX": (".profiling", "PROFILE_ID_PREFIX"),
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
