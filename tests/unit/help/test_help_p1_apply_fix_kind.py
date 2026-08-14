"""Point 11: HelpMiss apply prefers a code PR, else one-line instruction replace."""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.help_miss_apply import (
    approve_help_miss_plan,
    choose_help_miss_apply,
    existing_help_miss_pr_url,
    replace_one_agent_instruction,
    resolve_help_miss_target_file,
)
from eden.improvement.issue_patch_trigger import instruction_is_generic


_INSTRUCTION = "Issue refunds under $50 without asking."


def test_resolve_file_from_leftover_path() -> None:
    assert (
        resolve_help_miss_target_file(
            [{"snippet": "I'll just do it", "path": "src/refunds.py"}]
        )
        == "src/refunds.py"
    )
    assert resolve_help_miss_target_file([{"snippet": "I'll just do it"}]) is None
    assert (
        resolve_help_miss_target_file(
            [{"snippet": "I'll just do it", "path": "ambient"}]
        )
        is None
    )


def test_choose_code_pr_when_path_or_diff() -> None:
    ev = {
        "instruction": _INSTRUCTION,
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
        "instruction": _INSTRUCTION,
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
    assert choose_help_miss_apply({"instruction": ""})["status"] == "refused"


def test_existing_pr_is_idempotent() -> None:
    plan = {"pr_url": "https://github.com/acme/repo/pull/9"}
    assert existing_help_miss_pr_url(plan) == "https://github.com/acme/repo/pull/9"


def test_replace_one_instruction_overwrites_does_not_append() -> None:
    one = replace_one_agent_instruction("old line", _INSTRUCTION)
    assert one == _INSTRUCTION
    assert one.count(_INSTRUCTION) == 1
    multi = replace_one_agent_instruction(
        "You are the refund agent.\nDo not leave it for the human.",
        _INSTRUCTION,
    )
    assert multi.splitlines()[0] == "You are the refund agent."
    assert multi.splitlines()[-1] == _INSTRUCTION
    assert multi.count(_INSTRUCTION) == 1


def _pin_ok() -> dict:
    return {
        "status": "pinned",
        "prompt_name": "agent-a",
        "version": 4,
        "env": "prod",
    }


@pytest.mark.asyncio
async def test_approve_help_miss_instruction_replace_no_agents_md() -> None:
    plan = {
        "id": "p1",
        "agent_id": "agent-a",
        "plan_kind": "prompt_update",
        "evidence": {
            "help_miss": True,
            "fix_kind": "instruction_replace",
            "instruction": _INSTRUCTION,
            "leftovers": [{"snippet": "I'll just do the refund myself"}],
        },
    }
    with (
        patch(
            "eden.improvement.help_miss_apply._pin_help_miss_instruction",
            AsyncMock(return_value=_pin_ok()),
        ) as pin,
        patch(
            "eden.improvement.plans_repo.mark_approved",
            AsyncMock(return_value={"id": "p1", "status": "approved"}),
        ) as marked,
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent", "channel": "C123"}),
        ) as notify,
        patch(
            "eden.improvement.plans_repo.mark_pr_opened",
            AsyncMock(),
        ) as pr_opened,
    ):
        out = await approve_help_miss_plan("org", "p1", plan, approved_by="kaiav")
    assert out["status"] == "applied"
    assert out["apply_kind"] == "instruction_replace"
    assert out["agents_md"] is False
    assert out["pr_url"] is None
    assert out["version"] == 4
    meta = marked.await_args.kwargs["metadata"]
    assert meta["agents_md"] is False
    assert meta["apply_kind"] == "instruction_replace"
    pin.assert_awaited_once()
    notify.assert_awaited_once()
    assert notify.await_args.kwargs["apply_kind"] == "instruction_replace"
    pr_opened.assert_not_awaited()


