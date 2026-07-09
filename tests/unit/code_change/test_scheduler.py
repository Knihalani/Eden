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


# ── F58 batched cooldown view ──────────────────────────────────────
#
# Pre-F58 ``_cluster_passes_pre_filters`` issued two per-cluster
# DB round-trips for the file-path cooldowns. With N clusters
# per org that adds ``2 * N`` SELECTs per cron tick across
# every opted-in tenant. F58 builds the per-org cooldown state
# in two queries once, then filters per cluster in process.
# These tests pin the new helpers and verify the per-cluster
# path uses the supplied view (rather than round-tripping).


class TestF58CooldownView:
    """``_CooldownView`` is an in-process snapshot of the org's
    cooldown state, populated once per ``evaluate_pending_clusters``
    run from two SELECTs."""

    def test_empty_view_returns_false_for_anything(self) -> None:
        from eden.code_change.scheduler import _CooldownView

        view = _CooldownView()
        assert view.is_in_24h_cooldown("any/file.py") is False
        assert view.is_in_rejection_cooldown(
            "any/file.py", "title_xyz",
        ) is False

    def test_recent_24h_files_match(self) -> None:
        from eden.code_change.scheduler import _CooldownView

        view = _CooldownView(
            recent_24h_files={"src/api/users.py", "src/api/orders.py"},
        )
        assert view.is_in_24h_cooldown("src/api/users.py") is True
        assert view.is_in_24h_cooldown("src/api/orders.py") is True
        assert view.is_in_24h_cooldown("src/api/billing.py") is False
        # Empty file path → False (matches per-cluster helper).
        assert view.is_in_24h_cooldown("") is False

    def test_rejection_cooldowns_match(self) -> None:
        from eden.code_change.scheduler import _CooldownView

        view = _CooldownView(
            rejection_cooldowns={
                ("src/api/users.py", "title_abc"),
                ("src/api/orders.py", "title_xyz"),
            },
        )
        assert view.is_in_rejection_cooldown(
            "src/api/users.py", "title_abc",
        ) is True
        # Wrong title hash → False.
        assert view.is_in_rejection_cooldown(
            "src/api/users.py", "title_zzz",
        ) is False
        # Wrong file → False.
        assert view.is_in_rejection_cooldown(
            "src/api/billing.py", "title_abc",
        ) is False
        # Empty inputs → False (matches per-cluster helper).
        assert view.is_in_rejection_cooldown("", "title_abc") is False
        assert view.is_in_rejection_cooldown("src/api/users.py", "") is False


class TestF58CooldownViewFromRows:
    """``_cooldown_view_from_rows`` projects two row lists into a
    :class:`_CooldownView`. Tested without touching Postgres."""

    def test_empty_lists_yield_empty_view(self) -> None:
        from eden.code_change.scheduler import (
            _cooldown_view_from_rows,
        )
        v = _cooldown_view_from_rows(
            recent_24h_rows=[],
            rejection_rows=[],
        )
        assert v.recent_24h_files == set()
        assert v.rejection_cooldowns == set()

    def test_projects_recent_files_from_jsonb(self) -> None:
        from eden.code_change.scheduler import (
            _cooldown_view_from_rows,
        )
        v = _cooldown_view_from_rows(
            recent_24h_rows=[
                {
                    "blast_radius_affected_ids": [
                        "src/api/users.py", "src/api/orders.py",
                    ],
                },
                {"blast_radius_affected_ids": None},
                {
                    "blast_radius_affected_ids": [
                        "src/api/users.py",  # duplicate
                        "src/api/billing.py",
                    ],
                },
                # Non-list values are silently skipped — the row
                # isn't expected to look like this, but be
                # defensive.
                {"blast_radius_affected_ids": "garbage"},
            ],
            rejection_rows=[],
        )
        assert v.recent_24h_files == {
            "src/api/users.py",
            "src/api/orders.py",
            "src/api/billing.py",
        }

    def test_projects_rejection_tuples(self) -> None:
        from eden.code_change.scheduler import (
            _cooldown_view_from_rows,
        )
        v = _cooldown_view_from_rows(
            recent_24h_rows=[],
            rejection_rows=[
                {"file_path": "src/api/a.py", "title_hash": "abc"},
                {"file_path": None, "title_hash": "x"},
                {"file_path": "src/api/b.py", "title_hash": None},
                {"file_path": "src/api/a.py", "title_hash": "def"},
            ],
        )
        assert v.rejection_cooldowns == {
            ("src/api/a.py", "abc"),
            ("src/api/a.py", "def"),
        }


