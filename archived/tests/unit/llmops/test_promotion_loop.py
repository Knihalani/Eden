"""Tests for the PromotionLoop decision math (Phase 7.2d).

The PromotionLoop reads per-version call stats from telemetry_events
and decides whether to promote the candidate (winner) or roll it
back (loser). The math is conservative: 30+ calls minimum, ≥5%
absolute success-rate lift, ≤10% latency regression.

These tests verify the threshold logic by simulating candidate vs
control stats and asserting the right decision.
"""

import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, "src")

from eden.llmops.promotion import PromotionLoop


class _FakeRow(dict):
    """A dict that also supports attribute access, mimicking a
    ``asyncpg.Record``. The PromotionLoop reads via ``row.get(...)``,
    so a plain dict works perfectly.
    """


def _stats(calls, successes, p95):
    return _FakeRow(
        calls=calls,
        successes=successes,
        p95_latency_ms=p95,
        avg_latency_ms=p95 * 0.5,
    )


@pytest.fixture
def loop():
    return PromotionLoop()


@pytest.mark.asyncio
async def test_keep_when_candidate_below_min_calls(loop, monkeypatch):
    """Not enough calls yet → keep waiting."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)

    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=10, successes=8, p95=500),  # candidate
        _stats(calls=100, successes=90, p95=500),  # control
    ])

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "keep"


@pytest.mark.asyncio
async def test_promote_when_candidate_wins(loop, monkeypatch):
    """candidate success rate > control by >=5% AND p95 ≤ 110% of
    control → promote (after EvidenceGate passes)."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)
    monkeypatch.setattr(s, "promotion_min_success_rate_lift", 0.05)
    monkeypatch.setattr(s, "promotion_max_latency_ratio", 1.10)
    # W25: full promote requires EvidenceGate; stub pass for threshold math.
    monkeypatch.setattr(
        loop, "_evidence_gate_promote", AsyncMock(return_value=True)
    )

    fake_client = MagicMock()
    # candidate: 50 calls, 45 successes (90%), p95=500ms
    # control: 100 calls, 75 successes (75%), p95=500ms
    # lift = 0.15, latency_ratio = 1.0
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=45, p95=500),
        _stats(calls=100, successes=75, p95=500),
    ])
    fake_client.execute = AsyncMock()

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "promote"


@pytest.mark.asyncio
async def test_rollback_when_candidate_loses_on_success(loop, monkeypatch):
    """Candidate success rate < control by ≥5% → rollback."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)

    fake_client = MagicMock()
    # candidate: 50 calls, 30 successes (60%), p95=500
    # control: 100 calls, 80 successes (80%), p95=500
    # lift = -0.20
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=30, p95=500),
        _stats(calls=100, successes=80, p95=500),
    ])
    fake_client.execute = AsyncMock()

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "rollback"


@pytest.mark.asyncio
async def test_rollback_when_candidate_slow(loop, monkeypatch):
    """Candidate p95 latency > 132% of control → rollback."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)
    monkeypatch.setattr(s, "promotion_max_latency_ratio", 1.10)

    fake_client = MagicMock()
    # candidate: 50 calls, 40 successes, p95=1000ms
    # control: 100 calls, 80 successes, p95=500ms
    # lift = 0, latency_ratio = 2.0 → rollback
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=40, p95=1000),
        _stats(calls=100, successes=80, p95=500),
    ])
    fake_client.execute = AsyncMock()

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "rollback"


@pytest.mark.asyncio
async def test_keep_within_confidence_band(loop, monkeypatch):
    """Difference is small (success lift < 5%) → keep rolling."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)
    monkeypatch.setattr(s, "promotion_min_success_rate_lift", 0.05)

    fake_client = MagicMock()
    # candidate: 50 calls, 40 successes (80%), p95=500
    # control: 100 calls, 78 successes (78%), p95=500
    # lift = 0.02 — within the 5% gate
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=40, p95=500),
        _stats(calls=100, successes=78, p95=500),
    ])

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "keep"


@pytest.mark.asyncio
async def test_keep_when_control_also_below_min_calls(loop, monkeypatch):
    """If the control doesn't have enough calls either, keep waiting."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)

    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=40, p95=500),  # candidate
        _stats(calls=10, successes=8, p95=500),   # control below min
    ])

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "keep"


class _TextRefIdPgClient:
    """Fake postgres client modeling the FIXED schema (migration 149:
    ``promotion_candidates.ref_id`` is TEXT, not UUID). Any string bind
    parameter — including the composite ``"agent:version"`` ref
    ``_evidence_gate_promote`` writes — is accepted, mirroring how a real
    TEXT column behaves.
    """

    async def execute(self, query: str, *args) -> None:
        return None

    async def fetchrow(self, *args, **kwargs):
        return None


class _UuidRefIdPgClient:
    """Fake postgres client modeling the ORIGINAL buggy schema
    (``promotion_candidates.ref_id UUID NOT NULL``). Reproduces asyncpg's
    real behavior: binding a non-hex string (e.g. ``"checkout-agent:7"``)
    against a UUID-typed parameter raises. This is what made
    ``EvidenceGate.enqueue`` always return ``None`` — and therefore
    ``PromotionLoop._evidence_gate_promote`` always return ``False`` —
    for every ``kind="prompt_version"`` candidate before FEAT-28.
    """

    async def execute(self, query: str, *args) -> None:
        if "insert into promotion_candidates" in query.strip().lower():
            ref_id = args[3]
            from uuid import UUID as _UUID

            _UUID(str(ref_id))  # raises ValueError for composite refs

    async def fetchrow(self, *args, **kwargs):
        return None


@pytest.mark.asyncio
async def test_evidence_gate_promote_composite_ref_id_fixed_schema(loop, monkeypatch):
    """FEAT-28 regression (fixed side): ``_evidence_gate_promote`` enqueues
    the composite ``"{agent}:{candidate_version}"`` ref used for
    ``kind="prompt_version"`` candidates. Against the fixed TEXT schema
    this must enqueue successfully and return the gate's verdict — not
    unconditionally ``False``.
    """
    from uuid import UUID

    from eden.promotion.evidence_gate import EvidenceGate, EvidenceReport

    async def _get_client():
        return _TextRefIdPgClient()

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_client
    )
    monkeypatch.setattr(
        EvidenceGate,
        "evaluate_bayesian",
        AsyncMock(
            return_value=EvidenceReport(candidate_id=UUID(int=0), passed=True)
        ),
    )

    result = await loop._evidence_gate_promote(
        org_id="org-1",
        experiment_id="exp-1",
        agent="checkout-agent",
        candidate_version=7,
    )
    assert result is True


@pytest.mark.asyncio
async def test_evidence_gate_promote_composite_ref_id_original_bug(loop, monkeypatch):
    """FEAT-28 regression (buggy side, documents the original failure):
    against the original ``ref_id UUID NOT NULL`` schema, the composite
    ``"agent:version"`` ref makes asyncpg's UUID codec raise on every
    call, which ``EvidenceGate.enqueue``'s except-clause swallows into
    ``None`` — so ``_evidence_gate_promote`` always returns ``False``,
    100%-reproducibly, regardless of how good the candidate is.
    """
    async def _get_client():
        return _UuidRefIdPgClient()

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_client
    )

    result = await loop._evidence_gate_promote(
        org_id="org-1",
        experiment_id="exp-1",
        agent="checkout-agent",
        candidate_version=7,
    )
    assert result is False
