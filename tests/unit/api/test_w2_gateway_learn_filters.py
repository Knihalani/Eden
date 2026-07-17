"""Wave 2 — learn filters mutate live /gateway/v1 messages; GuardrailBlocked → 4xx."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from eden.llmops.ai_gateway import ModelRequest
from eden.llmops.filters.guardrail import GuardrailBlocked, GuardrailGatewayFilter
from eden.llmops.openai_adapter import messages_to_prompt


def test_write_back_prompt_prefixes_system_message() -> None:
    from eden.api.routes.gateway import _write_back_prompt_to_messages

    messages = [
        {"role": "system", "content": "base"},
        {"role": "user", "content": "hi"},
    ]
    original = messages_to_prompt(messages)
    mutated = f"<!-- inject -->\n\n{original}"
    out = _write_back_prompt_to_messages(
        messages,
        original_prompt=original,
        mutated_prompt=mutated,
    )
    assert out[0]["role"] == "system"
    assert "<!-- inject -->" in out[0]["content"]
    assert "base" in out[0]["content"]
    assert out[1]["content"] == "hi"


def test_write_back_prompt_full_replace() -> None:
    from eden.api.routes.gateway import _write_back_prompt_to_messages

    messages = [{"role": "user", "content": "hi"}]
    original = messages_to_prompt(messages)
    out = _write_back_prompt_to_messages(
        messages,
        original_prompt=original,
        mutated_prompt="DEPLOYED TEMPLATE",
    )
    assert out == [{"role": "system", "content": "DEPLOYED TEMPLATE"}]


def test_apply_learn_filters_injects_nudge_prefix() -> None:
    from eden.api.routes import gateway as gw_mod

    messages = [{"role": "user", "content": "hello world"}]
    original = messages_to_prompt(messages)

    class _Nudge:
        name = "runtime_nudge"

        def enabled(self, request):
            return True

        def apply(self, request):
            request.prompt = f"[nudge-injected]\n\n{request.prompt}"
            return request, ["nudge_promoted:test"]

    fake_gw = MagicMock()
    fake_gw._filters.filters = [_Nudge()]

    with patch.object(gw_mod, "get_ai_gateway", return_value=fake_gw):
        out, findings = gw_mod._apply_learn_filters_to_messages(
            messages,
            org_id="org-1",
            agent_id="agent-1",
        )

    assert "nudge_promoted:test" in findings
    assert out[0]["role"] == "system"
    assert "[nudge-injected]" in out[0]["content"]
    assert messages_to_prompt(out) != original or "[nudge-injected]" in messages_to_prompt(out)


def test_apply_learn_filters_guardrail_raises() -> None:
    from eden.api.routes import gateway as gw_mod

    class _Block:
        name = "judge_guardrail"

        def enabled(self, request):
            return True

        def apply(self, request):
            raise GuardrailBlocked({"summary": "blocked by policy", "judge_id": "j1"})

    fake_gw = MagicMock()
    fake_gw._filters.filters = [_Block()]

    with patch.object(gw_mod, "get_ai_gateway", return_value=fake_gw):
        with pytest.raises(gw_mod._GuardrailBlockedError) as ei:
            gw_mod._apply_learn_filters_to_messages(
                [{"role": "user", "content": "bad"}],
                org_id="org-1",
                agent_id="agent-1",
            )
    assert ei.value.verdict.get("judge_id") == "j1"


def test_filter_registry_does_not_swallow_guardrail_blocked() -> None:
    from eden.llmops.filters.base import FilterRegistry

    class _Block:
        name = "judge_guardrail"

        def enabled(self, request):
            return True

        def apply(self, request):
            raise GuardrailBlocked({"summary": "no"})

    reg = FilterRegistry(fail_open=True)
    reg.register(_Block())
    mr = ModelRequest(
        model_family="openai",
        model_version="x",
        prompt="hi",
        tenant_id="o1",
    )
    with pytest.raises(GuardrailBlocked):
        reg.run(mr)


def test_guardrail_filter_block_raises() -> None:
    filt = GuardrailGatewayFilter()
    filt.load_policies(
        "org-1",
        [{"pattern": "FORBIDDEN", "enforcement_level": "block", "judge_id": "j"}],
    )
    mr = ModelRequest(
        model_family="openai",
        model_version="x",
        prompt="this is FORBIDDEN text",
        tenant_id="org-1",
    )
    mr.org_id = "org-1"  # type: ignore[attr-defined]
    with pytest.raises(GuardrailBlocked):
        filt.apply(mr)
