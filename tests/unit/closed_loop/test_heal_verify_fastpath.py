"""M10 (§5.3) — heal verify fast-path via ``ref`` prefixes.

``heal:<fingerprint_or_id>`` refs schedule in ``verify_delay_seconds_heal``
(300s) and verify with ``verify_quiet_window_minutes_heal`` (10min);
``merge:<plan_id>`` and legacy raw-fingerprint refs keep the code-merge
defaults (1800s / 30min).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import verify as verify_mod

ORG = "org_fastpath"
ISSUE = "issue-fast-1"
FP = "fp-fast-1"


class _Issue:
    fingerprint = FP


def _client() -> MagicMock:
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"id": "v-row-1"})
    return client


async def _schedule(ref: str, **kw: Any) -> tuple[Any, ...]:
    """Run schedule_verify and return the INSERT args."""
    client = _client()
    with patch.object(
        verify_mod, "_pg", new=AsyncMock(return_value=client)
    ), patch("eden.issues.repo.IssuesRepo") as repo_cls:
        repo_cls.return_value.get_issue = AsyncMock(return_value=_Issue())
        out = await verify_mod.schedule_verify(ORG, ISSUE, ref=ref, **kw)
    assert out == "v-row-1"
    return client.fetchrow.await_args.args


# ── scheduling delay ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_heal_ref_uses_fast_delay() -> None:
    args = await _schedule(f"heal:{FP}")
    # args: (query, verify_id, org, issue, fingerprint, ref, delay)
    assert args[6] == "300"
    assert args[5] == f"heal:{FP}"
    # A prefixed ref is a source tag — fingerprint comes from the issue.
    assert args[4] == FP


@pytest.mark.asyncio
async def test_merge_ref_uses_default_delay() -> None:
    args = await _schedule("merge:plan-123")
    assert args[6] == "1800"
    assert args[5] == "merge:plan-123"
    assert args[4] == FP


@pytest.mark.asyncio
async def test_legacy_raw_ref_unchanged() -> None:
    args = await _schedule(FP)
    assert args[6] == "1800"
    assert args[5] == FP
    assert args[4] == FP  # raw ref still treated as the fingerprint


@pytest.mark.asyncio
async def test_explicit_delay_overrides_prefix() -> None:
    args = await _schedule(f"heal:{FP}", delay_seconds=42)
    assert args[6] == "42"


# ── quiet window per ref prefix ─────────────────────────────────────


def test_quiet_window_minutes_by_prefix() -> None:
    assert verify_mod._quiet_window_minutes(f"heal:{FP}") == 10
    assert verify_mod._quiet_window_minutes("merge:plan-123") == 30
    assert verify_mod._quiet_window_minutes(FP) == 30
    assert verify_mod._quiet_window_minutes("") == 30
    assert verify_mod._quiet_window_minutes(None) == 30


@pytest.mark.asyncio
async def test_verify_issue_uses_heal_window() -> None:
    with patch("eden.issues.repo.IssuesRepo") as repo_cls:
        repo = repo_cls.return_value
        repo.count_recent_stumbles = AsyncMock(return_value=1)
        passed, detail = await verify_mod._verify_issue(
            ORG, ISSUE, FP, f"heal:{FP}"
        )
    assert passed is False  # stumbles inside the window
    assert detail["quiet_window_minutes"] == 10
    repo.count_recent_stumbles.assert_awaited_once_with(
        ORG, FP, minutes=10
    )


@pytest.mark.asyncio
async def test_verify_issue_merge_and_legacy_window() -> None:
    for ref in ("merge:plan-123", FP, ""):
        with patch("eden.issues.repo.IssuesRepo") as repo_cls:
            repo = repo_cls.return_value
            repo.count_recent_stumbles = AsyncMock(return_value=1)
            _passed, detail = await verify_mod._verify_issue(
                ORG, ISSUE, FP, ref
            )
        assert detail["quiet_window_minutes"] == 30, ref
