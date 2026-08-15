"""Eden Observability Platform v2 — Telemetry, trace visualization, and comparative analysis.

Phase 6.5: Provides the Eden Telemetry Collector (ETC), SDK instrumentation,
and backend support for trace trees, heatmaps, timelines, and comparative dashboards.

Phase R: adds the stdlib ``logging`` shim — :func:`install` is the
Logfire-style 5-minute time-to-first-log surface.

Audit 2026-07-06 — package __init__ is lazy via PEP 562. Previously
the eager re-exports of telemetry_collector pulled the whole
observability subpackage (telemetry_collector + logging_shim) on
the first ``from eden.observability import ...`` call. Now each
submodule is imported on first attribute access; the public API
is unchanged.
"""

from __future__ import annotations

__all__ = [
    "TelemetryCollector",
    "get_telemetry_collector",
    "close_telemetry_collector",
    "TelemetryEvent",
    "TraceTree",
    "HeatmapData",
    "TimelineData",
    # Phase R — logging shim.
    "EdenLoggingHandler",
    "install",
    "install_logging",
    "uninstall",
    "uninstall_logging",
    "is_logging_shim_installed",
    "get_logging_handler",
    "set_trace_context",
    "clear_trace_context",
]


_NAME_TO_MODULE = {
    "TelemetryCollector": "telemetry_collector",
    "get_telemetry_collector": "telemetry_collector",
    "close_telemetry_collector": "telemetry_collector",
    "TelemetryEvent": "telemetry_collector",
    "TraceTree": "telemetry_collector",
    "HeatmapData": "telemetry_collector",
    "TimelineData": "telemetry_collector",
    "EdenLoggingHandler": "logging_shim",
    "install_logging": "logging_shim",
    "uninstall_logging": "logging_shim",
    "is_logging_shim_installed": "logging_shim",
    "get_logging_handler": "logging_shim",
    "set_trace_context": "logging_shim",
    "clear_trace_context": "logging_shim",
}


def __getattr__(name: str):
    """PEP 562 — lazy module attribute access."""
    mod_name = _NAME_TO_MODULE.get(name)
    if mod_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    submodule = importlib.import_module(f".{mod_name}", __name__)
    value = getattr(submodule, name)
    globals()[name] = value
    return value


# Logfire-style aliases. We resolve them eagerly at the function
# level so callers can still do ``from eden.observability import
# install`` without going through the PEP 562 machinery for the
# most common paths.
def install(*args, **kwargs):
    from eden.observability.logging_shim import install as _install
    return _install(*args, **kwargs)


def uninstall(*args, **kwargs):
    from eden.observability.logging_shim import uninstall as _uninstall
    return _uninstall(*args, **kwargs)
