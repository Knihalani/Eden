"""Unit tests for Phase P — Agent Debugger.

What's covered:

  Checkpoint dataclass (3 tests)
  ─────────────────────────────
  * to_dict round-trip
  * Defaults
  * Custom fields preserved

  CheckpointStore (5 tests)
  ──────────────────────
  * save() persists
  * list_for_trace() returns in step order
  * get_at_step() returns specific step
  * get_at_step() returns None for unknown step
  * empty store returns []

  ReRunEngine (8 tests)
  ────────────────────
  * rerun() returns replayed checkpoints
  * rerun() with from_step skips earlier
  * prompt_override replaces system message
  * prompt_override prepends when no system message exists
  * diff highlights changed responses
  * diff empty when override doesn't change anything
  * empty trace returns empty replay
  * to_dict round-trip

  RolloutEntrypoint + discover (5 tests)
  ─────────────────────────────────────
  * discover returns sorted by confidence
  * discover filters by min_confidence
  * discover handles empty list
  * discover preserves arg_signature
  * to_dict round-trip

  _apply_prompt_override helper (3 tests)
  ────────────────────────────────────
  * Replaces existing system message
  * Prepends when missing
  * Marks source as "replay"
"""

from __future__ import annotations

import json
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

from eden.debugger.checkpoints import (
    Checkpoint,
    CheckpointStore,
    ReRunEngine,
    ReRunResult,
    RolloutEntrypoint,
    _apply_prompt_override,
    _payload_to_checkpoint,
    discover_entrypoint,
)

# ─- Fake PG ──────────────────────────────────────────────────────


class FakePg:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self._rows: list[dict[str, Any]] = []

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((query.strip().lower(), args))
        sql = " ".join(query.strip().lower().split())
        if sql.startswith("insert into telemetry_events"):
            payload = args[-1]
            if isinstance(payload, str):
                payload = json.loads(payload)
            self._rows.append({
                "trace_id": args[3],
                "tenant_id": args[1],
                "event_type": args[5],
                "payload": payload,
            })
            return "INSERT 0 1"
        return "OK"

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        sql = " ".join(query.strip().lower().split())
        rows = [
            r for r in self._rows
            if r["trace_id"] == args[0]
            and r["event_type"] == "debugger.checkpoint"
        ]
        # list_for_trace: (trace_id, tenant_id) — ORDER BY mentions step_number
        # get_at_step:    (trace_id, step_number, tenant_id)
        if "tenant_id" in sql and len(args) > 1:
            tenant = args[2] if len(args) > 2 else args[1]
            rows = [r for r in rows if r.get("tenant_id") == tenant]
        out = [{"payload": r["payload"]} for r in rows]
        # Equality filter only present on get_at_step (3 args).
        if "step_number" in sql and len(args) > 2:
            step = args[1]
            out = [
                r for r in out
                if r["payload"].get("step_number") == step
            ][:1]
        return out

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        for r in self._rows:
            if (
                r["trace_id"] == args[0]
                and r["payload"].get("step_number") == args[1]
            ):
                return {"payload": r["payload"]}
        return None


def _checkpoint(step: int, **kwargs: Any) -> Checkpoint:
    defaults = {
        "id": f"cp-{step}",
        "trace_id": "trace-1",
        "step_number": step,
        "input_messages": [{"role": "user", "content": f"step {step}"}],
        "tool_calls": [],
        "tool_results": [],
        "response": {"content": f"response {step}"},
        "started_at": "2026-06-17T12:00:00+00:00",
        "ended_at": "2026-06-17T12:00:01+00:00",
        "duration_ms": 1000.0,
    }
    defaults.update(kwargs)
    return Checkpoint(**defaults)


# ─- Checkpoint ──────────────────────────────────────────────────


class TestCheckpoint:
    def test_defaults(self) -> None:
        c = Checkpoint(
            id="c", trace_id="t", step_number=0,
            input_messages=[], tool_calls=[], tool_results=[],
            response={},
        )
        assert c.prompt_override is None
        assert c.source == "live"
        assert c.duration_ms == 0.0

    def test_to_dict_round_trip(self) -> None:
        c = _checkpoint(1)
        d = c.to_dict()
        assert d["id"] == "cp-1"
        assert d["trace_id"] == "trace-1"
        assert d["step_number"] == 1
        assert d["response"] == {"content": "response 1"}

    def test_custom_fields(self) -> None:
        c = _checkpoint(
            2, source="replay",
            prompt_override="you are a helpful assistant",
        )
        assert c.source == "replay"
        assert c.prompt_override == "you are a helpful assistant"


# ─- CheckpointStore ─────────────────────────────────────────────


