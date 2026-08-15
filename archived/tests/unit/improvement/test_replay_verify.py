"""M7 (§4.1) — signature-based replay-before-PR verification tests."""

from __future__ import annotations

import asyncio

import pytest

from eden.improvement import replay_verify as rv
from eden.improvement.replay_verify import (
    FailureSignature,
    extract_failure_signature,
    is_replayable,
    normalize_error_text,
    run_replay_verify,
    signature_present,
)

ORG = "org_test"
ISSUE = "iss-1"

# ── Shared fixtures ─────────────────────────────────────────────

PROMPT_BEFORE = "You are a helpful bot.\nAlways do X.\n"
PROMPT_DIFF = (
    "--- a/prompts/system.md\n"
    "+++ b/prompts/system.md\n"
    "@@ -1,2 +1,2 @@\n"
    " You are a helpful bot.\n"
    "-Always do X.\n"
    "+Never divide by zero.\n"
)
LINKED = [{"path": "prompts/system.md", "content": PROMPT_BEFORE}]

STUMBLE_DETAIL = {
    "kind": "tool_error",
    "error": "division by zero in checkout step 7",
}
SIG = extract_failure_signature(STUMBLE_DETAIL, {"name": "tool.checkout"})
assert SIG is not None

PACK = {
    "status": "ok",
    "example_trace_ids": ["trc-1"],
    "excerpt": "span=tool.checkout division by zero",
    "failure_signature": SIG.to_json(),
}


def _failing_checkpoint():
    from eden.debugger.checkpoints import Checkpoint

    return Checkpoint(
        id="cp-1",
        trace_id="trc-1",
        step_number=0,
        input_messages=[
            {"role": "system", "content": "You are a helpful bot.\nAlways do X."},
            {"role": "user", "content": "checkout my cart"},
        ],
        tool_calls=[],
        tool_results=[],
        response={
            "content": "Error: division by zero in checkout step 7",
            "model": "test-model",
        },
    )


class _FakeStore:
    def __init__(self, by_trace):
        self.by_trace = by_trace

    async def list_for_trace(self, trace_id, org_id=None):
        return list(self.by_trace.get(trace_id, []))


def _patch_seams(monkeypatch, *, store, gateway_text="all good", cost=0.001):
    async def _fake_store():
        return store

    calls = []

    async def _fake_gateway(org_id, model, prompt):
        calls.append({"org_id": org_id, "model": model, "prompt": prompt})
        return {"text": gateway_text, "cost_usd": cost}

    async def _enabled(org_id):
        return True

    monkeypatch.setattr(rv, "_get_checkpoint_store", _fake_store)
    monkeypatch.setattr(rv, "_gateway_complete", _fake_gateway)
    monkeypatch.setattr(rv, "_settings_enabled", lambda: True)
    monkeypatch.setattr(rv, "_org_enabled", _enabled)
    return calls


# ── Pure: normalization + extraction ────────────────────────────


def test_normalize_strips_ids_numbers_and_case() -> None:
    raw = (
        "Request 5f2b6c8e-1234-4a5b-9c0d-aabbccddeeff FAILED after 37 retries "
        "at 0xDEADBEEF"
    )
    out = normalize_error_text(raw)
    assert "<id>" in out
    assert "<n>" in out
    assert "5f2b6c8e" not in out
    assert "37" not in out
    assert out == out.lower()


def test_extract_failure_signature_from_detail() -> None:
    sig = extract_failure_signature(STUMBLE_DETAIL, {"name": "tool.checkout"})
    assert sig is not None
    assert sig.stumble_kind == "tool_error"
    assert sig.failing_span_name == "tool.checkout"
    assert sig.error_substring == "division by zero in checkout step <n>"
    assert sig.judge_dimension is None


def test_extract_failure_signature_span_attrs_fallback_and_cap() -> None:
    sig = extract_failure_signature(
        {"kind": "judge", "judge_dimension": "helpfulness"},
        {"exception.message": "x" * 500, "span_name": "agent.answer"},
    )
    assert sig is not None
    assert len(sig.error_substring) <= 120
    assert sig.judge_dimension == "helpfulness"
    assert sig.failing_span_name == "agent.answer"