@pytest.mark.asyncio
async def test_instruction_pin_calls_deploy_and_canary() -> None:
    plan = {
        "id": "p1",
        "agent_id": "agent-a",
        "evidence": {
            "help_miss": True,
            "fix_kind": "instruction_replace",
            "instruction": _INSTRUCTION,
            "leftovers": [{"snippet": "I'll just do the refund myself"}],
        },
    }
    create = AsyncMock(return_value={"version": 4, "template": _INSTRUCTION})
    deploy = AsyncMock(return_value={"prompt_name": "agent-a", "env": "prod", "version": 4})
    arm = AsyncMock(return_value={"experiment_id": "exp-1"})
    with (
        patch(
            "eden.improvement.help_miss_apply._current_agent_template",
            AsyncMock(return_value=("old instruction", 3)),
        ),
        patch(
            "eden.services.prompt_versioning.PromptService.create_version",
            create,
        ),
        patch("eden.prompts.deploy.PromptDeployService.deploy", deploy),
        patch("eden.agents.prompt_canary.arm_help_miss_canary", arm),
        patch(
            "eden.improvement.plans_repo.mark_approved",
            AsyncMock(return_value={"id": "p1", "status": "approved"}),
        ),
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent"}),
        ),
    ):
        out = await approve_help_miss_plan("org", "p1", plan, approved_by="kaiav")
    assert out["apply_kind"] == "instruction_replace"
    assert out["version"] == 4
    create.assert_awaited_once()
    assert create.await_args.kwargs["template"] == _INSTRUCTION
    deploy.assert_awaited_once()
    arm.assert_awaited_once()


@pytest.mark.asyncio
async def test_code_change_with_path_attempts_existing_pr() -> None:
    plan = {
        "id": "p2",
        "agent_id": "agent-a",
        "title": "agent-a didn't help",
        "summary": "smallest change",
        "evidence": {
            "help_miss": True,
            "fix_kind": "code_change",
            "instruction": _INSTRUCTION,
            "leftovers": [
                {
                    "snippet": "rewrote the reply",
                    "path": "src/refunds.py",
                    "trace_id": "tr-1",
                }
            ],
        },
    }
    gen = AsyncMock(
        return_value={"data": {"diff": "--- a/src/refunds.py\n+++ b/src/refunds.py\n"}}
    )
    pr_info = SimpleNamespace(url="https://github.com/o/r/pull/9", number=9)
    repo = MagicMock()
    repo.read_file = AsyncMock(return_value="def refund():\n    pass\n")
    pr = MagicMock()
    pr.create_pr = AsyncMock(return_value=pr_info)
    with (
        patch(
            "eden.improvement.issue_patch_trigger._resolve_repo_id",
            AsyncMock(return_value="repo-1"),
        ),
        patch("eden.patches.patch_generator.PatchGenerator.generate", gen),
        patch(
            "eden.providers.factory.get_repo_provider_for_org",
            AsyncMock(return_value=repo),
        ),
        patch(
            "eden.providers.factory.get_pr_provider_for_org",
            AsyncMock(return_value=pr),
        ),
        patch(
            "eden.providers.factory.resolve_pr_base_branch",
            AsyncMock(return_value="main"),
        ),
        patch(
            "eden.patches.diff_materializer.materialize_unified_diff",
            AsyncMock(return_value=[{"path": "src/refunds.py", "content": "x"}]),
        ),
        patch(
            "eden.improvement.plans_repo.mark_pr_opened",
            AsyncMock(return_value={"id": "p2", "status": "pr_opened"}),
        ) as marked_pr,
        patch(
            "eden.improvement.plans_repo.mark_approved",
            AsyncMock(),
        ) as marked,
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent"}),
        ),
    ):
        out = await approve_help_miss_plan("org", "p2", plan, approved_by="kaiav")
    assert out["apply_kind"] == "code_pr"
    assert out["target_file"] == "src/refunds.py"
    assert out["code_pr_attempted"] is True
    assert out["pr_url"] == "https://github.com/o/r/pull/9"
    assert out["agents_md"] is False
    gen.assert_awaited()
    assert gen.await_args.kwargs["linked_files"][0]["path"] == "src/refunds.py"
    pr.create_pr.assert_awaited()
    marked_pr.assert_awaited()
    marked.assert_not_awaited()


