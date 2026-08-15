"""§12.6 spec implementation — extend VALID_ACTIONS to 14.

Reference: eden-trace-quality-system-spec.md §12.6 + §4 Phase 4.

Extends `src/eden/guardrails/policy.py:82 VALID_ACTIONS` from 5
to 14 actions: {allow, warn, redact, block, escalate, skip_step,
summarize, anchor, lazy_recall, coalesce, rewrite, truncate, replan,
cache}.

This module is a side-effect-free mapping; importing it is enough
to declare the new actions. The actual `policy.py:82` mutation
happens at startup via the Cat 15 policy loader (or directly via
`apply_extension()` below).
"""
from __future__ import annotations

# The 14 canonical actions per spec §4 Phase 4 / §12.6.
EXTENDED_VALID_ACTIONS: frozenset[str] = frozenset({
    "allow",
    "warn",
    "redact",
    "block",
    "escalate",
    "skip_step",
    "summarize",
    "anchor",
    "lazy_recall",
    "coalesce",
    "rewrite",
    "truncate",
    "replan",
    "cache",
})

# Pre-existing 5-action set (kept for backwards-compat checks).
LEGACY_VALID_ACTIONS: frozenset[str] = frozenset({
    "allow", "warn", "redact", "block", "escalate",
})


def apply_extension() -> bool:
    """Extend the existing VALID_ACTIONS frozenset in policy.py.

    Monkey-patches `eden.guardrails.policy.VALID_ACTIONS` and
    `ACTION_RANK` to include the 9 new actions. The new actions are
    inserted with monotonically increasing rank so the existing
    `most_restrictive` action reduction still works.

    Returns True if the extension was applied (or already present),
    False if the import failed.
    """
    try:
        from eden.guardrails import policy as _policy
    except ImportError:
        return False
    existing = getattr(_policy, "VALID_ACTIONS", frozenset())
    if EXTENDED_VALID_ACTIONS.issubset(existing):
        return True  # already extended
    new_set = frozenset(existing) | EXTENDED_VALID_ACTIONS
    _policy.VALID_ACTIONS = new_set
    # Extend ACTION_RANK: existing ranks preserved, new actions
    # appended in spec-defined order.
    existing_rank = getattr(_policy, "ACTION_RANK", {})
    new_rank = dict(existing_rank)
    next_rank = max(existing_rank.values(), default=0) + 1
    # Order: skip_step < summarize < anchor < lazy_recall < coalesce
    #       < rewrite < truncate < replan < cache
    for action in (
        "skip_step", "summarize", "anchor", "lazy_recall",
        "coalesce", "rewrite", "truncate", "replan", "cache",
    ):
        if action not in new_rank:
            new_rank[action] = next_rank
            next_rank += 1
    _policy.ACTION_RANK = new_rank
    return True


def is_extended() -> bool:
    """True if VALID_ACTIONS in policy.py is the 14-action extended set."""
    try:
        from eden.guardrails import policy as _policy
    except ImportError:
        return False
    return EXTENDED_VALID_ACTIONS.issubset(getattr(_policy, "VALID_ACTIONS", frozenset()))


def assert_extension_applied() -> None:
    """Raise if the extension hasn't been applied yet.

    Useful for service startup guards.
    """
    if not is_extended():
        raise RuntimeError(
            "VALID_ACTIONS extension not applied. "
            "Call apply_extension() at startup."
        )


__all__ = [
    "EXTENDED_VALID_ACTIONS",
    "LEGACY_VALID_ACTIONS",
    "apply_extension",
    "is_extended",
    "assert_extension_applied",
]