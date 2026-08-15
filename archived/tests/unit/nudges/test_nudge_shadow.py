"""Unit tests for F39 nudge shadow mode."""

from __future__ import annotations

from uuid import uuid4

import pytest

from eden.llmops.ai_gateway import ModelRequest
from eden.llmops.filters.nudge import NudgeGatewayFilter
from eden.nudges.engine import NudgeEngine, apply_nudge_to_prompt
from eden.nudges.models import Nudge
from eden.nudges.trigger_eval import evaluate_trigger


def _req(prompt: str = "help me run python") -> ModelRequest:
    req = ModelRequest(
        model_family="claude",
        model_version="claude-sonnet-4",
        prompt=prompt,
        tenant_id="org-1",
        job_id="trace-1",
    )
    req.org_id = "org-1"
    req.agent_id = "checkout-agent"
    req.context = {
        "org_id": "org-1",
        "agent_id": "checkout-agent",
        "trace_id": "trace-1",
        "prompt": prompt,
        "recent_tool_calls": [
            {"tool_name": "bash", "result": "command not found: python"},
        ],
    }
    return req


def test_trigger_eval_tool_result_match():
    trigger = {
        "all": [
            {
                "event": "tool_result",
                "tool_name": "bash",
                "result_contains": "command not found",
            }
        ]
    }
    ctx = {
        "recent_tool_calls": [{"tool_name": "bash", "result": "command not found: python"}]
    }
    assert evaluate_trigger(trigger, ctx) is True


def test_shadow_nudge_does_not_mutate_prompt(monkeypatch):
    import eden.llmops.filters.nudge as nudge_filter_mod

    monkeypatch.setattr(nudge_filter_mod, "artifacts_enabled_sync", lambda _: True)

    nudge = Nudge(
        id=uuid4(),
        org_id="org-1",
        agent_id="checkout-agent",
        name="python3",
        trigger={"all": [{"event": "prompt_contains", "text": "python"}]},
        action_type="system_append",
        content="Use python3 on macOS.",
        mode="shadow",
    )
    engine = NudgeEngine()
    engine._NUDGE_CACHE = {}  # noqa: SLF001 — test setup
    from eden.nudges import engine as engine_mod

    engine_mod._NUDGE_CACHE["org-1:checkout-agent:promoted,shadow"] = [nudge]

    filt = NudgeGatewayFilter(engine)
    req = _req()
    original = req.prompt
    out, findings = filt.apply(req)

    assert out.prompt == original
    assert any("nudge_shadow" in f for f in findings)
    audit = getattr(out, "nudge_audit", [])
    assert audit and audit[0]["applied"] is False


def test_promoted_nudge_appends_to_prompt(monkeypatch):
    import eden.llmops.filters.nudge as nudge_filter_mod

    monkeypatch.setattr(nudge_filter_mod, "artifacts_enabled_sync", lambda _: True)

    nudge = Nudge(
        id=uuid4(),
        org_id="org-1",
        agent_id="checkout-agent",
        name="python3",
        trigger={"all": [{"event": "prompt_contains", "text": "python"}]},
        action_type="system_append",
        content="Use python3 on macOS.",
        mode="promoted",
    )
    from eden.nudges import engine as engine_mod

    engine_mod._NUDGE_CACHE["org-1:checkout-agent:promoted,shadow"] = [nudge]

    filt = NudgeGatewayFilter(NudgeEngine())
    req = _req()
    out, findings = filt.apply(req)

    assert "Use python3 on macOS." in out.prompt
    # Promoted system_append nudges route through InjectBudget.pack
    # (F83 gateway provider-cache unification) — the marker is now
    # "eden-inject:artifact:<id>", not the older "eden-nudge:<id>".
    assert out.prompt != req.prompt or "eden-inject" in out.prompt
    # system_append promoted nudges report as "nudge_promoted:<id>"
    # once packed via InjectBudget (see NudgeGatewayFilter.apply).
    assert any("nudge_promoted" in f for f in findings)


def test_apply_nudge_to_prompt_system_append():
    nudge = Nudge(
        id=uuid4(),
        org_id="org-1",
        agent_id="a",
        name="hint",
        trigger={},
        action_type="system_append",
        content="hint body",
        mode="promoted",
    )
    new_prompt, meta = apply_nudge_to_prompt(nudge, "base prompt")
    assert "hint body" in new_prompt
    assert meta.startswith("nudge_applied:")


def test_nudge_filter_disabled_via_context():
    filt = NudgeGatewayFilter()
    req = _req()
    req.context = {"nudges_enabled": False}
    assert filt.enabled(req) is False
