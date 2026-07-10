"""Eden issues layer (F28 stumbles + F29 grouped issues).

The issues layer is the substrate for the closed-loop error-diagnosis
system: detectors write atomic :class:`Stumble` rows, which promote into
grouped :class:`Issue` rows (Sentry-style) keyed by a stable
``fingerprint``. Triage (F30), the orchestrator (F46), self-heal (N21),
and patch generation (N20) all operate on issues.
"""

from __future__ import annotations

from eden.issues.fingerprint import compute_fingerprint, error_signature_for
from eden.issues.issue_promoter import IssuePromoter
from eden.issues.models import (
    ISSUE_STATUSES,
    STUMBLE_KINDS,
    Issue,
    Severity,
    Stumble,
    StumbleCreate,
    StumbleKind,
    severity_for_kind,
)
from eden.issues.repo import IssuesRepo
from eden.issues.stumble_writer import StumbleWriter

__all__ = [
    "ISSUE_STATUSES",
    "STUMBLE_KINDS",
    "Issue",
    "IssuePromoter",
    "IssuesRepo",
    "Severity",
    "Stumble",
    "StumbleCreate",
    "StumbleKind",
    "StumbleWriter",
    "compute_fingerprint",
    "error_signature_for",
    "severity_for_kind",
]
