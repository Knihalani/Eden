"""Natural Language Interface for Cat 14 (Autonomous Intelligence).

ponytail: per upgradespec §D.4 (Phase 1 cut), only
``NLReportGenerator`` ships. ``NLQueryEngine`` and
``AutoDashboardBuilder`` were removed; the deep-linked
routes return a stable 501 envelope via
``intelligence_autonomous.py::_deferred``.
"""

from __future__ import annotations

from .query import (
    NLReportGenerator,
    _truncate_for_prompt,
    _validate_readonly_sql,
)

__all__ = [
    "NLReportGenerator",
]
