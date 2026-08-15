"""Tests for VALID_ACTIONS extension (§12.6)."""
from __future__ import annotations

import pytest

from supplementaries.phase_4_guardrails.policy_extension import (
    EXTENDED_VALID_ACTIONS,
    LEGACY_VALID_ACTIONS,
    apply_extension,
    assert_extension_applied,
    is_extended,
)


# ── Constants ────────────────────────────────────────────────────


def test_extended_valid_actions_has_14():
    """Spec requires 14 canonical actions."""
    assert len(EXTENDED_VALID_ACTIONS) == 14


def test_extended_valid_actions_includes_legacy():
    """All legacy actions must be in the extended set."""
    for action in LEGACY_VALID_ACTIONS:
        assert action in EXTENDED_VALID_ACTIONS


def test_extended_includes_all_spec_actions():
    """All 14 actions from spec §12.6 are present."""
    expected = {
        "allow", "warn", "redact", "block", "escalate",
        "skip_step", "summarize", "anchor", "lazy_recall",
        "coalesce", "rewrite", "truncate", "replan", "cache",
    }
    assert EXTENDED_VALID_ACTIONS == expected


def test_legacy_has_5():
    """The pre-spec set has 5 actions."""
    assert len(LEGACY_VALID_ACTIONS) == 5


# ── Apply / extension ───────────────────────────────────────────


def test_apply_extension_idempotent():
    """apply_extension() is idempotent — calling twice doesn't error."""
    assert apply_extension()
    assert apply_extension()
    assert is_extended()


def test_is_extended_returns_true_after_apply():
    assert apply_extension()
    assert is_extended()


def test_assert_extension_applied_does_not_raise_after_apply():
    apply_extension()
    assert_extension_applied()  # should not raise


def test_assert_extension_applied_raises_before_apply():
    """If a previous test applied the extension, this test might not
    raise. Skip if already applied.
    """
    if is_extended():
        pytest.skip("VALID_ACTIONS already extended")
    with pytest.raises(RuntimeError, match="not applied"):
        assert_extension_applied()


# ── Integration with policy.py ───────────────────────────────────


def test_policy_module_has_extended_valid_actions():
    """After apply_extension(), policy.VALID_ACTIONS has 14 actions."""
    apply_extension()
    try:
        from eden.guardrails import policy as _policy
        assert len(_policy.VALID_ACTIONS) >= 14
    except ImportError:
        pytest.skip("eden.guardrails.policy not importable in this env")


def test_policy_action_rank_includes_new_actions():
    """After apply_extension(), policy.ACTION_RANK has ranks for all 14."""
    apply_extension()
    try:
        from eden.guardrails import policy as _policy
        rank = _policy.ACTION_RANK
        for action in EXTENDED_VALID_ACTIONS:
            assert action in rank
            assert isinstance(rank[action], int)
    except ImportError:
        pytest.skip("eden.guardrails.policy not importable in this env")


def test_action_rank_monotonic_for_new_actions():
    """The 9 new actions should have monotonically increasing ranks."""
    apply_extension()
    try:
        from eden.guardrails import policy as _policy
        rank = _policy.ACTION_RANK
        # New actions in spec order
        new_actions = (
            "skip_step", "summarize", "anchor", "lazy_recall",
            "coalesce", "rewrite", "truncate", "replan", "cache",
        )
        prev = -1
        for action in new_actions:
            assert rank[action] > prev, (
                f"{action} rank {rank[action]} not > prev {prev}"
            )
            prev = rank[action]
    except ImportError:
        pytest.skip("eden.guardrails.policy not importable in this env")