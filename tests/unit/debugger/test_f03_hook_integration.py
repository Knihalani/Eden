"""F03 integration tests — checkpoint hook populates N cache rows.

Covers:
  * N LLM events → N debugger_llm_cache rows (one per step)
  * Non-LLM events are ignored
  * Cache upsert failure is fail-open (CheckpointStore still called)
  * Feature flag off → hook is no-op
  * LivePrefixEngine reads from cache when PrefixCacheService is wired
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.debugger.cache import PrefixCacheService, llm_input_hash
from eden.observability.ingestion.checkpoint_hook import maybe_persist_checkpoint


# ── Fake storage ─────────────────────────────────────────────────


class FakePg:
    """Combined fake for CheckpointStore (telemetry_events) + PrefixCacheService."""

    def __init__(self) -> None:
        self.checkpoint_rows: list[dict[str, Any]] = []
        self.cache_rows: list[dict[str, Any]] = []
        self.execute_calls: list[str] = []

    async def execute(self, query: str, *args: Any) -> str:
        q = " ".join(query.lower().split())
        self.execute_calls.append(q[:60])
        if "insert into telemetry_events" in q:
            self.checkpoint_rows.append({"trace_id": args[3], "payload": args[-1]})
        elif "insert into debugger_llm_cache" in q:
            self.cache_rows.append({
                "org_id": args[0],
                "trace_id": args[1],
                "step_number": args[2],
                "input_hash": args[3],
                "response": json.loads(args[4]) if isinstance(args[4], str) else args[4],
            })
        return "OK"

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        trace_id = args[0] if args else ""
        return [
            {"payload": r["payload"]}
            for r in self.checkpoint_rows
            if r["trace_id"] == trace_id
        ]

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        return None


def _llm_event(trace_id: str = "tr1", step: int | None = None, seq: int = 0) -> SimpleNamespace:
    payload: dict[str, Any] = {
        "messages": [{"role": "user", "content": f"step {seq}"}],
        "response": {"content": f"resp {seq}"},
    }
    if step is not None:
        payload["step_number"] = step
    return SimpleNamespace(
        event_type="llm.completion",
        trace_id=trace_id,
        tenant_id="org_a",
        sequence=seq,
        payload=payload,
    )


# ── N events → N cache rows ──────────────────────────────────────


@pytest.mark.asyncio
async def test_n_llm_events_produce_n_cache_rows() -> None:
    N = 5
    pg = FakePg()

    for i in range(N):
        ok = await maybe_persist_checkpoint(_llm_event(step=i, seq=i), pg=pg)
        assert ok is True

    # One checkpoint audit row per event
    assert len(pg.checkpoint_rows) == N
    # One cache row per event
    assert len(pg.cache_rows) == N
    # Step numbers are distinct
    steps = {r["step_number"] for r in pg.cache_rows}
    assert steps == set(range(N))


@pytest.mark.asyncio
async def test_non_llm_events_are_ignored() -> None:
    pg = FakePg()
    event = SimpleNamespace(
        event_type="tool.call",
        trace_id="tr2",
        tenant_id="org_a",
        sequence=0,
        payload={},
    )
    ok = await maybe_persist_checkpoint(event, pg=pg)
    assert ok is False
    assert pg.checkpoint_rows == []
    assert pg.cache_rows == []


# ── Fail-open: cache upsert failure does not break ingest ────────


@pytest.mark.asyncio
async def test_cache_upsert_failure_is_fail_open() -> None:
    checkpoint_saved: list[Any] = []

    class StoreOnlyPg:
        """Fake that only stores telemetry_events; debugger_llm_cache raises."""

        async def execute(self, query: str, *args: Any) -> str:
            q = " ".join(query.lower().split())
            if "insert into debugger_llm_cache" in q:
                raise RuntimeError("simulated cache failure")
            if "insert into telemetry_events" in q:
                checkpoint_saved.append(args[3])  # trace_id
            return "OK"

        async def fetch(self, *_a: Any, **_k: Any) -> list:
            return []

        async def fetchrow(self, *_a: Any, **_k: Any) -> None:
            return None

    ok = await maybe_persist_checkpoint(_llm_event(step=0), pg=StoreOnlyPg())
    # Hook returns True — CheckpointStore write succeeded
    assert ok is True
    assert "tr1" in checkpoint_saved


# ── Feature flag off → no-op ─────────────────────────────────────


@pytest.mark.asyncio
async def test_feature_flag_off_is_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    pg = FakePg()

    class _FakeSettings:
        debugger_checkpoint_ingest_v1 = False

    with patch("eden.observability.ingestion.checkpoint_hook.get_settings", return_value=_FakeSettings()):
        ok = await maybe_persist_checkpoint(_llm_event(step=0), pg=pg)

    assert ok is False
    assert pg.checkpoint_rows == []
    assert pg.cache_rows == []


# ── Redis INCR step fallback ─────────────────────────────────────


@pytest.mark.asyncio
async def test_redis_incr_used_when_step_omitted() -> None:
    pg = FakePg()

    _counter = [0]

    class FakeRedis:
        async def incr(self, key: str) -> int:
            _counter[0] += 1
            return _counter[0]

        async def ttl(self, key: str) -> int:
            return -1

        async def expire(self, key: str, seconds: int) -> None:
            pass

        def pipeline(self, transaction: bool = False) -> "_Pipe":
            return _Pipe(self)

    class _Pipe:
        def __init__(self, redis: FakeRedis) -> None:
            self._redis = redis
            self._ops: list[tuple[str, tuple]] = []

        def incr(self, key: str) -> "_Pipe":
            self._ops.append(("incr", (key,)))
            return self

        def expire(self, key: str, ttl: int) -> "_Pipe":
            self._ops.append(("expire", (key, ttl)))
            return self

        async def execute(self) -> list:
            out: list = []
            for op, args in self._ops:
                if op == "incr":
                    out.append(await self._redis.incr(args[0]))
                elif op == "expire":
                    await self._redis.expire(args[0], args[1])
                    out.append(True)
            return out

    event = SimpleNamespace(
        event_type="llm.completion",
        trace_id="tr_redis",
        tenant_id="org_a",
        sequence=None,  # no sequence
        payload={
            "messages": [{"role": "user", "content": "hi"}],
            "response": {"content": "ok"},
            # no step_number
        },
    )

    ok = await maybe_persist_checkpoint(event, pg=pg, redis=FakeRedis())
    assert ok is True
    # Redis INCR was called
    assert _counter[0] == 1


# ── LivePrefixEngine prefers cache over CheckpointStore ──────────


@pytest.mark.asyncio
async def test_live_prefix_engine_prefers_cache() -> None:
    from eden.debugger.checkpoints import CheckpointStore, LivePrefixEngine

    # Cache has 3 steps for "tr_cache"
    class CacheSvc:
        async def get_prefix_for_trace(
            self, *, org_id: str, trace_id: str
        ) -> list[dict[str, Any]]:
            if trace_id == "tr_cache":
                return [
                    {
                        "step_number": i,
                        "input_hash": f"h{i}",
                        "response": {"content": f"cached {i}"},
                        "model": None,
                        "created_at": "2026-07-14",
                    }
                    for i in range(3)
                ]
            return []

    class EmptyStorePg:
        async def fetch(self, *_a: Any, **_k: Any) -> list:
            return []

        async def fetchrow(self, *_a: Any, **_k: Any) -> None:
            return None

    store = CheckpointStore(EmptyStorePg())
    engine = LivePrefixEngine(store, cache_svc=CacheSvc())
    result = await engine.rerun_live_prefix("tr_cache", live_from_step=5, org_id="org1")

    # All 3 steps came from cache (steps 0, 1, 2 < live_from_step=5)
    assert len(result.prefix_checkpoints) == 3
    assert result.prefix_checkpoints[0].response == {"content": "cached 0"}


@pytest.mark.asyncio
async def test_live_prefix_engine_falls_back_to_store() -> None:
    """When cache returns empty, fall back to CheckpointStore."""
    from eden.debugger.checkpoints import Checkpoint, CheckpointStore, LivePrefixEngine

    class EmptyCacheSvc:
        async def get_prefix_for_trace(
            self, *, org_id: str, trace_id: str
        ) -> list[dict[str, Any]]:
            return []

    # Store has 2 checkpoints
    class StorePg:
        def __init__(self) -> None:
            self._rows: list[dict[str, Any]] = [
                {
                    "payload": json.dumps({
                        "id": f"cp-{i}", "trace_id": "tr_store",
                        "step_number": i, "input_messages": [],
                        "tool_calls": [], "tool_results": [],
                        "response": {"content": f"store {i}"},
                        "started_at": "", "ended_at": "",
                        "duration_ms": 0.0, "source": "live",
                    })
                }
                for i in range(2)
            ]

        async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
            return self._rows

        async def fetchrow(self, *_a: Any, **_k: Any) -> None:
            return None

    store = CheckpointStore(StorePg())
    engine = LivePrefixEngine(store, cache_svc=EmptyCacheSvc())
    result = await engine.rerun_live_prefix("tr_store", live_from_step=5, org_id="org1")
    assert len(result.prefix_checkpoints) == 2
    assert result.prefix_checkpoints[0].response == {"content": "store 0"}