def test_extract_failure_signature_none_without_error_text() -> None:
    assert extract_failure_signature({}, None) is None
    assert extract_failure_signature({"kind": "tool_error"}, {}) is None


def test_signature_roundtrip_json() -> None:
    data = SIG.to_json()
    back = FailureSignature.from_json(data)
    assert back == SIG
    assert FailureSignature.from_json({}) is None
    assert FailureSignature.from_json({"error_substring": ""}) is None


def test_signature_present_normalized_and_payloads() -> None:
    assert signature_present("DIVISION by zero in checkout step 99", SIG)
    assert signature_present({"resp": "division by zero in checkout step 3"}, SIG)
    assert not signature_present("checkout completed fine", SIG)
    assert not signature_present(None, SIG)


# ── Pure: applicability ─────────────────────────────────────────


def test_is_replayable_prompt_and_config_shapes() -> None:
    ok, why = is_replayable(["prompts/system.md"], {})
    assert ok and why == "prompt_or_config_change"
    ok, why = is_replayable(["settings/app.yaml"], {})
    assert ok and why == "prompt_or_config_change"
    ok, why = is_replayable(["src/agent_prompt.py"], {})
    assert ok and why == "prompt_or_config_change"


def test_is_replayable_span_match_and_not_replayable() -> None:
    pack = {
        "fixture": {
            "traces": [{"spans": [{"name": "tool.checkout", "attributes": {}}]}]
        }
    }
    ok, why = is_replayable(["src/checkout.py"], pack)
    assert ok and why == "file_in_traced_spans"

    ok, why = is_replayable(["src/billing.py"], {})
    assert not ok and why == "not_replayable"
    # 1-char stems must not spuriously match traced text.
    ok, why = is_replayable(["x"], {"excerpt": "span=tool.error boom"})
    assert not ok and why == "not_replayable"


# ── run_replay_verify ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_replay_passes_when_patch_removes_signature(monkeypatch) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    calls = _patch_seams(
        monkeypatch, store=store, gateway_text="Checkout complete, no errors."
    )

    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "passed"
    assert result.reason == "signature_absent_in_replay"
    assert result.traces_checked == 1
    assert result.cost_usd == pytest.approx(0.001)
    # The patched prompt (not the original) was what got re-executed.
    assert calls and "Never divide by zero." in calls[0]["prompt"]
    assert "Always do X." not in calls[0]["prompt"]
    per_trace = result.details["per_trace"]
    assert per_trace[0]["signature_in_original"] is True
    assert per_trace[0]["signature_in_replay"] is False
    assert per_trace[0]["used_prompt_override"] is True


@pytest.mark.asyncio
async def test_replay_fails_when_signature_persists(monkeypatch) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    _patch_seams(
        monkeypatch,
        store=store,
        gateway_text="Error: division by zero in checkout step 12",
    )

    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "failed"
    assert result.reason == "signature_still_present"
    assert result.traces_checked == 1


@pytest.mark.asyncio
async def test_replay_skips_without_checkpoints(monkeypatch) -> None:
    store = _FakeStore({"trc-1": []})
    _patch_seams(monkeypatch, store=store)

    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "skipped"
    assert result.reason == "no_checkpoints"


@pytest.mark.asyncio
async def test_replay_skips_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(rv, "_settings_enabled", lambda: False)
    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "skipped"
    assert result.reason == "disabled"


@pytest.mark.asyncio
async def test_replay_skips_on_org_kill_switch(monkeypatch) -> None:
    async def _org_off(org_id):
        return False

    monkeypatch.setattr(rv, "_settings_enabled", lambda: True)
    monkeypatch.setattr(rv, "_org_enabled", _org_off)
    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "skipped"
    assert result.reason == "disabled"


