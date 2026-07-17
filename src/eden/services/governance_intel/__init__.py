"""Cat 10 — Governance Intelligence (Compliance + Security + Approvals).

Eager imports removed (W9) — heavy compliance/security stacks pull numpy
and other native deps; submodule imports stay cheap for RTBF fanout tests
and hot paths.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "ApprovalWorkflowService",
    "ComplianceDashboardService",
    "ComplianceEvidenceGenerator",
    "DataLineageService",
    "RightToBeForgottenService",
    "SecurityScanner",
    "RtbfRequestTracker",
    "RTBF_STATUS_PENDING",
    "RTBF_STATUS_IN_PROGRESS",
    "RTBF_STATUS_COMPLETED",
    "RTBF_STATUS_FAILED",
    "ALL_RTBF_STATUSES",
]

_LAZY: dict[str, tuple[str, str]] = {
    "ApprovalWorkflowService": (".approval", "ApprovalWorkflowService"),
    "ComplianceEvidenceGenerator": (".compliance", "ComplianceEvidenceGenerator"),
    "ComplianceDashboardService": (".dashboard", "ComplianceDashboardService"),
    "RightToBeForgottenService": (".gdpr", "RightToBeForgottenService"),
    "DataLineageService": (".lineage", "DataLineageService"),
    "SecurityScanner": (".security", "SecurityScanner"),
    "RtbfRequestTracker": (".rtbf_tracker", "RtbfRequestTracker"),
    "ALL_RTBF_STATUSES": (".rtbf_tracker", "ALL_RTBF_STATUSES"),
    "RTBF_STATUS_COMPLETED": (".rtbf_tracker", "RTBF_STATUS_COMPLETED"),
    "RTBF_STATUS_FAILED": (".rtbf_tracker", "RTBF_STATUS_FAILED"),
    "RTBF_STATUS_IN_PROGRESS": (".rtbf_tracker", "RTBF_STATUS_IN_PROGRESS"),
    "RTBF_STATUS_PENDING": (".rtbf_tracker", "RTBF_STATUS_PENDING"),
}


def __getattr__(name: str) -> Any:
    if name not in _LAZY:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    mod_name, attr = _LAZY[name]
    from importlib import import_module

    mod = import_module(mod_name, __name__)
    value = getattr(mod, attr)
    globals()[name] = value
    return value