@pytest.mark.asyncio
async def test_code_change_with_trace_uses_linker() -> None:
    plan = {
        "id": "p2b",
        "agent_id": "agent-a",
        "evidence": {
            "help_miss": True,
            "fix_kind": "code_change",
            "instruction": _INSTRUCTION,
            "leftovers": [{"snippet": "rewrote the reply", "trace_id": "tr-9"}],
        },
    }
    with (
        patch(
            "eden.improvement.help_miss_apply.resolve_help_miss_file",
            AsyncMock(return_value="src/handler.py"),
        ),
        patch(
            "eden.improvement.help_miss_apply._open_or_update_help_miss_code_pr",
            AsyncMock(
                return_value={
                    "pr_url": "https://github.com/o/r/pull/3",
                    "pr_number": 3,
                    "marked": True,
                    "plan": {"id": "p2b"},
                }
            ),
        ) as code_pr,
        patch(
            "eden.improvement.help_miss_apply._pin_help_miss_instruction",
            AsyncMock(),
        ) as pin,
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent"}),
        ),
    ):
        out = await approve_help_miss_plan("org", "p2b", plan)
    assert out["apply_kind"] == "code_pr"
    assert out["target_file"] == "src/handler.py"
    code_pr.assert_awaited_once()
    pin.assert_not_awaited()


@pytest.mark.asyncio
async def test_code_change_without_file_falls_back_to_pin() -> None:
    plan = {
        "id": "p4",
        "agent_id": "agent-a",
        "evidence": {
            "help_miss": True,
            "fix_kind": "code_change",
            "instruction": _INSTRUCTION,
            "leftovers": [{"snippet": "I'll just do it", "path": "ambient"}],
        },
    }
    with (
        patch(
            "eden.improvement.help_miss_apply.resolve_help_miss_file",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.help_miss_apply._pin_help_miss_instruction",
            AsyncMock(return_value=_pin_ok()),
        ) as pin,
        patch(
            "eden.improvement.help_miss_apply._open_or_update_help_miss_code_pr",
            AsyncMock(),
        ) as code_pr,
        patch(
            "eden.improvement.plans_repo.mark_approved",
            AsyncMock(return_value={"id": "p4", "status": "approved"}),
        ),
        patch(
            "eden.services.slack_notify.notify_help_miss_applied",
            AsyncMock(return_value={"status": "sent"}),
        ),
    ):
        out = await approve_help_miss_plan("org", "p4", plan)
    assert out["apply_kind"] == "instruction_replace"
    pin.assert_awaited_once()
    code_pr.assert_not_awaited()


@pytest.mark.asyncio
async def test_approve_help_miss_reuses_pr_url() -> None:
    plan = {
        "id": "p2",
        "agent_id": "agent-a",
        "plan_kind": "prompt_update",
        "pr_url": "https://github.com/acme/repo/pull/9",
        "diff_unified": "diff --git a/src/refunds.py b/src/refunds.py",
        "evidence": {
            "help_miss": True,
            "fix_kind": "code_change",
            "instruction": _INSTRUCTION,
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
        patch(
            "eden.improvement.help_miss_apply._open_or_update_help_miss_code_pr",
            AsyncMock(),
        ) as opener,
    ):
        out = await approve_help_miss_plan("org", "p2", plan, approved_by="kaiav")
    assert out["apply_kind"] == "code_pr"
    assert out["pr_url"] == "https://github.com/acme/repo/pull/9"
    assert out["agents_md"] is False
    assert notify.await_args.kwargs["pr_url"] == "https://github.com/acme/repo/pull/9"
    opener.assert_not_awaited()


@pytest.mark.asyncio
async def test_generic_refuse_stays_on_draft() -> None:
    plan = {
        "id": "p3",
        "agent_id": "agent-a",
        "status": "draft",
        "evidence": {
            "help_miss": True,
            "instruction": "be more helpful",
            "leftovers": [{"snippet": "I'll just do it"}],
        },
    }
    with (
        patch("eden.improvement.plans_repo.mark_approved", AsyncMock()) as marked,
        patch(
            "eden.improvement.help_miss_apply._pin_help_miss_instruction",
            AsyncMock(),
        ) as pin,
        patch(
            "eden.improvement.help_miss_apply._open_or_update_help_miss_code_pr",
            AsyncMock(),
        ) as code_pr,
    ):
        out = await approve_help_miss_plan("org", "p3", plan)
    assert out["status"] == "refused"
    marked.assert_not_awaited()
    pin.assert_not_awaited()
    code_pr.assert_not_awaited()


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
    assert "code_change_enabled" not in text
    pin_src = inspect.getsource(approve_help_miss_plan)
    assert "AGENTS.md" not in pin_src

