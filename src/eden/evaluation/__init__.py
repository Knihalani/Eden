"""Eden CI/CD Evaluation & Canary Deployment System.

Phase 5.6: Continuous evaluation, golden datasets, canary deployments,
security scanning, auto-dataset promotion, and review gates.
"""

from .golden_dataset import (
    GoldenDataset,
    GoldenCase,
    DatasetRegistry,
    EnvironmentCategory,
    DifficultyLevel,
    load_canonical_datasets,
)
from .ci_pipeline import (
    CIPipeline,
    StageName,
    StageStatus,
    StageResult,
    PipelineReport,
)
from .canary import (
    CanaryDeployment,
    CanaryResult,
    DeploymentConfig,
    MetricThreshold,
    RollbackController,
    DeploymentStrategy,
    CanaryStatus,
    RolloutStage,
)
from .review_gate import (
    RiskClassifier,
    RiskLevel,
    ReviewGate,
    ReviewDecision,
    EnvironmentDiff,
)
from .security_scanner import (
    SecurityScanner,
    SecurityIssue,
    Severity,
    IssueCategory,
    ScanResult,
    SecurityGatePolicy,
    DependencyVerifier,
    SASTScanner,
    SBOMGenerator,
)
from .auto_dataset import (
    AutoDatasetPromoter,
    TraceQualityScorer,
    TraceQualityScore,
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
    # Canary deployment
    "CanaryDeployment",
    "CanaryResult",
    "DeploymentConfig",
    "MetricThreshold",
    "RollbackController",
    "DeploymentStrategy",
    "CanaryStatus",
    "RolloutStage",
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
