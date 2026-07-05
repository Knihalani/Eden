"""Unit tests for Phase 3b scheduler pre-filters + cost circuit breaker.

Verifies:
- _is_opted_in reads code_change_enabled
- _cluster_passes_pre_filters enforces every gate
- evaluate_pending_clusters returns a deterministic summary
  with mocked DB
- cost circuit breaker trips at the cap
- daily / weekly counters short-circuit
- not-now memory + 24h file cooldown block generation

All tests use mocked _select_rows + _list_active_orgs so the
suite runs without Postgres. The DB-touching parts of the
scheduler are exercised by the integration suite.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

# ── Test fixtures ───────────────────────────────────────────────────


def _cluster(
    *,
    id_: str = "clu_abc123",
    severity: str = "high",
    count: int = 5,
    category: str = "src/api/users.py",
    error_type: str = "timeout",
    agent_id: str = "agent_a",
) -> dict[str, Any]:
    return {
        "id": id_,
        "name": f"{agent_id}_{error_type}_{category}",
        "severity": severity,
        "member_count": count,
        "category": category,
        "error_type": error_type,
        "agent_id": agent_id,
        "last_seen_at": None,
    }


def _policy(enabled: bool = True) -> dict[str, Any]:
    return {"code_change_enabled": enabled}


# ── Pre-filter tests ───────────────────────────────────────────────


class TestIsOptedIn:
    def test_true_when_enabled(self):
        from eden.code_change.scheduler import _is_opted_in
        assert _is_opted_in({"code_change_enabled": True}) is True

    def test_false_when_disabled(self):
        from eden.code_change.scheduler import _is_opted_in
        assert _is_opted_in({"code_change_enabled": False}) is False

    def test_false_when_missing(self):
        from eden.code_change.scheduler import _is_opted_in
        assert _is_opted_in({}) is False


class TestPermittedSeverities:
    def test_only_high_and_critical(self):
        from eden.code_change.scheduler import _permitted_severities
        assert _permitted_severities() == {"high", "critical"}


class TestClusterPassesPreFilters:
    @pytest.fixture
    def settings(self, monkeypatch):
        from eden.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "patch_cluster_min_size", 3, raising=False)
        monkeypatch.setattr(s, "max_cost_per_user_per_day", 50.0, raising=False)
        monkeypatch.setattr(s, "patch_max_per_day", 10, raising=False)
        monkeypatch.setattr(s, "patch_max_per_week", 30, raising=False)
        return s

    @pytest.mark.asyncio
    async def test_pass_for_healthy_cluster(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(),
            policy=_policy(),
            cost_today=10.0,
            count_today=2,
            count_week=5,
            settings=settings,
        )
        assert passed is True
        assert reason == "passed"

    @pytest.mark.asyncio
    async def test_blocked_when_not_opted_in(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(),
            policy=_policy(enabled=False),
            cost_today=0.0,
            count_today=0,
            count_week=0,
            settings=settings,
        )
        assert passed is False
        assert "code_change_enabled" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_low_severity(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(severity="low"),
            policy=_policy(),
            cost_today=0.0,
            count_today=0,
            count_week=0,
            settings=settings,
        )
        assert passed is False
        assert "not permitted" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_below_min_cluster_size(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(count=2),  # below 3
            policy=_policy(),
            cost_today=0.0,
            count_today=0,
            count_week=0,
            settings=settings,
        )
        assert passed is False
        assert "min" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_cost_cap_hit(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(),
            policy=_policy(),
            cost_today=50.0,  # == cap
            count_today=0,
            count_week=0,
            settings=settings,
        )
        assert passed is False
        assert "daily cost" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_daily_count_cap_hit(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(),
            policy=_policy(),
            cost_today=0.0,
            count_today=10,  # == cap
            count_week=0,
            settings=settings,
        )
        assert passed is False
        assert "daily count" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_weekly_count_cap_hit(self, settings):
        from eden.code_change.scheduler import _cluster_passes_pre_filters

        passed, reason = await _cluster_passes_pre_filters(
            "org_test",
            _cluster(),
            policy=_policy(),
            cost_today=0.0,
            count_today=0,
            count_week=30,  # == cap
            settings=settings,
        )
        assert passed is False
        assert "weekly count" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_file_in_24h_cooldown(self, settings):
        from eden.code_change.scheduler import (
            _cluster_passes_pre_filters,
            _is_same_file_in_24h_cooldown,
        )

        with patch(
            "eden.code_change.scheduler._is_same_file_in_24h_cooldown",
            new=AsyncMock(return_value=True),
        ):
            passed, reason = await _cluster_passes_pre_filters(
                "org_test",
                _cluster(),
                policy=_policy(),
                cost_today=0.0,
                count_today=0,
                count_week=0,
                settings=settings,
            )
        assert passed is False
        assert "24h cooldown" in reason

    @pytest.mark.asyncio
    async def test_blocked_when_in_rejection_memory(self, settings):
        from eden.code_change.scheduler import (
            _cluster_passes_pre_filters,
            _is_in_rejection_cooldown,
            _is_same_file_in_24h_cooldown,
        )

        with (
            patch(
                "eden.code_change.scheduler._is_same_file_in_24h_cooldown",
                new=AsyncMock(return_value=False),
            ),
            patch(
                "eden.code_change.scheduler._is_in_rejection_cooldown",
                new=AsyncMock(return_value=True),
            ),
        ):
            passed, reason = await _cluster_passes_pre_filters(
                "org_test",
                _cluster(),
                policy=_policy(),
                cost_today=0.0,
                count_today=0,
                count_week=0,
                settings=settings,
            )
        assert passed is False
        assert "rejection" in reason.lower()


# ── evaluate_pending_clusters integration ────────────────────────────


class TestEvaluatePendingClustersDryRun:
    @pytest.mark.asyncio
    async def test_dry_run_no_llm(self):
        from eden.code_change.scheduler import evaluate_pending_clusters

        # All clusters permitted; dry_run so no LLM is called.
        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.code_change.scheduler._get_org_policy",
                new=AsyncMock(return_value=_policy()),
            ),
            patch(
                "eden.code_change.scheduler._recent_cost_for_org",
                new=AsyncMock(return_value=0.0),
            ),
            patch(
                "eden.code_change.scheduler._recent_count_for_org",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.code_change.scheduler._list_clusters_for_org",
                new=AsyncMock(return_value=[_cluster()]),
            ),
        ):
            result = await evaluate_pending_clusters(dry_run=True)
        assert result["dry_run"] is True
        assert result["orgs_scanned"] == 1
        assert result["orgs_opted_in"] == 1
        assert result["clusters_found"] == 1
        assert result["clusters_passed"] == 1
        # dry_run skips LLM call → no actual patches generated
        assert result["patches_generated"] == 0

    @pytest.mark.asyncio
    async def test_skips_orgs_not_opted_in(self):
        from eden.code_change.scheduler import evaluate_pending_clusters

        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.code_change.scheduler._get_org_policy",
                new=AsyncMock(return_value=_policy(enabled=False)),
            ),
            patch(
                "eden.code_change.scheduler._list_clusters_for_org",
                new=AsyncMock(return_value=[_cluster()]),
            ),
        ):
            result = await evaluate_pending_clusters(dry_run=True)
        assert result["orgs_scanned"] == 1
        assert result["orgs_opted_in"] == 0
        assert result["clusters_found"] == 0

    @pytest.mark.asyncio
    async def test_fires_drift_on_cost_circuit_breaker(self):
        from eden.code_change.scheduler import evaluate_pending_clusters

        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.code_change.scheduler._get_org_policy",
                new=AsyncMock(return_value=_policy()),
            ),
            patch(
                "eden.code_change.scheduler._recent_cost_for_org",
                new=AsyncMock(return_value=100.0),  # over the cap
            ),
            patch(
                "eden.code_change.scheduler._list_clusters_for_org",
                new=AsyncMock(return_value=[_cluster()]),
            ),
            patch(
                "eden.code_change.scheduler._emit_drift",
                new=AsyncMock(),
            ) as emit_mock,
        ):
            await evaluate_pending_clusters(dry_run=True)
        # Cost circuit breaker fires before any cluster is read.
        emit_calls = [c.kwargs.get("drift_type") for c in emit_mock.await_args_list]
        assert "cat23_cost_circuit_breaker" in emit_calls


class TestEvaluatePendingClustersWithMockGenerator:
    @pytest.mark.asyncio
    async def test_calls_generator_for_passed_cluster(self):
        from eden.code_change.scheduler import evaluate_pending_clusters

        gen = AsyncMock()
        gen.generate = AsyncMock(
            return_value={
                "status": "ok",
                "data": {
                    "patch_id": "patch_xyz",
                    "status": "proposed",
                    "cost_usd": 0.25,
                },
            }
        )
        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.code_change.scheduler._get_org_policy",
                new=AsyncMock(return_value=_policy()),
            ),
            patch(
                "eden.code_change.scheduler._recent_cost_for_org",
                new=AsyncMock(return_value=0.0),
            ),
            patch(
                "eden.code_change.scheduler._recent_count_for_org",
                new=AsyncMock(return_value=0),
            ),
            patch(
                "eden.code_change.scheduler._list_clusters_for_org",
                new=AsyncMock(return_value=[_cluster()]),
            ),
            patch(
                "eden.code_change.scheduler._emit_drift",
                new=AsyncMock(),
            ),
        ):
            result = await evaluate_pending_clusters(
                dry_run=False, patch_generator=gen,
            )
        assert result["patches_generated"] == 1
        gen.generate.assert_awaited_once()
        # The generator should have been called with rca_id derived
        # from the cluster id.
        call = gen.generate.await_args
        assert call.kwargs["rca_id"].startswith("clu_")


# ── Not-now memory / cooldown (mocked DB) ───────────────────────────


class TestIsInRejectionCooldown:
    @pytest.mark.asyncio
    async def test_no_match_returns_false(self):
        from eden.code_change.scheduler import _is_in_rejection_cooldown

        with patch(
            "eden.code_change.scheduler._select_rows",
            new=AsyncMock(return_value=[]),
        ):
            result = await _is_in_rejection_cooldown(
                "org_test", "src/api/users.py", "abc123",
            )
        assert result is False

    @pytest.mark.asyncio
    async def test_match_returns_true(self):
        from eden.code_change.scheduler import _is_in_rejection_cooldown

        with patch(
            "eden.code_change.scheduler._select_rows",
            new=AsyncMock(return_value=[{"id": "prm_1"}]),
        ):
            result = await _is_in_rejection_cooldown(
                "org_test", "src/api/users.py", "abc123",
            )
        assert result is True


class TestIsSameFileIn24hCooldown:
    @pytest.mark.asyncio
    async def test_no_match_returns_false(self):
        from eden.code_change.scheduler import _is_same_file_in_24h_cooldown

        with patch(
            "eden.code_change.scheduler._select_rows",
            new=AsyncMock(return_value=[]),
        ):
            result = await _is_same_file_in_24h_cooldown(
                "org_test", "src/api/users.py",
            )
        assert result is False


class TestRecentCostForOrg:
    @pytest.mark.asyncio
    async def test_sums_cost_usd(self):
        from eden.code_change.scheduler import _recent_cost_for_org

        with patch(
            "eden.code_change.scheduler._select_rows",
            new=AsyncMock(
                return_value=[
                    {"cost_usd": 0.10},
                    {"cost_usd": 0.25},
                    {"cost_usd": None},  # null should be 0
                    {"cost_usd": 0.05},
                ]
            ),
        ):
            result = await _recent_cost_for_org("org_test")
        assert result == pytest.approx(0.40)

    @pytest.mark.asyncio
    async def test_zero_when_no_rows(self):
        from eden.code_change.scheduler import _recent_cost_for_org

        with patch(
            "eden.code_change.scheduler._select_rows",
            new=AsyncMock(return_value=[]),
        ):
            result = await _recent_cost_for_org("org_test")
        assert result == 0.0


# ── Weekly digest + stale sweep ─────────────────────────────────────


class TestWeeklyDigest:
    @pytest.mark.asyncio
    async def test_aggregates_by_status(self):
        from eden.code_change.scheduler import weekly_digest

        rows = [
            {"status": "proposed"},
            {"status": "proposed"},
            {"status": "low_quality"},
            {"status": "merged"},
            {"status": "reverted"},
        ]
        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(
                    return_value=AsyncMock(
                        fetch=AsyncMock(
                            return_value=[
                                {"org_id": "org_a", **r, "cost_usd": 0.0}
                                for r in rows
                            ]
                        )
                    )
                ),
            ),
        ):
            result = await weekly_digest(dry_run=True)
        rollup = result["rollups"]["org_a"]
        assert rollup["proposed"] == 2
        assert rollup["low_quality"] == 1
        assert rollup["merged"] == 1
        assert rollup["reverted"] == 1
        assert rollup["__total"] == 5


class TestStalePendingSweep:
    @pytest.mark.asyncio
    async def test_dry_run_counts_without_firing(self):
        from eden.code_change.scheduler import stale_pending_sweep

        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.code_change.scheduler._select_rows",
                new=AsyncMock(
                    return_value=[
                        {"id": "patch_1"},
                        {"id": "patch_2"},
                    ]
                ),
            ),
            patch(
                "eden.code_change.scheduler._emit_drift",
                new=AsyncMock(),
            ) as emit_mock,
        ):
            result = await stale_pending_sweep(dry_run=True)
        assert result["stale_patches_found"] == 2
        # dry_run → no drift alerts fired.
        emit_mock.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_fires_drift_per_patch_when_live(self):
        from eden.code_change.scheduler import stale_pending_sweep

        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a"]),
            ),
            patch(
                "eden.code_change.scheduler._select_rows",
                new=AsyncMock(
                    return_value=[{"id": "patch_1"}, {"id": "patch_2"}]
                ),
            ),
            patch(
                "eden.code_change.scheduler._emit_drift",
                new=AsyncMock(),
            ) as emit_mock,
        ):
            result = await stale_pending_sweep(dry_run=False)
        assert result["stale_patches_found"] == 2
        assert emit_mock.await_count == 2
