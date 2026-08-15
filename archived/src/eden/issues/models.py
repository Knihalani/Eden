"""Data models for the issues layer (F28 / F29).

Kinds and statuses are plain strings (mirroring the ``VARCHAR`` columns
in migration 084) so callers never have to import a Postgres enum, and
the F28↔F29 kind reconciliation / F46 status extension stays a pure
code change.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

Severity = Literal["p0", "p1", "p2", "p3"]


class StumbleKind(StrEnum):
    """Superset of F28 + F29 stumble kinds.

    F29's original SQL enum omitted ``timeout`` / ``mcp_auth_failure`` /
    ``statgate_p0``; F28 is the source of truth, so we carry all of them.
    """

    TOOL_ERROR = "tool_error"
    LOOP = "loop"
    HALLUCINATION = "hallucination"
    TASK_FAILURE = "task_failure"
    USER_FRUSTRATION = "user_frustration"
    TIMEOUT = "timeout"
    SELF_DIAGNOSTIC = "self_diagnostic"
    MCP_AUTH_FAILURE = "mcp_auth_failure"
    STATGATE_P0 = "statgate_p0"
    CUSTOM = "custom"


STUMBLE_KINDS: frozenset[str] = frozenset(k.value for k in StumbleKind)

# Outcome miss grouped on agent_issues. Not a stumble / detector kind.
HELP_MISS_KIND = "help_miss"

# F29 open/resolved/ignored/regressed + F46 orchestration states.
# ``acknowledged`` is the portal "In progress" triage value (also mapped
# from triaged/fix_pending/verifying/learning/regressed/escalated on read).
ISSUE_STATUSES: frozenset[str] = frozenset(
    {
        "open",
        "acknowledged",
        "triaged",
        "fix_pending",
        "verifying",
        "resolved",
        "regressed",
        "ignored",
        "learning",
        "escalated",
    }
)

# Default severity per kind — high-signal kinds map to p1, softer signals
# to p2/p3. IssuePromoter escalates from the new stumble's resolved
# severity using blast-radius counters (user_count / stumble_count /
# repetition_count) and never downgrades via ``_more_severe``.
_DEFAULT_SEVERITY: dict[str, Severity] = {
    StumbleKind.TOOL_ERROR.value: "p1",
    StumbleKind.TASK_FAILURE.value: "p1",
    StumbleKind.HALLUCINATION.value: "p1",
    StumbleKind.STATGATE_P0.value: "p0",
    StumbleKind.MCP_AUTH_FAILURE.value: "p1",
    StumbleKind.LOOP.value: "p2",
    StumbleKind.USER_FRUSTRATION.value: "p2",
    StumbleKind.TIMEOUT.value: "p2",
    StumbleKind.SELF_DIAGNOSTIC.value: "p2",
    StumbleKind.CUSTOM.value: "p3",
    HELP_MISS_KIND: "p1",
}


def severity_for_kind(kind: str) -> Severity:
    """Return the default severity for a stumble kind (fallback p2)."""
    return _DEFAULT_SEVERITY.get(kind, "p2")


@dataclass(slots=True)
class StumbleCreate:
    """Write contract for a new stumble (F28 ``StumbleCreate``)."""

    org_id: str
    trace_id: str
    kind: str
    title: str
    detail: dict[str, Any]
    detected_by: str
    severity: Severity | None = None
    session_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    span_id: str | None = None

    def resolved_severity(self) -> Severity:
        return self.severity or severity_for_kind(self.kind)


@dataclass(slots=True)
class Stumble:
    id: str
    org_id: str
    trace_id: str
    kind: str
    fingerprint: str
    title: str
    detail: dict[str, Any]
    severity: Severity
    detected_by: str
    session_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    span_id: str | None = None
    detected_at: datetime | None = None


@dataclass(slots=True)
class Issue:
    id: str
    org_id: str
    fingerprint: str
    kind: str
    title: str
    status: str
    severity: Severity
    stumble_count: int = 1
    user_count: int = 1
    repetition_count: int = 1
    agent_id: str | None = None
    affected_user_ids: list[str] = field(default_factory=list)
    example_stumble_ids: list[str] = field(default_factory=list)
    triage_result: dict[str, Any] | None = None
    experiment_id: str | None = None
    experiment_result: dict[str, Any] | None = None
    regression_case_id: str | None = None
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    was_created: bool = False
    was_regressed: bool = False
