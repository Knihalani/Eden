"""M3 (D3) — fix_pending janitor: issues stranded in ``fix_pending``
older than ``fix_pending_max_age_minutes`` go back to ``triaged`` with an
audit row and a cockpit ``stuck`` badge."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import verify

ORG = "org-janitor"
ISSUE = "cccccccc-cccc-cccc-cccc-cccccccccccc"


@pytest.fixture(autouse=True)
def _clean_registry():
    verify._reset_state_for_tests()
    yield
    verify._reset_state_for_tests()


def _client(rows: list[dict[str, Any]]) -> MagicMock:
    client = MagicMock()
    client.fetch = AsyncMock(return_value=rows)
    client.execute = AsyncMock(return_value="OK")
    return client


def _stale_row(age_seconds: float = 3 * 3600.0) -> dict[str, Any]:
    return {"id": ISSUE, "org_id": ORG, "age_seconds": age_seconds}


@pytest.mark.asyncio
async def test_janitor_sweeps_stale_row_and_audits() -> None:
    client = _client([_stale_row()])
    issue = SimpleNamespace(triage_result={"root_cause": "bug"})
    repo = MagicMock()
    repo.set_status = AsyncMock(return_value=True)
    repo.get_issue = AsyncMock(return_value=issue)
    repo.set_triage_result = AsyncMock(return_value=True)
    audit = AsyncMock()

    with patch.object(verify, "_pg", AsyncMock(return_value=client)), patch(
        "eden.issues.repo.IssuesRepo", return_value=repo
    ), patch("eden.closed_loop.autonomy_policy.audit", audit):
        swept = await verify.fix_pending_janitor()

    assert swept == 1
    repo.set_status.assert_awaited_once_with(ORG, ISSUE, "triaged")

    # Cockpit badge merged into triage_result (existing keys preserved).
    stamped = repo.set_triage_result.await_args.args[2]
    assert stamped["root_cause"] == "bug"
    assert stamped["stuck"]["by"] == "fix_pending_janitor"
    assert stamped["stuck"]["age_minutes"] == 180
    assert stamped["stuck"]["returned_to"] == "triaged"

    # Audit row.
    audit.assert_awaited_once()
    kwargs = audit.await_args.kwargs
    assert audit.await_args.args[0] == ORG
    assert kwargs["action"] == "fix_pending_janitor"
    assert kwargs["decision"] == "allow"
    assert "180m" in kwargs["reason"]


@pytest.mark.asyncio
async def test_janitor_respects_max_age_setting() -> None:
    client = _client([])

    def _cfg(name: str, default: int) -> int:
        return 45 if name == "fix_pending_max_age_minutes" else default

    with patch.object(verify, "_pg", AsyncMock(return_value=client)), patch.object(
        verify, "_cfg", _cfg
    ):
        swept = await verify.fix_pending_janitor()

    assert swept == 0
    client.fetch.assert_awaited_once()
    assert client.fetch.await_args.args[1] == "45"  # minutes → SQL interval


@pytest.mark.asyncio
async def test_janitor_leaves_fresh_rows_untouched() -> None:
    # The SQL age filter returns nothing → nothing is touched.
    client = _client([])
    repo = MagicMock()
    repo.set_status = AsyncMock()
    audit = AsyncMock()

    with patch.object(verify, "_pg", AsyncMock(return_value=client)), patch(
        "eden.issues.repo.IssuesRepo", return_value=repo
    ), patch("eden.closed_loop.autonomy_policy.audit", audit):
        swept = await verify.fix_pending_janitor()

    assert swept == 0
    repo.set_status.assert_not_awaited()
    audit.assert_not_awaited()


@pytest.mark.asyncio
async def test_janitor_skips_rows_it_cannot_move() -> None:
    client = _client([_stale_row()])
    repo = MagicMock()
    repo.set_status = AsyncMock(return_value=False)  # lost the race
    repo.get_issue = AsyncMock()
    audit = AsyncMock()

    with patch.object(verify, "_pg", AsyncMock(return_value=client)), patch(
        "eden.issues.repo.IssuesRepo", return_value=repo
    ), patch("eden.closed_loop.autonomy_policy.audit", audit):
        swept = await verify.fix_pending_janitor()

    assert swept == 0
    audit.assert_not_awaited()


def test_janitor_registered_as_default_chore() -> None:
    verify._register_default_chores()
    by_name = {c.name: c for c in verify._IDLE_CHORES}
    assert "fix_pending_janitor" in by_name
    assert by_name["fix_pending_janitor"].interval_s == 300.0
    assert by_name["fix_pending_janitor"].fn is verify.fix_pending_janitor
