"""Unit tests for Phase 2b — improvement_plans PR merge/close sync.

The GitHub webhook (Phase 2b) needs a way to find the improvement_plans
row a PR belongs to, and to flip its status to ``merged``/``closed``
without needing the caller to already know the org_id. These tests
cover ``plans_repo.find_by_pr`` / ``mark_merged`` / ``mark_closed`` in
isolation from the webhook route itself.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement import plans_repo


def _mock_client(*, fetchrow_return: dict | None = None) -> MagicMock:
    client = MagicMock()
    client.execute = AsyncMock(return_value="UPDATE 1")
    client.fetchrow = AsyncMock(return_value=fetchrow_return)
    return client


@pytest.mark.asyncio
async def test_find_by_pr_matches_canonical_github_url() -> None:
    row = {
        "id": "plan-1",
        "org_id": "org-1",
        "pr_number": 42,
        "pr_url": "https://github.com/acme/widgets/pull/42",
        "status": "pr_opened",
        "files_changed": [],
        "evidence": {},
    }
    client = _mock_client(fetchrow_return=row)
    with patch.object(
        plans_repo, "get_postgres_client", AsyncMock(return_value=client)
    ):
        found = await plans_repo.find_by_pr(
            repo_full_name="acme/widgets", pr_number=42
        )

    assert found is not None
    assert found["id"] == "plan-1"
    args = client.fetchrow.await_args.args
    assert args[1] == 42
    assert args[2] == "https://github.com/acme/widgets/pull/42"


@pytest.mark.asyncio
async def test_find_by_pr_returns_none_when_no_match() -> None:
    client = _mock_client(fetchrow_return=None)
    with patch.object(
        plans_repo, "get_postgres_client", AsyncMock(return_value=client)
    ):
        found = await plans_repo.find_by_pr(
            repo_full_name="acme/widgets", pr_number=99
        )
    assert found is None


@pytest.mark.asyncio
async def test_find_by_pr_returns_none_without_required_args() -> None:
    assert await plans_repo.find_by_pr(repo_full_name="", pr_number=1) is None
    assert await plans_repo.find_by_pr(repo_full_name="a/b", pr_number=0) is None


@pytest.mark.asyncio
async def test_mark_merged_updates_status_and_returns_plan() -> None:
    updated_row = {
        "id": "plan-1",
        "org_id": "org-1",
        "status": "merged",
        "files_changed": [],
        "evidence": {},
    }
    client = _mock_client(fetchrow_return=updated_row)
    with patch.object(
        plans_repo, "get_postgres_client", AsyncMock(return_value=client)
    ):
        result = await plans_repo.mark_merged("org-1", "plan-1")

    assert result is not None
    assert result["status"] == "merged"
    client.execute.assert_awaited_once()
    sql = client.execute.await_args.args[0]
    assert "status = 'merged'" in sql
    open_statuses = client.execute.await_args.args[3]
    assert set(open_statuses) == set(plans_repo._OPEN_STATUSES)


@pytest.mark.asyncio
async def test_mark_closed_sets_status_and_rejection_reason() -> None:
    updated_row = {
        "id": "plan-1",
        "org_id": "org-1",
        "status": "closed",
        "rejection_reason": "pr_closed_without_merge",
        "files_changed": [],
        "evidence": {},
    }
    client = _mock_client(fetchrow_return=updated_row)
    with patch.object(
        plans_repo, "get_postgres_client", AsyncMock(return_value=client)
    ):
        result = await plans_repo.mark_closed(
            "org-1", "plan-1", reason="pr_closed_without_merge"
        )

    assert result is not None
    assert result["status"] == "closed"
    assert result["rejection_reason"] == "pr_closed_without_merge"
    args = client.execute.await_args.args
    assert args[3] == "pr_closed_without_merge"
    assert set(args[4]) == set(plans_repo._OPEN_STATUSES)


@pytest.mark.asyncio
async def test_mark_merged_noop_when_client_unavailable() -> None:
    with patch.object(
        plans_repo, "get_postgres_client", AsyncMock(return_value=None)
    ):
        assert await plans_repo.mark_merged("org-1", "plan-1") is None
