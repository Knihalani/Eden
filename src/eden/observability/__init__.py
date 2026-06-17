"""Eden Observability Platform v2 — Telemetry, trace visualization, and comparative analysis.

Phase 6.5: Provides the Eden Telemetry Collector (ETC), SDK instrumentation,
and backend support for trace trees, heatmaps, timelines, and comparative dashboards.

Phase R: adds the stdlib ``logging`` shim — :func:`install` is the
Logfire-style 5-minute time-to-first-log surface.
"""

from eden.observability.telemetry_collector import (
    TelemetryCollector,
    get_telemetry_collector,
    close_telemetry_collector,
    TelemetryEvent,
    TraceTree,
    HeatmapData,
    TimelineData,
)
from eden.observability.logging_shim import (
    EdenLoggingHandler,
    install as install_logging,
    uninstall as uninstall_logging,
    is_installed as is_logging_shim_installed,
    get_handler as get_logging_handler,
    set_trace_context,
    clear_trace_context,
)

# Logfire-style aliases. Users can do ``from eden.observability import install``
# — these are the same function under two names, kept for ergonomics.
install = install_logging
uninstall = uninstall_logging

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
