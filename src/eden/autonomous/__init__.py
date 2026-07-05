"""Autonomous Intelligence (Cat 14) — top-level package.

The "Automation" half of the Observation → Explanation →
Evaluation → Attribution → Optimization → **Automation**
chain. Two services survive per upgradespec §D.4 (Phase 1
cut):

* ``eden.autonomous.investigation`` — InvestigationAgent
  (with folded ``report()`` and ``recommend()`` methods;
  SelfHealer remains the destructive surface)
* ``eden.autonomous.nl_interface`` — NLReportGenerator
  (``NLQueryEngine`` + ``AutoDashboardBuilder`` removed
  per §D.4)

See ``docs/observability-gap/14-autonomous-intelligence.md``.
"""

from __future__ import annotations

from .investigation import InvestigationAgent, SelfHealer
from .nl_interface import NLReportGenerator

__all__ = [
    "InvestigationAgent",
    "SelfHealer",
    "NLReportGenerator",
]
