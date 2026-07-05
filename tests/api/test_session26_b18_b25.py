"""Session 26 tests — Backend correctness (B-18..B-25).

Eight audit items:

* **B-18** — UNIQUE constraints on agent_performance_snapshots,
  agent_relationships, agent_benchmark_runs; the
  ``_delete_then_insert_*`` helpers now use ``INSERT … ON
  CONFLICT DO UPDATE`` instead of ``DELETE + INSERT``.
* **B-19** — UNIQUE on ``user_behavioural_signals(org_id,
  trace_id)``; the ``_upsert_signal_row`` helper now uses
  ``ON CONFLICT DO UPDATE`` (the old DELETE+INSERT is gone).
* **B-20** — ``critical`` is now an allowed severity on
  ``PromotionHook.on_drift_alert`` (no longer silently
  downgraded to ``medium``).
* **B-21** — SSE emits ``event: error`` on Redis-down and
  closes cleanly (pre-fix emitted 2 keep-alive pings then
  closed, which clients interpreted as "healthy stream").
* **B-22** — SSE rejects ``last_event_id`` more than
  ``_MAX_REPLAY_GAP = 1000`` behind the server seq.
* **B-23** — ``_fire_fleet_drift_hook`` is now ``async def``
  + ``await`` from the caller (was: sync function returning
  a discarded coroutine).
* **B-24** — ``AgentBenchmarkRunner.run`` returns a
  ``synthetic: true`` disclaimer in BOTH the top-level
  envelope AND inside ``metrics`` (persists to
  ``agent_benchmark_runs.metrics_json``).
* **B-25** — ``WebhookDeliveryService`` shares a single
  ``httpx.AsyncClient`` + caps concurrent outbound POSTs
  with an ``asyncio.Semaphore(16)`` (was: each call site
  opened its own ``AsyncClient``).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import textwrap
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ─── Migration 075 (B-18/B-19 schema) ──────────────────────────


class TestMigration075:
    """Migration 075 (uniqueness_constraints) exists, is wired
    into the alembic chain after 074, declares the 4 unique
    constraints via an ``information_schema`` DO-block so it's
    idempotent against partial-replay environments, and de-dups
    each of the 4 tables before adding the constraint.
    """

    def test_migration_file_exists(self) -> None:
        from pathlib import Path

        path = (
            Path(__file__).parent.parent.parent
            / "src/eden/db_migrations/versions/075_uniqueness_constraints.py"
        )
        assert path.exists(), (
            f"B-18/B-19 regression: migration 075 not at {path}"
        )
        source = path.read_text()
        assert "075_uniqueness_constraints" in source, (
            "B-18/B-19 regression: revision constant missing"
        )
        assert 'down_revision = "074_hook_repetition_closed_loop"' in source, (
            "B-18/B-19 regression: down_revision should sit on 074"
        )

    def test_migration_adds_four_uniques(self) -> None:
        from pathlib import Path

        path = (
            Path(__file__).parent.parent.parent
            / "src/eden/db_migrations/versions/075_uniqueness_constraints.py"
        )
        source = path.read_text()
        # 4 tables must be referenced (in dedup SQL and the
        # constraint name).
        for name in (
            "agent_performance_snapshots",
            "agent_relationships",
            "agent_benchmark_runs",
            "user_behavioural_signals",
        ):
            assert name in source, (
                f"B-18/B-19 regression: 075 missing table {name}"
            )
        # 4 dedup CTEs (one DELETE FROM per table).
        assert source.count("DELETE FROM") == 4, (
            f"B-18/B-19 regression: expected 4 dedup DELETE statements, "
            f"got {source.count('DELETE FROM')}"
        )
        # 4 ``uq_<table>_tuple`` constraint names (one per table).
        for tbl in (
            "agent_performance_snapshots",
            "agent_relationships",
            "agent_benchmark_runs",
            "user_behavioural_signals",
        ):
            assert f"uq_{tbl}_tuple" in source, (
                f"B-18/B-19 regression: missing constraint for {tbl}"
            )
        # The idempotent guard (information_schema lookup) is
        # present so re-running the migration on a partially-
        # applied DB is safe.
        assert "information_schema.table_constraints" in source, (
            "B-18/B-19 regression: missing idempotency guard "
            "(information_schema.table_constraints lookup)"
        )


# ─── B-18: UPSERT instead of DELETE + INSERT (agent perf) ─────


class TestB18AgentUPSERT:
    """``_delete_then_insert_perf_snapshot`` now uses a single
    ``INSERT … ON CONFLICT DO UPDATE`` instead of the
    legacy DELETE + INSERT (race-prone, two-step transaction).
    """

    def test_perf_helper_uses_on_conflict(self) -> None:
        from eden.agents.agent_intel import _common

        source = textwrap.dedent(
            inspect.getsource(_common._delete_then_insert_perf_snapshot)
        )
        assert "ON CONFLICT (org_id, agent_id, window_name)" in source, (
            "B-18 regression: perf helper still using DELETE+INSERT; "
            "should be INSERT ON CONFLICT"
        )
        assert "DO UPDATE" in source, (
            "B-18 regression: perf helper missing DO UPDATE clause"
        )
        assert "DELETE FROM agent_performance_snapshots" not in source, (
            "B-18 regression: perf helper still has DELETE statement"
        )

    def test_relationships_helper_uses_on_conflict(self) -> None:
        from eden.agents.agent_intel import _common

        source = textwrap.dedent(
            inspect.getsource(_common._delete_then_insert_relationships)
        )
        assert (
            "ON CONFLICT (org_id, parent_agent_id, child_agent_id)" in source
        ), "B-18 regression: relationships missing ON CONFLICT tuple"
        assert "DELETE FROM agent_relationships" not in source, (
            "B-18 regression: relationships still has DELETE-first"
        )

    def test_benchmark_helper_uses_on_conflict(self) -> None:
        from eden.agents.agent_intel import _common

        source = textwrap.dedent(
            inspect.getsource(_common._delete_then_insert_benchmark_run)
        )
        assert (
            "ON CONFLICT (org_id, agent_id, dataset_id)" in source
        ), "B-18 regression: benchmark missing ON CONFLICT tuple"
        assert "DELETE FROM agent_benchmark_runs" not in source, (
            "B-18 regression: benchmark still has DELETE-first"
        )


# ─── B-19: UPSERT user_behavioural_signals ───────────────────────


class TestB19BehaviouralUPSERT:
    """``_upsert_signal_row`` no longer DELETEs first; a single
    ``INSERT … ON CONFLICT DO UPDATE`` against the
    ``user_behavioural_signals`` UNIQUE tuple replaces the race-
    prone legacy pattern.
    """

    def test_uses_on_conflict_no_delete(self) -> None:
        from eden.services.user_intel import behavioural

        source = textwrap.dedent(
            inspect.getsource(behavioural._upsert_signal_row)
        )
        assert "ON CONFLICT (org_id, trace_id)" in source, (
            "B-19 regression: missing ON CONFLICT tuple "
            "(org_id, trace_id)"
        )
        assert "DO UPDATE SET" in source, (
            "B-19 regression: missing DO UPDATE clause"
        )
        assert "DELETE FROM user_behavioural_signals" not in source, (
            "B-19 regression: DELETE statement still present"
        )


# ─── B-20: critical severity permitted ───────────────────────────


class TestB20CriticalSeverity:
    """``critical`` is now an allowed severity on
    ``PromotionHook.on_drift_alert``. Pre-fix the
    ``allowed-in {"high", "medium", "low"}`` whitelist
    silently downgraded critical to medium.
    """

    def test_critical_in_allowed_set(self) -> None:
        from eden.llmops import promotion_hooks

        source = textwrap.dedent(
            inspect.getsource(promotion_hooks.PromotionHook.on_drift_alert)
        )
        assert '"critical"' in source, (
            "B-20 regression: critical severity not in allowed whitelist"
        )

    def test_critical_passes_through(self) -> None:
        """A call with ``severity='critical'`` is recorded as
        critical (not silently rewritten to medium)."""
        from eden.llmops import promotion_hooks

        recorded: dict[str, str] = {}

        async def _fake_record_action(*args, **kwargs):
            # ``_record_action(org_id, *, hook_name, ... severity)``
            # — severity comes in as a kwarg per the audit
            # signature, so we read it from kwargs.
            recorded["severity"] = kwargs.get("severity", "?")
            return "act_test"

        with patch.object(
            promotion_hooks,
            "_record_action",
            side_effect=_fake_record_action,
        ):
            asyncio.new_event_loop().run_until_complete(
                promotion_hooks.PromotionHook().on_drift_alert(
                    "org_test",
                    drift_type="regression",
                    severity="critical",
                )
            )
            asyncio.new_event_loop().close()
        assert recorded["severity"] == "critical", (
            f"B-20 regression: critical was silently downgraded to "
            f"{recorded['severity']!r}"
        )


# ─── B-21: SSE error event on Redis-down ─────────────────────────


class TestB21SseRedisDown:
    """When Redis is unavailable the SSE generator emits a single
    ``event: error`` payload (code=redis_unavailable) and exits
    without the 2 keep-alive pings the audit hard-flagged.
    """

    @pytest.mark.asyncio
    async def test_yields_single_error_event(self) -> None:
        from eden.api.routes import observability_stream

        # Patch the *imported* reference inside observability_stream
        # (the source-side patch on eden.storage.redis.get_redis_client
        # doesn't propagate to a ``from foo import X`` binding).
        with patch.object(
            observability_stream,
            "get_redis_client",
            new=AsyncMock(return_value=None),
        ):
            out = []
            async for chunk in observability_stream._event_stream(
                "org_test", None
            ):
                out.append(chunk)
        assert len(out) == 1, (
            f"B-21 regression: expected 1 SSE event, got {len(out)} "
            f"(pre-fix looped 2 pings then closed)"
        )
        body = out[0].decode("utf-8")
        assert body.startswith("event: error\n"), (
            f"B-21 regression: expected event: error, got {body!r}"
        )
        payload = json.loads(body.split("data: ", 1)[1].split("\n")[0])
        assert payload["code"] == "redis_unavailable", (
            f"B-21 regression: wrong error code {payload!r}"
        )


# ─── B-22: bound last_event_id to recent window ─────────────────


class TestB22LastEventIdBound:
    """``_event_stream`` rejects ``last_event_id`` more than
    ``_MAX_REPLAY_GAP = 1000`` behind the server's current
    seq with a single ``event: error`` carrying
    ``code=last_event_id_too_old``.
    """

    def test_max_replay_gap_constant(self) -> None:
        from eden.api.routes import observability_stream

        assert hasattr(observability_stream, "_MAX_REPLAY_GAP"), (
            "B-22 regression: _MAX_REPLAY_GAP constant missing"
        )
        assert observability_stream._MAX_REPLAY_GAP == 1000, (
            "B-22 regression: _MAX_REPLAY_GAP must be 1000 "
            "(matches the ZSET replay cap)"
        )

    @pytest.mark.asyncio
    async def test_stale_last_event_id_returns_error_event(self) -> None:
        from eden.api.routes import observability_stream

        # Build a fake redis: GET returns a high seq ("current = 5000"),
        # so a requested seq of 3000 is 2000 behind (over 1000 gap).
        fake_redis = MagicMock()
        fake_redis.pubsub.return_value = AsyncMock()
        fake_redis.get = AsyncMock(return_value="5000")
        fake_redis.zrangebyscore = AsyncMock(return_value=[])

        async def _fake_get_redis_client():
            return fake_redis

        # Patch on the imported reference (same reason as B-21).
        with patch.object(
            observability_stream,
            "get_redis_client",
            new=_fake_get_redis_client,
        ):
            out = []
            async for chunk in observability_stream._event_stream(
                "org_test", "3000"
            ):
                out.append(chunk)
        assert any(
            b"event: error" in chunk and b"last_event_id_too_old" in chunk
            for chunk in out
        ), (
            "B-22 regression: stale last_event_id did NOT return the "
            "last_event_id_too_old error event"
        )


# ─── B-23: _fire_fleet_drift_hook is async ───────────────────────


class TestB23FleetHookAsync:
    """``_fire_fleet_drift_hook`` is now ``async def`` and the
    caller (``AgentFleetService.register_agent_identity``)
    awaits it. Pre-fix the helper was sync and returned a
    discarded coroutine.
    """

    def test_helper_is_coroutine(self) -> None:
        from eden.agents.agent_intel import _common

        assert inspect.iscoroutinefunction(
            _common._fire_fleet_drift_hook
        ), (
            "B-23 regression: _fire_fleet_drift_hook must be async"
        )

    def test_caller_awaits_helper(self) -> None:
        """``AgentFleetService.register_agent_identity`` must
        ``await`` the helper (the previous sync call returned
        a stray coroutine that the GC discarded)."""
        from eden.agents.agent_intel import performance

        source = textwrap.dedent(
            inspect.getsource(
                performance.AgentFleetService.register_agent_identity
            )
        )
        assert "await _fire_fleet_drift_hook" in source, (
            "B-23 regression: register_agent_identity must "
            "``await _fire_fleet_drift_hook``"
        )


# ─── B-24: synthetic:true disclaimer in benchmark response ──────


class TestB24SyntheticDisclaimer:
    """``AgentBenchmarkRunner.run`` returns ``synthetic: True``
    both at the top level AND inside the ``metrics`` dict
    (the latter persists to ``agent_benchmark_runs``).
    """

    @pytest.mark.asyncio
    async def test_synthetic_true_in_response_and_metrics(self) -> None:
        from eden.agents.agent_intel.performance import (
            AgentBenchmarkRunner,
        )

        pg = MagicMock()
        pg.fetch = AsyncMock(return_value=[])
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=pg),
        ), patch(
            "eden.agents.agent_intel.performance._delete_then_insert_benchmark_run",
            new=AsyncMock(),
        ) as persist:
            # ``dataset_id`` is keyword-only on ``.run``.
            # Use the built-in ``synthetic_default`` benchmark
            # so the validator accepts it (the audit ships a
            # closed set of valid names; an unknown name
            # short-circuits before the metrics path).
            result = await AgentBenchmarkRunner().run(
                "org_test",
                "agent_a",
                dataset_id="synthetic_default",
            )
        d = result["data"]
        assert d.get("synthetic") is True, (
            "B-24 regression: top-level response missing synthetic: True"
        )
        assert d["metrics"].get("synthetic") is True, (
            "B-24 regression: metrics missing synthetic: True "
            "(would be persisted without the flag)"
        )
        # The persisted metrics_json must carry the flag too.
        # ``json.dumps`` adds a space after each colon by default,
        # so accept either format.
        written = persist.await_args.kwargs["metrics_json"]
        assert (
            "\"synthetic\":true" in written
            or "\"synthetic\": true" in written
        ), (
            "B-24 regression: persisted metrics_json missing "
            "synthetic flag"
        )


# ─── B-25: shared httpx.AsyncClient + Semaphore ─────────────────


class TestB25SharedHttpClient:
    """``WebhookDeliveryService`` owns a single
    ``httpx.AsyncClient`` + a concurrency ``Semaphore(16)``.
    Both call sites that used to instantiate their own
    ``AsyncClient(timeout=30.0)`` now go through
    ``_ensure_http_client``.
    """

    def test_module_has_singleton_and_semaphore_constants(self) -> None:
        from eden.services import webhook_delivery

        assert hasattr(webhook_delivery.WebhookDeliveryService, "_HTTP_CONCURRENCY"), (
            "B-25 regression: missing _HTTP_CONCURRENCY constant"
        )
        assert webhook_delivery.WebhookDeliveryService._HTTP_CONCURRENCY == 16, (
            "B-25 regression: _HTTP_CONCURRENCY must be 16 "
            "(matches httpx default pool)"
        )

    def test_ensure_helper_exists(self) -> None:
        from eden.services.webhook_delivery import WebhookDeliveryService

        assert hasattr(WebhookDeliveryService, "_ensure_http_client"), (
            "B-25 regression: missing _ensure_http_client helper"
        )

    @pytest.mark.asyncio
    async def test_attempt_delivery_uses_shared_client(self) -> None:
        """``_attempt_delivery`` no longer constructs a fresh
        ``httpx.AsyncClient(timeout=30.0)`` inline — it goes
        through the lazy shared ``_ensure_http_client`` path."""
        from eden.services import webhook_delivery

        source = textwrap.dedent(
            inspect.getsource(webhook_delivery.WebhookDeliveryService._attempt_delivery)
        )
        assert "self._ensure_http_client()" in source, (
            "B-25 regression: _attempt_delivery must call "
            "_ensure_http_client() (not instantiating its own AsyncClient)"
        )
        # The literal ``httpx.AsyncClient(timeout=30.0) as http:`` from
        # the pre-fix code must be gone (it's only inside
        # _ensure_http_client now).
        assert "httpx.AsyncClient(timeout=30.0) as http" not in source, (
            "B-25 regression: _attempt_delivery still has the "
            "inline AsyncClient creation"
        )

    @pytest.mark.asyncio
    async def test_semaphore_acquired_around_request(self) -> None:
        """``_attempt_delivery`` acquires the concurrency
        semaphore around the HTTP POST — so a burst caps at
        16 concurrent sockets."""
        from eden.services.webhook_delivery import WebhookDeliveryService

        service = WebhookDeliveryService()
        fake_http = MagicMock()
        fake_http.post = AsyncMock(
            return_value=MagicMock(
                status_code=200, text="ok", headers={}
            )
        )

        sem_acquired = 0

        @asynccontextmanager
        async def _fake_sem_ctx():
            nonlocal sem_acquired
            sem_acquired += 1
            yield

        async def _ensure():
            return fake_http, _fake_sem_ctx()

        service._ensure_http_client = _ensure  # type: ignore[assignment]

        async def _fake_postgres():
            client = MagicMock()
            client.fetchrow = AsyncMock(
                return_value={"attempt_count": 0, "max_attempts": 3,
                              "webhook_id": "wh_test"}
            )
            client.execute = AsyncMock()
            return client

        # Patch on the imported binding inside the
        # ``webhook_delivery`` module (the ``from foo import X``
        # binding means patching the source ``foo.X`` doesn't
        # propagate).
        from eden.services import webhook_delivery as _wd

        with patch.object(
            _wd,
            "get_postgres_client",
            new=_fake_postgres,
        ), patch.object(
            _wd,
            "_assert_public_ip",
            return_value=None,
        ):
            await service._attempt_delivery(
                delivery_id="d_test",
                url="https://example.com/hook",
                secret="secret",
                payload={"event": "test"},
            )
        # The POST went through the shared fake_http.
        fake_http.post.assert_awaited_once()
        # The semaphore was acquired around the POST.
        assert sem_acquired == 1, (
            f"B-25 regression: expected 1 semaphore acquire, got "
            f"{sem_acquired}"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
