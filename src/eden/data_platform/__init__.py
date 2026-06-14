"""Eden data platform — Bronze/Silver/Gold event ingestion and processing."""

from eden.data_platform.analytics_engine import (
    AnalyticsEngine,
    BenchmarkComparison,
    CohortMetrics,
    TimeSeriesPoint,
    TrendAnalysis,
)
from eden.data_platform.bronze_sink import (
    BronzeEventSink,
    RawEvent,
    bronze_sink_context,
    close_bronze_sink,
    get_bronze_sink,
)
from eden.data_platform.clickhouse_sink import (
    ClickHouseConfig,
    ClickHouseError,
    ClickHouseSink,
    IngestionReport,
    close_clickhouse_sink,
    get_clickhouse_sink,
)
from eden.data_platform.contracts import (
    AgentTraceContract,
    BenchmarkEventContract,
    ContractValidator,
    EventContract,
    FieldContract,
    PipelineEventContract,
    UsageEventContract,
    ValidationResult,
)
from eden.data_platform.gold_layer import (
    BenchmarkSuite,
    GoldLayerEngine,
    KPIBundle,
    TrainingDataPoint,
)
from eden.data_platform.lineage import (
    ColumnLineage,
    Dataset,
    LineageRun,
    LineageTracker,
    get_lineage_tracker,
)
from eden.data_platform.pii import PIIMasker
from eden.data_platform.quality import (
    SILVER_EVENT_EXPECTATIONS,
    USAGE_EVENT_EXPECTATIONS,
    DataQualityValidator,
    Expectation,
    ExpectationResult,
    ValidationReport,
)
from eden.data_platform.retention import (
    DEFAULT_POLICIES,
    DataRetentionManager,
    RetentionPolicy,
    RetentionReport,
)
from eden.data_platform.silver_etl import (
    ETLReport,
    SilverETLPipeline,
)
from eden.data_platform.storage_lifecycle import (
    DEFAULT_TRANSITIONS,
    LifecycleReport,
    StorageLifecycleManager,
    TierTransition,
)
from eden.data_platform.synthetic_data import (
    SyntheticDataEngine,
    SyntheticVariant,
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