class TestF58BuildOrgCooldownViewDbDown:
    """When the DB is unreachable, ``_build_org_cooldown_view``
    returns an empty view (fail-open). The scheduler still picks
    up the cluster and the file-path cooldown checks become
    harmless no-ops."""

    @pytest.mark.asyncio
    async def test_returns_empty_on_no_client(self) -> None:
        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )

        # The function lazily imports
        # ``eden.storage.postgres.get_postgres_client`` inside its
        # body, so the patch must target that module path.
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            v = await _build_org_cooldown_view("org_test")
        assert v.recent_24h_files == set()
        assert v.rejection_cooldowns == set()

    @pytest.mark.asyncio
    async def test_returns_empty_on_query_failure(self) -> None:
        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )

        fake_pg = AsyncMock()

        class _AcquireCM:
            async def __aenter__(self):
                raise RuntimeError("query failed")
            async def __aexit__(self, *a):
                return False

        fake_pg.acquire = lambda: _AcquireCM()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_pg),
        ):
            v = await _build_org_cooldown_view("org_test")
        assert v.recent_24h_files == set()
        assert v.rejection_cooldowns == set()


class TestF58PreFiltersUsesViewWhenSupplied:
    """``_cluster_passes_pre_filters`` should consult the supplied
    ``cooldown_view`` rather than round-tripping for every cluster
    call. Pin that here so a future refactor doesn't reintroduce
    the N+1."""

    @pytest.mark.asyncio
    async def test_24h_cooldown_via_view_does_not_query_db(
        self, monkeypatch,
    ) -> None:
        from eden.code_change.scheduler import (
            _cluster_passes_pre_filters,
            _CooldownView,
        )
        from eden.config import get_settings

        s = get_settings()
        monkeypatch.setattr(s, "patch_cluster_min_size", 3, raising=False)
        monkeypatch.setattr(s, "max_cost_per_user_per_day", 50.0, raising=False)
        monkeypatch.setattr(s, "patch_max_per_day", 10, raising=False)
        monkeypatch.setattr(s, "patch_max_per_week", 30, raising=False)

        # If the view is consulted correctly, the per-cluster
        # helpers MUST NOT be called. Patch them with AsyncMocks
        # and assert ``await_count == 0``.
        with (
            patch(
                "eden.code_change.scheduler._is_same_file_in_24h_cooldown",
                new=AsyncMock(),
            ) as m_24h,
            patch(
                "eden.code_change.scheduler._is_in_rejection_cooldown",
                new=AsyncMock(),
            ) as m_rej,
        ):
            view = _CooldownView(
                recent_24h_files={"src/api/users.py"},
                rejection_cooldowns=set(),
            )
            passed, reason = await _cluster_passes_pre_filters(
                "org_test",
                _cluster(),
                policy=_policy(),
                cost_today=0.0,
                count_today=0,
                count_week=0,
                settings=s,
                cooldown_view=view,
            )
        assert passed is False
        assert "in 24h cooldown" in reason
        # Critical: zero DB round-trips for cooldown checks.
        assert m_24h.await_count == 0
        assert m_rej.await_count == 0

    @pytest.mark.asyncio
    async def test_rejection_cooldown_via_view_does_not_query_db(
        self, monkeypatch,
    ) -> None:
        from eden.code_change.scheduler import (
            _cluster_passes_pre_filters,
            _CooldownView,
        )
        from eden.config import get_settings

        s = get_settings()
        monkeypatch.setattr(s, "patch_cluster_min_size", 3, raising=False)
        monkeypatch.setattr(s, "max_cost_per_user_per_day", 50.0, raising=False)
        monkeypatch.setattr(s, "patch_max_per_day", 10, raising=False)
        monkeypatch.setattr(s, "patch_max_per_week", 30, raising=False)

        with (
            patch(
                "eden.code_change.scheduler._is_same_file_in_24h_cooldown",
                new=AsyncMock(),
            ) as m_24h,
            patch(
                "eden.code_change.scheduler._is_in_rejection_cooldown",
                new=AsyncMock(),
            ) as m_rej,
        ):
            view = _CooldownView(
                recent_24h_files=set(),
                rejection_cooldowns={
                    ("src/api/users.py", "clu_abc123"),
                },
            )
            passed, reason = await _cluster_passes_pre_filters(
                "org_test",
                _cluster(),
                policy=_policy(),
                cost_today=0.0,
                count_today=0,
                count_week=0,
                settings=s,
                cooldown_view=view,
            )
        assert passed is False
        assert "rejection_memory cooldown" in reason
        assert m_24h.await_count == 0
        assert m_rej.await_count == 0

    @pytest.mark.asyncio
    async def test_clean_view_passes_cluster_without_db_query(
        self, monkeypatch,
    ) -> None:
        """When a clean view is supplied, the cluster passes — and
        crucially the per-cluster helpers are NOT consulted (the
        view is authoritative for the whole org-tick)."""
        from eden.code_change.scheduler import (
            _cluster_passes_pre_filters,
            _CooldownView,
        )
        from eden.config import get_settings

        s = get_settings()
        monkeypatch.setattr(s, "patch_cluster_min_size", 3, raising=False)
        monkeypatch.setattr(s, "max_cost_per_user_per_day", 50.0, raising=False)
        monkeypatch.setattr(s, "patch_max_per_day", 10, raising=False)
        monkeypatch.setattr(s, "patch_max_per_week", 30, raising=False)

        with (
            patch(
                "eden.code_change.scheduler._is_same_file_in_24h_cooldown",
                new=AsyncMock(),
            ) as m_24h,
            patch(
                "eden.code_change.scheduler._is_in_rejection_cooldown",
                new=AsyncMock(),
            ) as m_rej,
        ):
            view = _CooldownView()  # empty → no cooldowns
            passed, reason = await _cluster_passes_pre_filters(
                "org_test",
                _cluster(),
                policy=_policy(),
                cost_today=0.0,
                count_today=0,
                count_week=0,
                settings=s,
                cooldown_view=view,
            )
        assert passed is True
        assert reason == "passed"
        # View is authoritative — the per-cluster helpers are
        # intentionally skipped when a view is supplied.
        assert m_24h.await_count == 0
        assert m_rej.await_count == 0


