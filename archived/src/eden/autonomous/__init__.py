"""Autonomous Intelligence (Cat 14) — top-level package.

The "Automation" half of the Observation → Explanation →
Evaluation → Attribution → Optimization → **Automation**
chain.

* ``eden.autonomous.investigation`` — InvestigationAgent
  (with folded ``report()`` and ``recommend()`` methods;
  SelfHealer remains the destructive surface)
* ``eden.autonomous.nl_interface`` — NLQueryEngine,
  AutoDashboardBuilder, NLReportGenerator

See ``docs/observability-gap/14-autonomous-intelligence.md``.
"""

from __future__ import annotations

from .investigation import InvestigationAgent, SelfHealer
from .nl_interface import (
    AutoDashboardBuilder,
    NLQueryEngine,
    NLReportGenerator,
)

__all__ = [
    "InvestigationAgent",
    "SelfHealer",
    "NLQueryEngine",
    "AutoDashboardBuilder",
    "NLReportGenerator",
]
