"""Behavioural tests for Cat 19 — Trace Query DSL / EQL (v1.3).

Exercises the four real services
(:class:`EQLParser`, :class:`RelationalFieldResolver`,
:class:`EQLLinter`, :class:`AlertAsCode`) and the five
routes that expose them, plus the closed-loop
:class:`DSLHook` that fires from :class:`AlertAsCode.compile`
on the lint-warning path.

Mirrors the structure of :mod:`tests.intelligence.test_columnar_engine`
and :mod:`tests.intelligence.test_metric_studio`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. Tests that need
  data override the mock with a side-effect that matches
  the SQL fragment the service runs.
* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_dsl`` router mounted and
  ``get_current_user`` overridden. We hit each of the 5
  Cat 19 routes and assert the response shape.
"""

from __future__ import annotations

from datetime import UTC
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Test class: EQLParser ────────────────────────────────────


class TestEQLParser:
    """Service-level tests for the EQL parser."""

    async def test_invalid_shape_returns_stub(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query="SELECT * FROM telemetry_events",
            shape="invalid",
        )
        assert result["status"] == "not_implemented"
        assert "invalid shape" in result["message"]

    async def test_invalid_lint_mode_returns_stub(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query="SELECT * FROM telemetry_events",
            lint_mode="invalid",
        )
        assert result["status"] == "not_implemented"
        assert "invalid lint_mode" in result["message"]

    async def test_empty_query_returns_stub(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse("org_test", query="")
        assert result["status"] == "not_implemented"
        assert "non-empty" in result["message"]

    async def test_btql_pipe_syntax_rejected(self) -> None:
        from eden.dsl import EQLParser

        # The v1.3 ship is SQL only — the leading "select:"
        # / "filter:" / "dimensions:" BTQL directives are
        # rejected explicitly.
        result = await EQLParser().parse(
            "org_test",
            query="select: trace_id filter: event_type = 'x'",
        )
        assert result["status"] == "not_implemented"
        assert "BTQL pipe syntax" in result["message"]

    async def test_readonly_violation_rejected(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query="DROP TABLE telemetry_events",
        )
        assert result["status"] == "not_implemented"
        assert "read-only" in result["message"]

    async def test_basic_query_parses(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE org_id = 'org_test'"
            ),
        )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert "clickhouse_sql" in result["data"]
        assert "trace_id" in result["data"]["clickhouse_sql"]
        assert result["data"]["shape"] == "traces"
        assert result["data"]["relational_fields_used"] == []

    async def test_relational_field_root_detected(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE root.event_type = 'agent.run' "
                "AND org_id = 'org_test'"
            ),
        )
        assert result["status"] == "ok"
        assert "root" in result["data"]["relational_fields_used"]

    async def test_relational_field_any_expands_to_exists(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE any.error IS NOT NULL "
                "AND org_id = 'org_test'"
            ),
        )
        assert result["status"] == "ok"
        # The expansion adds an EXISTS clause for "any".
        assert "EXISTS" in result["data"]["clickhouse_sql"]
        assert "any" in result["data"]["relational_fields_used"]

    async def test_missing_org_auto_injected(self) -> None:
        from eden.dsl import EQLParser

        result = await EQLParser().parse(
            "org_test",
            query="SELECT trace_id FROM telemetry_events",
        )
        # Even though MISSING_ORG is filtered (the expansion
        # added the filter), the org_id must be in the SQL.
        assert "org_test" in result["data"]["clickhouse_sql"]

    async def test_strict_mode_blocks_on_error(self) -> None:
        from eden.dsl import EQLParser

        # NO_FILTERS fires when there's no WHERE clause —
        # severity is 'error' so strict mode blocks.
        result = await EQLParser().parse(
            "org_test",
            query="SELECT * FROM telemetry_events",
            lint_mode="strict",
        )
        assert result["status"] == "not_implemented"
        assert "strict" in result["message"]


# ─── Test class: RelationalFieldResolver ──────────────────────


