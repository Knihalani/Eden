"""Tests for the async path in JudgeDetector + DetectorRegistry.

Phase 7.2a — the previous sync-only ``_fetch_recent_rows`` silently
no-op'd when called from inside an event loop. The new
``aanalyze`` uses ``await`` directly, so judge scores flow through
in async contexts (e.g. the FastAPI handler that calls
``DetectorRegistry.run_selected``).
"""

from __future__ import annotations

from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.insights.detectors import DetectorRegistry, JudgeDetector

# ── aanalyze: async path ──────────────────────────────────────────


class _FakeEvent:
    """Minimal stub that the detector's matches() accepts as an
    LLM-event (it only checks event_type, not the rest)."""

    def __init__(self, et: str = "otel.chat") -> None:
        self.event_type = et


def _row(**kwargs) -> dict[str, Any]:
    base = {
        "judge_run_id": "jr_1",
        "judge_name": "hallucination",
        "judge_version": "2026-06-03",
        "trace_id": "tr_1",
        "span_id": "sp_1",
        "score": 0.3,
        "rationale": "test",
        "model": "claude-haiku",
        "scored_at": datetime(2026, 6, 3, 12, 0, 0, tzinfo=UTC),
        "latency_ms": 100.0,
    }
    base.update(kwargs)
    return base


@pytest.mark.asyncio
async def test_judge_detector_aanalyze_reads_rows_in_async_context(monkeypatch):
    """``aanalyze`` works when the event loop is running — the bug the
    Phase 1 sync path had was silent no-op in this case."""
    rows = [_row(score=0.2), _row(judge_run_id="jr_2", score=0.8)]

    async def _read(self):
        return rows

    monkeypatch.setattr(
        JudgeDetector, "_fetch_recent_rows_async", _read
    )

    d = JudgeDetector()
    insights = await d.aanalyze([])
    assert len(insights) == 2
    # score=0.2 → critical; 0.8 → low.
    assert insights[0].severity == "critical"
    assert insights[1].severity == "low"
    # Detector prefix.
    assert all(i.detector == "judge.hallucination" for i in insights)


@pytest.mark.asyncio
async def test_judge_detector_aanalyze_swallows_db_errors(monkeypatch):
    """When the DB read raises, the detector returns [] rather than
    propagating the exception — telemetry must never break the
    caller's flow."""
    async def _read_raises(self):
        raise RuntimeError("DB down")

    monkeypatch.setattr(
        JudgeDetector, "_fetch_recent_rows_async", _read_raises
    )

    d = JudgeDetector()
    insights = await d.aanalyze([])
    assert insights == []


@pytest.mark.asyncio
async def test_judge_detector_aanalyze_handles_empty_rows(monkeypatch):
    """No rows → empty Insight list, not an error."""
    async def _read(self):
        return []

    monkeypatch.setattr(
        JudgeDetector, "_fetch_recent_rows_async", _read
    )

    d = JudgeDetector()
    assert await d.aanalyze([]) == []


# ── DetectorRegistry.arun_all: dispatch logic ──────────────────────


@pytest.mark.asyncio
async def test_registry_arun_all_uses_aanalyze_when_available(monkeypatch):
    """A detector with ``aanalyze`` is awaited; one without falls
    back to ``asyncio.to_thread(analyze, ...)``."""
    plain_calls: list[list] = []

    class _PlainDetector:
        name = "plain"
        min_confidence = 0.0

        def analyze(self, traces):
            plain_calls.append(traces)
            return []

    r = DetectorRegistry()
    r._detectors["judge_scores_bridge"] = JudgeDetector()  # has aanalyze
    r._detectors["plain"] = _PlainDetector()  # only analyze

    # Patch the JudgeDetector to return a known set of rows.
    async def _read(self):
        return [_row()]

    monkeypatch.setattr(
        JudgeDetector, "_fetch_recent_rows_async", _read
    )

    insights = await r.arun_all([])
    assert any(i.detector == "judge.hallucination" for i in insights)
    # The plain detector's sync analyze was called via to_thread.
    assert plain_calls == [[]]


@pytest.mark.asyncio
async def test_registry_arun_all_swallows_per_detector_failures():
    """A single detector failure doesn't break the rest."""
    class _BadDetector:
        name = "bad"
        min_confidence = 0.0

        def analyze(self, traces):
            raise RuntimeError("boom")

    r = DetectorRegistry()
    r._detectors["bad"] = _BadDetector()

    # Should not raise — the failure is logged and swallowed.
    insights = await r.arun_all([])
    assert insights == []


# ── Sync path still works (backwards compat) ──────────────────────


def test_judge_detector_sync_analyze_still_works():
    """The legacy ``analyze`` path is preserved for callers that
    don't need async. Smoke-test the conversion logic."""
    rows = [_row(score=0.5)]
    d = JudgeDetector()
    # Patch the underlying fetch to avoid the no-op in async context.
    d._fetch_recent_rows = MagicMock(return_value=rows)
    insights = d.analyze([])
    assert len(insights) == 1
    assert insights[0].detector == "judge.hallucination"
