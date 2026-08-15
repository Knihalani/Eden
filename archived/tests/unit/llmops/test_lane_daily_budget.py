"""OOM W3-5 — LaneDailyBudget unit tests.

Covers:
- exceeded → skip (all lanes)
- daily reset (key changes per day)
- lane isolation (one lane over cap does not affect another)
- fail-open when Redis is unavailable
- config defaults are non-zero and per-lane distinct where appropriate
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llmops.evolution_spend import LaneDailyBudget


# ── helpers ─────────────────────────────────────────────────────────


def _redis_stub(
    *,
    spent: float | None = 0.0,
    incr_ok: bool = True,
) -> MagicMock:
    """Build a minimal async Redis stub."""
    r = MagicMock()
    raw = str(spent).encode() if spent is not None else None
    r.get = AsyncMock(return_value=raw)
    if incr_ok:
        r.incrbyfloat = AsyncMock(return_value=spent or 0.0)
        r.expire = AsyncMock(return_value=True)
    else:
        r.incrbyfloat = AsyncMock(side_effect=RuntimeError("redis error"))
        r.expire = AsyncMock(side_effect=RuntimeError("redis error"))
    return r


def _patch_redis(stub):
    return patch(
        "eden.llmops.evolution_spend._get_redis",
        new=AsyncMock(return_value=stub),
    )


def _patch_redis_down():
    return patch(
        "eden.llmops.evolution_spend._get_redis",
        new=AsyncMock(return_value=None),
    )


def _patch_cap(lane: str, cap: float):
    """Override the cap for a given lane without touching other lanes."""
    return patch(
        "eden.llmops.evolution_spend._lane_cap_usd",
        side_effect=lambda l: cap if l == lane else 0.0,
    )


# ── LaneDailyBudget.check — core behaviour ─────────────────────────


@pytest.mark.asyncio
async def test_check_allowed_when_under_cap() -> None:
    """Spent < cap → allowed."""
    with (
        _patch_cap("annotator", 5.0),
        _patch_redis(_redis_stub(spent=1.0)),
    ):
        allowed, spent, cap = await LaneDailyBudget("annotator").check()
    assert allowed is True
    assert spent == pytest.approx(1.0)
    assert cap == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_check_blocked_when_over_cap() -> None:
    """Spent >= cap → not allowed (budget exceeded → skip)."""
    with (
        _patch_cap("annotator", 5.0),
        _patch_redis(_redis_stub(spent=5.01)),
    ):
        allowed, spent, cap = await LaneDailyBudget("annotator").check()
    assert allowed is False
    assert spent == pytest.approx(5.01)
    assert cap == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_check_allowed_exactly_at_cap_no_estimated() -> None:
    """Spent == cap with no estimated_usd → allowed (spent + 0 <= cap is True).

    The gate uses ``(spent + estimated_usd) <= cap``.  With estimated_usd=0 the
    call at exactly-cap is still allowed; the *next* call with estimated_usd > 0
    would be blocked.  This is intentional: fail-safe on the cheap path.
    """
    with (
        _patch_cap("clusterer", 3.0),
        _patch_redis(_redis_stub(spent=3.0)),
    ):
        allowed, *_ = await LaneDailyBudget("clusterer").check()
    assert allowed is True  # 3.0 + 0.0 <= 3.0


@pytest.mark.asyncio
async def test_check_blocked_when_estimated_would_exceed_cap() -> None:
    """Spent == cap but estimated_usd would push over → not allowed."""
    with (
        _patch_cap("clusterer", 3.0),
        _patch_redis(_redis_stub(spent=3.0)),
    ):
        allowed, *_ = await LaneDailyBudget("clusterer").check(estimated_usd=0.01)
    assert allowed is False


@pytest.mark.asyncio
async def test_check_unlimited_when_cap_zero() -> None:
    """Cap == 0 (disabled) → always allowed, no Redis round-trip."""
    mock_get_redis = AsyncMock()
    with (
        _patch_cap("annotator", 0.0),
        patch("eden.llmops.evolution_spend._get_redis", new=mock_get_redis),
    ):
        allowed, spent, cap = await LaneDailyBudget("annotator").check()
    assert allowed is True
    assert cap == 0.0
    mock_get_redis.assert_not_awaited()  # skip Redis entirely when cap=0


# ── fail-open when Redis is unavailable ────────────────────────────


@pytest.mark.asyncio
async def test_check_fail_open_when_redis_down() -> None:
    """Redis unavailable → fail-open (allow=True, spent=0), logs WARNING."""
    with (
        _patch_cap("annotator", 5.0),
        _patch_redis_down(),
    ):
        allowed, spent, cap = await LaneDailyBudget("annotator").check()
    assert allowed is True
    assert spent == 0.0
    assert cap == pytest.approx(5.0)


# ── daily reset (key changes per day) ──────────────────────────────


@pytest.mark.asyncio
async def test_daily_reset_different_keys_for_different_days() -> None:
    """Two different dates produce different Redis keys."""
    b = LaneDailyBudget("annotator")
    with patch("eden.llmops.evolution_spend._today_str", return_value="2026-08-12"):
        key_day1 = b._redis_key()
    with patch("eden.llmops.evolution_spend._today_str", return_value="2026-08-13"):
        key_day2 = b._redis_key()
    assert key_day1 != key_day2
    assert "2026-08-12" in key_day1
    assert "2026-08-13" in key_day2


@pytest.mark.asyncio
async def test_daily_reset_spend_zeroes_at_midnight() -> None:
    """Simulates midnight rollover: day-2 key has no spend → allowed even if day-1 was over cap."""
    b = LaneDailyBudget("annotator")

    # Day 1: key exists, spent=10.0 (over the 5.0 cap)
    stub_d1 = _redis_stub(spent=10.0)
    with (
        _patch_cap("annotator", 5.0),
        patch("eden.llmops.evolution_spend._today_str", return_value="2026-08-12"),
        patch("eden.llmops.evolution_spend._get_redis", new=AsyncMock(return_value=stub_d1)),
    ):
        allowed_d1, _, _ = await b.check()

    # Day 2: key doesn't exist yet → spent=0.0 (TTL expired naturally)
    stub_d2 = _redis_stub(spent=0.0)
    with (
        _patch_cap("annotator", 5.0),
        patch("eden.llmops.evolution_spend._today_str", return_value="2026-08-13"),
        patch("eden.llmops.evolution_spend._get_redis", new=AsyncMock(return_value=stub_d2)),
    ):
        allowed_d2, _, _ = await b.check()

    assert allowed_d1 is False  # over cap on day 1
    assert allowed_d2 is True   # fresh day 2 → OK


# ── lane isolation ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lane_isolation_annotator_over_cap_does_not_block_clusterer() -> None:
    """Annotator over cap must not affect clusterer's gate."""
    def _cap(lane: str) -> float:
        return {"annotator": 5.0, "clusterer": 3.0}.get(lane, 0.0)

    def _make_redis(spent: float):
        return AsyncMock(return_value=_redis_stub(spent=spent))

    with patch("eden.llmops.evolution_spend._lane_cap_usd", side_effect=_cap):
        # Annotator: spent=6.0 → over cap
        with patch("eden.llmops.evolution_spend._get_redis", new=_make_redis(6.0)):
            ann_allowed, _, _ = await LaneDailyBudget("annotator").check()

        # Clusterer: spent=1.0 → under cap
        with patch("eden.llmops.evolution_spend._get_redis", new=_make_redis(1.0)):
            clu_allowed, _, _ = await LaneDailyBudget("clusterer").check()

    assert ann_allowed is False
    assert clu_allowed is True


