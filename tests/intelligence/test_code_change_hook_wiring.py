"""Tests for the Gate 4a+4b CodeChangeHook real-ship wiring.

Covers:

* ``propose_patch_from_rca``:
  - Advisory-only path (no policy / disabled)
  - Confidence gate (below min_rca_confidence)
  - repo_id required gate
  - Imports-failed graceful handling
  - Action_id + payload always present

* ``post_merge_degraded``:
  - Advisory-only path (auto_revert_enabled=false)
  - min_post_merge_window_hours gate
  - Strategy dispatch via the engine when enabled
  - revert_failed graceful handling
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


# ── propose_patch_from_rca ───────────────────────────────────


@pytest.mark.asyncio
async def test_propose_patch_advisory_when_no_policy() -> None:
    """Without a policy, the hook records the action but
    does NOT mint a patch."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    result = await hook.propose_patch_from_rca(
        "test-org",
        rca_id="rca_x",
        trace_id="trace_x",
        confidence=0.95,
    )
    assert isinstance(result, dict)
    assert result["executed"] is False
    # ``code_change_disabled`` is the default — the policy
    # arg is None, which my impl treats as disabled.
    assert "skipped_reason" in result


@pytest.mark.asyncio
async def test_propose_patch_advisory_when_code_change_disabled() -> None:
    """``code_change_enabled=false`` is the advisory-only path."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    result = await hook.propose_patch_from_rca(
        "test-org",
        rca_id="rca_x",
        trace_id="trace_x",
        confidence=0.95,
        policy={"code_change_enabled": False},
    )
    assert result["executed"] is False
    assert result["skipped_reason"] == "code_change_disabled"


@pytest.mark.asyncio
async def test_propose_patch_skipped_below_min_confidence() -> None:
    """Confidence below ``min_rca_confidence`` is advisory."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    result = await hook.propose_patch_from_rca(
        "test-org",
        rca_id="rca_x",
        trace_id="trace_x",
        confidence=0.5,
        policy={
            "code_change_enabled": True,
            "min_rca_confidence": 0.8,
        },
        repo_id="repo-1",
    )
    assert result["executed"] is False
    assert "confidence" in result["skipped_reason"]
    assert "0.5" in result["skipped_reason"]


@pytest.mark.asyncio
async def test_propose_patch_requires_repo_id() -> None:
    """When ``code_change_enabled`` is true, ``repo_id`` is required."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    result = await hook.propose_patch_from_rca(
        "test-org",
        rca_id="rca_x",
        trace_id="trace_x",
        confidence=0.95,
        policy={
            "code_change_enabled": True,
            "min_rca_confidence": 0.8,
        },
        # repo_id omitted
    )
    assert result["executed"] is False
    assert result["skipped_reason"] == "repo_id_required"


@pytest.mark.asyncio
async def test_propose_patch_handles_import_failure() -> None:
    """When the code_change modules can't import (env error),
    the hook degrades gracefully to advisory."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    with patch.dict(
        "sys.modules",
        {"eden.code_change.rca_linker": None},
    ):
        result = await hook.propose_patch_from_rca(
            "test-org",
            rca_id="rca_x",
            trace_id="trace_x",
            confidence=0.95,
            policy={
                "code_change_enabled": True,
                "min_rca_confidence": 0.8,
            },
            repo_id="repo-1",
        )
    # The import failure is caught + skipped_reason recorded.
    assert result["executed"] is False
    # "imports_failed" or "mint_failed" — both are acceptable
    # depending on where the import broke.
    assert "imports_failed" in result.get("skipped_reason", "") or \
           "mint_failed" in result.get("skipped_reason", "")


# ── post_merge_degraded ─────────────────────────────────────


@pytest.mark.asyncio
async def test_post_merge_advisory_when_auto_revert_disabled() -> None:
    """``auto_revert_enabled=false`` is the advisory-only path."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    result = await hook.post_merge_degraded(
        "test-org",
        pr_id="pr_42",
        regression_evidence={"score": 0.18},
        window_hours=24,
        policy={"auto_revert_enabled": False},
    )
    assert result["executed"] is False
    assert result["skipped_reason"] == "auto_revert_disabled"


@pytest.mark.asyncio
async def test_post_merge_skipped_below_min_window() -> None:
    """Below ``min_post_merge_window_hours`` is advisory."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    result = await hook.post_merge_degraded(
        "test-org",
        pr_id="pr_42",
        regression_evidence={"score": 0.18},
        window_hours=1,
        policy={
            "auto_revert_enabled": True,
            "min_post_merge_window_hours": 24,
        },
    )
    assert result["executed"] is False
    assert "window_hours 1" in result["skipped_reason"]


@pytest.mark.asyncio
async def test_post_merge_handles_revert_failure() -> None:
    """A revert engine exception is caught + advisory."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    with patch(
        "eden.code_change.revert_engine.AutoRevertEngine.revert",
        AsyncMock(side_effect=RuntimeError("engine exploded")),
    ):
        result = await hook.post_merge_degraded(
            "test-org",
            pr_id="pr_42",
            regression_evidence={"score": 0.18},
            window_hours=24,
            policy={
                "auto_revert_enabled": True,
                "min_post_merge_window_hours": 24,
            },
        )
    assert result["executed"] is False
    assert "revert_failed" in result["skipped_reason"]
    assert "engine exploded" in result["skipped_reason"]


@pytest.mark.asyncio
async def test_post_merge_executes_when_fully_enabled() -> None:
    """Full opt-in + matching window → engine executes the revert."""
    from eden.llmops.promotion_hooks import get_code_change_hook

    hook = get_code_change_hook()
    engine_result = {
        "status": "ok",
        "data": {
            "strategy": "close_pr",
            "executed": True,
            "revert_id": "rev_test",
            "revert_pr_url": "file://./prs/1.json",
            "revert_pr_number": 1,
        },
    }
    with patch(
        "eden.code_change.revert_engine.AutoRevertEngine.revert",
        AsyncMock(return_value=engine_result),
    ):
        result = await hook.post_merge_degraded(
            "test-org",
            pr_id="pr_42_abc",
            regression_evidence={"score": 0.18},
            window_hours=24,
            policy={
                "auto_revert_enabled": True,
                "min_post_merge_window_hours": 24,
            },
        )
    assert result["executed"] is True
    assert result["strategy"] == "close_pr"
    assert result["revert_pr_url"] == "file://./prs/1.json"