@pytest.mark.asyncio
async def test_replay_not_replayable_code_patch(monkeypatch) -> None:
    """Pure applicability skip — never touches store or gateway."""
    diff = (
        "--- a/src/billing.py\n"
        "+++ b/src/billing.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-a = 1\n"
        "+a = 2\n"
    )
    result = await run_replay_verify(
        ORG, ISSUE, diff, [{"path": "src/billing.py", "content": "a = 1\n"}], PACK
    )
    assert result.status == "skipped"
    assert result.reason == "not_replayable"


@pytest.mark.asyncio
async def test_replay_downgrades_when_no_injection_point(monkeypatch) -> None:
    """Honest downgrade: code patch matched a traced span, but nothing in
    the checkpointed step's input contains the patched content — we must
    not pretend the hermetic rerun proved anything."""
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    _patch_seams(monkeypatch, store=store)
    diff = (
        "--- a/src/checkout.py\n"
        "+++ b/src/checkout.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-total = a / b\n"
        "+total = a / b if b else 0\n"
    )
    pack = dict(PACK)
    pack["fixture"] = {
        "traces": [{"spans": [{"name": "tool.checkout", "attributes": {}}]}]
    }
    result = await run_replay_verify(
        ORG,
        ISSUE,
        diff,
        [{"path": "src/checkout.py", "content": "total = a / b\n"}],
        pack,
    )
    assert result.status == "skipped"
    assert result.reason == "not_replayable"
    assert result.details["per_trace"][0]["skip"] == "no_injection_point"


@pytest.mark.asyncio
async def test_replay_skips_no_signature() -> None:
    pack = {"status": "ok", "example_trace_ids": ["trc-1"], "excerpt": ""}
    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, pack)
    assert result.status == "skipped"
    assert result.reason == "no_signature"


@pytest.mark.asyncio
async def test_replay_cost_cap_via_llm_budget(monkeypatch) -> None:
    from eden.improvement import sweep_budget

    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    _patch_seams(monkeypatch, store=store)
    sweep_budget.begin_sweep_llm_budget(0)
    try:
        result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    finally:
        sweep_budget.clear_sweep_llm_budget()
    assert result.status == "skipped"
    assert result.reason == "cost_cap"
    assert result.details["llm_steps"] == 0


@pytest.mark.asyncio
async def test_replay_timeout(monkeypatch) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    _patch_seams(monkeypatch, store=store)

    async def _slow_gateway(org_id, model, prompt):
        await asyncio.sleep(0.5)
        return {"text": "", "cost_usd": 0.0}

    monkeypatch.setattr(rv, "_gateway_complete", _slow_gateway)
    monkeypatch.setattr(rv, "_REPLAY_WALL_CLOCK_S", 0.05)
    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "skipped"
    assert result.reason == "timeout"


@pytest.mark.asyncio
async def test_replay_skips_trace_without_original_signature(monkeypatch) -> None:
    from eden.debugger.checkpoints import Checkpoint

    healthy = Checkpoint(
        id="cp-2",
        trace_id="trc-1",
        step_number=0,
        input_messages=[{"role": "system", "content": "You are a helpful bot."}],
        tool_calls=[],
        tool_results=[],
        response={"content": "everything fine"},
    )
    store = _FakeStore({"trc-1": [healthy]})
    _patch_seams(monkeypatch, store=store)
    result = await run_replay_verify(ORG, ISSUE, PROMPT_DIFF, LINKED, PACK)
    assert result.status == "skipped"
    assert result.reason == "signature_absent_in_original"
    assert result.details["per_trace"][0]["skip"] == "signature_absent_in_original"


# ── N01 regression replay helpers (regression_replay_v1) ────────


@pytest.mark.asyncio
async def test_replay_case_signature_passes_when_absent(monkeypatch) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    calls = _patch_seams(
        monkeypatch, store=store, gateway_text="Checkout complete."
    )
    result = await rv.replay_case_signature(ORG, "trc-1", SIG)
    assert result.status == "passed"
    assert result.reason == "replay_signature_absent"
    assert result.traces_checked == 1
    assert result.regenerated_output == "Checkout complete."
    assert result.to_json()["regenerated_output"] == "Checkout complete."
    # The stored input was replayed verbatim — not a synthesized prompt.
    assert calls and "checkout my cart" in calls[0]["prompt"]


