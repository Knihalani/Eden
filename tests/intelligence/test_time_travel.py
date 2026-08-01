"""Behavioural tests for Cat 20 — Time-Travel Debugging (v1.3).

Exercises the four real services
(:class:`TraceRecorder`, :class:`TraceForker`,
:class:`TraceReplayer`, :class:`ReplayDiff`) and the four
routes that expose them.

Mirrors the structure of
:mod:`tests.intelligence.test_dsl` and
:mod:`tests.intelligence.test_columnar_engine`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. Tests that need
  data override the mock with a side-effect that matches
  the SQL fragment the service runs.
* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_time_travel`` router
  mounted and ``get_current_user`` overridden. We hit
  each of the 4 Cat 20 routes and assert the response
  shape.
"""

from __future__ import annotations

from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Test class: TraceRecorder ───────────────────────────────


class TestTraceRecorder:
    """Service-level tests for the recorder."""

    async def test_temperature_zero_is_cacheable(self) -> None:
        from eden.time_travel import TraceRecorder

        rec = TraceRecorder()
        result = await rec.record_step(
            "org_test",
            trace_id="trc_abc",
            step_index=1,
            request={"model": "gpt-4o"},
            response={"response_hash": "hash_abc"},
            temperature=0.0,
        )
        assert result["cacheable"] is True
        assert result["cache_key"] is not None
        assert "trc_abc" in result["cache_key"]
        assert "1" in result["cache_key"]

    async def test_seed_set_is_cacheable(self) -> None:
        from eden.time_travel import TraceRecorder

        rec = TraceRecorder()
        result = await rec.record_step(
            "org_test",
            trace_id="trc_abc",
            step_index=2,
            request={"model": "gpt-4o"},
            response={"response_hash": "hash_def"},
            seed=42,
        )
        assert result["cacheable"] is True
        assert result["cache_key"] is not None

    async def test_cache_mode_always_is_cacheable(self) -> None:
        from eden.time_travel import TraceRecorder

        rec = TraceRecorder()
        result = await rec.record_step(
            "org_test",
            trace_id="trc_abc",
            step_index=3,
            request={"model": "gpt-4o"},
            response={"response_hash": "hash_ghi"},
            cache_mode="always",
        )
        assert result["cacheable"] is True

    async def test_nonzero_temp_no_seed_is_not_cacheable(self) -> None:
        from eden.time_travel import TraceRecorder

        rec = TraceRecorder()
        result = await rec.record_step(
            "org_test",
            trace_id="trc_abc",
            step_index=4,
            request={"model": "gpt-4o"},
            response={"response_hash": "hash_jkl"},
            temperature=0.7,
        )
        assert result["cacheable"] is False
        assert result["cache_key"] is None

    async def test_no_temp_no_seed_not_cacheable(self) -> None:
        from eden.time_travel import TraceRecorder

        rec = TraceRecorder()
        result = await rec.record_step(
            "org_test",
            trace_id="trc_abc",
            step_index=5,
            request={"model": "gpt-4o"},
            response={"response_hash": "hash_mno"},
        )
        assert result["cacheable"] is False


# ─── Test class: TraceForker ─────────────────────────────────


