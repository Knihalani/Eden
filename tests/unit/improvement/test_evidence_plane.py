"""Autonomy evidence plane + Cat 20 honesty tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.evidence_plane import hydrate_linked_files
from eden.patches.patch_generator import _build_patch_prompt
from eden.time_travel._common import _apply_edits_to_step
from eden.time_travel.replayer import TraceReplayer


@pytest.mark.asyncio
async def test_hydrate_linked_files_reads_repo_content() -> None:
    provider = MagicMock()
    provider.read_file = AsyncMock(return_value="def checkout():\n    return 1\n")

    with patch(
        "eden.providers.factory.get_repo_provider_for_org",
        AsyncMock(return_value=provider),
    ):
        out = await hydrate_linked_files(
            "org_test",
            [{"path": "agent/checkout.py", "content": ""}],
            agent_id="agent-1",
        )

    assert len(out) == 1
    assert out[0]["path"] == "agent/checkout.py"
    assert "def checkout" in out[0]["content"]
    provider.read_file.assert_awaited_once_with("agent/checkout.py")


@pytest.mark.asyncio
async def test_hydrate_linked_files_skips_empty() -> None:
    provider = MagicMock()
    provider.read_file = AsyncMock(return_value="")

    with patch(
        "eden.providers.factory.get_repo_provider_for_org",
        AsyncMock(return_value=provider),
    ):
        out = await hydrate_linked_files(
            "org_test",
            [{"path": "missing.py", "content": ""}],
        )

    assert out == []


def test_build_patch_prompt_includes_file_content() -> None:
    _sys, user = _build_patch_prompt(
        repo_id="r1",
        rca_id="iss_1",
        trace_id="trc_real",
        linked_files=[{"path": "a.py", "content": "print(1)\n"}],
        style_profile={},
        pr_patterns={},
        kg_penalties=[],
        test_plan=[],
        rca_summary="root cause here",
    )
    assert "## Linked source files" in user
    assert "print(1)" in user
    assert "trc_real" in user


def test_build_patch_prompt_empty_content_warns() -> None:
    _sys, user = _build_patch_prompt(
        repo_id="r1",
        rca_id="iss_1",
        trace_id="trc_x",
        linked_files=[{"path": "a.py", "content": ""}],
        style_profile={},
        pr_patterns={},
        kg_penalties=[],
        test_plan=[],
        rca_summary="rca",
    )
    assert "content unavailable" in user
    assert "- a.py" in user


def test_apply_edits_to_step_writes_payload() -> None:
    step = {
        "payload": {
            "step_index": 0,
            "request": {"model": "gpt", "prompt": "old"},
            "response": {"response_hash": "abc"},
        }
    }
    edited = _apply_edits_to_step(
        step,
        {"system_prompt": "You are careful.", "prompt": "new prompt", "temperature": 0.0},
    )
    payload = edited["payload"]
    assert payload["prompt"] == "new prompt"
    assert payload["system_prompt"] == "You are careful."
    assert payload["request"]["prompt"] == "new prompt"
    assert payload["request"]["system_prompt"] == "You are careful."
    assert payload["request"]["temperature"] == 0.0


@pytest.mark.asyncio
async def test_re_execute_empty_prompt_not_claimed() -> None:
    step = {
        "payload": {
            "request": {"model": "gpt", "prompt_hash": "x"},
            "response": {"response_hash": "deadbeef", "tokens_used": 3},
        },
        "response_hash": "deadbeef",
    }
    result = await TraceReplayer()._re_execute_step(org_id="org", step=step)
    assert result["cannot_replay"] is True
    assert result["re_executed"] is False
    assert result["response_hash"] == "deadbeef"


@pytest.mark.asyncio
async def test_re_execute_edited_prompt_changes_hash() -> None:
    """Changed prompt → gateway called → different response_hash."""
    step = {
        "payload": {
            "step_index": 0,
            "request": {
                "model": "openai/gpt-test",
                "prompt": "original prompt",
                "messages": [{"role": "user", "content": "original prompt"}],
            },
            "response": {"response_hash": "orig_hash", "tokens_used": 10},
        },
        "response_hash": "orig_hash",
    }
    edited = _apply_edits_to_step(step, {"prompt": "brand new edited prompt"})

    class _Resp:
        text = "totally different model output"
        input_tokens = 4
        output_tokens = 6
        cost_usd = 0.01

    gw = MagicMock()
    gw.complete = AsyncMock(return_value=_Resp())

    with patch("eden.api.routes.gateway.get_ai_gateway", return_value=gw):
        result = await TraceReplayer()._re_execute_step(org_id="org", step=edited)

    assert result["re_executed"] is True
    assert result["cannot_replay"] is False
    assert result["response_hash"] != "orig_hash"
    assert len(result["response_hash"]) == 32
    gw.complete.assert_awaited_once()
    call_req = gw.complete.await_args.args[0]
    assert "brand new edited prompt" in call_req.prompt


@pytest.mark.asyncio
async def test_propose_plan_passes_hydrated_content_and_real_trace() -> None:
    from eden.improvement.issue_patch_trigger import propose_plan_for_issue

    issue = MagicMock()
    issue.id = "iss-1"
    issue.title = "Checkout fails"
    issue.kind = "code_bug"
    issue.fingerprint = "fp1"
    issue.severity = "high"
    issue.stumble_count = 6
    issue.user_count = 2
    issue.agent_id = "agent-a"
    issue.triage_result = {
        "summary": "null deref",
        "confidence": 0.9,
        "recommended_action": "propose_patch",
        "candidate_files": ["agent/checkout.py"],
        "example_trace_id": "trc_prod_99",
    }

    generate = AsyncMock(
        return_value={
            "data": {
                "status": "proposed",
                "diff": "diff --git a/x b/x\n@@\n-a\n+b\n",
                "cost_usd": 0.01,
                "files": ["agent/checkout.py"],
                "description": "fix",
                "explanation": "why",
                "critic_verdict": {"passed": True},
            }
        }
    )
    plan = {"id": "plan-1"}

    with (
        patch(
            "eden.improvement.issue_patch_trigger._improvement_enabled",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._issue_context",
            AsyncMock(
                return_value={
                    "issue": issue,
                    "agent_id": "agent-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca text",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._budget_ok",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._find_open_plan",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.is_rejection_active",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.closed_loop.efficiency.AgentEfficiencyController.should_run_patch",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._resolve_repo_id",
            AsyncMock(return_value="repo-1"),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._linked_files",
            AsyncMock(
                return_value=[
                    {"path": "agent/checkout.py", "content": "def checkout():\n    pass\n"}
                ]
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.build_failure_pack",
            AsyncMock(
                return_value={
                    "status": "ok",
                    "example_trace_ids": ["trc_prod_99"],
                    "excerpt": "span=tool.error boom",
                    "format": "eden-failure-fixture-v1",
                }
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.run_hermetic_preverify",
            AsyncMock(return_value={"status": "passed", "detail": {}}),
        ),
        patch("eden.patches.patch_generator.PatchGenerator.generate", generate),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.record_spend",
            AsyncMock(return_value=0.01),
        ),
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")

    assert result["status"] == "proposed"
    assert result["hermetic_preverify"] == "passed"
    assert "trc_prod_99" in result["example_trace_ids"]
    kwargs = generate.await_args.kwargs
    assert kwargs["trace_id"] == "trc_prod_99"
    assert "def checkout" in kwargs["linked_files"][0]["content"]
    assert "Failure pack" in kwargs["rca_summary"]


@pytest.mark.asyncio
async def test_apply_diff_to_files_passes() -> None:
    from eden.improvement.evidence_plane import apply_diff_to_files

    base = "def checkout():\n    return 1\n"
    diff = (
        "diff --git a/agent/checkout.py b/agent/checkout.py\n"
        "--- a/agent/checkout.py\n"
        "+++ b/agent/checkout.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def checkout():\n"
        "-    return 1\n"
        "+    return 2\n"
    )
    result = await apply_diff_to_files(
        diff, [{"path": "agent/checkout.py", "content": base}]
    )
    assert result["status"] == "passed"
    assert result["detail"]["files_changed"] == 1
    assert "content" in result["detail"]["files_after"][0]
    assert "return 2" in result["detail"]["files_after"][0]["content"]
    assert result["detail"]["static_check"]["status"] == "passed"


@pytest.mark.asyncio
async def test_apply_diff_to_files_fails_on_mismatch() -> None:
    from eden.improvement.evidence_plane import apply_diff_to_files

    base = "def checkout():\n    return 99\n"
    diff = (
        "diff --git a/agent/checkout.py b/agent/checkout.py\n"
        "--- a/agent/checkout.py\n"
        "+++ b/agent/checkout.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def checkout():\n"
        "-    return 1\n"
        "+    return 2\n"
    )
    result = await apply_diff_to_files(
        diff, [{"path": "agent/checkout.py", "content": base}]
    )
    assert result["status"] == "failed"


@pytest.mark.asyncio
async def test_apply_diff_fails_on_broken_python_syntax() -> None:
    from eden.improvement.evidence_plane import apply_diff_to_files

    base = "def checkout():\n    return 1\n"
    diff = (
        "diff --git a/agent/checkout.py b/agent/checkout.py\n"
        "--- a/agent/checkout.py\n"
        "+++ b/agent/checkout.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def checkout():\n"
        "-    return 1\n"
        "+    return (\n"
    )
    result = await apply_diff_to_files(
        diff, [{"path": "agent/checkout.py", "content": base}]
    )
    assert result["status"] == "failed"
    assert result["detail"]["reason"] == "static_syntax_failed"
    errors = result["detail"]["static_check"]["errors"]
    assert errors
    assert errors[0]["kind"] == "python_syntax"


def test_static_check_files_json_and_skip_unknown() -> None:
    from eden.improvement.evidence_plane import static_check_files

    ok = static_check_files(
        [
            {"path": "cfg.json", "content": '{"a": 1}'},
            {"path": "readme.md", "content": "# hi"},
        ]
    )
    assert ok["status"] == "passed"
    assert ok["files_checked"] == 1
    assert ok["files_skipped"] == 1

    bad = static_check_files(
        [{"path": "cfg.json", "content": '{"a": '}]
    )
    assert bad["status"] == "failed"
    assert bad["errors"][0]["kind"] == "json_syntax"


@pytest.mark.asyncio
async def test_propose_plan_suppresses_on_static_preverify_failed() -> None:
    from eden.improvement.issue_patch_trigger import propose_plan_for_issue

    issue = MagicMock()
    issue.id = "iss-1"
    issue.title = "Checkout fails"
    issue.kind = "code_bug"
    issue.fingerprint = "fp1"
    issue.severity = "high"
    issue.stumble_count = 6
    issue.user_count = 2
    issue.agent_id = "agent-a"
    issue.triage_result = {
        "summary": "null deref",
        "confidence": 0.9,
        "recommended_action": "propose_patch",
        "candidate_files": ["agent/checkout.py"],
        "example_trace_id": "trc_prod_99",
    }

    generate = AsyncMock(
        return_value={
            "data": {
                "status": "proposed",
                "diff": "diff --git a/x b/x\n@@\n-a\n+b\n",
                "cost_usd": 0.01,
                "files": ["agent/checkout.py"],
                "description": "fix",
                "explanation": "why",
                "critic_verdict": {"passed": True},
            }
        }
    )
    create_plan = AsyncMock(return_value={"id": "plan-1"})

    with (
        patch(
            "eden.improvement.issue_patch_trigger._improvement_enabled",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._issue_context",
            AsyncMock(
                return_value={
                    "issue": issue,
                    "agent_id": "agent-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca text",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._budget_ok",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._find_open_plan",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.is_rejection_active",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.closed_loop.efficiency.AgentEfficiencyController.should_run_patch",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._resolve_repo_id",
            AsyncMock(return_value="repo-1"),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._linked_files",
            AsyncMock(
                return_value=[
                    {"path": "agent/checkout.py", "content": "def checkout():\n    pass\n"}
                ]
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.build_failure_pack",
            AsyncMock(
                return_value={
                    "status": "ok",
                    "example_trace_ids": ["trc_prod_99"],
                    "excerpt": "span=tool.error boom",
                    "format": "eden-failure-fixture-v1",
                }
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.run_hermetic_preverify",
            AsyncMock(
                return_value={
                    "status": "failed",
                    "detail": {"reason": "static_syntax_failed"},
                }
            ),
        ),
        patch("eden.patches.patch_generator.PatchGenerator.generate", generate),
        patch("eden.improvement.plans_repo.create_plan", create_plan),
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")

    assert result["status"] == "suppressed"
    assert result["reason"] == "static_preverify_failed"
    create_plan.assert_not_awaited()


@pytest.mark.asyncio
async def test_record_cache_lookup_inserts(monkeypatch) -> None:
    from eden.time_travel import _common as common

    executed: list[str] = []

    class _Client:
        async def execute(self, sql, *args):
            executed.append(sql.strip().split()[0].upper())

    async def _pg():
        return _Client()

    monkeypatch.setattr("eden.storage.postgres.get_postgres_client", _pg)
    await common.record_cache_lookup(
        org_id="org", cache_key="tt:trc:0:abc", tokens_used=10, cost_usd=0.01
    )
    assert "CREATE" in executed
    assert "INSERT" in executed
