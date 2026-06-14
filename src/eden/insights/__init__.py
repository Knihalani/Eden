"""Eden Insights Engine — automatic pattern detection and intelligence extraction.

Phase 6.3: Insights Engine & Dataset Generation
"""

from .comparative_analysis import ComparativeAnalysisEngine, DisparityReport
from .dataset_engine import DatasetGenerationEngine, DatasetRule, DatasetType
from .detectors import (
    DetectorRegistry,
    DisparityDetector,
    FailurePatternDetector,
    Insight,
    NovelBehaviorDetector,
    PerformanceAnomalyDetector,
    RegressionDetector,
    RewardHackingDetector,
)
from .insights_service import InsightsService
from .unified_trace_model import Outcome, Realm, TraceNormalizer, UnifiedTrace
from .utils import BoundedSet, sequence_similarity

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
