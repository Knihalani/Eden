"""Eden CI/CD Evaluation System.

Phase 5.6: Continuous evaluation, golden datasets, security scanning,
auto-dataset promotion, and review gates.
"""

from .auto_dataset import (
    AutoDatasetPromoter,
    TraceQualityScore,
    TraceQualityScorer,
)
from .ci_pipeline import (
    CIPipeline,
    PipelineReport,
    StageName,
    StageResult,
    StageStatus,
)
from .golden_dataset import (
    DatasetRegistry,
    DifficultyLevel,
    EnvironmentCategory,
    GoldenCase,
    GoldenDataset,
    load_canonical_datasets,
)
from .review_gate import (
    EnvironmentDiff,
    ReviewDecision,
    ReviewGate,
    RiskClassifier,
    RiskLevel,
)
from .security_scanner import (
    DependencyVerifier,
    IssueCategory,
    SASTScanner,
    SBOMGenerator,
    ScanResult,
    SecurityGatePolicy,
    SecurityIssue,
    SecurityScanner,
    Severity,
)

__all__ = [
    # Golden datasets
    "GoldenDataset",
    "GoldenCase",
    "DatasetRegistry",
    "EnvironmentCategory",
    "DifficultyLevel",
    "load_canonical_datasets",
    # CI pipeline
    "CIPipeline",
    "StageName",
    "StageStatus",
    "StageResult",
    "PipelineReport",
    # Review gates
    "RiskClassifier",
    "RiskLevel",
    "ReviewGate",
    "ReviewDecision",
    "EnvironmentDiff",
    # Security scanning
    "SecurityScanner",
    "SecurityIssue",
    "Severity",
    "IssueCategory",
    "ScanResult",
    "SecurityGatePolicy",
    "DependencyVerifier",
    "SASTScanner",
    "SBOMGenerator",
    # Auto dataset
    "AutoDatasetPromoter",
    "TraceQualityScorer",
    "TraceQualityScore",
]
