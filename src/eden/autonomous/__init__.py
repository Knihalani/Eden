"""Autonomous Intelligence (Cat 14) — top-level package.

The "Automation" half of the Observation → Explanation →
Evaluation → Attribution → Optimization → **Automation**
chain. Seven services across two sub-modules:

* ``eden.autonomous.investigation`` — InvestigationAgent,
  ReportGenerator, RecommendationEngine, SelfHealer
  (base autonomous services)
* ``eden.autonomous.nl_interface`` — NLQueryEngine,
  AutoDashboardBuilder, NLReportGenerator
  (Braintrust Loop-AI / Phoenix Alyx / LangSmith Polly parity)

See ``docs/observability-gap/14-autonomous-intelligence.md``.
"""

from __future__ import annotations

from .investigation import (
    InvestigationAgent,
    RecommendationEngine,
    ReportGenerator,
    SelfHealer,
)
from .nl_interface import (
    AutoDashboardBuilder,
    NLQueryEngine,
    NLReportGenerator,
)

__all__ = [
    "InvestigationAgent",
    "ReportGenerator",
    "RecommendationEngine",
    "SelfHealer",
    "NLQueryEngine",
    "AutoDashboardBuilder",
    "NLReportGenerator",
]
