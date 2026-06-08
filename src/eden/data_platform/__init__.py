"""Eden data platform — Bronze/Silver/Gold event ingestion and processing."""

from eden.data_platform.bronze_sink import (
    BronzeEventSink,
    RawEvent,
    get_bronze_sink,
    close_bronze_sink,
    bronze_sink_context,
)
from eden.data_platform.silver_etl import (
    SilverETLPipeline,
    ETLReport,
)
from eden.data_platform.pii import PIIMasker
from eden.data_platform.contracts import (
    ContractValidator,
    EventContract,
    FieldContract,
    ValidationResult,
    AgentTraceContract,
    UsageEventContract,
    PipelineEventContract,
    BenchmarkEventContract,
)
from eden.data_platform.quality import (
    DataQualityValidator,
    Expectation,
    ExpectationResult,
    ValidationReport,
    SILVER_EVENT_EXPECTATIONS,
    USAGE_EVENT_EXPECTATIONS,
)
from eden.data_platform.retention import (
    DataRetentionManager,
    RetentionPolicy,
    RetentionReport,
    DEFAULT_POLICIES,
)
from eden.data_platform.storage_lifecycle import (
    StorageLifecycleManager,
    TierTransition,
    LifecycleReport,
    DEFAULT_TRANSITIONS,
)
from eden.data_platform.clickhouse_sink import (
    ClickHouseSink,
    ClickHouseConfig,
    IngestionReport,
    ClickHouseError,
    get_clickhouse_sink,
    close_clickhouse_sink,
)
from eden.data_platform.lineage import (
    LineageTracker,
    Dataset,
    ColumnLineage,
    LineageRun,
    get_lineage_tracker,
)
from eden.data_platform.gold_layer import (
    GoldLayerEngine,
    TrainingDataPoint,
    BenchmarkSuite,
    KPIBundle,
)
from eden.data_platform.synthetic_data import (
    SyntheticDataEngine,
    SyntheticVariant,
)
from eden.data_platform.analytics_engine import (
    AnalyticsEngine,
    TimeSeriesPoint,
    TrendAnalysis,
    CohortMetrics,
    BenchmarkComparison,
)

__all__ = [
    "BronzeEventSink",
    "RawEvent",
    "get_bronze_sink",
    "close_bronze_sink",
    "bronze_sink_context",
    "SilverETLPipeline",
    "ETLReport",
    "PIIMasker",
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
