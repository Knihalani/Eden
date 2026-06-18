"""Eden Observability Platform v2 — Telemetry, trace visualization, and comparative analysis.

Phase 6.5: Provides the Eden Telemetry Collector (ETC), SDK instrumentation,
and backend support for trace trees, heatmaps, timelines, and comparative dashboards.

Phase R: adds the stdlib ``logging`` shim — :func:`install` is the
Logfire-style 5-minute time-to-first-log surface.
"""

from eden.observability.logging_shim import (
    EdenLoggingHandler,
    clear_trace_context,
    set_trace_context,
)
from eden.observability.logging_shim import (
    get_handler as get_logging_handler,
)
from eden.observability.logging_shim import (
    install as install_logging,
)
from eden.observability.logging_shim import (
    is_installed as is_logging_shim_installed,
)
from eden.observability.logging_shim import (
    uninstall as uninstall_logging,
)
from eden.observability.telemetry_collector import (
    HeatmapData,
    TelemetryCollector,
    TelemetryEvent,
    TimelineData,
    TraceTree,
    close_telemetry_collector,
    get_telemetry_collector,
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
