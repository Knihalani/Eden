"""M13 (§6.1) — EV ranking order + sweep.ev_capture."""

from __future__ import annotations

from unittest.mock import patch

from eden.improvement.planner import (
    PlanCandidate,
    compute_ev,
    ev_capture,
    rank_candidates,
)


def _cand(
    title: str,
    *,
    severity: str = "medium",
    confidence: float = 0.8,
    stumble: int = 5,
    kind: str = "code_patch",
    llm_cost: float = 0.05,
    user_count: int = 10,
) -> PlanCandidate:
    return PlanCandidate(
        plan_kind=kind,
        title=title,
        source_ref=title,
        source_fingerprint=f"fp:{title}",
        severity=severity,
        confidence=confidence,
        llm_cost_usd=llm_cost,
        user_count=user_count,
        evidence={"stumble_count": stumble},
    )


def test_ev_formula_matches_spec() -> None:
    c = _cand("x", severity="critical", confidence=1.0, stumble=25, user_count=100)
    # severity_w=1.0, conf=1.0, recurrence=min(1,0.2+25/25)=1.0,
    # user_w=1.15, issue_cost=10.0, fix=0.05 → EV ≈ 11.5 - 0.05
    with patch("eden.improvement.planner._ev_enabled", return_value=True):
        ev = compute_ev(c)
    assert ev > 10.0


def test_rank_candidates_orders_by_ev() -> None:
    low = _cand("low", severity="low", confidence=0.3, stumble=1, user_count=1)
    high = _cand(
        "high", severity="critical", confidence=0.95, stumble=40, user_count=50
    )
    with patch("eden.improvement.planner._ev_enabled", return_value=True):
        ranked = rank_candidates([low, high])
    assert ranked[0].title == "high"
    assert ranked[1].title == "low"
    assert ranked[0].ev_score is not None
    assert ranked[0].ev_score > ranked[1].ev_score  # type: ignore[operator]


def test_kg_revert_premium_lowers_ev() -> None:
    c = _cand("risky", severity="high", confidence=0.9)
    with patch("eden.improvement.planner._ev_enabled", return_value=True):
        base = compute_ev(c, kg_premium=0.0)
        penalized = compute_ev(c, kg_premium=2.0)
    assert penalized < base
    assert abs((base - penalized) - 2.0) < 1e-6


def test_ev_capture_of_top_k() -> None:
    a = _cand("a", severity="critical", confidence=1.0, stumble=50)
    b = _cand("b", severity="high", confidence=0.9, stumble=20)
    c = _cand("c", severity="low", confidence=0.4, stumble=1)
    with patch("eden.improvement.planner._ev_enabled", return_value=True):
        ranked = rank_candidates([a, b, c])
    top = ranked[:2]
    capture = ev_capture(ranked, top)
    assert 0.8 <= capture <= 1.0
    # Generating only the worst should yield low capture.
    worst_only = [ranked[-1]]
    low_cap = ev_capture(ranked, worst_only)
    assert low_cap < capture


def test_advisory_demoted_relative_to_code() -> None:
    code = _cand("code", severity="medium", confidence=0.8, kind="code_patch")
    adv = _cand("adv", severity="medium", confidence=0.8, kind="advisory")
    with patch("eden.improvement.planner._ev_enabled", return_value=True):
        ranked = rank_candidates([adv, code])
    assert ranked[0].title == "code"


def test_sweep_ev_ranking_flag_default_true() -> None:
    from eden.config import get_settings

    assert get_settings().sweep_ev_ranking_v1 is True
    assert get_settings().test_gate_synthesis_v1 is False