@pytest.mark.asyncio
async def test_replay_case_signature_fails_when_present(monkeypatch) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})
    _patch_seams(
        monkeypatch,
        store=store,
        gateway_text="Error: division by zero in checkout step 12",
    )
    result = await rv.replay_case_signature(ORG, "trc-1", SIG)
    assert result.status == "failed"
    assert result.reason == "replay_signature_present"


@pytest.mark.asyncio
async def test_replay_case_signature_no_checkpoints(monkeypatch) -> None:
    _patch_seams(monkeypatch, store=_FakeStore({}))
    result = await rv.replay_case_signature(ORG, "trc-1", SIG)
    assert result.status == "skipped"
    assert result.reason == "no_checkpoints"


@pytest.mark.asyncio
async def test_replay_case_signature_gateway_error_never_passes(
    monkeypatch,
) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})

    async def _fake_store():
        return store

    async def _boom(org_id, model, prompt):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(rv, "_get_checkpoint_store", _fake_store)
    monkeypatch.setattr(rv, "_gateway_complete", _boom)
    result = await rv.replay_case_signature(ORG, "trc-1", SIG)
    assert result.status == "skipped"
    assert result.reason == "replay_error"


@pytest.mark.asyncio
async def test_checkpoint_available_true_and_false(monkeypatch) -> None:
    store = _FakeStore({"trc-1": [_failing_checkpoint()]})

    async def _fake_store():
        return store

    monkeypatch.setattr(rv, "_get_checkpoint_store", _fake_store)
    assert await rv.checkpoint_available(ORG, "trc-1") is True
    assert await rv.checkpoint_available(ORG, "trc-none") is False
    assert await rv.checkpoint_available(ORG, "") is False


# ── _gateway_complete: real internal-LLM routing (not the dormant
# AIGateway) — every other test in this file stubs
# ``_gateway_complete`` itself, so none of them exercise its actual
# body. These confirm the fix at FEAT-26: the helper must route
# through ``eden.llm.internal_router.route_async`` (the sanctioned
# internal-LLM entry point) instead of ``AIGateway.complete()``,
# which unconditionally raised ``ProviderUnavailableError`` because
# no provider is ever registered on the shared gateway instance.
# ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gateway_complete_routes_through_internal_llm_client(
    monkeypatch,
) -> None:
    from unittest.mock import AsyncMock, MagicMock

    fake_resp = MagicMock()
    fake_resp.content = "replayed output text"
    fake_resp.usage = MagicMock(cost=0.0042)

    route = AsyncMock(return_value=fake_resp)
    monkeypatch.setattr("eden.llm.internal_router.route_async", route)

    out = await rv._gateway_complete(ORG, "test-model", "replay this prompt")

    route.assert_awaited_once()
    assert out == {"text": "replayed output text", "cost_usd": 0.0042}
    call_args, call_kwargs = route.call_args
    assert call_args[1] == "replay this prompt"
    assert call_kwargs["org_id"] == ORG
    assert call_kwargs["feature"] == "replay_verify"


@pytest.mark.asyncio
async def test_gateway_complete_does_not_use_dormant_ai_gateway(
    monkeypatch,
) -> None:
    """Regression guard for FEAT-137: the helper must never reach
    the deleted ``AIGateway.complete()`` path.
    """
    from unittest.mock import AsyncMock, MagicMock

    def _boom_get_ai_gateway():
        raise AssertionError(
            "AIGateway must not be reached from _gateway_complete"
        )

    fake_resp = MagicMock()
    fake_resp.content = "ok"
    fake_resp.usage = MagicMock(cost=0.0)

    monkeypatch.setattr(
        "eden.api.routes.gateway.get_ai_gateway", _boom_get_ai_gateway
    )
    monkeypatch.setattr(
        "eden.llm.internal_router.route_async",
        AsyncMock(return_value=fake_resp),
    )

    out = await rv._gateway_complete(ORG, "test-model", "prompt")
    assert out["text"] == "ok"
