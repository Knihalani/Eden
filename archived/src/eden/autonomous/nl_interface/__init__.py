"""Natural Language Interface for Cat 14 (Autonomous Intelligence).

Live services:

* ``NLQueryEngine`` — NL → SQL (Postgres fallback heuristics)
* ``AutoDashboardBuilder`` — NL → dashboard spec
* ``NLReportGenerator`` — NL → InvestigationAgent.report()
"""

from __future__ import annotations

from .query import (
    AutoDashboardBuilder,
    NLQueryEngine,
    NLReportGenerator,
    _truncate_for_prompt,
    _validate_readonly_sql,
)

__all__ = [
    "AutoDashboardBuilder",
    "NLQueryEngine",
    "NLReportGenerator",
    "_truncate_for_prompt",
    "_validate_readonly_sql",
]
