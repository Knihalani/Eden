"""Phase 4 storage: OnlineScoringRulesEngine must prefer request_body_zstd
/ response_body_zstd over the plaintext JSONB columns.

Before this migration ``_load_span_content._decode`` preferred the
plaintext column and only fell back to ``*_zstd`` when it was empty —
the opposite of the canonical reader in
``telemetry_collector.get_trace_tree``. That ordering silently returns
stale/empty content once ``telemetry_plaintext_jsonb_write_enabled``
flips to False (the plaintext column stops being populated on new
rows, but old code path would only look there).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.evaluation.online.rules_engine import OnlineScoringRulesEngine
from eden.storage.compression import compress_jsonb

ORG = "org-1"
TRACE = "trace-1"


def _fake_row(**overrides) -> dict:
    base = {
        "agent_id": "agent-1",
        "outcome": "success",
        "name": "llm.completion",
        "request_body": None,
        "response_body": None,
        "request_body_zstd": None,
        "response_body_zstd": None,
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_prefers_zstd_when_plaintext_is_none():
    """Simulates telemetry_plaintext_jsonb_write_enabled=False: the
    plaintext columns are NULL on new rows, only *_zstd is populated."""
    req_zstd = compress_jsonb({"messages": [{"role": "user", "content": "hi"}]})
    resp_zstd = compress_jsonb({"choices": [{"message": {"content": "hey"}}]})
    row = _fake_row(request_body_zstd=req_zstd, response_body_zstd=resp_zstd)

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    engine = OnlineScoringRulesEngine(pg=client)

    out = await engine._load_span_content(ORG, TRACE)

    assert out["input"]["messages"][0]["content"] == "hi"
    assert out["output"]["choices"][0]["message"]["content"] == "hey"


@pytest.mark.asyncio
async def test_prefers_zstd_over_stale_plaintext():
    """Even when both columns are populated, *_zstd wins — matches the
    canonical reader in telemetry_collector.get_trace_tree so both
    readers agree on the source of truth."""
    fresh_zstd = compress_jsonb({"messages": [{"role": "user", "content": "fresh"}]})
    row = _fake_row(
        request_body={"messages": [{"role": "user", "content": "stale"}]},
        request_body_zstd=fresh_zstd,
    )
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    engine = OnlineScoringRulesEngine(pg=client)

    out = await engine._load_span_content(ORG, TRACE)

    assert out["input"]["messages"][0]["content"] == "fresh"


@pytest.mark.asyncio
async def test_falls_back_to_plaintext_when_zstd_absent():
    """Pre-migration rows (written before *_zstd existed) must still
    work — plaintext-only fallback path."""
    row = _fake_row(request_body={"messages": [{"role": "user", "content": "legacy"}]})
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    engine = OnlineScoringRulesEngine(pg=client)

    out = await engine._load_span_content(ORG, TRACE)

    assert out["input"]["messages"][0]["content"] == "legacy"


@pytest.mark.asyncio
async def test_falls_back_to_plaintext_on_corrupt_zstd():
    """A corrupt/garbage *_zstd value must not raise — fall back to
    plaintext rather than crashing the scoring pipeline."""
    row = _fake_row(
        request_body={"messages": [{"role": "user", "content": "recovered"}]},
        request_body_zstd=b"not-a-valid-zstd-frame",
    )
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    engine = OnlineScoringRulesEngine(pg=client)

    out = await engine._load_span_content(ORG, TRACE)

    assert out["input"]["messages"][0]["content"] == "recovered"


@pytest.mark.asyncio
async def test_no_content_at_all_returns_empty():
    row = _fake_row()
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    engine = OnlineScoringRulesEngine(pg=client)

    out = await engine._load_span_content(ORG, TRACE)

    assert "input" not in out
    assert "output" not in out