class TestF58EvaluatePendingClustersOneFetchPerOrg:
    """``evaluate_pending_clusters`` should call
    ``_build_org_cooldown_view`` exactly once per org (not once
    per cluster), so we measure round-trip cost by org count."""

    @pytest.mark.asyncio
    async def test_view_built_once_per_org(self) -> None:
        from eden.code_change.scheduler import (
            evaluate_pending_clusters,
        )

        with (
            patch(
                "eden.code_change.scheduler._list_active_orgs",
                new=AsyncMock(return_value=["org_a", "org_b"]),
            ),
            patch(
                "eden.code_change.scheduler._get_org_policy",
                new=AsyncMock(
                    return_value={"code_change_enabled": True},
                ),
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
                new=AsyncMock(return_value=[]),  # no clusters — quick exit
            ),
            patch(
                "eden.code_change.scheduler._build_org_cooldown_view",
                new=AsyncMock(),
            ) as view_mock,
        ):
            await evaluate_pending_clusters(dry_run=True)

        # Critical: view is built exactly ONCE per active org,
        # not once per cluster. With the empty-cluster stub
        # the call count reduces to ``len(orgs)``.
        assert view_mock.await_count == 2


class TestF58SourceLevelSqlContract:
    """Source-level SQL contract: catch table/column typos that
    mocked-DB tests would miss. Mirrors the F49-F53 source-level
    pattern from the previous audit."""

    def test_recent_query_filters_correctly(self) -> None:
        import inspect

        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )
        src = inspect.getsource(_build_org_cooldown_view)
        assert "FROM proposed_patches" in src
        assert "created_at > NOW() - INTERVAL '1 day'" in src
        # $1 placeholder for org_id — never format it in.
        assert "$1::text" in src or "$1" in src
        assert "%(" not in src  # no % formatting

    def test_rejection_query_filters_correctly(self) -> None:
        import inspect

        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )
        src = inspect.getsource(_build_org_cooldown_view)
        assert "FROM pr_rejection_memory" in src
        assert "expires_at > NOW()" in src
        # limit is bound parameter or hardcoded — never format().
        assert "LIMIT 2000" in src


