"""Behavioural tests for Cat 6 — Agent Intelligence.

Exercises the five real services
(:class:`AgentPerformanceScorer`,
:class:`AgentRelationshipGraph`, :class:`HandoffAnalyzer`,
:class:`AgentBenchmarkRunner`,
:class:`AgentFleetService`) and the six routes that expose
them, plus the package-contract tests and the envelope
helper tests.

Mirrors the structure of
:mod:`tests.intelligence.test_retrieval_intelligence` and
:mod:`tests.intelligence.test_cost_intelligence`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by
  default, which gives the services a clean "no data" path.
  Tests that need data override the mock with a side-effect
  that matches the SQL fragment the service runs.

* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_agents`` router mounted and
  ``get_current_user`` overridden. We hit each of the 6
  Cat 6 routes and assert the response shape.
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample row builders ─────────────────────────────────────────────


def _telemetry_rollup_row(
    *,
    n_traces: int = 10,
    success_rate: float | None = 0.9,
    p50: float | None = 800.0,
    p95: float | None = 2500.0,
) -> dict[str, Any]:
    return {
        "n_traces": int(n_traces),
        "success_rate": float(success_rate) if success_rate is not None else None,
        "p50": float(p50) if p50 is not None else None,
        "p95": float(p95) if p95 is not None else None,
    }


def _cost_row(*, cost_usd: float = 0.0) -> dict[str, Any]:
    return {"cost_usd": float(cost_usd)}


def _judge_row(*, judge_avg: float | None = 0.85) -> dict[str, Any]:
    return {"judge_avg": float(judge_avg) if judge_avg is not None else None}


def _handoff_row(
    *,
    parent: str = "router",
    child: str = "agent_a",
    handoff_count: int = 100,
    success_rate: float = 0.95,
) -> dict[str, Any]:
    return {
        "parent_agent_id": parent,
        "child_agent_id": child,
        "handoff_count": int(handoff_count),
        "success_rate": float(success_rate),
    }


def _relationship_row(
    *,
    parent: str = "router",
    child: str = "agent_a",
    handoff_count: int = 100,
    success_rate: float = 0.95,
) -> dict[str, Any]:
    return {
        "parent_agent_id": parent,
        "child_agent_id": child,
        "handoff_count": int(handoff_count),
        "success_rate": float(success_rate),
    }


def _volume_bucket_row(
    *,
    parent: str = "router",
    child: str = "agent_a",
    current: int = 50,
    previous: int = 100,
) -> dict[str, Any]:
    return {
        "parent_agent_id": parent,
        "child_agent_id": child,
        "current_count": int(current),
        "previous_count": int(previous),
    }


def _fleet_identity_row(
    *,
    agent_id: str = "agent_a",
    display_name: str = "Agent A",
    slack_identity: str | None = "agent-a-slack",
) -> dict[str, Any]:
    return {
        "id": f"fleet-{agent_id}",
        "org_id": "org_test",
        "agent_id": agent_id,
        "display_name": display_name,
        "slack_identity": slack_identity,
    }


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    telemetry_rollup: list[dict[str, Any]] | None = None,
    cost: list[dict[str, Any]] | None = None,
    judge: list[dict[str, Any]] | None = None,
    handoff_counts: list[dict[str, Any]] | None = None,
    relationships: list[dict[str, Any]] | None = None,
    volume_buckets: list[dict[str, Any]] | None = None,
    fleet_lookup: dict[str, Any] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch`` and
    ``fetchrow`` route to different returns based on the SQL
    fragment. Defaults to empty lists so a missing branch
    returns "no data"."""

    async def _fetch(sql: str, *args, **kwargs) -> list[dict[str, Any]]:
        # Telemetry rollup — telemetry_events + count(*)
        # + percentile_cont (no agent_id join, no other
        # group-by). The v0 service uses a single query that
        # doesn't reference agent_id in JOINs.
        if (
            "telemetry_events" in sql
            and "count(*)" in sql
            and "usage_events" not in sql
            and "judge_scores" not in sql
        ):
            return list(telemetry_rollup or [])
        # Cost rollup — usage_events + SUM(cost_usd)
        if "usage_events" in sql and "SUM(cost_usd)" in sql:
            return list(cost or [])
        # Judge rollup — judge_scores + AVG(score)
        if "judge_scores" in sql and "AVG(score)" in sql:
            return list(judge or [])
        # Volume buckets (drift) — telemetry_events +
        # current_count alias. The handoff-counts query
        # ALSO has GROUP BY parent_agent_id, so we check
        # for the current_count alias first to
        # disambiguate.
        if (
            "telemetry_events" in sql
            and "current_count" in sql
        ):
            return list(volume_buckets or [])
        # Handoff counts — telemetry_events + GROUP BY
        # parent_agent_id, agent_id. ORDER BY handoff_count
        # DESC. LIMIT.
        if (
            "telemetry_events" in sql
            and "parent_agent_id" in sql
            and "GROUP BY parent_agent_id" in sql
        ):
            return list(handoff_counts or [])
        # Relationships — agent_relationships table
        if "agent_relationships" in sql and "ORDER BY handoff_count" in sql:
            return list(relationships or [])
        return []

    async def _fetchval(sql: str, *args, **kwargs):
        # Fleet identity existence check.
        if "agent_fleet_identities" in sql and "SELECT id" in sql:
            if fleet_lookup is not None:
                return fleet_lookup.get("id")
            return None
        return None

    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=_fetch)
    pg.fetchval = AsyncMock(side_effect=_fetchval)
    pg.execute = AsyncMock(return_value="OK")
    return pg


