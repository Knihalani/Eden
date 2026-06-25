"""Tests for the Gate 4b AutoRevertEngine wiring.

Covers:

* Strategy selection (``_pick_strategy``) — pure function,
  no side-effects
* Manual-trigger path (no provider) — returns the
  strategy + ``executed=False``
* Auto-mode path (provider configured) — calls
  ``provider.revert`` + persists to ``revert_events``
* Opt-in gate — returns the ``gate=revert_pr`` envelope
  when the policy doesn't allow reverts
* Provider failure — returns ``executed=False`` + the
  error message
* PR-number parsing — ``pr_<n>_<...>`` → ``<n>``,
  ``patch_<n>_<...>`` → ``<n>``, malformed → ``0``
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest

from eden.code_change.revert_engine import (
    AutoRevertEngine,
    STRATEGY_CLOSE_PR,
    STRATEGY_REVERT_BRANCH,
    STRATEGY_REVERT_PR,
    _parse_pr_number,
    _pick_strategy,
)
from eden.providers.pr import PRRevertRequest
from eden.providers.repo import PullRequestInfo


# ── Strategy selection (pure function) ───────────────────────


def test_pick_strategy_open_pr_returns_close() -> None:
    """An open PR is closed (no revert commit needed)."""
    assert _pick_strategy(pr_state="open", history_is_linear=True) == STRATEGY_CLOSE_PR


def test_pick_strategy_closed_pr_returns_close() -> None:
    """A closed (not merged) PR is also closed."""
    assert _pick_strategy(pr_state="closed", history_is_linear=True) == STRATEGY_CLOSE_PR


def test_pick_strategy_merged_linear_returns_revert_pr() -> None:
    """A merged PR with linear history gets the standard revert PR."""
    assert _pick_strategy(pr_state="merged", history_is_linear=True) == STRATEGY_REVERT_PR


def test_pick_strategy_merged_nonlinear_returns_revert_branch() -> None:
    """A merged PR with non-linear history (squash, rebase)
    uses the branch-revert strategy."""
    assert _pick_strategy(pr_state="merged", history_is_linear=False) == STRATEGY_REVERT_BRANCH


# ── PR-number parsing ────────────────────────────────────────


def test_parse_pr_number_pr_prefix() -> None:
    """``pr_<n>_<rest>`` → ``<n>``."""
    assert _parse_pr_number("pr_42_abc123") == 42


def test_parse_pr_number_patch_prefix() -> None:
    """``patch_<n>_<rest>`` → ``<n>``."""
    assert _parse_pr_number("patch_99_xyz") == 99


def test_parse_pr_number_no_underscore_returns_zero() -> None:
    """A bare id returns ``0``."""
    assert _parse_pr_number("42") == 0


def test_parse_pr_number_malformed_returns_zero() -> None:
    """A non-numeric id returns ``0``."""
    assert _parse_pr_number("pr_abc_def") == 0


def test_parse_pr_number_extra_segments_ok() -> None:
    """Multiple segments after the number still parse."""
    assert _parse_pr_number("pr_7_a_b_c_d") == 7


# ── Manual-trigger path (no provider) ─────────────────────────


@pytest.mark.asyncio
async def test_revert_no_provider_returns_strategy_only() -> None:
    """Without a provider, the engine picks the strategy + returns
    ``executed=False``. The caller is the manual-trigger path."""
    engine = AutoRevertEngine()
    result = await engine.revert(
        org_id="test-org",
        pr_id="pr_42_abc",
        policy={
            "code_change_enabled": True,
            "auto_revert_enabled": True,
        },
        pr_state="merged",
        history_is_linear=True,
    )
    assert result["status"] == "ok"
    assert result["data"]["strategy"] == STRATEGY_REVERT_PR
    assert result["data"]["executed"] is False
    assert result["data"]["revert_id"].startswith("rev_")


@pytest.mark.asyncio
async def test_revert_no_provider_close_strategy() -> None:
    """An open PR without a provider returns the close strategy."""
    engine = AutoRevertEngine()
    result = await engine.revert(
        org_id="test-org",
        pr_id="pr_42_abc",
        policy={
            "code_change_enabled": True,
            "auto_revert_enabled": True,
        },
        pr_state="open",
        history_is_linear=True,
    )
    assert result["data"]["strategy"] == STRATEGY_CLOSE_PR
    assert result["data"]["executed"] is False


# ── Opt-in gate ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_revert_blocked_when_code_change_disabled() -> None:
    """``code_change_enabled=false`` blocks the revert entirely."""
    engine = AutoRevertEngine()
    result = await engine.revert(
        org_id="test-org",
        pr_id="pr_42_abc",
        policy={
            "code_change_enabled": False,
            "auto_revert_enabled": True,
        },
        pr_state="merged",
    )
    assert result["status"] != "ok"
    assert result["data"]["gate"] == "optin_blocked"
    assert "code_change_enabled" in result["data"]["message"]


@pytest.mark.asyncio
async def test_revert_blocked_when_auto_revert_disabled() -> None:
    """``auto_revert_enabled=false`` blocks the revert even when
    ``code_change_enabled=true``. Manual revert is the path."""
    engine = AutoRevertEngine()
    result = await engine.revert(
        org_id="test-org",
        pr_id="pr_42_abc",
        policy={
            "code_change_enabled": True,
            "auto_revert_enabled": False,
        },
        pr_state="merged",
    )
    assert result["status"] != "ok"
    assert result["data"]["gate"] == "auto_mode_blocked"
    assert "auto_revert_enabled" in result["data"]["message"]


# ── Auto-mode path (provider configured) ──────────────────────


@pytest.mark.asyncio
async def test_revert_with_provider_dispatches() -> None:
    """With a provider configured, the engine calls
    ``provider.revert`` and persists the revert_event."""
    provider = AsyncMock()
    provider.revert = AsyncMock(return_value=PullRequestInfo(
        number=43,
        title="Revert #42",
        body="Automated revert of PR #42.",
        branch="eden/revert-42-1234567890",
        base="main",
        url="https://github.com/acme/repo/pull/43",
        state="open",
        created_at=datetime.now(UTC),
    ))

    engine = AutoRevertEngine(provider=provider)
    with patch(
        "eden.code_change.revert_engine._insert_row",
        AsyncMock(return_value=None),
    ):
        result = await engine.revert(
            org_id="test-org",
            pr_id="pr_42_abc",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="merged",
            history_is_linear=True,
            merge_sha="abc123def456",
        )

    assert result["data"]["executed"] is True
    assert result["data"]["strategy"] == STRATEGY_REVERT_PR
    assert result["data"]["revert_pr_number"] == 43
    assert result["data"]["revert_pr_url"] == "https://github.com/acme/repo/pull/43"
    # The provider was called with the correct request.
    provider.revert.assert_awaited_once()
    call_args = provider.revert.await_args
    req = call_args[0][0]
    assert isinstance(req, PRRevertRequest)
    assert req.pr_number == 42
    assert req.strategy == STRATEGY_REVERT_PR
    assert req.merge_sha == "abc123def456"


@pytest.mark.asyncio
async def test_revert_with_provider_persists_event() -> None:
    """The revert event is persisted to ``revert_events`` with
    the strategy + URL + regression evidence."""
    provider = AsyncMock()
    provider.revert = AsyncMock(return_value=PullRequestInfo(
        number=43, title="Revert #42", body="",
        branch="eden/revert-42", base="main",
        url="https://github.com/acme/repo/pull/43",
        state="open", created_at=datetime.now(UTC),
    ))

    insert_mock = AsyncMock(return_value=None)
    engine = AutoRevertEngine(provider=provider)
    with patch(
        "eden.code_change.revert_engine._insert_row",
        insert_mock,
    ):
        result = await engine.revert(
            org_id="test-org",
            pr_id="pr_42_abc",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="merged",
            regression_evidence={"score": 0.18, "metrics": ["judge_score"]},
        )

    assert result["data"]["executed"] is True
    insert_mock.assert_awaited_once()
    args = insert_mock.await_args
    assert args[0][0] == "test-org"
    assert args[0][1] == "revert_events"
    columns = args[0][2]
    values = args[0][3]
    assert "strategy" in columns
    assert "revert_pr_number" in columns
    assert "revert_pr_url" in columns
    assert "regression_evidence" in columns
    strategy_idx = columns.index("strategy")
    assert values[strategy_idx] == STRATEGY_REVERT_PR


@pytest.mark.asyncio
async def test_revert_with_provider_handles_failure() -> None:
    """A provider exception is caught + surfaced as ``executed=False``
    + the error message. The caller can decide what to do next."""
    provider = AsyncMock()
    provider.revert = AsyncMock(side_effect=RuntimeError("GitHub API down"))

    engine = AutoRevertEngine(provider=provider)
    result = await engine.revert(
        org_id="test-org",
        pr_id="pr_42_abc",
        policy={
            "code_change_enabled": True,
            "auto_revert_enabled": True,
        },
        pr_state="merged",
    )
    assert result["data"]["executed"] is False
    assert "GitHub API down" in result["data"]["error"]
    assert result["data"]["strategy"] == STRATEGY_REVERT_PR


# ── get_default_pr_provider integration ───────────────────────


def test_default_engine_uses_default_provider_when_configured() -> None:
    """The default-engine convenience constructs with the platform
    default PRProvider (LocalPRProvider when no token is set)."""
    from eden.providers import LocalPRProvider
    import os
    # Ensure no GitHub token in env so the default is Local.
    env = {k: v for k, v in os.environ.items()
           if k not in ("EDEN_PR_PROVIDER", "EDEN_GITHUB_TOKEN", "EDEN_GITHUB_REPO")}
    with patch.dict(os.environ, env, clear=True):
        from eden.providers import get_default_pr_provider
        provider = get_default_pr_provider()
    assert isinstance(provider, LocalPRProvider)


def test_engine_accepts_none_provider() -> None:
    """``AutoRevertEngine(provider=None)`` is the manual-trigger path."""
    engine = AutoRevertEngine(provider=None)
    assert engine._provider is None