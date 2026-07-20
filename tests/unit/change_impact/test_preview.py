"""Unit tests for N04 change impact preview."""

from __future__ import annotations

import pytest

from eden.change_impact.preview import (
    ChangeDetector,
    ImpactPreviewOrchestrator,
    ImpactReport,
    check_run_payload,
    format_pr_comment,
    post_github_check_and_comment,
)


def test_change_detector_finds_prompt_files() -> None:
    files = ChangeDetector.detect_changed_files(
        ["README.md", "prompts/checkout.yaml", "src/main.py"]
    )
    assert files == ["prompts/checkout.yaml"]


@pytest.mark.asyncio
async def test_generate_report_unknown_when_no_traces() -> None:
    orch = ImpactPreviewOrchestrator(pg=None)
    report = await orch.generate_report(
        "org-1",
        change_id="pr-acme-1",
        changed_files=["prompts/foo.yaml"],
        trace_ids=[],
    )
    assert report.recommendation == "unknown"
    assert report.traces_replayed == 0
    assert "cost_delta_pct" not in report.to_dict()
    assert "latency_delta_pct" not in report.to_dict()
    assert "no traces" in " ".join(report.recommendation_reasons).lower()
    assert "unknown" in format_pr_comment(report)


@pytest.mark.asyncio
async def test_replay_does_not_diverge_on_live_tail_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from eden.debugger.checkpoints import LivePrefixResult

    class _FakeEngine:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def rerun_live_prefix(self, *_a: object, **_k: object) -> LivePrefixResult:
            return LivePrefixResult(
                source_trace_id="t1",
                live_from_step=1,
                prefix_checkpoints=[],
                live_tail_steps=3,
                diff=[],
            )

    monkeypatch.setattr(
        "eden.debugger.checkpoints.LivePrefixEngine",
        _FakeEngine,
    )
    monkeypatch.setattr(
        "eden.debugger.checkpoints.CheckpointStore",
        lambda *_a, **_k: object(),
    )

    orch = ImpactPreviewOrchestrator(pg=object())
    div = await orch._replay_trace("t1", prompt_override=None)
    assert div["diverged"] is False


@pytest.mark.asyncio
async def test_replay_passes_prompt_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from eden.debugger.checkpoints import LivePrefixResult

    seen: dict[str, object] = {}

    class _FakeEngine:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

        async def rerun_live_prefix(self, *_a: object, **kwargs: object) -> LivePrefixResult:
            seen.update(kwargs)
            return LivePrefixResult(
                source_trace_id="t1",
                live_from_step=1,
                prefix_checkpoints=[],
                live_tail_steps=1,
                diff=[{"step_number": 0, "input_messages_changed": True}],
            )

    monkeypatch.setattr(
        "eden.debugger.checkpoints.LivePrefixEngine",
        _FakeEngine,
    )
    monkeypatch.setattr(
        "eden.debugger.checkpoints.CheckpointStore",
        lambda *_a, **_k: object(),
    )

    orch = ImpactPreviewOrchestrator(pg=object())
    div = await orch._replay_trace(
        "t1", prompt_override="new system prompt", org_id="org-1"
    )
    assert seen.get("prompt_override") == "new system prompt"
    assert div["diverged"] is True


def test_check_run_payload_uses_head_sha() -> None:
    report = ImpactReport(
        change_id="pr-acme-checkout-42",
        org_id="org-1",
        agent_id="checkout-agent",
        recommendation="safe",
    )
    payload = check_run_payload(report, head_sha="abc123deadbeef")
    assert payload["head_sha"] == "abc123deadbeef"
    assert payload["conclusion"] == "success"


def test_check_run_unknown_is_neutral() -> None:
    report = ImpactReport(
        change_id="pr-x",
        org_id="org-1",
        agent_id=None,
        recommendation="unknown",
    )
    payload = check_run_payload(report, head_sha="deadbeef")
    assert payload["conclusion"] == "neutral"


@pytest.mark.asyncio
async def test_post_github_skips_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "eden.integrations.github.is_configured",
        lambda: False,
    )
    report = ImpactReport(
        change_id="pr-x",
        org_id="org-1",
        agent_id=None,
    )
    result = await post_github_check_and_comment(
        installation_id=1,
        repo_full="acme/repo",
        pr_number=1,
        head_sha="sha",
        report=report,
    )
    assert result.get("skipped") is True
