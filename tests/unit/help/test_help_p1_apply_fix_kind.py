"""Point 11: HelpMiss apply prefers a code PR, else one-line instruction replace."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.help_miss_apply import (
    choose_help_miss_apply,
    existing_help_miss_pr_url,
    resolve_help_miss_target_file,
)
from eden.improvement.issue_patch_trigger import instruction_is_generic


def test_resolve_file_from_leftover_path() -> None:
    assert (
        resolve_help_miss_target_file(
            [{"snippet": "I'll just do it", "path": "src/refunds.py"}]
        )
        == "src/refunds.py"
    )
    assert resolve_help_miss_target_file([{"snippet": "I'll just do it"}]) is None


def test_choose_code_pr_when_path_or_diff() -> None:
    ev = {
        "instruction": "Issue refunds under $50 without asking.",
        "fix_kind": "code_change",
        "leftovers": [{"snippet": "I'll just do it", "path": "src/refunds.py"}],
    }
    choice = choose_help_miss_apply(ev, plan={"diff_unified": "diff --git a/src/refunds.py"})
    assert choice["status"] == "ok"
    assert choice["apply_kind"] == "code_pr"
    assert choice["target_file"] == "src/refunds.py"
    assert choice["can_open_pr"] is True


def test_choose_instruction_replace_when_no_file() -> None:
    ev = {
        "instruction": "Issue refunds under $50 without asking.",
        "fix_kind": "instruction_replace",
        "leftovers": [{"snippet": "I'll just do the refund myself"}],
    }
    choice = choose_help_miss_apply(ev)
    assert choice["apply_kind"] == "instruction_replace"
    assert choice["target_file"] is None
    assert choice["can_open_pr"] is False


def test_choose_refuses_generic() -> None:
    ev = {
        "instruction": "be more helpful",
        "leftovers": [{"snippet": "I'll just do it", "path": "src/refunds.py"}],
    }
    assert choose_help_miss_apply(ev)["status"] == "refused"
    assert instruction_is_generic("be more helpful")


def test_existing_pr_is_idempotent() -> None:
    plan = {"pr_url": "https://github.com/acme/repo/pull/9"}
    assert existing_help_miss_pr_url(plan) == "https://github.com/acme/repo/pull/9"


@pytest.mark.asyncio
async def test_approve_help_miss_instruction_replace_no_agents_md() -> None:
    from eden.improvement.help_miss_apply import approve_help_miss_plan

    plan = {
        "id": "p1",
        "agent_id": "agent-a",
        "plan_kind": "prompt_update",
        "evidence": {
            "help_miss": True,
            "fix_kind": "instruction_replace",
            "instruction": "Issue refunds under $50 without asking.",
            "leftovers": [{"snippet": "I'll just do the refund myself"}],
        },
    }
    with (
        patch(
            "eden.improvement.plans_repo.mark_approved",
            AsyncMock(return_value={"id": "p1", "status": "approved"}),
        ) as marked,
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent", "channel": "C123"}),
        ) as notify,
    ):
        out = await approve_help_miss_plan("org", "p1", plan, approved_by="kaiav")
    assert out["status"] == "applied"
    assert out["apply_kind"] == "instruction_replace"
    assert out["agents_md"] is False
    assert out["pr_url"] is None
    meta = marked.await_args.kwargs["metadata"]
    assert meta["agents_md"] is False
    assert meta["apply_kind"] == "instruction_replace"
    notify.assert_awaited_once()
    assert notify.await_args.kwargs["apply_kind"] == "instruction_replace"


@pytest.mark.asyncio
async def test_approve_help_miss_reuses_pr_url() -> None:
    from eden.improvement.help_miss_apply import approve_help_miss_plan

    plan = {
        "id": "p2",
        "agent_id": "agent-a",
        "plan_kind": "prompt_update",
        "pr_url": "https://github.com/acme/repo/pull/9",
        "diff_unified": "diff --git a/src/refunds.py b/src/refunds.py",
        "evidence": {
            "help_miss": True,
            "fix_kind": "code_change",
            "instruction": "Issue refunds under $50 without asking.",
            "leftovers": [
                {"snippet": "rewrote the reply", "path": "src/refunds.py", "trace_id": "tr-1"}
            ],
        },
    }
    with (
        patch(
            "eden.improvement.plans_repo.mark_approved",
            AsyncMock(return_value={"id": "p2", "status": "approved"}),
        ),
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent"}),
        ) as notify,
    ):
        out = await approve_help_miss_plan("org", "p2", plan, approved_by="kaiav")
    assert out["apply_kind"] == "code_pr"
    assert out["pr_url"] == "https://github.com/acme/repo/pull/9"
    assert out["agents_md"] is False
    assert notify.await_args.kwargs["pr_url"] == "https://github.com/acme/repo/pull/9"


@pytest.mark.asyncio
async def test_approve_plan_routes_help_miss_generic_to_refuse() -> None:
    from eden.improvement.approve import approve_plan

    plan = {
        "id": "p3",
        "status": "draft",
        "plan_kind": "prompt_update",
        "evidence": {
            "help_miss": True,
            "instruction": "be more helpful",
            "leftovers": [{"snippet": "I'll just do it"}],
        },
    }
    with (
        patch("eden.improvement.plans_repo.get_plan", AsyncMock(return_value=plan)),
        patch("eden.improvement.approve._n22_blocked", AsyncMock(return_value=None)),
    ):
        out = await approve_plan("org", "p3", approved_by="kaiav")
    assert out["status"] == "refused"
    assert out["reason"] == "generic_draft"


@pytest.mark.asyncio
async def test_notify_help_miss_applied_uses_picked_channel() -> None:
    from eden.services import slack_notify

    with patch.object(
        slack_notify, "_send", AsyncMock(return_value={"status": "sent", "channel": "Cwatch"})
    ) as send:
        out = await slack_notify.notify_help_miss_applied(
            "org",
            agent_id="agent-a",
            plan_id="p1",
            apply_kind="instruction_replace",
        )
    assert out["status"] == "sent"
    assert send.await_args.kwargs["agent_id"] == "agent-a"
    assert send.await_args.kwargs["dedupe_key"] == "helpmiss_applied:p1"
    assert "Change is in Eden" in send.await_args.kwargs["blocks"][1]["text"]["text"]


def test_apply_module_never_mentions_agents_md_write() -> None:
    from pathlib import Path

    src = Path(__file__).resolve().parents[3] / "src/eden/improvement/help_miss_apply.py"
    text = src.read_text()
    assert "AGENTS.md" not in text
    assert "eden:start" not in text
