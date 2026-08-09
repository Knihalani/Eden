"""F03 unit tests — PrefixCacheService + llm_input_hash.

Covers:
  * llm_input_hash excludes system-role messages
  * llm_input_hash is stable for same inputs, different for different inputs
  * PrefixCacheService.upsert writes correct SQL
  * PrefixCacheService.get returns response on hit, None on miss
  * PrefixCacheService.get_prefix_for_trace returns ordered list
  * All methods fail-open (never raise on DB error)
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.debugger.cache import PrefixCacheService, llm_input_hash

# ── llm_input_hash ───────────────────────────────────────────────


class TestLlmInputHash:
    def test_excludes_system_role(self) -> None:
        messages_with_system = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "hello"},
        ]
        messages_without_system = [
            {"role": "user", "content": "hello"},
        ]
        assert llm_input_hash(messages_with_system) == llm_input_hash(messages_without_system)

    def test_different_user_messages_give_different_hash(self) -> None:
        h1 = llm_input_hash([{"role": "user", "content": "hello"}])
        h2 = llm_input_hash([{"role": "user", "content": "bye"}])
        assert h1 != h2

    def test_empty_messages_is_stable(self) -> None:
        assert llm_input_hash([]) == llm_input_hash([])

    def test_only_system_messages_equal_empty(self) -> None:
        h_only_system = llm_input_hash([{"role": "system", "content": "x"}])
        h_empty = llm_input_hash([])
        assert h_only_system == h_empty

    def test_returns_64_char_hex(self) -> None:
        h = llm_input_hash([{"role": "user", "content": "hi"}])
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_system_change_does_not_change_hash(self) -> None:
        base = [
            {"role": "user", "content": "question"},
            {"role": "assistant", "content": "answer"},
        ]
        with_sys1 = [{"role": "system", "content": "prompt v1"}, *base]
        with_sys2 = [{"role": "system", "content": "prompt v2"}, *base]
        assert llm_input_hash(with_sys1) == llm_input_hash(with_sys2)
        assert llm_input_hash(with_sys1) == llm_input_hash(base)


# ── FakePg helpers ───────────────────────────────────────────────


class FakePg:
    """Minimal in-memory fake for PrefixCacheService tests."""

    def __init__(self) -> None:
        # (org_id, trace_id, step_number, input_hash) -> row
        self._cache: dict[tuple[str, str, int, str], dict[str, Any]] = {}

    async def execute(self, query: str, *args: Any) -> str:
        # Handles INSERT ... ON CONFLICT DO NOTHING
        q = " ".join(query.lower().split())
        if "insert into debugger_llm_cache" in q:
            org_id, trace_id, step_number, input_hash, response_json, model = args
            key = (org_id, trace_id, int(step_number), input_hash)
            if key not in self._cache:
                response = json.loads(response_json) if isinstance(response_json, str) else response_json
                self._cache[key] = {
                    "step_number": int(step_number),
                    "input_hash": input_hash,
                    "response": response,
                    "model": model,
                    "created_at": "2026-07-14T00:00:00+00:00",
                }
        return "OK"

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        org_id, trace_id, step_number, input_hash = args
        key = (org_id, trace_id, int(step_number), input_hash)
        row = self._cache.get(key)
        if row is None:
            return None
        return {"response": json.dumps(row["response"])}

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        org_id, trace_id = args
        rows = [
            {
                "step_number": v["step_number"],
                "input_hash": v["input_hash"],
                "response": json.dumps(v["response"]),
                "model": v["model"],
                "created_at": v["created_at"],
            }
            for (o, t, _s, _h), v in sorted(self._cache.items(), key=lambda x: x[0][2])
            if o == org_id and t == trace_id
        ]
        return rows


# ── PrefixCacheService.upsert ────────────────────────────────────


class TestPrefixCacheServiceUpsert:
    @pytest.mark.asyncio
    async def test_upsert_writes_row(self) -> None:
        pg = FakePg()
        svc = PrefixCacheService(pg)
        ok = await svc.upsert(
            org_id="org1",
            trace_id="tr1",
            step_number=0,
            input_hash="abc123",
            response={"content": "hi"},
        )
        assert ok is True
        assert len(pg._cache) == 1

    @pytest.mark.asyncio
    async def test_upsert_conflict_is_noop(self) -> None:
        pg = FakePg()
        svc = PrefixCacheService(pg)
        await svc.upsert(
            org_id="org1", trace_id="tr1", step_number=0,
            input_hash="abc", response={"content": "v1"},
        )
        await svc.upsert(
            org_id="org1", trace_id="tr1", step_number=0,
            input_hash="abc", response={"content": "v2"},
        )
        # ON CONFLICT DO NOTHING: still only one row, original value
        assert len(pg._cache) == 1
        assert pg._cache[("org1", "tr1", 0, "abc")]["response"] == {"content": "v1"}

    @pytest.mark.asyncio
    async def test_upsert_fail_open(self) -> None:
        class BrokenPg:
            async def execute(self, *_a: Any, **_k: Any) -> str:
                raise RuntimeError("connection refused")

        svc = PrefixCacheService(BrokenPg())
        ok = await svc.upsert(
            org_id="org1", trace_id="tr1", step_number=0,
            input_hash="x", response={},
        )
        assert ok is False  # fail-open: returns False, does not raise


# ── PrefixCacheService.get ───────────────────────────────────────


class TestPrefixCacheServiceGet:
    @pytest.mark.asyncio
    async def test_get_returns_response_on_hit(self) -> None:
        pg = FakePg()
        svc = PrefixCacheService(pg)
        await svc.upsert(
            org_id="org1", trace_id="tr1", step_number=2,
            input_hash="h1", response={"content": "cached"},
        )
        result = await svc.get(org_id="org1", trace_id="tr1", step_number=2, input_hash="h1")
        assert result == {"content": "cached"}

    @pytest.mark.asyncio
    async def test_get_returns_none_on_miss(self) -> None:
        pg = FakePg()
        svc = PrefixCacheService(pg)
        result = await svc.get(org_id="org1", trace_id="tr1", step_number=0, input_hash="nope")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_fail_open(self) -> None:
        class BrokenPg:
            async def fetchrow(self, *_a: Any, **_k: Any) -> None:
                raise RuntimeError("db down")

        svc = PrefixCacheService(BrokenPg())
        result = await svc.get(org_id="o", trace_id="t", step_number=0, input_hash="h")
        assert result is None


# ── PrefixCacheService.get_prefix_for_trace ──────────────────────


class TestGetPrefixForTrace:
    @pytest.mark.asyncio
    async def test_returns_ordered_steps(self) -> None:
        pg = FakePg()
        svc = PrefixCacheService(pg)
        for step in [2, 0, 1]:
            await svc.upsert(
                org_id="org1", trace_id="tr1", step_number=step,
                input_hash=f"h{step}", response={"step": step},
            )
        rows = await svc.get_prefix_for_trace(org_id="org1", trace_id="tr1")
        assert len(rows) == 3
        assert [r["step_number"] for r in rows] == [0, 1, 2]

    @pytest.mark.asyncio
    async def test_returns_empty_for_unknown_trace(self) -> None:
        pg = FakePg()
        svc = PrefixCacheService(pg)
        rows = await svc.get_prefix_for_trace(org_id="org1", trace_id="no-such-trace")
        assert rows == []

    @pytest.mark.asyncio
    async def test_fail_open_on_db_error(self) -> None:
        class BrokenPg:
            async def fetch(self, *_a: Any, **_k: Any) -> list:
                raise RuntimeError("timeout")

        svc = PrefixCacheService(BrokenPg())
        rows = await svc.get_prefix_for_trace(org_id="o", trace_id="t")
        assert rows == []
