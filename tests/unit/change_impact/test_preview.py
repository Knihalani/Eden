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
async def test_generate_report_safe_when_no_traces() -> None:
    orch = ImpactPreviewOrchestrator(pg=None)
    report = await orch.generate_report(
        "org-1",
        change_id="pr-acme-1",
        changed_files=["prompts/foo.yaml"],
        trace_ids=[],
    )
    assert report.recommendation == "safe"
    assert report.change_id == "pr-acme-1"
    assert "safe" in format_pr_comment(report)


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
