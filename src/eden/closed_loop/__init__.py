"""Closed-loop error-diagnosis orchestrator (F46).

Ties the issues layer (F28/F29), triage (F30), remediation (N20/N21),
verification, and alerts (F47) into one event-driven loop:

    issue_created → triage → (recommend | heal | patch | human)
                 → verify → resolved | regressed → learn

Events flow through a Redis stream (``eden.loop.events``) consumed by a
consumer group (``eden-closed-loop``); the :class:`ClosedLoopOrchestrator`
handles each event, driving the F46 issue state machine and delegating to
existing services. ``subscribe()`` (G9) bridges the promotion hooks into
the loop.
"""

from __future__ import annotations

from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import (
    ClosedLoopOrchestrator,
    get_orchestrator,
)
from eden.closed_loop.state_machine import (
    ISSUE_STATE_TRANSITIONS,
    IssueStatus,
    next_status,
)

__all__ = [
    "ISSUE_STATE_TRANSITIONS",
    "ClosedLoopOrchestrator",
    "EventType",
    "IssueStatus",
    "LoopEvent",
    "get_orchestrator",
    "next_status",
]