class TestTraceForker:
    """Service-level tests for the forker."""

    async def test_empty_parent_trace_id(self) -> None:
        from eden.time_travel import TraceForker

        result = await TraceForker().fork(
            "org_test",
            parent_trace_id="",
            fork_at_step=0,
            name="x",
        )
        assert result["status"] == "not_implemented"
        assert "parent_trace_id" in result["message"]

    async def test_negative_fork_at_step(self) -> None:
        from eden.time_travel import TraceForker

        result = await TraceForker().fork(
            "org_test",
            parent_trace_id="trc_abc",
            fork_at_step=-1,
            name="x",
        )
        assert result["status"] == "not_implemented"
        assert "non-negative" in result["message"]

    async def test_empty_name(self) -> None:
        from eden.time_travel import TraceForker

        result = await TraceForker().fork(
            "org_test",
            parent_trace_id="trc_abc",
            fork_at_step=0,
            name="",
        )
        assert result["status"] == "not_implemented"
        assert "name" in result["message"]

    async def test_fork_happy_path_no_parent_steps(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceForker

        # The parent has no agent.step events — the
        # forker still creates the fork metadata; the
        # replayer will re-execute everything live.
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        mock_postgres_client.execute = AsyncMock(return_value=None)
        result = await TraceForker().fork(
            "org_test",
            parent_trace_id="trc_abc",
            fork_at_step=5,
            name="Try new system prompt",
        )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["fork_id"].startswith("frk_")
        assert result["data"]["parent_trace_id"] == "trc_abc"
        assert result["data"]["fork_at_step"] == 5
        assert result["data"]["n_parent_steps"] == 0
        assert result["data"]["has_cacheable_steps"] is False

    async def test_fork_happy_path_with_parent_steps(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceForker

        mock_postgres_client.fetch = AsyncMock(
            return_value=[
                {
                    "event_id": "ev_1",
                    "trace_id": "trc_abc",
                    "span_id": "s1",
                    "name": "agent.step",
                    "payload": {"step_index": 0},
                    "attributes": {"cacheable": True},
                    "response_hash": "h1",
                    "duration_ms": 100.0,
                    "timestamp": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
                },
                {
                    "event_id": "ev_2",
                    "trace_id": "trc_abc",
                    "span_id": "s2",
                    "name": "agent.step",
                    "payload": {"step_index": 1},
                    "attributes": {"cacheable": True},
                    "response_hash": "h2",
                    "duration_ms": 150.0,
                    "timestamp": datetime(2026, 6, 11, 10, 0, 1, tzinfo=UTC),
                },
            ]
        )
        mock_postgres_client.execute = AsyncMock(return_value=None)
        result = await TraceForker().fork(
            "org_test",
            parent_trace_id="trc_abc",
            fork_at_step=1,
            name="Try new system prompt",
        )
        assert result["status"] == "ok"
        assert result["data"]["n_parent_steps"] == 2
        assert result["data"]["has_cacheable_steps"] is True


# ─── Test class: TraceReplayer ───────────────────────────────


class TestTraceReplayer:
    """Service-level tests for the replayer."""

    async def test_empty_fork_id(self) -> None:
        from eden.time_travel import TraceReplayer

        result = await TraceReplayer().replay_from("org_test", fork_id="", edits={})
        assert result["status"] == "not_implemented"
        assert "fork_id" in result["message"]

    async def test_invalid_edits_key(self) -> None:
        from eden.time_travel import TraceReplayer

        fork = {
            "fork_id": "frk_abc",
            "org_id": "org_test",
            "parent_trace_id": "tr_1",
            "fork_at_step": 0,
            "edits_json": {},
        }
        with patch(
            "eden.time_travel.replayer._get_fork_branch",
            new=AsyncMock(return_value=fork),
        ):
            result = await TraceReplayer().replay_from(
                "org_test",
                fork_id="frk_abc",
                edits={"not_a_step_key": "x"},
            )
        assert result["status"] == "not_implemented"
        assert "invalid edit key" in result["message"]

    async def test_fork_not_found(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceReplayer

        mock_postgres_client.fetchrow = AsyncMock(return_value=None)
        result = await TraceReplayer().replay_from("org_test", fork_id="frk_missing", edits={})
        assert result["status"] == "not_implemented"
        assert "not found" in result["message"]

    async def test_replay_with_cache_hit(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceReplayer

        # _try_cache_lookup uses fetchrow. The first
        # call returns the fork row; subsequent calls
        # return the cache hit row.
        cache_hit = {
            "tokens_used": 100,
            "cost_usd": 0.001,
        }
        mock_postgres_client.fetchrow = AsyncMock(
            side_effect=[
                # First: _get_fork_branch.
                {
                    "fork_id": "frk_abc",
                    "parent_trace_id": "trc_abc",
                    "parent_fork_id": None,
                    "fork_at_step": 2,
                    "name": "Test",
                    "edits_json": "{}",
                    "n_replays": 0,
                    "last_replay_outcome": None,
                    "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
                },
                # Then: cache hits for steps 0 and 1.
                cache_hit,
                cache_hit,
            ]
        )
        # _get_parent_steps: 3 agent.step events with prompt content.
        parent_rows = [
            {
                "event_id": f"ev_{i}",
                "trace_id": "trc_abc",
                "span_id": f"s{i}",
                "name": "agent.step",
                "payload": {
                    "step_index": i,
                    "request": {
                        "model": "openai/gpt-test",
                        "prompt": f"prompt step {i}",
                    },
                    "response": {"response_hash": f"hash_{i}", "tokens_used": 10},
                },
                "attributes": {"cacheable": True, "response_hash": f"hash_{i}"},
                "response_hash": f"hash_{i}",
                "duration_ms": 100.0,
                "timestamp": datetime(2026, 6, 11, 10, 0, i, tzinfo=UTC),
            }
            for i in range(3)
        ]
        mock_postgres_client.fetch = AsyncMock(return_value=parent_rows)
        mock_postgres_client.execute = AsyncMock(return_value=None)

        class _Resp:
            text = "live replay output"
            input_tokens = 2
            output_tokens = 3
            cost_usd = 0.002

        gw = MagicMock()
        gw.complete = AsyncMock(return_value=_Resp())

        with patch("eden.api.routes.gateway.get_ai_gateway", return_value=gw):
            result = await TraceReplayer().replay_from(
                "org_test", fork_id="frk_abc", edits={}
            )
        assert result["status"] == "ok"
        assert result["data"]["replay_id"].startswith("rpl_")
        # Steps 0 and 1 should be served from cache
        # (fork_at_step=2).
        assert 0 in result["data"]["served_from_cache"]
        assert 1 in result["data"]["served_from_cache"]
        # Step 2 is the fork step — re-executed live.
        assert 2 in result["data"]["re_executed"]
        # No cache-miss warnings (the cache_lookups
        # side-effect returned a row every time).
        assert result["data"]["cache_miss_warnings"] == []
        gw.complete.assert_awaited()

    async def test_replay_with_cache_miss_warning(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceReplayer

        # First fetchrow: fork row. Subsequent:
        # None (cache miss).
        mock_postgres_client.fetchrow = AsyncMock(
            side_effect=[
                {
                    "fork_id": "frk_abc",
                    "parent_trace_id": "trc_abc",
                    "parent_fork_id": None,
                    "fork_at_step": 2,
                    "name": "Test",
                    "edits_json": "{}",
                    "n_replays": 0,
                    "last_replay_outcome": None,
                    "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
                },
                None,  # cache miss for step 0
                None,  # cache miss for step 1
            ]
        )
        parent_rows = [
            {
                "event_id": f"ev_{i}",
                "trace_id": "trc_abc",
                "span_id": f"s{i}",
                "name": "agent.step",
                "payload": {"step_index": i},
                "attributes": {"cacheable": True},
                "response_hash": f"hash_{i}",
                "duration_ms": 100.0,
                "timestamp": datetime(2026, 6, 11, 10, 0, i, tzinfo=UTC),
            }
            for i in range(3)
        ]
        mock_postgres_client.fetch = AsyncMock(return_value=parent_rows)
        mock_postgres_client.execute = AsyncMock(return_value=None)

        result = await TraceReplayer().replay_from("org_test", fork_id="frk_abc", edits={})
        assert result["status"] == "ok"
        # Every cache-served step had a miss → all are
        # in cache_miss_warnings and re_executed.
        assert 0 in result["data"]["cache_miss_warnings"]
        assert 1 in result["data"]["cache_miss_warnings"]
        # The top-level message is the "cache miss" hint.
        assert "cache miss" in result["message"].lower()

    async def test_replay_no_parent_steps(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceReplayer

        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "fork_id": "frk_abc",
                "parent_trace_id": "trc_abc",
                "parent_fork_id": None,
                "fork_at_step": 0,
                "name": "Test",
                "edits_json": "{}",
                "n_replays": 0,
                "last_replay_outcome": None,
                "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        )
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        mock_postgres_client.execute = AsyncMock(return_value=None)

        result = await TraceReplayer().replay_from("org_test", fork_id="frk_abc", edits={})
        assert result["status"] == "ok"
        assert result["data"]["n_served_from_cache"] == 0
        assert result["data"]["n_re_executed"] == 0
        assert "no agent.step" in result["message"].lower()

    async def test_replay_with_edits(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import TraceReplayer

        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "fork_id": "frk_abc",
                "parent_trace_id": "trc_abc",
                "parent_fork_id": None,
                "fork_at_step": 0,
                "name": "Test",
                "edits_json": "{}",
                "n_replays": 0,
                "last_replay_outcome": None,
                "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        )
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        mock_postgres_client.execute = AsyncMock(return_value=None)

        # Valid per-step edits.
        result = await TraceReplayer().replay_from(
            "org_test",
            fork_id="frk_abc",
            edits={
                "step_0.system_prompt": "You are a careful, terse agent...",
                "step_0.temperature": 0.0,
            },
        )
        assert result["status"] == "ok"


# ─── Test class: ReplayDiff ──────────────────────────────────


class TestReplayDiff:
    """Service-level tests for the diff service."""

    async def test_empty_fork_id(self) -> None:
        from eden.time_travel import ReplayDiff

        result = await ReplayDiff().diff("org_test", fork_id="", replay_id="rpl_abc")
        assert result["status"] == "not_implemented"

    async def test_empty_replay_id(self) -> None:
        from eden.time_travel import ReplayDiff

        result = await ReplayDiff().diff("org_test", fork_id="frk_abc", replay_id="")
        assert result["status"] == "not_implemented"

    async def test_fork_not_found(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import ReplayDiff

        mock_postgres_client.fetchrow = AsyncMock(return_value=None)
        result = await ReplayDiff().diff("org_test", fork_id="frk_missing", replay_id="rpl_abc")
        assert result["status"] == "not_implemented"

    async def test_diff_happy_path(self, mock_postgres_client: MagicMock) -> None:
        from eden.time_travel import ReplayDiff

        # fork row.
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "fork_id": "frk_abc",
                "parent_trace_id": "trc_abc",
                "parent_fork_id": None,
                "fork_at_step": 0,
                "name": "Test",
                "edits_json": "{}",
                "n_replays": 1,
                "last_replay_outcome": "success",
                "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        )
        # parent_steps + replay_steps via fetch.
        parent_rows = [
            {
                "event_id": "ev_0",
                "trace_id": "trc_abc",
                "span_id": "s0",
                "name": "agent.step",
                "payload": {"step_index": 0},
                "attributes": {"cacheable": True},
                "response_hash": "hash_orig",
                "duration_ms": 100.0,
                "timestamp": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        ]
        replay_rows = [
            {
                "step_index": 0,
                "served_from_cache": False,
                "re_executed": True,
                "response_hash": "hash_replay",
                "tokens_used": 100,
                "cost_usd": 0.001,
            }
        ]
        fetch_calls = [0]

        async def fetch_side_effect(*args: Any, **kwargs: Any) -> Any:
            fetch_calls[0] += 1
            if fetch_calls[0] == 1:
                return parent_rows
            return replay_rows

        mock_postgres_client.fetch = AsyncMock(side_effect=fetch_side_effect)

        result = await ReplayDiff().diff("org_test", fork_id="frk_abc", replay_id="rpl_abc")
        assert result["status"] == "ok"
        assert result["data"]["fork_id"] == "frk_abc"
        assert result["data"]["replay_id"] == "rpl_abc"
        # The response_hash changed → diff has at least
        # one entry.
        assert result["data"]["n_diffs"] >= 1
        assert "step_0.response_hash" in result["data"]["diff"]


# ─── Test class: package contract ─────────────────────────────


class TestPackageContract:
    """The package exposes the 4 services via lazy re-export."""

    def test_lazy_reexports_resolve(self) -> None:
        from eden import time_travel

        assert isinstance(time_travel.ReplayDiff, type)
        assert isinstance(time_travel.TraceForker, type)
        assert isinstance(time_travel.TraceReplayer, type)
        assert isinstance(time_travel.TraceRecorder, type)

    def test_dir_shows_public_surface(self) -> None:
        from eden import time_travel

        names = dir(time_travel)
        assert "ReplayDiff" in names
        assert "TraceForker" in names
        assert "TraceReplayer" in names
        assert "TraceRecorder" in names

    def test_unknown_attribute_raises(self) -> None:
        from eden import time_travel

        with pytest.raises(AttributeError):
            _ = time_travel.NoSuchService


# ─── Test class: route smoke tests ────────────────────────────


def _pg_router(mock_postgres_client: MagicMock) -> Any:
    """Build a FastAPI app with the time-travel router mounted."""
    from eden.api.deps import get_current_user, require_path_org_access
    from eden.api.routes import intelligence_time_travel

    app = FastAPI()
    app.include_router(intelligence_time_travel.router)
    app.dependency_overrides[get_current_user] = lambda: {"user_id": "user_test"}
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    return app


@pytest.fixture(scope="module")
def tt_client() -> TestClient:
    """A TestClient with the intelligence_gap_v0 flag enabled."""
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    return TestClient(_pg_router(MagicMock()))


class TestTimeTravelRoutes:
    """Route-level smoke tests for the 4 Cat 20 routes."""

    def test_fork_route(self, tt_client: TestClient, mock_postgres_client: MagicMock) -> None:
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        mock_postgres_client.execute = AsyncMock(return_value=None)
        resp = tt_client.post(
            "/orgs/org_test/intelligence/time-travel/fork",
            json={
                "parent_trace_id": "trc_abc",
                "fork_at_step": 30,
                "name": "Try new system prompt",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "TraceForker"
        assert body["data"]["fork_id"].startswith("frk_")
        assert body["data"]["fork_at_step"] == 30

    def test_replay_route(self, tt_client: TestClient, mock_postgres_client: MagicMock) -> None:
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "fork_id": "frk_abc",
                "parent_trace_id": "trc_abc",
                "parent_fork_id": None,
                "fork_at_step": 0,
                "name": "Test",
                "edits_json": "{}",
                "n_replays": 0,
                "last_replay_outcome": None,
                "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        )
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        mock_postgres_client.execute = AsyncMock(return_value=None)
        resp = tt_client.post(
            "/orgs/org_test/intelligence/time-travel/replay",
            json={
                "fork_id": "frk_abc",
                "edits": {},
            },
        )
        # Replay enabled by default after 2026-07-31 honesty fix.
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "TraceReplayer"
        assert body["data"]["replay_id"].startswith("rpl_")

    def test_replay_route_when_disabled(
        self, tt_client: TestClient, mock_postgres_client: MagicMock, monkeypatch
    ) -> None:
        from eden.config import get_settings

        settings = get_settings()
        monkeypatch.setattr(
            settings, "time_travel_replay_enabled", False, raising=False
        )
        resp = tt_client.post(
            "/orgs/org_test/intelligence/time-travel/replay",
            json={"fork_id": "frk_abc", "edits": {}},
        )
        assert resp.status_code == 503
        assert "disabled" in resp.json()["detail"].lower()

    def test_replay_route_when_enabled(
        self, tt_client: TestClient, mock_postgres_client: MagicMock, monkeypatch
    ) -> None:
        """Explicit True still works (kill-switch smoke)."""
        from eden.config import get_settings

        settings = get_settings()
        monkeypatch.setattr(
            settings, "time_travel_replay_enabled", True, raising=False
        )
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "fork_id": "frk_abc",
                "parent_trace_id": "trc_abc",
                "parent_fork_id": None,
                "fork_at_step": 0,
                "name": "Test",
                "edits_json": "{}",
                "n_replays": 0,
                "last_replay_outcome": None,
                "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        )
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        mock_postgres_client.execute = AsyncMock(return_value=None)
        resp = tt_client.post(
            "/orgs/org_test/intelligence/time-travel/replay",
            json={"fork_id": "frk_abc", "edits": {}},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "TraceReplayer"
        assert body["data"]["replay_id"].startswith("rpl_")

    def test_diff_route(self, tt_client: TestClient, mock_postgres_client: MagicMock) -> None:
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "fork_id": "frk_abc",
                "parent_trace_id": "trc_abc",
                "parent_fork_id": None,
                "fork_at_step": 0,
                "name": "Test",
                "edits_json": "{}",
                "n_replays": 1,
                "last_replay_outcome": "success",
                "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
            }
        )
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        resp = tt_client.get("/orgs/org_test/intelligence/time-travel/diff/frk_abc/rpl_abc")
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "ReplayDiff"
        assert body["data"]["fork_id"] == "frk_abc"

    def test_list_forks_route(self, tt_client: TestClient, mock_postgres_client: MagicMock) -> None:
        mock_postgres_client.fetch = AsyncMock(
            return_value=[
                {
                    "fork_id": "frk_abc",
                    "parent_trace_id": "trc_abc",
                    "parent_fork_id": None,
                    "fork_at_step": 30,
                    "name": "Try new system prompt",
                    "n_replays": 3,
                    "last_replay_outcome": "success",
                    "created_at": datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC),
                }
            ]
        )
        resp = tt_client.get(
            "/orgs/org_test/intelligence/time-travel/forks",
            params={"parent_trace_id": "trc_abc"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["feature"] == "TraceForker"
        assert body["data"]["n_forks"] == 1
        assert body["data"]["forks"][0]["fork_id"] == "frk_abc"