class TestRelationalFieldResolver:
    """Service-level tests for the relational-field resolver."""

    async def test_empty_query_returns_stub(self) -> None:
        from eden.dsl import RelationalFieldResolver

        result = await RelationalFieldResolver().resolve("org_test", query="")
        assert result["status"] == "not_implemented"

    async def test_invalid_lint_mode(self) -> None:
        from eden.dsl import RelationalFieldResolver

        result = await RelationalFieldResolver().resolve(
            "org_test", query="SELECT 1", lint_mode="bogus"
        )
        assert result["status"] == "not_implemented"

    async def test_readonly_violation(self) -> None:
        from eden.dsl import RelationalFieldResolver

        result = await RelationalFieldResolver().resolve(
            "org_test", query="DROP TABLE x"
        )
        assert result["status"] == "not_implemented"
        assert "read-only" in result["message"]

    async def test_no_relational_fields_passthrough(self) -> None:
        from eden.dsl import RelationalFieldResolver

        result = await RelationalFieldResolver().resolve(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE org_id = 'org_test'"
            ),
        )
        assert result["status"] == "ok"
        # No expansion happened, but the org_id is still
        # auto-injected.
        assert "org_test" in result["data"]["expanded_query"]

    async def test_any_overuse_fires_warning(self) -> None:
        from eden.dsl import RelationalFieldResolver

        result = await RelationalFieldResolver().resolve(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE any.error IS NOT NULL "
                "AND any.event_type = 'x' "
                "AND any.duration_ms > 100 "
                "AND org_id = 'org_test'"
            ),
        )
        assert result["status"] == "ok"
        # 3 any. references → ANY_SPAN_OVERUSE warning fires.
        codes = [w["code"] for w in result["data"]["warnings"]]
        assert "ANY_SPAN_OVERUSE" in codes

    async def test_strict_mode_blocks_on_error(self) -> None:
        from eden.dsl import RelationalFieldResolver

        # Strip the org_id so MISSING_ORG fires (severity=error).
        result = await RelationalFieldResolver().resolve(
            "org_test",
            query="SELECT trace_id FROM telemetry_events",
            lint_mode="strict",
        )
        assert result["status"] == "not_implemented"


# ─── Test class: EQLLinter ────────────────────────────────────


class TestEQLLinter:
    """Service-level tests for the linter."""

    async def test_empty_query(self) -> None:
        from eden.dsl import EQLLinter

        result = await EQLLinter().lint("org_test", query="")
        assert result["status"] == "not_implemented"

    async def test_invalid_lint_mode(self) -> None:
        from eden.dsl import EQLLinter

        result = await EQLLinter().lint(
            "org_test", query="SELECT 1", lint_mode="bogus"
        )
        assert result["status"] == "not_implemented"

    async def test_invalid_shape(self) -> None:
        from eden.dsl import EQLLinter

        result = await EQLLinter().lint(
            "org_test", query="SELECT 1", shape="bogus"
        )
        assert result["status"] == "not_implemented"

    async def test_no_filters_warning(self) -> None:
        from eden.dsl import EQLLinter

        result = await EQLLinter().lint(
            "org_test", query="SELECT * FROM telemetry_events"
        )
        assert result["status"] == "ok"
        codes = [w["code"] for w in result["data"]["warnings"]]
        assert "NO_FILTERS" in codes
        assert "MISSING_ORG" in codes

    async def test_clean_query_no_warnings(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.dsl import EQLLinter

        result = await EQLLinter().lint(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE org_id = 'org_test' AND timestamp > '2026-06-01'"
            ),
        )
        assert result["status"] == "ok"
        assert result["data"]["n_warnings"] == 0
        assert result["data"]["n_errors"] == 0

    async def test_shape_mismatch_warning(self) -> None:
        from eden.dsl import EQLLinter

        # "span_id" is a spans-shape field; requesting
        # traces shape should trigger SHAPE_MISMATCH.
        result = await EQLLinter().lint(
            "org_test",
            query=(
                "SELECT span_id FROM telemetry_events "
                "WHERE org_id = 'org_test'"
            ),
            shape="traces",
        )
        assert result["status"] == "ok"
        codes = [w["code"] for w in result["data"]["warnings"]]
        assert "SHAPE_MISMATCH" in codes

    async def test_any_overuse_warning(self) -> None:
        from eden.dsl import EQLLinter

        result = await EQLLinter().lint(
            "org_test",
            query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE org_id = 'org_test' "
                "AND any.error IS NOT NULL "
                "AND any.duration_ms > 100 "
                "AND any.event_type = 'x'"
            ),
        )
        codes = [w["code"] for w in result["data"]["warnings"]]
        assert "ANY_SPAN_OVERUSE" in codes


# ─── Test class: AlertAsCode ──────────────────────────────────