@pytest.mark.asyncio
async def test_lane_isolation_separate_redis_keys() -> None:
    """Different lanes use different Redis keys so they never share counters."""
    b_ann = LaneDailyBudget("annotator")
    b_clu = LaneDailyBudget("clusterer")
    with patch("eden.llmops.evolution_spend._today_str", return_value="2026-08-12"):
        assert b_ann._redis_key() != b_clu._redis_key()
        assert "annotator" in b_ann._redis_key()
        assert "clusterer" in b_clu._redis_key()


# ── record() ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_record_increments_and_sets_ttl() -> None:
    stub = _redis_stub(spent=1.0)
    with patch("eden.llmops.evolution_spend._get_redis", new=AsyncMock(return_value=stub)):
        await LaneDailyBudget("annotator").record(0.05)
    stub.incrbyfloat.assert_awaited_once()
    call_args = stub.incrbyfloat.await_args
    assert call_args.args[1] == pytest.approx(0.05)
    stub.expire.assert_awaited_once()
    # TTL must be ≥ 86400 (one day)
    ttl_arg = stub.expire.await_args.args[1]
    assert ttl_arg >= 86400


@pytest.mark.asyncio
async def test_record_no_op_for_zero_cost() -> None:
    mock_get_redis = AsyncMock()
    with patch("eden.llmops.evolution_spend._get_redis", new=mock_get_redis):
        await LaneDailyBudget("annotator").record(0.0)
    mock_get_redis.assert_not_awaited()


@pytest.mark.asyncio
async def test_record_swallows_redis_errors() -> None:
    stub = _redis_stub(spent=0.0, incr_ok=False)
    with patch("eden.llmops.evolution_spend._get_redis", new=AsyncMock(return_value=stub)):
        # Must not raise
        await LaneDailyBudget("annotator").record(0.10)


# ── config defaults ─────────────────────────────────────────────────


def test_config_defaults_are_nonzero() -> None:
    """Every lane cap must have a positive default so the gate can trip."""
    from eden.config import get_settings

    s = get_settings()
    assert s.annotator_daily_budget_usd > 0, "annotator cap must be set"
    assert s.soft_issue_daily_budget_usd > 0, "soft_issue cap must be set"
    assert s.clusterer_daily_budget_usd > 0, "clusterer cap must be set"
    assert s.judges_daily_budget_usd > 0, "judges cap must be set"
    assert s.evolution_daily_budget_usd > 0, "evolution cap must be set"
    assert s.investigation_daily_budget_usd > 0, "investigation cap must be set"


def test_evolution_loop_interval_is_1800() -> None:
    """OOM W3-5: evolution tick must be 1800s (30 min), not the old 300s."""
    from eden.config import get_settings

    assert get_settings().evolution_loop_interval_seconds == 1800


# ── status() ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_status_shape() -> None:
    with (
        _patch_cap("evolution", 2.0),
        _patch_redis(_redis_stub(spent=0.5)),
    ):
        st = await LaneDailyBudget("evolution").status()
    assert st["lane"] == "evolution"
    assert st["cap_usd"] == pytest.approx(2.0)
    assert st["spent_usd"] == pytest.approx(0.5)
    assert st["remaining_usd"] == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_status_unlimited_lane_has_none_remaining() -> None:
    with (
        _patch_cap("evolution", 0.0),
    ):
        st = await LaneDailyBudget("evolution").status()
    assert st["remaining_usd"] is None