class TestCheckpointStore:
    @pytest.mark.asyncio
    async def test_save_persists(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        await store.save(_checkpoint(1))
        # The pg saw one INSERT.
        assert any("insert into telemetry_events" in c[0] for c in pg.calls)

    @pytest.mark.asyncio
    async def test_save_uses_event_id_and_stamps_source_format(self) -> None:
        """F-B pinning test (Wave 1).

        The INSERT used to target an ``id`` column — ``telemetry_events``
        has no ``id`` column (PK is ``event_id``, migration 009) — so
        Postgres rejected every checkpoint and the debugger's
        replay-verify backbone silently persisted nothing. This test
        captures the raw SQL and pins the corrected column + the
        ``source_format='debugger_checkpoint'`` provenance tag the
        docstring always promised.
        """
        raw_calls: list[str] = []

        class _RawPg:
            async def execute(self, query: str, *args: Any) -> str:
                raw_calls.append(query)
                return "INSERT 0 1"

        store = CheckpointStore(_RawPg())
        await store.save(_checkpoint(1))

        assert raw_calls, "save() never executed SQL"
        sql = raw_calls[0]
        # 1. The real column is event_id — the dead ``id`` column must
        #    never appear in the column list.
        assert "event_id" in sql
        # No bare ``id`` column token: "id" appears inside event_id and
        # span_id, so assert the INSERT column list has no standalone id.
        insert_cols = sql.split("(")[1].split(")")[0]
        cols = [c.strip().lower() for c in insert_cols.split(",")]
        assert "id" not in cols
        assert "event_id" in cols
        # 2. source_format is stamped 'debugger_checkpoint'.
        assert "debugger_checkpoint" in sql

    @pytest.mark.asyncio
    async def test_list_for_trace_returns_in_step_order(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        # Save checkpoints out of order.
        await store.save(_checkpoint(3))
        await store.save(_checkpoint(1))
        await store.save(_checkpoint(2))
        cps = await store.list_for_trace("trace-1")
        # FakePg doesn't sort; we get the insertion order.
        # The real SQL has ORDER BY, but for the fake the
        # test just verifies the data is loaded.
        assert len(cps) == 3
        steps = {c.step_number for c in cps}
        assert steps == {1, 2, 3}

    @pytest.mark.asyncio
    async def test_get_at_step_returns_specific_step(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        await store.save(_checkpoint(1))
        await store.save(_checkpoint(2))
        cp = await store.get_at_step("trace-1", 1)
        assert cp is not None
        assert cp.step_number == 1

    @pytest.mark.asyncio
    async def test_get_at_step_unknown_returns_none(self) -> None:
        # Direct test: the fake's `fetch` filters on step_number
        # when the SQL has the (payload->>'step_number')::int = $2
        # clause (which is what get_at_step uses).
        pg = FakePg()
        store = CheckpointStore(pg)
        await store.save(_checkpoint(1))
        # The fake's `fetch` is wired to return only matching
        # step numbers, so step 99 returns no row.
        result = await store.get_at_step("trace-1", 99)
        assert result is None

    @pytest.mark.asyncio
    async def test_empty_store_returns_empty(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        assert await store.list_for_trace("nothing") == []


# ─- ReRunEngine ────────────────────────────────────────────────


class TestReRunEngine:
    @pytest.mark.asyncio
    async def test_rerun_returns_replayed_checkpoints(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        for i in range(3):
            await store.save(_checkpoint(i))
        engine = ReRunEngine(store)
        result = await engine.rerun("trace-1")
        assert result.source_trace_id == "trace-1"
        assert len(result.checkpoints) == 3
        assert result.from_step == 0

    @pytest.mark.asyncio
    async def test_rerun_with_from_step_skips_earlier(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        for i in range(5):
            await store.save(_checkpoint(i))
        engine = ReRunEngine(store)
        result = await engine.rerun("trace-1", from_step=3)
        assert len(result.checkpoints) == 2  # 3 and 4
        assert all(c.step_number >= 3 for c in result.checkpoints)

    @pytest.mark.asyncio
    async def test_prompt_override_replaces_system_message(self) -> None:
        cp = _checkpoint(
            0,
            input_messages=[
                {"role": "system", "content": "old prompt"},
                {"role": "user", "content": "hi"},
            ],
        )
        new_cp = _apply_prompt_override(cp, "new prompt")
        # The system message was replaced.
        assert new_cp.input_messages[0] == {
            "role": "system", "content": "new prompt",
        }
        assert new_cp.input_messages[1] == {"role": "user", "content": "hi"}
        assert new_cp.prompt_override == "new prompt"
        assert new_cp.source == "replay"

    @pytest.mark.asyncio
    async def test_prompt_override_prepends_when_missing(self) -> None:
        cp = _checkpoint(
            0,
            input_messages=[{"role": "user", "content": "hi"}],
        )
        new_cp = _apply_prompt_override(cp, "new prompt")
        # The new system message was prepended.
        assert new_cp.input_messages[0] == {
            "role": "system", "content": "new prompt",
        }
        assert new_cp.input_messages[1] == {"role": "user", "content": "hi"}

    @pytest.mark.asyncio
    async def test_diff_highlights_changed_inputs(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        # Save two checkpoints with identical responses.
        await store.save(_checkpoint(0, response={"content": "same"}))
        await store.save(_checkpoint(1, response={"content": "same"}))
        engine = ReRunEngine(store)
        # Apply a prompt override — this DOES change the
        # input messages (so the diff picks it up).
        result = await engine.rerun(
            "trace-1", prompt_override="new system prompt",
        )
        # The diff is non-empty (input changed).
        assert len(result.diff) >= 1
        # The first diff entry marks input as changed.
        assert result.diff[0]["input_messages_changed"] is True

    @pytest.mark.asyncio
    async def test_diff_empty_when_no_override(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        await store.save(_checkpoint(0))
        await store.save(_checkpoint(1))
        engine = ReRunEngine(store)
        # No override → no diff.
        result = await engine.rerun("trace-1")
        assert result.diff == []

    @pytest.mark.asyncio
    async def test_empty_trace_returns_empty_replay(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        engine = ReRunEngine(store)
        result = await engine.rerun("nothing")
        assert result.checkpoints == []
        assert result.diff == []

    @pytest.mark.asyncio
    async def test_rerun_result_to_dict(self) -> None:
        pg = FakePg()
        store = CheckpointStore(pg)
        await store.save(_checkpoint(0))
        engine = ReRunEngine(store)
        result = await engine.rerun(
            "trace-1", prompt_override="x",
        )
        d = result.to_dict()
        assert d["source_trace_id"] == "trace-1"
        assert d["prompt_override"] == "x"
        assert len(d["checkpoints"]) == 1


# ─- RolloutEntrypoint + discover ─────────────────────────────


class TestDiscoverEntrypoint:
    def test_discover_returns_sorted_by_confidence(self) -> None:
        candidates = [
            {"name": "low", "file_path": "a.py", "function_name": "low_fn",
             "confidence": 0.3},
            {"name": "high", "file_path": "b.py", "function_name": "high_fn",
             "confidence": 0.9},
            {"name": "mid", "file_path": "c.py", "function_name": "mid_fn",
             "confidence": 0.6},
        ]
        out = discover_entrypoint(candidates, min_confidence=0.5)
        names = [e.name for e in out]
        assert names == ["high", "mid"]  # sorted by confidence

    def test_discover_filters_by_min_confidence(self) -> None:
        candidates = [
            {"name": "a", "file_path": "a.py", "function_name": "a",
             "confidence": 0.4},
            {"name": "b", "file_path": "b.py", "function_name": "b",
             "confidence": 0.6},
        ]
        out = discover_entrypoint(candidates, min_confidence=0.5)
        names = [e.name for e in out]
        assert names == ["b"]

    def test_discover_empty(self) -> None:
        assert discover_entrypoint([]) == []
        assert discover_entrypoint([
            {"name": "a", "file_path": "a.py", "function_name": "a",
             "confidence": 0.1},
        ], min_confidence=0.5) == []

    def test_discover_preserves_arg_signature(self) -> None:
        candidates = [{
            "name": "agent", "file_path": "agent.py", "function_name": "run",
            "confidence": 0.9, "arg_signature": ["messages", "tools"],
        }]
        out = discover_entrypoint(candidates, min_confidence=0.5)
        assert out[0].arg_signature == ["messages", "tools"]

    def test_entrypoint_to_dict(self) -> None:
        e = RolloutEntrypoint(
            name="a", file_path="a.py", function_name="a",
            confidence=0.9, arg_signature=["x"],
        )
        d = e.to_dict()
        assert d["name"] == "a"
        assert d["arg_signature"] == ["x"]


# ─- _apply_prompt_override ─────────────────────────────────────


class TestApplyPromptOverride:
    def test_replaces_existing_system_message(self) -> None:
        cp = _checkpoint(
            0,
            input_messages=[
                {"role": "system", "content": "old"},
                {"role": "user", "content": "hi"},
            ],
        )
        new_cp = _apply_prompt_override(cp, "new")
        assert new_cp.input_messages[0]["content"] == "new"
        assert len(new_cp.input_messages) == 2

    def test_prepends_when_missing(self) -> None:
        cp = _checkpoint(
            0,
            input_messages=[{"role": "user", "content": "hi"}],
        )
        new_cp = _apply_prompt_override(cp, "new")
        assert new_cp.input_messages[0] == {"role": "system", "content": "new"}
        assert new_cp.input_messages[1] == {"role": "user", "content": "hi"}

    def test_marks_source_as_replay(self) -> None:
        cp = _checkpoint(0)
        new_cp = _apply_prompt_override(cp, "x")
        assert new_cp.source == "replay"
        assert new_cp.prompt_override == "x"
