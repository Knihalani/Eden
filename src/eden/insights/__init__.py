"""Eden Insights Engine — automatic pattern detection and intelligence extraction.

Phase 6.3: Insights Engine & Dataset Generation
"""

from .unified_trace_model import UnifiedTrace, TraceNormalizer, Realm, Outcome
from .detectors import (
    FailurePatternDetector,
    PerformanceAnomalyDetector,
    RegressionDetector,
    DisparityDetector,
    RewardHackingDetector,
    NovelBehaviorDetector,
    DetectorRegistry,
    Insight,
)
from .dataset_engine import DatasetGenerationEngine, DatasetRule, DatasetType
from .comparative_analysis import ComparativeAnalysisEngine, DisparityReport
from .insights_service import InsightsService
from .utils import sequence_similarity, BoundedSet

__all__ = [
    "UnifiedTrace",
    "TraceNormalizer",
    "Realm",
    "Outcome",
    "FailurePatternDetector",
    "PerformanceAnomalyDetector",
    "RegressionDetector",
    "DisparityDetector",
    "RewardHackingDetector",
    "NovelBehaviorDetector",
    "DetectorRegistry",
    "Insight",
    "DatasetGenerationEngine",
    "DatasetRule",
    "DatasetType",
    "ComparativeAnalysisEngine",
    "DisparityReport",
    "InsightsService",
    "sequence_similarity",
    "BoundedSet",
]
