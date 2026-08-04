"""F46 issue state machine + transition persistence.

    open ─▶ triaged ─▶ fix_pending ─▶ verifying ─▶ resolved
                                          │           ▲
                                          ▼           │
                                       regressed ─────┘ (re-open on new stumble)

Terminal-ish states (``resolved``/``ignored``) can transition back to
``regressed`` when a matching stumble reappears (handled by the promoter).
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from eden.closed_loop.events import EventType

logger = logging.getLogger(__name__)


class IssueStatus:
    OPEN = "open"
    TRIAGED = "triaged"
    FIX_PENDING = "fix_pending"
    VERIFYING = "verifying"
    RESOLVED = "resolved"
    REGRESSED = "regressed"
    IGNORED = "ignored"
    LEARNING = "learning"
    # M4 (D17): waiting on a human — written by ESCALATED_HUMAN so the
    # cockpit can filter "waiting on human" instead of escalations being
    # invisible status no-ops.
    ESCALATED = "escalated"


# Allowed forward transitions per event type.
ISSUE_STATE_TRANSITIONS: dict[str, dict[str, str]] = {
    EventType.TRIAGE_COMPLETED: {
        IssueStatus.OPEN: IssueStatus.TRIAGED,
        IssueStatus.REGRESSED: IssueStatus.TRIAGED,
    },
    # M3 (D5): triage failure is a recorded self-loop — the status stays
    # ``open`` but the attempt lands in ``issue_state_transitions``.
    EventType.TRIAGE_FAILED: {IssueStatus.OPEN: IssueStatus.OPEN},
    EventType.HEAL_REQUESTED: {IssueStatus.TRIAGED: IssueStatus.FIX_PENDING},
    # M3 (D3): a failed heal returns the issue to ``triaged`` instead of
    # stranding it in ``fix_pending``.
    EventType.HEAL_FAILED: {IssueStatus.FIX_PENDING: IssueStatus.TRIAGED},
    EventType.PATCH_PROPOSED: {IssueStatus.TRIAGED: IssueStatus.FIX_PENDING},
    EventType.HEAL_EXECUTED: {
        IssueStatus.FIX_PENDING: IssueStatus.VERIFYING,
        IssueStatus.TRIAGED: IssueStatus.VERIFYING,
    },
    EventType.VERIFY_SCHEDULED: {
        IssueStatus.FIX_PENDING: IssueStatus.VERIFYING,
        IssueStatus.TRIAGED: IssueStatus.VERIFYING,
    },
    EventType.VERIFY_PASSED: {IssueStatus.VERIFYING: IssueStatus.RESOLVED},
    EventType.VERIFY_FAILED: {IssueStatus.VERIFYING: IssueStatus.REGRESSED},
    # M4 (D17): escalation writes a real status. ``regressed`` is NOT a
    # source state on purpose — a post-verify regression keeps its more
    # specific status (the golden-path harness asserts it) while the
    # escalation event/alert still fires.
    EventType.ESCALATED_HUMAN: {
        IssueStatus.OPEN: IssueStatus.ESCALATED,
        IssueStatus.TRIAGED: IssueStatus.ESCALATED,
        IssueStatus.FIX_PENDING: IssueStatus.ESCALATED,
        IssueStatus.VERIFYING: IssueStatus.ESCALATED,
    },
    # M13 (§6.4): LEARNING state around permanent N01 regression case.
    EventType.LEARNING_STARTED: {
        IssueStatus.RESOLVED: IssueStatus.LEARNING,
    },
    EventType.LEARNING_COMPLETED: {
        IssueStatus.LEARNING: IssueStatus.RESOLVED,
    },
}


def next_status(current: str, event_type: str) -> str | None:
    """Return the target status for ``(current, event_type)`` or None."""
    return ISSUE_STATE_TRANSITIONS.get(event_type, {}).get(current)


async def apply_transition(
    org_id: str,
    issue_id: str,
    *,
    event_type: str,
    reason: str = "",
    actor: str = "orchestrator",
    detail: dict[str, Any] | None = None,
    set_resolved_at: bool | None = None,
) -> str | None:
    """Advance an issue's status per the state machine + append an audit
    row. Returns the new status, or None if the transition is not valid
    from the issue's current status (a no-op)."""
    from eden.issues.repo import IssuesRepo

    repo = IssuesRepo()
    issue = await repo.get_issue(org_id, issue_id)
    if issue is None:
        return None
    target = next_status(issue.status, event_type)
    if target is None:
        return None
    if target != issue.status:
        # Normal forward transition — move the row.
        resolved = (
            set_resolved_at
            if set_resolved_at is not None
            else target == IssueStatus.RESOLVED
        )
        ok = await repo.set_status(
            org_id, issue_id, target, set_resolved_at=resolved
        )
        if not ok:
            return None
    # else: declared self-loop (e.g. TRIAGE_FAILED open→open) — no status
    # write, but the attempt is still recorded below (M3, D5).

    await _record_transition(
        org_id,
        issue_id,
        from_status=issue.status,
        to_status=target,
        event_type=event_type,
        reason=reason,
        actor=actor,
        detail=detail or {},
    )
    return target


async def _record_transition(
    org_id: str,
    issue_id: str,
    *,
    from_status: str,
    to_status: str,
    event_type: str,
    reason: str,
    actor: str,
    detail: dict[str, Any],
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO issue_state_transitions
                (id, org_id, issue_id, from_status, to_status, event_type,
                 reason, actor, detail)
            VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb)
            """,
            str(uuid.uuid4()),
            org_id,
            issue_id,
            from_status,
            to_status,
            event_type[:48],
            (reason or "")[:2000],
            actor[:64],
            json.dumps(detail, default=str),
        )
    except Exception as exc:
        # The status row already moved; losing the audit row must not be
        # silent (chaos row c). Log loudly with full transition identity and
        # bump a counter so monitoring can see audit-row loss.
        logger.error(
            "state_machine: audit-row loss — issue_state_transitions insert "
            "failed for org=%s issue=%s %s->%s event=%s: %s",
            org_id,
            issue_id,
            from_status,
            to_status,
            event_type,
            exc,
        )
        try:
            from eden.observability.simple_metrics import Counter

            Counter(
                "eden_loop_audit_row_loss_total",
                "issue_state_transitions audit-row insert failures",
                labelnames=("event_type",),
            ).labels(event_type=event_type[:48]).inc()
        except Exception:  # noqa: BLE001 - metrics must never mask the log
            pass