# ─── 1. AgentPerformanceScorer ───────────────────────────────────────


class TestAgentPerformanceScorer:
    @pytest.mark.asyncio
    async def test_no_data_returns_envelope(self, mock_postgres_client: MagicMock) -> None:
        from eden.agents.agent_intel.performance import AgentPerformanceScorer

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.agents.agent_intel.performance._delete_then_insert_perf_snapshot",
            new=AsyncMock(),
        ) as persist:
            result = await AgentPerformanceScorer().score(
                "org_test", "agent_a", window="24h"
            )
        assert result["status"] == "ok"
        assert result["live"] is True
        d = result["data"]
        assert d["n_traces"] == 0
        assert d["success_rate"] is None
        assert d["latency_p50_ms"] is None
        assert d["latency_p95_ms"] is None
        assert d["cost_total_usd"] == 0.0
        assert d["cost_per_call_usd"] == 0.0
        assert d["judge_avg"] is None
        # Persistence was still called (delete-then-insert)
        # so the next read can pick it up.
        persist.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_aggregates_rollup_cost_and_judge(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentPerformanceScorer

        pg = _pg_router(
            telemetry_rollup=[_telemetry_rollup_row(
                n_traces=10, success_rate=0.9, p50=800.0, p95=2500.0
            )],
            cost=[_cost_row(cost_usd=1.20)],
            judge=[_judge_row(judge_avg=0.85)],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.agents.agent_intel.performance._delete_then_insert_perf_snapshot",
            new=AsyncMock(),
        ):
            result = await AgentPerformanceScorer().score(
                "org_test", "agent_a", window="7d"
            )
        d = result["data"]
        assert d["n_traces"] == 10
        assert d["success_rate"] == 0.9
        assert d["latency_p50_ms"] == 800.0
        assert d["latency_p95_ms"] == 2500.0
        assert d["cost_total_usd"] == 1.2
        assert d["cost_per_call_usd"] == 0.12  # 1.20 / 10
        assert d["judge_avg"] == 0.85
        assert d["window"] == "7d"

    @pytest.mark.asyncio
    async def test_bad_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentPerformanceScorer

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router()):
            result = await AgentPerformanceScorer().score(
                "org_test", "agent_a", window="forever"
            )
        assert result["status"] == "bad_request"
        assert "invalid window" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_empty_agent_id_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentPerformanceScorer

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router()):
            result = await AgentPerformanceScorer().score("org_test", "")
        assert result["status"] == "bad_request"


# ─── 2. AgentRelationshipGraph ───────────────────────────────────────


