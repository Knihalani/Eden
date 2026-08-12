"""Wave 5 pinning tests — 5.3 ledger: the plan's event trail gains the verify leg.

``queue_verify_for_plan`` (approve.py) is the choke point every N01
replay-verify schedule funnels through. Wave 5 emits a ``verify_queued``
plan event there so the plan ledger renders the full loop trail:
triage → approve → verify queued → merged → post-merge watch.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.approve import queue_verify_for_plan


def _plan(**overrides: object) -> dict[str, object]:
    plan: dict[str, object] = {
        "id": "11111111-1111-1111-1111-111111111111",
        "org_id": "org-1",
        "status": "pr_opened",
        "evidence": {"issue_id": "issue-9"},
    }
    plan.update(overrides)
    return plan


@pytest.mark.asyncio
async def test_queue_verify_emits_verify_queued_plan_event() -> None:
    emit = AsyncMock()
    with (
        patch(
            "eden.improvement.approve._queue_verify", AsyncMock(return_value="verify-1")
        ),
        patch("eden.improvement.approve.plans_repo.emit_event", emit),
    ):
        verify_id = await queue_verify_for_plan("org-1", _plan())

    assert verify_id == "verify-1"
    args = emit.await_args.args
    assert args[0] == "org-1"
    assert args[1] == "11111111-1111-1111-1111-111111111111"
    assert args[2] == "verify_queued"
    assert emit.await_args.kwargs["payload"]["verification_id"] == "verify-1"


@pytest.mark.asyncio
async def test_queue_verify_post_merge_detail() -> None:
    emit = AsyncMock()
    with (
        patch(
            "eden.improvement.approve._queue_verify", AsyncMock(return_value="v-2")
        ),
        patch("eden.improvement.approve.plans_repo.emit_event", emit),
    ):
        await queue_verify_for_plan(
            "org-1",
            _plan(evidence={"issue_id": "issue-9", "auto_merge": {"merged": True}}),
        )

    assert "post-merge replay verify queued" in emit.await_args.kwargs["detail"]
    assert emit.await_args.kwargs["payload"]["post_merge"] is True


@pytest.mark.asyncio
async def test_queue_verify_no_event_when_verify_not_scheduled() -> None:
    emit = AsyncMock()
    with (
        patch("eden.improvement.approve._queue_verify", AsyncMock(return_value=None)),
        patch("eden.improvement.approve.plans_repo.emit_event", emit),
    ):
        verify_id = await queue_verify_for_plan("org-1", _plan())

    assert verify_id is None
    emit.assert_not_awaited()


@pytest.mark.asyncio
async def test_queue_verify_event_failure_never_breaks_scheduling() -> None:
    emit = AsyncMock(side_effect=RuntimeError("db blip"))
    with (
        patch(
            "eden.improvement.approve._queue_verify", AsyncMock(return_value="verify-3")
        ),
        patch("eden.improvement.approve.plans_repo.emit_event", emit),
    ):
        verify_id = await queue_verify_for_plan("org-1", _plan())

    assert verify_id == "verify-3"