class TestAlertAsCode:
    """Service-level tests for the alert compiler."""

    async def test_empty_name(self) -> None:
        from eden.dsl import AlertAsCode

        result = await AlertAsCode().compile(
            "org_test", name="", eql_query="SELECT 1"
        )
        assert result["status"] == "not_implemented"

    async def test_invalid_severity(self) -> None:
        from eden.dsl import AlertAsCode

        result = await AlertAsCode().compile(
            "org_test",
            name="x",
            eql_query="SELECT 1",
            severity="bogus",
        )
        assert result["status"] == "not_implemented"

    async def test_interval_too_small(self) -> None:
        from eden.dsl import AlertAsCode

        result = await AlertAsCode().compile(
            "org_test",
            name="x",
            eql_query="SELECT 1",
            interval_seconds=10,
        )
        assert result["status"] == "not_implemented"
        assert "interval_seconds" in result["message"]

    async def test_empty_query(self) -> None:
        from eden.dsl import AlertAsCode

        result = await AlertAsCode().compile(
            "org_test", name="x", eql_query=""
        )
        assert result["status"] == "not_implemented"

    async def test_readonly_violation(self) -> None:
        from eden.dsl import AlertAsCode

        result = await AlertAsCode().compile(
            "org_test", name="x", eql_query="DROP TABLE x"
        )
        assert result["status"] == "not_implemented"

    async def test_compile_happy_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.dsl import AlertAsCode

        mock_postgres_client.execute = AsyncMock(return_value=None)
        result = await AlertAsCode().compile(
            "org_test",
            name="Test alert",
            eql_query=(
                "SELECT trace_id FROM telemetry_events "
                "WHERE org_id = 'org_test'"
            ),
            interval_seconds=3600,
            severity="warning",
        )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["alert_id"].startswith("eql_alert_")
        assert result["data"]["interval_seconds"] == 3600
        assert "next_fire_at" in result["data"]

    async def test_compile_with_warnings_fires_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.dsl import AlertAsCode

        mock_postgres_client.execute = AsyncMock(return_value=None)
        with patch(
            "eden.dsl.alerts._fire_dsl_alert_lint_warning_hook",
            new=AsyncMock(),
        ) as mock_hook:
            # NO_FILTERS will fire because there's no WHERE
            # on the original (before expansion adds one for
            # the org_id) — but the parser's MISSING_ORG
            # warning is filtered because the expansion adds
            # the filter. So we need to craft a query that
            # surfaces a warning after expansion.
            result = await AlertAsCode().compile(
                "org_test",
                name="Test with warnings",
                eql_query=(
                    "SELECT trace_id FROM telemetry_events "
                    "WHERE any.error IS NOT NULL "
                    "AND any.duration_ms > 100 "
                    "AND any.event_type = 'x' "
                    "AND org_id = 'org_test'"
                ),
            )
        assert result["status"] == "ok"
        # 3 any. references → ANY_SPAN_OVERUSE warning →
        # hook should fire.
        assert any(
            w["code"] == "ANY_SPAN_OVERUSE"
            for w in result["data"]["warnings"]
        )
        mock_hook.assert_awaited_once()

    async def test_list_alerts(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from datetime import datetime, timezone

        from eden.dsl import AlertAsCode

        mock_postgres_client.fetch = AsyncMock(
            return_value=[
                {
                    "alert_id": "eql_alert_aaa",
                    "name": "Test",
                    "shape": "traces",
                    "interval_seconds": 3600,
                    "severity": "warning",
                    "last_fired_at": None,
                    "next_fire_at": datetime(
                        2026, 6, 11, 12, 0, 0, tzinfo=UTC
                    ),
                    "enabled": True,
                    "lifecycle_status": "active",
                    "n_fired": 0,
                    "created_at": datetime(
                        2026, 6, 11, 11, 0, 0, tzinfo=UTC
                    ),
                }
            ]
        )
        result = await AlertAsCode().list_alerts("org_test")
        assert result["status"] == "ok"
        assert result["data"]["n_alerts"] == 1
        assert result["data"]["alerts"][0]["alert_id"] == "eql_alert_aaa"


# ─── Test class: package contract ─────────────────────────────


class TestPackageContract:
    """The package exposes the 4 services via lazy re-export."""

    def test_lazy_reexports_resolve(self) -> None:
        from eden import dsl

        assert isinstance(dsl.AlertAsCode, type)
        assert isinstance(dsl.EQLLinter, type)
        assert isinstance(dsl.EQLParser, type)
        assert isinstance(dsl.RelationalFieldResolver, type)

    def test_dir_shows_public_surface(self) -> None:
        from eden import dsl

        names = dir(dsl)
        assert "AlertAsCode" in names
        assert "EQLLinter" in names
        assert "EQLParser" in names
        assert "RelationalFieldResolver" in names

    def test_unknown_attribute_raises(self) -> None:
        from eden import dsl

        with pytest.raises(AttributeError):
            _ = dsl.NoSuchService


# ─── Test class: hook registration ────────────────────────────


class TestDSLHook:
    """The closed-loop DSLHook is registered as a singleton."""

    def test_singleton_is_registered(self) -> None:
        from eden.llmops.promotion_hooks import DSLHook, get_dsl_hook

        hook = get_dsl_hook()
        assert isinstance(hook, DSLHook)

    def test_on_alert_lint_warning_logs(self) -> None:
        from eden.llmops.promotion_hooks import get_dsl_hook

        # No-op in v1.3 — just confirm the call doesn't
        # raise.
        get_dsl_hook().on_alert_lint_warning(
            "org_test",
            alert_id="eql_alert_aaa",
            warning_codes=["NO_FILTERS", "MISSING_ORG"],
        )


# ─── Test class: route smoke tests ────────────────────────────


def _pg_router(mock_postgres_client: MagicMock) -> Any:
    """Build a FastAPI app with the DSL router mounted."""
    from eden.api.deps import get_current_user
    from eden.api.routes import intelligence_dsl

    app = FastAPI()
    app.include_router(intelligence_dsl.router)
    app.dependency_overrides[get_current_user] = lambda: {
        "user_id": "user_test"
    }
    return app


@pytest.fixture(scope="module")
def dsl_client() -> TestClient:
    """A TestClient with the intelligence_gap_v0 flag enabled."""
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    return TestClient(_pg_router(MagicMock()))


class TestDSLRoutes:
    """Route-level smoke tests for the 5 Cat 19 routes."""

    def test_parse_route(self, dsl_client: TestClient) -> None:
        resp = dsl_client.post(
            "/orgs/org_test/intelligence/dsl/parse",
            json={
                "query": (
                    "SELECT trace_id FROM telemetry_events "
                    "WHERE org_id = 'org_test'"
                ),
                "shape": "traces",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "EQLParser"
        assert "clickhouse_sql" in body["data"]

    def test_resolve_route(self, dsl_client: TestClient) -> None:
        resp = dsl_client.post(
            "/orgs/org_test/intelligence/dsl/resolve",
            json={
                "query": (
                    "SELECT trace_id FROM telemetry_events "
                    "WHERE root.event_type = 'agent.run' "
                    "AND org_id = 'org_test'"
                ),
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "RelationalFieldResolver"
        assert "expanded_query" in body["data"]

    def test_lint_route(self, dsl_client: TestClient) -> None:
        resp = dsl_client.post(
            "/orgs/org_test/intelligence/dsl/lint",
            json={
                "query": "SELECT * FROM telemetry_events",
                "shape": "traces",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "EQLLinter"
        codes = [w["code"] for w in body["data"]["warnings"]]
        assert "NO_FILTERS" in codes

    def test_alerts_compile_route(
        self, dsl_client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        mock_postgres_client.execute = AsyncMock(return_value=None)
        resp = dsl_client.post(
            "/orgs/org_test/intelligence/dsl/alerts/compile",
            json={
                "name": "Smoke test alert",
                "eql_query": (
                    "SELECT trace_id FROM telemetry_events "
                    "WHERE org_id = 'org_test'"
                ),
                "interval_seconds": 3600,
                "severity": "warning",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "AlertAsCode"
        assert body["data"]["alert_id"].startswith("eql_alert_")

    def test_alerts_list_route(
        self, dsl_client: TestClient, mock_postgres_client: MagicMock
    ) -> None:
        from datetime import datetime, timezone

        mock_postgres_client.fetch = AsyncMock(
            return_value=[
                {
                    "alert_id": "eql_alert_aaa",
                    "name": "Test",
                    "shape": "traces",
                    "interval_seconds": 3600,
                    "severity": "warning",
                    "last_fired_at": None,
                    "next_fire_at": datetime(
                        2026, 6, 11, 12, 0, 0, tzinfo=UTC
                    ),
                    "enabled": True,
                    "lifecycle_status": "active",
                    "n_fired": 0,
                    "created_at": datetime(
                        2026, 6, 11, 11, 0, 0, tzinfo=UTC
                    ),
                }
            ]
        )
        resp = dsl_client.get(
            "/orgs/org_test/intelligence/dsl/alerts"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "AlertAsCode"
        assert body["data"]["n_alerts"] == 1

    def test_parse_route_strict_mode_block(
        self, dsl_client: TestClient
    ) -> None:
        # NO_FILTERS → severity=error → strict blocks.
        resp = dsl_client.post(
            "/orgs/org_test/intelligence/dsl/parse",
            json={
                "query": "SELECT * FROM telemetry_events",
                "lint_mode": "strict",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "not_implemented"
        assert "strict" in body["message"]
