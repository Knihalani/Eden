"""M13 (§6.3) — webhook / guardian outcomes write KG rows."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.patches.knowledge_graph import CodebaseKnowledgeGraph, record_plan_outcome


ORG = "org-kg"
REPO = "agent-a"


def _plan(**overrides: Any) -> dict[str, Any]:
    base = {
        "id": "11111111-1111-1111-1111-111111111111",
        "org_id": ORG,
        "agent_id": REPO,
        "title": "Fix rate limiter",
        "files_changed": ["src/rate_limiter.py", "tests/test_rl.py"],
        "source_fingerprint": "issue:abc",
        "status": "pr_opened",
        "evidence": {},
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_record_outcome_merged_writes_kg() -> None:
    client = MagicMock()
    client.execute = AsyncMock()
    client.fetchrow = AsyncMock(
        return_value={"historical_patches_count": 1}
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        kg = CodebaseKnowledgeGraph()
        out = await kg.record_outcome(
            ORG, repo=REPO, path="src/rate_limiter.py", outcome="merged"
        )
    assert out["data"]["outcome"] == "merged"
    assert out["data"]["code_path"] == "src/rate_limiter.py"
    client.execute.assert_awaited()
    sql = client.execute.await_args.args[0]
    assert "codebase_knowledge_graph" in sql
    # merged bumps historical only (reverted/denied/edited args are 0)
    assert client.execute.await_args.args[6:9] == (0, 0, 0)


@pytest.mark.asyncio
async def test_record_outcome_reverted_bumps_reverted_count() -> None:
    client = MagicMock()
    client.execute = AsyncMock()
    client.fetchrow = AsyncMock(
        return_value={"historical_patches_count": 2}
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        kg = CodebaseKnowledgeGraph()
        out = await kg.record_outcome(
            ORG, REPO, "src/rate_limiter.py", "reverted"
        )
    assert out["data"]["outcome"] == "reverted"
    # bump_reverted=1, bump_denied=0, bump_edited=0
    assert client.execute.await_args.args[6:9] == (1, 0, 0)


@pytest.mark.asyncio
async def test_record_outcome_rejected_bumps_denied_count() -> None:
    client = MagicMock()
    client.execute = AsyncMock()
    client.fetchrow = AsyncMock(
        return_value={"historical_patches_count": 1}
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        kg = CodebaseKnowledgeGraph()
        out = await kg.record_outcome(
            ORG, REPO, "src/rate_limiter.py", "rejected"
        )
    assert out["data"]["outcome"] == "rejected"
    assert client.execute.await_args.args[6:9] == (0, 1, 0)


@pytest.mark.asyncio
async def test_mark_merged_records_kg_merged() -> None:
    plan = _plan(status="merged")
    with (
        patch(
            "eden.improvement.plans_repo.get_postgres_client",
            AsyncMock(return_value=MagicMock(execute=AsyncMock())),
        ),
        patch(
            "eden.improvement.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.patches.knowledge_graph.record_plan_outcome",
            AsyncMock(return_value=2),
        ) as rec,
    ):
        from eden.improvement import plans_repo

        result = await plans_repo.mark_merged(ORG, plan["id"])
    assert result is plan
    rec.assert_awaited_once_with(ORG, plan, "merged")


@pytest.mark.asyncio
async def test_mark_closed_records_kg_rejected_and_rejection_memory() -> None:
    plan = _plan(status="closed")
    with (
        patch(
            "eden.improvement.plans_repo.get_postgres_client",
            AsyncMock(return_value=MagicMock(execute=AsyncMock())),
        ),
        patch(
            "eden.improvement.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.patches.knowledge_graph.record_plan_outcome",
            AsyncMock(return_value=2),
        ) as rec,
        patch(
            "eden.improvement.plans_repo.write_rejection_memory",
            AsyncMock(),
        ) as mem,
    ):
        from eden.improvement import plans_repo

        result = await plans_repo.mark_closed(
            ORG, plan["id"], reason="pr_closed_without_merge"
        )
    assert result is plan
    rec.assert_awaited_once_with(ORG, plan, "rejected")
    mem.assert_awaited_once()


@pytest.mark.asyncio
async def test_guardian_follow_up_does_not_record_kg_reverted() -> None:
    """Follow-up-only regressions must not inflate KG revert history."""
    plan = _plan(status="merged", id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    with (
        patch(
            "eden.improvement.guardian._find_merged_plan_for_issue",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.improvement.guardian._existing_follow_up",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.improvement.guardian._decide_revert_allowed",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.improvement.guardian._draft_follow_up",
            AsyncMock(return_value={"id": "follow"}),
        ),
        patch(
            "eden.patches.knowledge_graph.record_plan_outcome",
            AsyncMock(return_value=1),
        ) as rec,
        patch(
            "eden.services.slack_notify.notify_regression",
            AsyncMock(return_value={}),
        ),
    ):
        from eden.improvement.guardian import handle_regression

        result = await handle_regression(ORG, "issue-1", severity="MEDIUM")
    assert result["status"] == "drafted"
    assert result["action"] == "follow_up"
    rec.assert_not_awaited()


@pytest.mark.asyncio
async def test_guardian_revert_records_kg_reverted() -> None:
    plan = _plan(status="merged", id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    revert_plan = {"id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}
    with (
        patch(
            "eden.improvement.guardian._find_merged_plan_for_issue",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.improvement.guardian._existing_follow_up",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.improvement.guardian._decide_revert_allowed",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.guardian._draft_revert",
            AsyncMock(return_value=(revert_plan, None)),
        ),
        patch(
            "eden.improvement.auto_merge.parent_is_canary_auto_merged",
            return_value=False,
        ),
        patch(
            "eden.patches.knowledge_graph.record_plan_outcome",
            AsyncMock(return_value=1),
        ) as rec,
        patch(
            "eden.services.slack_notify.notify_regression",
            AsyncMock(return_value={}),
        ),
    ):
        from eden.improvement.guardian import handle_regression

        result = await handle_regression(ORG, "issue-1", severity="P0")
    assert result["action"] == "revert"
    rec.assert_awaited_once_with(ORG, plan, "reverted")


@pytest.mark.asyncio
async def test_record_plan_outcome_walks_files() -> None:
    calls: list[tuple[str, str]] = []

    async def _fake_record(self: Any, **kwargs: Any) -> dict[str, Any]:
        calls.append((kwargs["code_path"], kwargs["outcome"]))
        return {"data": {}}

    with patch.object(
        CodebaseKnowledgeGraph, "record_outcome", _fake_record
    ):
        n = await record_plan_outcome(ORG, _plan(), "merged")
    assert n == 2
    assert calls[0][0] == "src/rate_limiter.py"
    assert calls[0][1] == "merged"
