"""W3-1 (1.4) — balanced sampling rollout tests.

Covers:
  * New-org default: ``sampling_profile_override`` is seeded to ``balanced``
    in the Phase-3 GA defaults block of ``create_org``.
  * Dogfood org: ``_maybe_seed_dogfood`` also sets ``balanced`` (dogfood-first
    rollout — the existing org can be re-seeded without a data migration).
  * P0/P1 severity floor: error, loop, tool-error, stumble, judge-failure,
    stat-gate, mcp-auth, high-cost, and slow traces are ALWAYS kept even
    when the profile is ``balanced`` or ``aggressive``.
  * Probabilistic floor: non-signal traces ARE dropped under ``balanced``.
"""

from __future__ import annotations

import pytest

from eden.observability.sampling.policy import (
    IntelligenceAwareSamplingPolicy,
    KeepSignals,
    reset_sampling_policy,
)


@pytest.fixture(autouse=True)
def _reset() -> None:  # noqa: PT004
    reset_sampling_policy()
    yield
    reset_sampling_policy()


# ---------------------------------------------------------------------------
# P0/P1 severity-floor tests (policy.py § decide)
# ---------------------------------------------------------------------------

_ALL_SIGNAL_CASES = [
    ("has_error",          KeepSignals(has_error=True),          "error"),
    ("is_loop",            KeepSignals(is_loop=True),             "loop"),
    ("has_tool_error",     KeepSignals(has_tool_error=True),      "tool_error"),
    ("has_stumble",        KeepSignals(has_stumble=True),         "stumble"),
    ("has_judge_failure",  KeepSignals(has_judge_failure=True),   "judge_failure"),
    ("has_stat_gate_fail", KeepSignals(has_stat_gate_fail=True),  "stat_gate_fail"),
    ("has_mcp_auth",       KeepSignals(has_mcp_auth_failure=True), "mcp_auth_failure"),
    ("is_high_cost",       KeepSignals(is_high_cost=True),        "high_cost"),
    ("force_trace",        KeepSignals(force_trace=True),         "force_trace"),
    ("slow",               KeepSignals(duration_ms=9_000.0),      "slow"),  # > 5s default
]


@pytest.mark.parametrize("name,signals,expected_rule", _ALL_SIGNAL_CASES)
def test_p0_p1_floor_balanced(name: str, signals: KeepSignals, expected_rule: str) -> None:
    """P0/P1 signal traces are always kept even under ``balanced`` profile."""
    policy = IntelligenceAwareSamplingPolicy(profile="balanced", rng_seed=0)
    decision = policy.decide(signals)
    assert decision.keep is True, (
        f"{name}: balanced should keep signal traces; got keep=False rule={decision.rule_matched}"
    )
    assert decision.rule_matched == expected_rule, (
        f"{name}: expected rule_matched={expected_rule!r}, got {decision.rule_matched!r}"
    )


@pytest.mark.parametrize("name,signals,expected_rule", _ALL_SIGNAL_CASES)
def test_p0_p1_floor_aggressive(name: str, signals: KeepSignals, expected_rule: str) -> None:
    """P0/P1 signal traces are always kept even under ``aggressive`` profile."""
    policy = IntelligenceAwareSamplingPolicy(profile="aggressive", rng_seed=0)
    decision = policy.decide(signals)
    assert decision.keep is True, (
        f"{name}: aggressive should keep signal traces; got keep=False rule={decision.rule_matched}"
    )
    assert decision.rule_matched == expected_rule


def test_non_signal_balanced_drops_majority() -> None:
    """Non-signal traces ARE dropped under balanced (15% keep rate)."""
    policy = IntelligenceAwareSamplingPolicy(profile="balanced", rng_seed=42)
    kept = sum(
        1 for _ in range(200) if policy.decide(KeepSignals()).keep
    )
    # 15% keep → expect roughly 30/200; allow generous bounds [5, 60].
    assert kept < 60, f"too many kept ({kept}/200) — floor may be broken"
    assert kept > 0, "balanced should keep some traces probabilistically"


# ---------------------------------------------------------------------------
# New-org default: sampling_profile_override in Phase-3 GA defaults block
# ---------------------------------------------------------------------------

def test_phase3_ga_defaults_contain_balanced_profile() -> None:
    """Verify the Phase-3 GA defaults dict seeds sampling_profile_override=balanced.

    We read the *source* of create_org rather than running the whole route
    (which needs a live DB). Instead, extract the dict literal from the
    module text — simpler than mocking asyncpg and proves the key is wired.
    """
    import ast
    import inspect
    import textwrap

    import eden.api.routes.orgs as orgs_module

    src = inspect.getsource(orgs_module.create_org)
    # Find the json.dumps call that sets Phase-3 GA defaults.  We look for the
    # dict that contains ``artifacts_v1`` — that's the right call site.
    tree = ast.parse(textwrap.dedent(src))
    found_balanced = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        keys = [k.s if isinstance(k, ast.Constant) else None for k in node.keys]
        if "artifacts_v1" not in keys:
            continue
        # Found the Phase-3 block — check sampling_profile_override.
        for k, v in zip(node.keys, node.values):
            if isinstance(k, ast.Constant) and k.s == "sampling_profile_override":
                assert isinstance(v, ast.Constant), "sampling_profile_override must be a string literal"
                assert v.s == "balanced", (
                    f"new-org default should be 'balanced', got {v.s!r}"
                )
                found_balanced = True
                break
        if found_balanced:
            break
    assert found_balanced, (
        "create_org Phase-3 GA defaults block must contain "
        "sampling_profile_override='balanced' (W3-1 requirement)"
    )


def test_maybe_seed_dogfood_sets_balanced_profile() -> None:
    """Verify _maybe_seed_dogfood wires balanced sampling (dogfood-first rollout)."""
    import inspect

    import eden.api.routes.orgs as orgs_module

    src = inspect.getsource(orgs_module._maybe_seed_dogfood)
    assert "sampling_profile_override" in src, (
        "_maybe_seed_dogfood must set sampling_profile_override (dogfood-first, W3-1)"
    )
    assert "balanced" in src, (
        "_maybe_seed_dogfood must set sampling_profile_override to 'balanced'"
    )
