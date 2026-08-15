"""Eden data platform — Bronze/Silver/Gold event ingestion and processing.

Audit 2026-07-06 — package __init__ is lazy via PEP 562 ``__getattr__``.
Previously the eager re-exports caused ``from eden.data_platform.pii
import PIIMasker`` to load every data_platform submodule
(clickhouse_sink + aiohttp, bronze_sink, analytics_engine, lineage,
gold_layer, retention, silver_etl, …) on first call. The first one
wins: Python imports the parent package before any submodule, so
_every_ submodule ended up in the import graph. The gateway router
paid ~150ms for this. Now each submodule is imported on first
attribute access; the public API is unchanged.
"""

from __future__ import annotations

__all__ = [
    "BronzeEventSink",
    "RawEvent",
    "get_bronze_sink",
    "close_bronze_sink",
    "bronze_sink_context",
    "SilverETLPipeline",
    "ETLReport",
    "PIIMasker",
    "PIIMaskingError",
    "PIIPolicy",
    "ContractValidator",
    "EventContract",
    "FieldContract",
    "ValidationResult",
    "AgentTraceContract",
    "UsageEventContract",
    "PipelineEventContract",
    "BenchmarkEventContract",
    "DataQualityValidator",
    "Expectation",
    "ExpectationResult",
    "ValidationReport",
    "SILVER_EVENT_EXPECTATIONS",
    "USAGE_EVENT_EXPECTATIONS",
    "DataRetentionManager",
    "RetentionPolicy",
    "RetentionReport",
    "DEFAULT_POLICIES",
    "StorageLifecycleManager",
    "TierTransition",
    "LifecycleReport",
    "DEFAULT_TRANSITIONS",
    "ClickHouseSink",
    "ClickHouseConfig",
    "IngestionReport",
    "ClickHouseError",
    "get_clickhouse_sink",
    "close_clickhouse_sink",
    "LineageTracker",
    "Dataset",
    "ColumnLineage",
    "LineageRun",
    "get_lineage_tracker",
    "GoldLayerEngine",
    "TrainingDataPoint",
    "BenchmarkSuite",
    "KPIBundle",
    "SyntheticDataEngine",
    "SyntheticVariant",
    "AnalyticsEngine",
    "TimeSeriesPoint",
    "TrendAnalysis",
    "CohortMetrics",
    "BenchmarkComparison",
]


# Map each public name to the submodule that defines it. Built once
# here so __getattr__ is a single dict lookup (no module walking).
_NAME_TO_MODULE = {
    "BronzeEventSink": "bronze_sink",
    "RawEvent": "bronze_sink",
    "get_bronze_sink": "bronze_sink",
    "close_bronze_sink": "bronze_sink",
    "bronze_sink_context": "bronze_sink",
    "SilverETLPipeline": "silver_etl",
    "ETLReport": "silver_etl",
    "PIIMasker": "pii",
    "PIIMaskingError": "pii",
    "PIIPolicy": "pii",
    "ContractValidator": "contracts",
    "EventContract": "contracts",
    "FieldContract": "contracts",
    "ValidationResult": "contracts",
    "AgentTraceContract": "contracts",
    "UsageEventContract": "contracts",
    "PipelineEventContract": "contracts",
    "BenchmarkEventContract": "contracts",
    "DataQualityValidator": "quality",
    "Expectation": "quality",
    "ExpectationResult": "quality",
    "ValidationReport": "quality",
    "SILVER_EVENT_EXPECTATIONS": "quality",
    "USAGE_EVENT_EXPECTATIONS": "quality",
    "DataRetentionManager": "retention",
    "RetentionPolicy": "retention",
    "RetentionReport": "retention",
    "DEFAULT_POLICIES": "retention",
    "StorageLifecycleManager": "storage_lifecycle",
    "TierTransition": "storage_lifecycle",
    "LifecycleReport": "storage_lifecycle",
    "DEFAULT_TRANSITIONS": "storage_lifecycle",
    "ClickHouseSink": "clickhouse_sink",
    "ClickHouseConfig": "clickhouse_sink",
    "IngestionReport": "clickhouse_sink",
    "ClickHouseError": "clickhouse_sink",
    "get_clickhouse_sink": "clickhouse_sink",
    "close_clickhouse_sink": "clickhouse_sink",
    "LineageTracker": "lineage",
    "Dataset": "lineage",
    "ColumnLineage": "lineage",
    "LineageRun": "lineage",
    "get_lineage_tracker": "lineage",
    "GoldLayerEngine": "gold_layer",
    "TrainingDataPoint": "gold_layer",
    "BenchmarkSuite": "gold_layer",
    "KPIBundle": "gold_layer",
    "SyntheticDataEngine": "synthetic_data",
    "SyntheticVariant": "synthetic_data",
    "AnalyticsEngine": "analytics_engine",
    "TimeSeriesPoint": "analytics_engine",
    "TrendAnalysis": "analytics_engine",
    "CohortMetrics": "analytics_engine",
    "BenchmarkComparison": "analytics_engine",
}


def __getattr__(name: str):
    """PEP 562 — lazy module attribute access. Each public name
    is resolved by importing the defining submodule on first use
    and pulling the attribute out. We bind the result into
    globals() so the second access is a single dict lookup."""
    mod_name = _NAME_TO_MODULE.get(name)
    if mod_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    submodule = importlib.import_module(f".{mod_name}", __name__)
    value = getattr(submodule, name)
    globals()[name] = value
    return value