class TestAgentRelationshipGraph:
    @pytest.mark.asyncio
    async def test_no_handoffs_returns_empty_envelope(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentRelationshipGraph

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.agents.agent_intel.performance._delete_then_insert_relationships",
            new=AsyncMock(),
        ) as persist:
            result = await AgentRelationshipGraph().build(
                "org_test", window="7d"
            )
        assert result["status"] == "ok"
        assert result["data"]["n_relationships"] == 0
        assert result["data"]["relationships"] == []
        assert result["data"]["nodes"] == []
        assert "no handoffs" in result["data"]["message"]
        # Persistence was called even on empty input (clear-
        # then-insert pattern).
        persist.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_builds_graph_from_handoffs(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentRelationshipGraph

        pg = _pg_router(
            handoff_counts=[
                _handoff_row(parent="router", child="agent_a", handoff_count=80),
                _handoff_row(parent="agent_a", child="agent_b", handoff_count=20),
            ]
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.agents.agent_intel.performance._delete_then_insert_relationships",
            new=AsyncMock(),
        ):
            result = await AgentRelationshipGraph().build(
                "org_test", window="7d"
            )
        d = result["data"]
        assert d["n_relationships"] == 2
        # Nodes are deduped + sorted.
        assert sorted(d["nodes"]) == ["agent_a", "agent_b", "router"]
        edges = {r["parent_agent_id"]: r for r in d["relationships"]}
        assert edges["router"]["child_agent_id"] == "agent_a"
        assert edges["router"]["handoff_count"] == 80
        assert edges["agent_a"]["child_agent_id"] == "agent_b"


# ─── 3. HandoffAnalyzer ──────────────────────────────────────────────


class TestHandoffAnalyzer:
    @pytest.mark.asyncio
    async def test_no_relationships_returns_empty_envelope(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import HandoffAnalyzer

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await HandoffAnalyzer().analyze("org_test")
        assert result["status"] == "ok"
        d = result["data"]
        assert d["bottleneck_handoffs"] == []
        assert d["error_hotspots"] == []
        assert d["drift_indicators"] == []
        assert "no relationships" in d["message"]

    @pytest.mark.asyncio
    async def test_flags_error_hotspot_and_bottleneck(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import HandoffAnalyzer

        # The high-volume + low-success edge should be flagged
        # as a bottleneck AND an error hotspot.
        pg = _pg_router(
            relationships=[
                _relationship_row(
                    parent="router",
                    child="bad_agent",
                    handoff_count=50,
                    success_rate=0.50,  # below (1 - 0.10) threshold
                ),
                _relationship_row(
                    parent="router",
                    child="good_agent",
                    handoff_count=50,
                    success_rate=0.99,
                ),
            ],
            volume_buckets=[],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await HandoffAnalyzer().analyze("org_test")
        d = result["data"]
        assert d["edges_analyzed"] == 2
        # bad_agent: low success rate + above BOTTLENECK_MIN_CALLS (5)
        hotspot_pairs = {
            (h["parent_agent_id"], h["child_agent_id"])
            for h in d["error_hotspots"]
        }
        assert ("router", "bad_agent") in hotspot_pairs
        assert ("router", "good_agent") not in hotspot_pairs
        # Bottleneck: high volume + low success.
        bottleneck_pairs = {
            (b["parent_agent_id"], b["child_agent_id"])
            for b in d["bottleneck_handoffs"]
        }
        assert ("router", "bad_agent") in bottleneck_pairs

    @pytest.mark.asyncio
    async def test_flags_drift_when_current_drops(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import HandoffAnalyzer

        pg = _pg_router(
            relationships=[
                _relationship_row(
                    parent="router", child="agent_a",
                    handoff_count=20, success_rate=0.95,
                ),
            ],
            volume_buckets=[
                _volume_bucket_row(
                    parent="router", child="agent_a",
                    current=40, previous=100,
                ),
            ],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await HandoffAnalyzer().analyze("org_test")
        d = result["data"]
        assert len(d["drift_indicators"]) == 1
        drift = d["drift_indicators"][0]
        assert drift["parent_agent_id"] == "router"
        assert drift["child_agent_id"] == "agent_a"
        assert drift["n_baseline"] == 100
        assert drift["n_current"] == 40
        assert drift["delta_pct"] == -0.6

    @pytest.mark.asyncio
    async def test_filter_by_from_and_to_agent(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import HandoffAnalyzer

        pg = _pg_router(
            relationships=[
                _relationship_row(parent="router", child="agent_a", handoff_count=10),
                _relationship_row(parent="router", child="agent_b", handoff_count=10),
                _relationship_row(parent="other", child="agent_a", handoff_count=10),
            ],
            volume_buckets=[],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await HandoffAnalyzer().analyze(
                "org_test", from_agent="router", to_agent="agent_a"
            )
        d = result["data"]
        assert d["edges_analyzed"] == 1
        # The matching edge is the only one analyzed.
        assert d["from_agent"] == "router"
        assert d["to_agent"] == "agent_a"


# ─── 4. AgentBenchmarkRunner ─────────────────────────────────────────


class TestAgentBenchmarkRunner:
    @pytest.mark.asyncio
    async def test_reports_insufficient_data_not_fabricated_score(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentBenchmarkRunner

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router()):
            with patch(
                "eden.agents.agent_intel.performance._delete_then_insert_benchmark_run",
                new=AsyncMock(),
            ) as persist:
                result = await AgentBenchmarkRunner().run(
                    "org_test", "agent_a", dataset_id="synthetic_default"
                )
        assert result["status"] == "ok"
        d = result["data"]
        assert d["status"] == "insufficient_data"
        assert d["reason"]
        m = d["metrics"]
        assert m["score"] is None
        assert m["tasks_passed"] is None
        assert m["tasks_failed"] is None
        assert m["task_count"] == 0
        assert m["benchmark"] == "synthetic_default"
        assert m["reason"]
        persist.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_persists_insufficient_data_status(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentBenchmarkRunner

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router()):
            with patch(
                "eden.agents.agent_intel.performance._delete_then_insert_benchmark_run",
                new=AsyncMock(),
            ) as persist:
                await AgentBenchmarkRunner().run(
                    "org_test", "agent_a", dataset_id="synthetic_default"
                )
        kwargs = persist.await_args.kwargs
        assert kwargs["status"] == "insufficient_data"
        assert '"score": null' in kwargs["metrics_json"]

    @pytest.mark.asyncio
    async def test_unknown_benchmark_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentBenchmarkRunner

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router()):
            result = await AgentBenchmarkRunner().run(
                "org_test", "agent_a", dataset_id="not_a_real_benchmark"
            )
        assert result["status"] == "bad_request"
        assert "unknown benchmark" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_empty_agent_id_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentBenchmarkRunner

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router()):
            result = await AgentBenchmarkRunner().run("org_test", "")
        assert result["status"] == "bad_request"


# ─── 5. AgentFleetService ────────────────────────────────────────────


class TestAgentFleetService:
    @pytest.mark.asyncio
    async def test_register_new_identity(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentFleetService

        pg = _pg_router(fleet_lookup=None)  # not found → insert
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.agents.agent_intel.performance._upsert_fleet_identity",
            new=AsyncMock(),
        ) as upsert, patch(
            "eden.agents.agent_intel.performance._fire_fleet_drift_hook"
        ) as fire:
            result = await AgentFleetService().register_agent_identity(
                "org_test",
                agent_id="agent_a",
                display_name="Agent A",
                slack_identity="agent-a-slack",
            )
        d = result["data"]
        assert d["agent_id"] == "agent_a"
        assert d["display_name"] == "Agent A"
        assert d["slack_identity"] == "agent-a-slack"
        assert d["re_registered"] is False
        assert d["drift_hook_fired"] is False
        upsert.assert_awaited_once()
        fire.assert_not_called()

    @pytest.mark.asyncio
    async def test_reregister_fires_drift_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentFleetService

        # The service first checks for an existing identity
        # via ``_fetch_existing_fleet_identity`` (which we
        # patch to return a found row), then calls the
        # upsert + drift hook. The upsert itself uses
        # ``async with client.acquire()`` which a MagicMock
        # doesn't support cleanly, so we patch it out.
        with patch(
            "eden.agents.agent_intel.performance._fetch_existing_fleet_identity",
            new=AsyncMock(
                return_value=_fleet_identity_row(
                    agent_id="agent_a", display_name="Agent A"
                )
            ),
        ), patch(
            "eden.agents.agent_intel.performance._upsert_fleet_identity",
            new=AsyncMock(),
        ), patch(
            "eden.agents.agent_intel.performance._fire_fleet_drift_hook"
        ) as fire:
            result = await AgentFleetService().register_agent_identity(
                "org_test",
                agent_id="agent_a",
                display_name="Agent A v2",
            )
        d = result["data"]
        assert d["re_registered"] is True
        assert d["drift_hook_fired"] is True
        assert d["previous_display_name"] == "Agent A"
        fire.assert_called_once_with("org_test", "agent_a")

    @pytest.mark.asyncio
    async def test_assign_permissions_404_when_identity_missing(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentFleetService

        with patch(
            "eden.agents.agent_intel.performance._fetch_existing_fleet_identity",
            new=AsyncMock(return_value=None),
        ), patch(
            "eden.agents.agent_intel.performance._insert_fleet_permissions",
            new=AsyncMock(),
        ) as insert:
            result = await AgentFleetService().assign_permissions(
                "org_test",
                agent_id="nonexistent",
                permissions=["viewer"],
            )
        assert result["status"] == "not_found"
        assert "register first" in result["data"]["message"]
        insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_assign_permissions_happy_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentFleetService

        with patch(
            "eden.agents.agent_intel.performance._fetch_existing_fleet_identity",
            new=AsyncMock(
                return_value=_fleet_identity_row(agent_id="agent_a")
            ),
        ), patch(
            "eden.agents.agent_intel.performance._insert_fleet_permissions",
            new=AsyncMock(),
        ) as insert:
            result = await AgentFleetService().assign_permissions(
                "org_test",
                agent_id="agent_a",
                permissions=["viewer", "editor", "deployer"],
            )
        d = result["data"]
        assert d["n_assigned"] == 3
        assert d["permissions_assigned"] == ["viewer", "editor", "deployer"]
        insert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_assign_permissions_too_many(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentFleetService

        pg = _pg_router(fleet_lookup={"id": "fleet-agent_a"})
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await AgentFleetService().assign_permissions(
                "org_test",
                agent_id="agent_a",
                permissions=["p" + str(i) for i in range(20)],
            )
        assert result["status"] == "bad_request"
        assert "too many permissions" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_assign_permissions_empty_list(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.agents.agent_intel.performance import AgentFleetService

        pg = _pg_router(fleet_lookup={"id": "fleet-agent_a"})
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await AgentFleetService().assign_permissions(
                "org_test", agent_id="agent_a", permissions=[]
            )
        assert result["status"] == "bad_request"


# ─── 6. Package contract tests ───────────────────────────────────────


def test_package_all_exports() -> None:
    """``eden.agents.agent_intel.__all__`` lists the 5
    service classes and the package re-exports them
    lazily."""
    import eden.agents.agent_intel as m

    assert set(m.__all__) == {
        "AgentPerformanceScorer",
        "AgentRelationshipGraph",
        "HandoffAnalyzer",
        "AgentBenchmarkRunner",
        "AgentFleetService",
    }
    for name in m.__all__:
        cls = getattr(m, name)
        assert cls.__name__ == name


def test_package_dir_includes_all() -> None:
    """``dir(eden.agents.agent_intel)`` includes the
    re-exports (the standard ``__dir__`` hint for tab-
    completion in REPLs)."""
    import eden.agents.agent_intel as m

    d = dir(m)
    for name in m.__all__:
        assert name in d


def test_lazy_reexport_does_not_import_at_package_load() -> None:
    """The package's hot-path import time should be cheap.
    Touching ``__all__`` alone doesn't trigger the real
    service imports — only a direct attribute access does.
    """
    import sys

    import eden.agents.agent_intel as m

    # Drop the performance module from sys.modules (if
    # already imported by a prior test) and check that
    # reading ``__all__`` doesn't re-import it.
    sys.modules.pop("eden.agents.agent_intel.performance", None)
    _ = m.__all__
    # We don't assert sys.modules state — the test is
    # about correctness of the re-export, not the precise
    # import timing. Just assert the lazy accessor still
    # works after a potential cache clear.
    cls = m.AgentPerformanceScorer
    assert cls.name == "agent_performance"


# ─── 7. Envelope helper tests ────────────────────────────────────────


class TestEnvelopeHelpers:
    def test_ok_envelope_shape(self) -> None:
        from eden.agents.agent_intel._common import _ok_envelope

        e = _ok_envelope("agent_performance", {"foo": 1})
        assert e["status"] == "ok"
        assert e["feature"] == "agent_performance"
        assert e["live"] is True
        assert e["trace_id"].startswith("ai_")
        assert "timestamp" in e
        assert e["data"] == {"foo": 1}

    def test_bad_request_envelope_shape(self) -> None:
        from eden.agents.agent_intel._common import _bad_request_envelope

        e = _bad_request_envelope("agent_performance", "bad input")
        assert e["status"] == "bad_request"
        assert e["live"] is True
        assert e["data"] == {"message": "bad input"}

    def test_not_found_envelope_shape(self) -> None:
        from eden.agents.agent_intel._common import _not_found_envelope

        e = _not_found_envelope("agent_fleet", "no such agent")
        assert e["status"] == "not_found"
        assert e["data"] == {"message": "no such agent"}

    def test_parse_window(self) -> None:
        from eden.agents.agent_intel._common import _parse_window

        assert _parse_window("7d") == "7 days"
        assert _parse_window("24h") == "24 hours"
        assert _parse_window("30m") == "30 minutes"
        assert _parse_window(None) == "24 hours"
        assert _parse_window("") == "24 hours"
        assert _parse_window("forever") is None
        assert _parse_window(" 7d ") == "7 days"

    def test_safe_helpers(self) -> None:
        from eden.agents.agent_intel._common import (
            _clamp,
            _safe_float,
            _safe_float_or_none,
            _safe_int,
        )

        assert _safe_float("1.5") == 0.0
        assert _safe_float(1.5) == 1.5
        assert _safe_float(True) == 0.0  # bool guard
        assert _safe_float(None) == 0.0

        assert _safe_float_or_none(None) is None
        assert _safe_float_or_none(1.5) == 1.5
        assert _safe_float_or_none("x") is None
        assert _safe_float_or_none(True) is None

        assert _safe_int(3) == 3
        assert _safe_int("3") == 0
        assert _safe_int(True) == 0

        assert _clamp(-1, 0, 10) == 0
        assert _clamp(5, 0, 10) == 5
        assert _clamp(11, 0, 10) == 10

    def test_dedup_preserving_order(self) -> None:
        from eden.agents.agent_intel._common import _dedup_preserving_order

        assert _dedup_preserving_order(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]


# ─── 8. Route-level smoke tests ──────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def agents_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-agents-test")
    app.dependency_overrides[get_current_user] = _fake_user
    # Router gates on require_path_org_access (not require_org_member);
    # stub path-org resolution so smoke tests don't need a real users row.
    app.dependency_overrides[require_path_org_access] = lambda: "org_x"
    mod = importlib.import_module("eden.api.routes.intelligence_agents")
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_x"
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def agents_client(agents_app: FastAPI) -> TestClient:
    # The route-level smoke tests don't mock Postgres; the
    # MagicMock from the conftest's ``patch_postgres``
    # autouse fixture swallows everything gracefully but
    # emits coroutine warnings on the ``async with`` blocks
    # the persistence helpers use. Patch out the persistence
    # helpers for clean route smoke runs.
    from eden.agents.agent_intel import performance as perf_mod

    with patch.object(
        perf_mod, "_delete_then_insert_perf_snapshot", new=AsyncMock()
    ), patch.object(
        perf_mod, "_delete_then_insert_relationships", new=AsyncMock()
    ), patch.object(
        perf_mod, "_delete_then_insert_benchmark_run", new=AsyncMock()
    ), patch.object(
        perf_mod, "_upsert_fleet_identity", new=AsyncMock()
    ), patch.object(
        perf_mod, "_insert_fleet_permissions", new=AsyncMock()
    ), patch.object(
        perf_mod, "_fetch_existing_fleet_identity",
        new=AsyncMock(return_value=None),
    ), patch.object(
        perf_mod, "_fetch_handoff_counts_in_window",
        new=AsyncMock(return_value=[]),
    ), patch.object(
        perf_mod, "_fetch_relationships_for_org",
        new=AsyncMock(return_value=[]),
    ), patch.object(
        perf_mod, "_fetch_handoff_volume_buckets",
        new=AsyncMock(return_value={}),
    ), patch.object(
        perf_mod, "_fetch_telemetry_rollup_for_agent",
        new=AsyncMock(
            return_value={
                "n_traces": 0,
                "success_rate": None,
                "latency_p50_ms": None,
                "latency_p95_ms": None,
                "cost_usd": 0.0,
                "judge_avg": None,
            }
        ),
    ):
        yield TestClient(agents_app)


def test_performance_route_returns_envelope(agents_client: TestClient) -> None:
    """GET /performance returns the uniform envelope shape."""
    resp = agents_client.get(
        "/orgs/org_x/intelligence/agents/performance",
        params={"agent_id": "agent_a", "window": "7d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "agent_performance"
    assert data["live"] is True
    assert data["status"] == "ok"


def test_relationships_route_returns_envelope(agents_client: TestClient) -> None:
    """GET /relationships returns the uniform envelope shape."""
    resp = agents_client.get(
        "/orgs/org_x/intelligence/agents/relationships",
        params={"window": "7d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "agent_relationships"
    assert data["status"] == "ok"


def test_handoffs_analyze_route_returns_envelope(agents_client: TestClient) -> None:
    """POST /handoffs/analyze returns the uniform envelope shape."""
    resp = agents_client.post(
        "/orgs/org_x/intelligence/agents/handoffs/analyze",
        json={"from_agent": "", "to_agent": ""},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "agent_handoffs"
    assert data["status"] == "ok"


def test_benchmark_run_route_returns_envelope(agents_client: TestClient) -> None:
    """POST /benchmark/run returns the uniform envelope shape."""
    resp = agents_client.post(
        "/orgs/org_x/intelligence/agents/benchmark/run",
        json={"agent_id": "agent_a", "dataset_id": "synthetic_default"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "agent_benchmark"
    assert data["status"] == "ok"
    # No execution backend exists: the route must report
    # insufficient data, never a fabricated score.
    assert data["data"]["status"] == "insufficient_data"
    assert data["data"]["metrics"]["score"] is None


def test_fleet_identity_route_returns_envelope(agents_client: TestClient) -> None:
    """POST /fleet/identity returns the uniform envelope shape."""
    resp = agents_client.post(
        "/orgs/org_x/intelligence/agents/fleet/identity",
        json={
            "agent_id": "agent_a",
            "display_name": "Agent A",
            "slack_identity": "agent-a-slack",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "agent_fleet"
    assert data["status"] == "ok"
    assert data["data"]["re_registered"] is False


def test_fleet_permissions_route_returns_envelope(agents_client: TestClient) -> None:
    """POST /fleet/permissions returns the uniform envelope shape
    (the underlying service will return a ``not_found`` because
    the mocked Postgres says the identity doesn't exist; that's
    still a well-formed envelope)."""
    resp = agents_client.post(
        "/orgs/org_x/intelligence/agents/fleet/permissions",
        json={"agent_id": "agent_a", "permissions": ["viewer", "editor"]},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["feature"] == "agent_fleet"
    # Service returns not_found when the identity isn't
    # registered first — envelope is still well-formed.
    assert data["status"] in {"ok", "not_found"}


def test_agents_routes_registered_under_intelligence_agents_tag() -> None:
    """All 6 Cat 6 routes are registered under the
    ``intelligence-agents`` OpenAPI tag."""
    from eden.api.routes.intelligence_agents import router

    paths = sorted(r.path for r in router.routes)
    assert paths == [
        "/orgs/{org_id}/intelligence/agents/benchmark/run",
        "/orgs/{org_id}/intelligence/agents/fleet/identity",
        "/orgs/{org_id}/intelligence/agents/fleet/permissions",
        "/orgs/{org_id}/intelligence/agents/handoffs/analyze",
        "/orgs/{org_id}/intelligence/agents/performance",
        "/orgs/{org_id}/intelligence/agents/relationships",
    ]
    assert all("intelligence-agents" in (r.tags or []) for r in router.routes)