# ── F60 deterministic LIMIT ordering ────────────────────────────────
#
# Pre-F60 the two cooldown queries in
# ``_build_org_cooldown_view`` had ``LIMIT 2000`` but no
# ``ORDER BY``, so asyncpg returned an arbitrary subset of
# matching rows when the table had >2000 entries. Two
# identical scheduler ticks against the same data could
# produce two different cooldown sets — meaning a busy org
# could see the same cluster "passed" by the 24h cooldown on
# one tick and "blocked" on the next.
#
# F60 added ``ORDER BY created_at DESC`` for the
# ``proposed_patches`` query and ``ORDER BY file_path,
# title_hash`` for the ``pr_rejection_memory`` query so the
# snapshots are stable. These tests pin the ORDER BY clauses
# so a future refactor that drops them is caught.


class TestF60DeterministicLimitOrdering:
    """Source-level SQL contract: every ``LIMIT`` in
    ``_build_org_cooldown_view`` is paired with an
    ``ORDER BY`` so the snapshot is stable across runs
    (F60 fix). Mirrors the F49-F53 + F56 + F58
    source-level pattern."""

    def test_recent_query_orders_by_created_at_desc(self) -> None:
        import inspect

        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )
        src = inspect.getsource(_build_org_cooldown_view)
        assert "ORDER BY created_at DESC" in src, (
            "F60 regression: ORDER BY created_at DESC is "
            "missing from _build_org_cooldown_view. Without "
            "it the LIMIT 2000 is non-deterministic when "
            "proposed_patches has >2000 rows in the window."
        )

    def test_rejection_query_orders_by_file_path_title_hash(self) -> None:
        import inspect

        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )
        src = inspect.getsource(_build_org_cooldown_view)
        assert "ORDER BY file_path, title_hash" in src, (
            "F60 regression: ORDER BY file_path, title_hash "
            "is missing. pr_rejection_memory LIMIT 2000 needs "
            "a deterministic order."
        )

    def test_two_order_by_clauses_present(self) -> None:
        import inspect
        import re

        from eden.code_change.scheduler import (
            _build_org_cooldown_view,
        )
        src = inspect.getsource(_build_org_cooldown_view)
        order_bys = re.findall(r"ORDER BY", src)
        assert len(order_bys) >= 2, (
            "F60 regression: expected >=2 ORDER BY clauses "
            "(one per SELECT), found {len(order_bys)}"
        )


class TestF60DeterministicSnapshotIdenticalRuns:

    """End-to-end: building the cooldown view from the
    same row set yields identical snapshots across calls.
    The Python ``set`` deduplication gives us identity at
    the Python layer; the SQL ``ORDER BY`` guarantees it at
    the row-source layer."""

    @pytest.mark.asyncio
    async def test_repeated_calls_return_identical_view(self) -> None:
        from eden.code_change.scheduler import (
            _cooldown_view_from_rows,
        )
        rows = [
            {"blast_radius_affected_ids": [f"src/f{i % 7}.py"]}
            for i in range(50)
        ]
        rejection_rows = [
            {"file_path": f"src/f{i % 7}.py",
             "title_hash": f"t{i}"}
            for i in range(50)
        ]
        v1 = _cooldown_view_from_rows(
            recent_24h_rows=rows,
            rejection_rows=rejection_rows,
        )
        v2 = _cooldown_view_from_rows(
            recent_24h_rows=rows,
            rejection_rows=rejection_rows,
        )
        assert v1.recent_24h_files == v2.recent_24h_files
        assert v1.rejection_cooldowns == v2.rejection_cooldowns
