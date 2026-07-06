"""Per-phase fixture for Phase 4 tests.

``eden.guardrails.policy`` is mutated by ``apply_extension()``, so
once any test in the session has run that calls it, every later
test sees an already-extended state. To keep
``test_assert_extension_applied_raises_before_apply`` deterministic,
this conftest snapshots the module-level ``VALID_ACTIONS`` and
``ACTION_RANK`` before each test and restores them afterwards.

Only the two attributes we know how to restore are touched — if
other tests have set unrelated attributes on ``policy``, those
are left as-is.
"""
from __future__ import annotations

from typing import Any

import pytest


_LEGACY_VALID_ACTIONS = frozenset(
    {"allow", "warn", "redact", "block", "escalate"}
)
_LEGACY_ACTION_RANK = {
    "allow": 0,
    "warn": 1,
    "redact": 2,
    "escalate": 3,
    "block": 4,
}


@pytest.fixture(autouse=True)
def _restore_policy_state() -> Any:
    """Snapshot ``policy.VALID_ACTIONS`` / ``policy.ACTION_RANK`` and
    restore them after the test. Guarantees
    ``test_assert_extension_applied_raises_before_apply`` runs against
    a clean module regardless of collection order.
    """
    try:
        from eden.guardrails import policy as _policy
    except ImportError:
        yield
        return

    saved_actions = getattr(_policy, "VALID_ACTIONS", _LEGACY_VALID_ACTIONS)
    saved_rank = dict(getattr(_policy, "ACTION_RANK", _LEGACY_ACTION_RANK))

    # Force a known pre-extension state for every test.
    _policy.VALID_ACTIONS = _LEGACY_VALID_ACTIONS
    _policy.ACTION_RANK = dict(_LEGACY_ACTION_RANK)

    try:
        yield
    finally:
        _policy.VALID_ACTIONS = saved_actions
        _policy.ACTION_RANK = saved_rank
