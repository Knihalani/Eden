"""FEAT-86 — blast-radius severity escalation in IssuePromoter._update."""

from __future__ import annotations

from typing import Any

import pytest

from eden.issues.issue_promoter import (
    IssuePromoter,
    _more_severe,
    _severity_from_blast_radius,
)
from eden.issues.models import StumbleCreate


def test_severity_from_blast_radius_tier_one() -> None:
    assert _severity_from_blast_radius(
        "p3", user_count=10, stumble_count=1, repetition_count=1
    ) == "p2"
    assert _severity_from_blast_radius(
        "p3", user_count=1, stumble_count=20, repetition_count=1
    ) == "p2"


def test_severity_from_blast_radius_tier_two_only() -> None:
    # repetition_count alone satisfies tier 2 (+1 bump), not tier 1.
    assert _severity_from_blast_radius(
        "p3", user_count=1, stumble_count=1, repetition_count=5
    ) == "p2"


def test_severity_from_blast_radius_tier_two_with_high_volume() -> None:
    # user_count >= 50 satisfies both tiers (+2 bumps).
    assert _severity_from_blast_radius(
        "p3", user_count=50, stumble_count=1, repetition_count=1
    ) == "p1"
    assert _severity_from_blast_radius(
        "p3", user_count=1, stumble_count=100, repetition_count=1
    ) == "p1"


def test_severity_from_blast_radius_both_tiers_stack() -> None:
    assert _severity_from_blast_radius(
        "p3", user_count=50, stumble_count=100, repetition_count=5
    ) == "p1"


def test_severity_from_blast_radius_never_past_p0() -> None:
    assert _severity_from_blast_radius(
        "p0", user_count=100, stumble_count=200, repetition_count=10
    ) == "p0"


def test_more_severe_never_downgrades() -> None:
    assert _more_severe("p1", "p3") == "p1"


@pytest.mark.asyncio
async def test_update_escalates_severity_from_counters() -> None:
    promoter = IssuePromoter()
    existing = {
        "id": "issue-1",
        "org_id": "org_test",
        "fingerprint": "fp",
        "kind": "custom",
        "title": "t",
        "status": "open",
        "severity": "p3",
        "stumble_count": 19,
        "user_count": 1,
        "repetition_count": 1,
        "affected_user_ids": ["u1"],
        "example_stumble_ids": ["s0"],
    }
    sc = StumbleCreate(
        org_id="org_test",
        trace_id="trace-1",
        kind="custom",
        title="t",
        detail={},
        detected_by="test",
        user_id="u2",
    )

    class _Conn:
        last_args: tuple[Any, ...] = ()

        async def execute(self, sql: str, *args: Any) -> str:
            _Conn.last_args = args
            return "UPDATE 1"

    issue = await promoter._update(_Conn(), existing, sc, "s1", "p3")
    # stumble_count 19→20 triggers tier-1 bump p3→p2
    assert issue.severity == "p2"
    assert _Conn.last_args[4] == "p2"
