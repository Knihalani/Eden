"""Eden Observability Platform v2 — Telemetry, trace visualization, and comparative analysis.

Phase 6.5: Provides the Eden Telemetry Collector (ETC), SDK instrumentation,
and backend support for trace trees, heatmaps, timelines, and comparative dashboards.
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

__all__ = [
    "TelemetryCollector",
    "get_telemetry_collector",
    "close_telemetry_collector",
    "TelemetryEvent",
    "TraceTree",
    "HeatmapData",
    "TimelineData",
]
