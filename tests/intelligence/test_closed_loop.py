"""Behavioural tests for Cat 17 — Closed-Loop Wiring.

Exercises the wired hooks + the :class:`ClosedLoopExecutor`:

* **Hook service-level tests** — call the hook classes
  directly. The :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns a no-op Postgres client by
  default. Tests that need to assert on the recorded action
  override the mock with a side-effect that captures the
  SQL the hook ran.

* **Executor service-level tests** — exercise
  :meth:`list_pending`, :meth:`approve`, :meth:`deny`,
  :meth:`apply_approved`, :meth:`dashboard` end-to-end.

* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_closed_loop`` router mounted
  and ``get_current_user`` overridden. We hit each of the
  6 Cat 17 routes and assert the response shape.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Hook tests ───────────────────────────────────────────────────


class TestPromotionHook:
    async def test_on_judge_regression_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import PromotionHook

        captured: list[dict[str, Any]] = []

        async def _capture(query, *args):
            captured.append({"query": query, "args": args})
            return "INSERT 0 1"

        client = MagicMock()
        client.execute = AsyncMock(side_effect=_capture)
        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=lambda org_id, **kw: (
                captured.append({"org_id": org_id, **kw}) or "aid-1"
            )),
        ):
            action_id = await PromotionHook().on_judge_regression(
                "org_t",
                judge_name="hallucination_v2",
                trace_id="trace-1",
                score=0.3,
            )
        assert action_id == "aid-1"
        assert captured[0]["org_id"] == "org_t"
        assert captured[0]["action_kind"] == "block_promotion"
        assert captured[0]["target"] == "hallucination_v2"
        assert captured[0]["severity"] == "high"  # score < 0.4

    async def test_on_judge_regression_medium_severity(self) -> None:
        from eden.llmops.promotion_hooks import PromotionHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await PromotionHook().on_judge_regression(
                "org_t", judge_name="j1", trace_id="t1", score=0.5
            )
        # score 0.5 is medium (>= 0.4, < some implicit upper)
        assert captured["severity"] == "medium"

    async def test_on_judge_improvement_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import PromotionHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await PromotionHook().on_judge_improvement(
                "org_t", judge_name="j1", trace_id="t1", score=0.9
            )
        assert captured["action_kind"] == "bump_canary"
        assert captured["severity"] == "low"

    async def test_on_drift_alert_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import PromotionHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await PromotionHook().on_drift_alert(
                "org_t", drift_type="judge_distribution", severity="high"
            )
        assert captured["action_kind"] == "rollback_canary"
        assert captured["target"] == "judge_distribution"
        assert captured["severity"] == "high"

    async def test_on_drift_alert_normalizes_severity(self) -> None:
        from eden.llmops.promotion_hooks import PromotionHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await PromotionHook().on_drift_alert(
                "org_t", drift_type="d1", severity="critical"
            )
        # "critical" is not in (high, medium, low) so it
        # normalises to "medium"
        assert captured["severity"] == "medium"


class TestGuardrailHook:
    async def test_on_judge_threshold_breach_creates_link(
        self,
    ) -> None:
        from eden.llmops.promotion_hooks import GuardrailHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ), patch(
            "eden.guardrails.EvalToGuardrailLink.promote",
            AsyncMock(return_value={"status": "ok", "data": {"id": "p1"}}),
        ):
            await GuardrailHook().on_judge_threshold_breach(
                "org_t", judge_name="j1", threshold=0.6
            )
        assert captured["action_kind"] == "promote_judge"
        assert captured["target"] == "j1"
        assert captured["severity"] == "high"

    async def test_on_judge_below_floor_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import GuardrailHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await GuardrailHook().on_judge_below_floor(
                "org_t", judge_name="j1"
            )
        assert captured["action_kind"] == "disable_guardrail"
        assert captured["severity"] == "medium"


class TestExperimentHook:
    async def test_on_winner_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import ExperimentHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await ExperimentHook().on_winner(
                "org_t",
                experiment_id="exp_abc",
                winner_variant="variant_b",
            )
        assert captured["action_kind"] == "archive_variant"
        assert captured["target"] == "exp_abc"


class TestMetricStudioHook:
    async def test_on_metric_promotion_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import MetricStudioHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await MetricStudioHook().on_metric_promotion(
                "org_t",
                metric_id="metric_abc",
                judge_name="custom_metric_abc",
            )
        assert captured["action_kind"] == "register_regression_watch"
        assert captured["target"] == "metric_abc"


class TestColumnarHook:
    async def test_on_compaction_drift_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import ColumnarHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await ColumnarHook().on_compaction_drift(
                "org_t",
                partition_id="eden.org_abc.2026_06",
                reason="sla_breach",
                severity="high",
            )
        assert captured["action_kind"] == "pause_rollup_scheduler"
        assert captured["target"] == "eden.org_abc.2026_06"
        assert captured["severity"] == "high"


class TestDSLHook:
    async def test_on_alert_lint_warning_persists_action(self) -> None:
        from eden.llmops.promotion_hooks import DSLHook

        captured: dict[str, Any] = {}

        async def _capture(org_id, **kw):
            captured.update(kw)
            return "aid-1"

        with patch(
            "eden.llmops.promotion_hooks._record_action",
            AsyncMock(side_effect=_capture),
        ):
            await DSLHook().on_alert_lint_warning(
                "org_t",
                alert_id="eql_alert_abc",
                warning_codes=["NO_FILTERS", "ANY_SPAN_OVERUSE"],
            )
        assert captured["action_kind"] == "surface_lint_warning"
        assert captured["target"] == "eql_alert_abc"
        assert captured["payload"]["warning_codes"] == [
            "NO_FILTERS", "ANY_SPAN_OVERUSE"
        ]


# ─── Executor tests ───────────────────────────────────────────────


class TestClosedLoopExecutor:
    async def test_list_pending(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(
                return_value=[
                    {
                        "id": "a1",
                        "hook_name": "promotion_hook",
                        "action_kind": "block_promotion",
                        "target": "judge_x",
                        "severity": "high",
                        "status": "pending_approval",
                        "payload": {},
                    }
                ]
            ),
        ):
            r = await ClosedLoopExecutor().list_pending("org_t")
        assert r["data"]["count"] == 1
        assert r["data"]["actions"][0]["action_kind"] == "block_promotion"

    async def test_list_all(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(return_value=[]),
        ):
            r = await ClosedLoopExecutor().list_all("org_t")
        assert r["data"]["count"] == 0

    async def test_approve_flips_status(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ) as update_mock:
            r = await ClosedLoopExecutor().approve(
                "org_t", action_id="a1", applied_by="alice"
            )
        assert r["data"]["status"] == "approved"
        # Verify the SQL was called with the right status
        update_mock.assert_called_once()
        assert update_mock.call_args.kwargs["new_status"] == "approved"
        assert update_mock.call_args.kwargs["applied_by"] == "alice"

    async def test_deny_flips_status(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ) as update_mock:
            r = await ClosedLoopExecutor().deny(
                "org_t", action_id="a1", applied_by="alice"
            )
        assert r["data"]["status"] == "denied"
        assert update_mock.call_args.kwargs["new_status"] == "denied"

    async def test_approve_rejects_empty_action_id(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        r = await ClosedLoopExecutor().approve("org_t", action_id="")
        assert r["status"] == "not_implemented"

    async def test_approve_handles_db_error(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=False),
        ):
            r = await ClosedLoopExecutor().approve(
                "org_t", action_id="a1"
            )
        assert r["status"] == "not_implemented"

    async def test_apply_approved_v0_noop(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(
                return_value=[
                    {
                        "id": "a1",
                        "action_kind": "block_promotion",
                        "status": "approved",
                    }
                ]
            ),
        ), patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ):
            r = await ClosedLoopExecutor().apply_approved(
                "org_t", action_id="a1", applied_by="alice"
            )
        assert r["data"]["status"] == "applied"
        assert r["data"]["side_effect"] == "v0_noop"
        assert r["data"]["action_kind"] == "block_promotion"

    async def test_apply_approved_handles_unknown_action(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(return_value=[]),
        ), patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ):
            r = await ClosedLoopExecutor().apply_approved(
                "org_t", action_id="unknown", applied_by="alice"
            )
        # Even with no matching row, the status flips to applied
        # (the v0 ship is best-effort)
        assert r["data"]["action_kind"] == "unknown"

    async def test_dashboard_aggregates(self) -> None:
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(
                return_value=[
                    {
                        "action_kind": "block_promotion",
                        "status": "pending_approval",
                        "severity": "high",
                    },
                    {
                        "action_kind": "block_promotion",
                        "status": "applied",
                        "severity": "high",
                    },
                    {
                        "action_kind": "rollback_canary",
                        "status": "pending_approval",
                        "severity": "medium",
                    },
                ]
            ),
        ):
            r = await ClosedLoopExecutor().dashboard("org_t")
        d = r["data"]
        assert d["total"] == 3
        assert d["by_kind"]["block_promotion"] == 2
        assert d["by_kind"]["rollback_canary"] == 1
        assert d["by_status"]["pending_approval"] == 2
        assert d["by_status"]["applied"] == 1
        assert d["by_severity"]["high"] == 2
        assert d["by_severity"]["medium"] == 1


# ─── Route tests ──────────────────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def closed_loop_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member
    from eden.api.routes.intelligence_closed_loop import router
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-closed-loop-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    app.include_router(router)
    return app


class TestClosedLoopRoutes:
    def test_list_pending_route(self, closed_loop_app: FastAPI) -> None:
        client = TestClient(closed_loop_app)
        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(return_value=[]),
        ):
            r = client.get(
                "/orgs/org_test/intelligence/closed-loop/actions"
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["count"] == 0

    def test_list_all_route(self, closed_loop_app: FastAPI) -> None:
        client = TestClient(closed_loop_app)
        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(return_value=[]),
        ):
            r = client.get(
                "/orgs/org_test/intelligence/closed-loop/actions/all"
            )
        assert r.status_code == 200

    def test_approve_route(self, closed_loop_app: FastAPI) -> None:
        client = TestClient(closed_loop_app)
        with patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ):
            r = client.post(
                "/orgs/org_test/intelligence/closed-loop/actions/a1/approve",
                params={"applied_by": "alice"},
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["status"] == "approved"

    def test_deny_route(self, closed_loop_app: FastAPI) -> None:
        client = TestClient(closed_loop_app)
        with patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ):
            r = client.post(
                "/orgs/org_test/intelligence/closed-loop/actions/a1/deny",
                params={"applied_by": "bob"},
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["status"] == "denied"

    def test_apply_route(self, closed_loop_app: FastAPI) -> None:
        client = TestClient(closed_loop_app)
        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(
                return_value=[
                    {"id": "a1", "action_kind": "block_promotion"}
                ]
            ),
        ), patch(
            "eden.llmops.closed_loop_executor._update_status",
            AsyncMock(return_value=True),
        ):
            r = client.post(
                "/orgs/org_test/intelligence/closed-loop/actions/a1/apply"
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["status"] == "applied"

    def test_dashboard_route(self, closed_loop_app: FastAPI) -> None:
        client = TestClient(closed_loop_app)
        with patch(
            "eden.llmops.closed_loop_executor._fetch_actions",
            AsyncMock(return_value=[]),
        ):
            r = client.get(
                "/orgs/org_test/intelligence/closed-loop/dashboard"
            )
        assert r.status_code == 200
        body = r.json()
        assert "by_kind" in body["data"]
        assert "by_status" in body["data"]
        assert "by_severity" in body["data"]


# ─── Singleton / wiring tests ─────────────────────────────────────


class TestWiring:
    def test_get_singletons(self) -> None:
        from eden.llmops.promotion_hooks import (
            get_columnar_hook,
            get_dsl_hook,
            get_experiment_hook,
            get_guardrail_hook,
            get_metric_studio_hook,
            get_promotion_hook,
        )

        # All return the same singleton instance
        assert get_promotion_hook() is get_promotion_hook()
        assert get_guardrail_hook() is get_guardrail_hook()
        assert get_experiment_hook() is get_experiment_hook()
        assert get_metric_studio_hook() is get_metric_studio_hook()
        assert get_columnar_hook() is get_columnar_hook()
        assert get_dsl_hook() is get_dsl_hook()

    def test_register_all_hooks_logs(self) -> None:
        from eden.llmops.promotion_hooks import register_all_hooks

        # Just exercise the lifespan call to make sure it
        # doesn't raise. Logs are checked at the logger
        # level — we just call it.
        register_all_hooks()
