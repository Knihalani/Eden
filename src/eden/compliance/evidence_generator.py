"""Cat 10 — backwards-compat shim.

Historically this module held the stub :class:`ApprovalWorkflowService`
/ :class:`ComplianceEvidenceGenerator` / :class:`SecurityScanner`
that the v0 route at :mod:`eden.api.routes.intelligence_governance`
imported.

The real implementations now live in
:mod:`eden.services.governance_intel`. This module re-exports
them so any caller using the old import path keeps working.

See ``docs/observability-gap/10-governance-intelligence.md``.
"""

from __future__ import annotations

from eden.governance.compliance_pack import (
    AgentAuditLedgerWriter,
    CompliancePackGenerator,
)
from eden.services.governance_intel import (
    ApprovalWorkflowService,
    ComplianceDashboardService,
    ComplianceEvidenceGenerator,
    DataLineageService,
    RightToBeForgottenService,
    SecurityScanner,
)

__all__ = [
    "ApprovalWorkflowService",
    "ComplianceDashboardService",
    "ComplianceEvidenceGenerator",
    "CompliancePackGenerator",
    "AgentAuditLedgerWriter",
    "DataLineageService",
    "RightToBeForgottenService",
    "SecurityScanner",
]
