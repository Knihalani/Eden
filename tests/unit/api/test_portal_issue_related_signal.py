"""FEAT-84 — ``IssueCard.relatedSignalId`` must reflect the real
signal-investigator signal that produced the issue, not a hardcoded
``None``.

An issue's ``example_stumble_ids`` may include a stumble raised by the
signal investigator (``detected_by = 'signal_investigator'``, carrying
``detail.signal_id`` = a ``signal_definitions.id``). That def id maps to
the portal-facing ``nl_signals.id`` via the dual-write
``template_id = 'nl:' || nl_signals.id`` convention. ``list_portal_issues``
must thread that id through to ``IssueCard.relatedSignalId``; issues with
no such linkage must correctly report ``None``.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import portal as portal_mod
from eden.issues.models import Issue


class _FakeClient:
    """Routed by SQL shape."""

    async def fetch(self, query: str, *args):
        if "FROM agent_stumbles" in query:
            return [
                {
                    "id": "stmb-1",
                    "trace_id": "trace-1",
                    "session_id": "sess-1",
                    "detail": json.dumps(
                        {"source": "signal_investigator", "signal_id": "def-abc"}
                    ),
                    "detected_by": "signal_investigator",
                },
                {
                    "id": "stmb-2",
                    "trace_id": "trace-2",
                    "session_id": "sess-2",
                    "detail": json.dumps({}),
                    "detected_by": "other_detector",
                },
            ]
        if "FROM signal_definitions" in query:
            return [{"def_id": "def-abc", "nl_id": "nl-signal-1"}]
        return []


def _issue(issue_id: str, stumble_id: str) -> Issue:
    return Issue(
        id=issue_id,
        org_id="org_1",
        fingerprint=f"fp-{issue_id}",
        kind="latency_spike",
        title=f"Issue {issue_id}",
        status="open",
        severity="p1",
        stumble_count=3,
        example_stumble_ids=[stumble_id],
        triage_result={},
        agent_id="agent-1",
    )


@pytest.mark.asyncio
async def test_issue_with_signal_investigator_stumble_gets_related_signal_id():
    issues = [_issue("iss-1", "stmb-1"), _issue("iss-2", "stmb-2")]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_FakeClient()),
        ),
        patch(
            "eden.issues.repo.IssuesRepo.list_issues",
            AsyncMock(return_value=issues),
        ),
    ):
        cards = await portal_mod.list_portal_issues(
            org_id="org_1", limit=50, offset=0, _user={"sub": "u1"}
        )

    by_id = {c.id: c for c in cards}
    assert by_id["iss-1"].relatedSignalId == "nl-signal-1", (
        "issue whose stumble was raised by the signal investigator must "
        "surface the real nl_signals id, not None"
    )
    assert by_id["iss-2"].relatedSignalId is None, (
        "issue with no signal-investigator-linked stumble must stay None, "
        "not have a value forced onto it"
    )
