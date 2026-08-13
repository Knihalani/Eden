"""F03 — checkpoint ingest hook from LLM telemetry events."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.ingestion.checkpoint_hook import (
    extract_llm_payload,
    is_llm_event,
    maybe_persist_checkpoint,
    maybe_persist_checkpoints_batch,
)


def test_is_llm_event_accepts_known_types() -> None:
    assert is_llm_event("llm.completion")
    assert is_llm_event("openai.chat_completion")
    assert not is_llm_event("tool.call")
    assert not is_llm_event(None)


def test_extract_llm_payload_normalizes_messages() -> None:
    out = extract_llm_payload(
        {
            "messages": [{"role": "user", "content": "hi"}],
            "tool_calls": [{"name": "search"}],
            "response": {"content": "ok"},
            "step_number": "2",
        }
    )
    assert out["step_number"] == 2
    assert out["input_messages"][0]["content"] == "hi"
    assert out["tool_calls"][0]["name"] == "search"


@pytest.mark.asyncio
async def test_maybe_persist_checkpoint_writes_store() -> None:
    saved: list[Any] = []

    class FakeStore:
        def __init__(self, _pg: Any) -> None:
            pass

        async def save(self, checkpoint: Any, org_id: str | None = None) -> None:
            saved.append((checkpoint, org_id))

    event = SimpleNamespace(
        event_type="llm.completion",
        trace_id="tr_1",
        tenant_id="org_a",
        sequence=3,
        payload={
            "messages": [{"role": "user", "content": "x"}],
            "response": {"content": "y"},
        },
    )

    with patch("eden.debugger.checkpoints.CheckpointStore", FakeStore):
        ok = await maybe_persist_checkpoint(event, pg=object())

    assert ok is True
    assert len(saved) == 1
    cp, org = saved[0]
    assert org == "org_a"
    assert cp.trace_id == "tr_1"
    assert cp.step_number == 3
    assert cp.input_messages[0]["content"] == "x"


@pytest.mark.asyncio
async def test_maybe_persist_skips_non_llm() -> None:
    event = SimpleNamespace(
        event_type="tool.call",
        trace_id="tr_1",
        tenant_id="org_a",
        payload={},
    )
    assert await maybe_persist_checkpoint(event, pg=AsyncMock()) is False


# ── maybe_persist_checkpoints_batch (3.2) ────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_writes_two_executemany_calls() -> None:
    """One qualifying LLM event → exactly 2 ``pg.executemany`` calls
    (telemetry_events + debugger_llm_cache)."""
    event = SimpleNamespace(
        event_type="llm.completion",
        trace_id="tr-batch",
        tenant_id="org_b",
        sequence=0,
        payload={
            "messages": [{"role": "user", "content": "hi"}],
            "response": {"content": "ok"},
            "model": "gpt-4o",
        },
    )
    fake_pg = AsyncMock()
    fake_pg.executemany = AsyncMock()

    with patch(
        "eden.observability.ingestion.checkpoint_hook._resolve_step_number",
        new=AsyncMock(return_value=1),
    ), patch("eden.debugger.cache.llm_input_hash", return_value="h"):
        await maybe_persist_checkpoints_batch([event], pg=fake_pg)

    assert fake_pg.executemany.await_count == 2, (
        f"expected 2 executemany calls, got {fake_pg.executemany.await_count}"
    )


@pytest.mark.asyncio
async def test_batch_skips_non_llm_event() -> None:
    """Non-LLM events produce no executemany calls."""
    event = SimpleNamespace(
        event_type="tool.call",
        trace_id="tr-1",
        tenant_id="org_b",
        sequence=0,
        payload={},
    )
    fake_pg = AsyncMock()
    fake_pg.executemany = AsyncMock()

    await maybe_persist_checkpoints_batch([event], pg=fake_pg)

    fake_pg.executemany.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_is_best_effort_on_pg_error() -> None:
    """Propagated pg.executemany error must not escape the function."""
    event = SimpleNamespace(
        event_type="llm.completion",
        trace_id="tr-1",
        tenant_id="org_b",
        sequence=0,
        payload={
            "messages": [],
            "response": {},
        },
    )
    fake_pg = AsyncMock()
    fake_pg.executemany = AsyncMock(side_effect=RuntimeError("db gone"))

    with patch(
        "eden.observability.ingestion.checkpoint_hook._resolve_step_number",
        new=AsyncMock(return_value=0),
    ):
        # Must not raise.
        await maybe_persist_checkpoints_batch([event], pg=fake_pg)
