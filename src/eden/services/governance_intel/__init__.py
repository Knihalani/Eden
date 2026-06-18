"""Cat 10 — Governance Intelligence (Compliance + Security + Approvals).

Package layout:

* :mod:`._common` — shared envelope / Postgres helper / ID gen /
  hook firing (mirrors :mod:`eden.services.user_intel._common`
  and :mod:`eden.services.cost_intel._common`).
* :mod:`.approval`  — :class:`ApprovalWorkflowService`
* :mod:`.compliance` — :class:`ComplianceEvidenceGenerator`
  (SOC 2 / HIPAA / GDPR / ISO 27001)
* :mod:`.security`  — :class:`SecurityScanner`
  (Datadog Sensitive Data Scanner parity)
* :mod:`.gdpr`      — :class:`RightToBeForgottenService` (v2)
* :mod:`.lineage`   — :class:`DataLineageService` (v2)
* :mod:`.dashboard` — :class:`ComplianceDashboardService` (v2)

Mirrors the layout of :mod:`eden.services.user_intel`.
"""

from eden.services.governance_intel.approval import ApprovalWorkflowService
from eden.services.governance_intel.compliance import ComplianceEvidenceGenerator
from eden.services.governance_intel.dashboard import ComplianceDashboardService
from eden.services.governance_intel.gdpr import RightToBeForgottenService
from eden.services.governance_intel.lineage import DataLineageService
from eden.services.governance_intel.rtbf_tracker import (
    ALL_RTBF_STATUSES,
    RTBF_STATUS_COMPLETED,
    RTBF_STATUS_FAILED,
    RTBF_STATUS_IN_PROGRESS,
    RTBF_STATUS_PENDING,
    RtbfRequestTracker,
)
from eden.services.governance_intel.security import SecurityScanner

__all__ = [
    "ApprovalWorkflowService",
    "ComplianceDashboardService",
    "ComplianceEvidenceGenerator",
    "DataLineageService",
    "RightToBeForgottenService",
    "SecurityScanner",
    # Phase K — RTBF lifecycle.
    "RtbfRequestTracker",
    "RTBF_STATUS_PENDING",
    "RTBF_STATUS_IN_PROGRESS",
    "RTBF_STATUS_COMPLETED",
    "RTBF_STATUS_FAILED",
    "ALL_RTBF_STATUSES",
]
