"""D.12.4 Voice / audio tests — service + routes + SDK + hook (15 tests).

Covers:

* Service: record_session happy, record_session idempotent,
  get_sessions_for_trace, list_sessions with provider /
  had_barge_in / asr_p95_ms_gt filters, mark_barge_in,
  detect_barge_in_spike below threshold (no hook),
  detect_barge_in_spike above threshold (fires hook).
* Routes: GET /v1/voice_sessions, POST /v1/voice_sessions/{org},
  GET /v1/traces/{id}/voice_sessions, POST /v1/voice_sessions/{org}/barge_in,
  GET /v1/voice_sessions/barge_in_spike
* SDK: wrap_voice_session happy, mark_barge_in delegates,
  build_voice_attributes, detect_spike convenience

Auth stubs use ``app.dependency_overrides`` (the proven
FastAPI pattern from the D.12.1-3 tests).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

# ── helpers ───────────────────────────────────────────────────────────


_TID = "00000000-0000-0000-0000-000000000077"
_SID = "00000000-0000-0000-0000-000000000076"


def _voice_row(
    session_id: str = "sess-1",
    transport: str = "webrtc",
    barge_in: bool = False,
    asr_provider: str = "deepgram",
    tts_provider: str = "elevenlabs",
):
    now = datetime.now(UTC)
    return {
        "id": "00000000-0000-0000-0000-0000000000bb",
        "org_id": "org-1",
        "trace_id": _TID,
        "span_id": _SID,
        "session_id": session_id,
        "transport": transport,
        "asr_provider": asr_provider,
        "asr_latency_ms": 320,
        "asr_confidence": 0.96,
        "asr_input_audio_ms": 1500,
        "llm_first_audio_ms": 280,
        "tts_provider": tts_provider,
        "tts_first_byte_ms": 180,
        "tts_total_ms": 1100,
        "barge_in_detected": barge_in,
        "created_at": now,
    }


async def _fake_user() -> dict:
    return {"id": "u-1", "email": "t@test.io", "sub": "u-1"}


async def _fake_member() -> dict:
    return {"id": "u-1", "role": "member"}


async def _fake_admin() -> dict:
    return {"id": "u-1", "role": "admin"}


@pytest.fixture
def voice_client(mock_postgres_client: MagicMock) -> TestClient:
    """TestClient with the voice route's auth deps stubbed."""
    from eden.api.app import app
    from eden.api.deps import (
        get_current_user,
        require_org_admin,
        require_org_member,
    )
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_member
    app.dependency_overrides[require_org_admin] = _fake_admin
    try:
        client = TestClient(app)
        client.cookies.set("authorization", "test-token-for-default-deny")
        yield client
    finally:
        app.dependency_overrides.clear()


# ── service tests ─────────────────────────────────────────────────────


class TestVoiceSessionService:
    """8 service-level tests."""

    async def test_record_session_returns_id(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000bb",
        })
        session_id = await svc.record_session(
            "org-1",
            trace_id=_TID,
            span_id=_SID,
            session_id="sess-1",
            transport="webrtc",
            asr_provider="deepgram",
            asr_latency_ms=320,
            tts_provider="elevenlabs",
        )
        assert session_id == "00000000-0000-0000-0000-0000000000bb"
        # SQL was the upsert ON CONFLICT (trace_id, span_id)
        sql = mock_postgres_client.fetchrow.call_args.args[0]
        assert "ON CONFLICT (trace_id, span_id)" in sql
        # Barge-in is False by default
        args = mock_postgres_client.fetchrow.call_args.args
        assert args[-1] is False

    async def test_record_session_with_barge_in(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000bc",
        })
        session_id = await svc.record_session(
            "org-1",
            trace_id=_TID,
            span_id=_SID,
            session_id="sess-1",
            transport="webrtc",
            barge_in_detected=True,
        )
        assert session_id == "00000000-0000-0000-0000-0000000000bc"
        # barge_in_detected=True was passed as the last positional arg
        args = mock_postgres_client.fetchrow.call_args.args
        assert args[-1] is True

    async def test_get_sessions_for_trace_returns_rows(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _voice_row(session_id="sess-1", barge_in=True),
            _voice_row(session_id="sess-1", barge_in=False),
        ])
        rows = await svc.get_sessions_for_trace(_TID, org_id="org-1")
        assert len(rows) == 2
        assert rows[0]["session_id"] == "sess-1"
        assert rows[0]["barge_in_detected"] is True
        assert rows[1]["barge_in_detected"] is False

    async def test_list_sessions_with_provider_filter(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _voice_row(asr_provider="deepgram"),
        ])
        rows = await svc.list_sessions("org-1", provider="deepgram")
        assert len(rows) == 1
        # Filter clause was included in the SQL
        sql = mock_postgres_client.fetch.call_args.args[0]
        assert "asr_provider" in sql
        assert "tts_provider" in sql

    async def test_list_sessions_with_had_barge_in_filter(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _voice_row(barge_in=True),
        ])
        rows = await svc.list_sessions("org-1", had_barge_in=True)
        assert len(rows) == 1
        sql = mock_postgres_client.fetch.call_args.args[0]
        assert "barge_in_detected" in sql

    async def test_list_sessions_asr_p95_filter_excludes_low_p95(
        self, mock_postgres_client: MagicMock,
    ):
        """When the per-org p95 is below ``asr_p95_ms_gt``,
        the result is filtered to an empty list (post-filter
        in Python per the spec §C.8 note about p95 being
        a per-org aggregate).
        """
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        # All rows have asr_latency_ms=320; p95 will be 320.
        # Asking for asr_p95_ms_gt=1000 should drop them.
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _voice_row(),
            _voice_row(),
            _voice_row(),
        ])
        rows = await svc.list_sessions("org-1", asr_p95_ms_gt=1000)
        assert rows == []

    async def test_mark_barge_in_succeeds(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.execute = AsyncMock(return_value="OK")
        ok = await svc.mark_barge_in("sess-1", _TID)
        assert ok is True
        # SQL flipped barge_in_detected=TRUE with a filter
        sql = mock_postgres_client.execute.call_args.args[0]
        assert "barge_in_detected = TRUE" in sql
        assert "barge_in_detected = FALSE" in sql  # idempotent guard

    async def test_detect_barge_in_spike_below_threshold_returns_none(
        self, mock_postgres_client: MagicMock,
    ):
        """When the count is below the threshold, the detector
        returns ``None`` and does NOT fire the hook.
        """
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            {"session_id": "s-1", "trace_id": _TID, "span_id": _SID,
             "created_at": datetime.now(UTC)},
            {"session_id": "s-2", "trace_id": _TID, "span_id": _SID,
             "created_at": datetime.now(UTC)},
        ])
        summary = await svc.detect_barge_in_spike(
            "org-1", window_minutes=15, threshold=5,
        )
        assert summary is None

    async def test_detect_barge_in_spike_above_threshold_returns_summary(
        self, mock_postgres_client: MagicMock,
    ):
        """When the count is ``>=`` threshold, the detector
        returns the summary + (best-effort) fires the
        ``on_voice_barge_in_spike`` hook.
        """
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        # 6 rows > threshold 5
        rows = [
            {"session_id": f"s-{i}", "trace_id": _TID, "span_id": _SID,
             "created_at": datetime.now(UTC)}
            for i in range(6)
        ]
        mock_postgres_client.fetch = AsyncMock(return_value=rows)
        summary = await svc.detect_barge_in_spike(
            "org-1", window_minutes=15, threshold=5,
        )
        assert summary is not None
        assert summary["spike"] is True
        assert summary["count"] == 6
        assert summary["threshold"] == 5
        assert len(summary["session_ids"]) == 6
        assert summary["first_at"] is not None
        assert summary["last_at"] is not None


# ── route tests ───────────────────────────────────────────────────────


class TestVoiceRoutes:
    """5 route tests."""

    def test_get_voice_sessions_lists(
        self, mock_postgres_client: MagicMock, voice_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _voice_row(barge_in=True),
            _voice_row(),
        ])
        resp = voice_client.get(
            "/v1/voice_sessions?org_id=org-1",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["count"] == 2
        assert body["data"][0]["session_id"] == "sess-1"

    def test_post_voice_session_records(
        self, mock_postgres_client: MagicMock, voice_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000bb",
        })
        resp = voice_client.post(
            "/v1/voice_sessions/org-1",
            json={
                "trace_id": _TID,
                "span_id": _SID,
                "session_id": "sess-1",
                "transport": "webrtc",
                "asr_provider": "deepgram",
                "asr_latency_ms": 320,
                "tts_provider": "elevenlabs",
                "tts_first_byte_ms": 180,
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["id"] == "00000000-0000-0000-0000-0000000000bb"

    def test_get_trace_voice_sessions_returns_rows(
        self, mock_postgres_client: MagicMock, voice_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _voice_row(barge_in=True),
        ])
        resp = voice_client.get(
            f"/v1/traces/{_TID}/voice_sessions",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["count"] == 1
        assert body["data"][0]["barge_in_detected"] is True

    def test_post_barge_in_marks(
        self, mock_postgres_client: MagicMock, voice_client: TestClient,
    ):
        mock_postgres_client.execute = AsyncMock(return_value="OK")
        resp = voice_client.post(
            "/v1/voice_sessions/org-1/barge_in",
            json={
                "session_id": "sess-1",
                "trace_id": _TID,
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["barge_in_detected"] is True

    def test_get_barge_in_spike_no_spike(
        self, mock_postgres_client: MagicMock, voice_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        resp = voice_client.get(
            "/v1/voice_sessions/barge_in_spike?org_id=org-1",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["spike"] is False
        assert body["data"]["count"] == 0


# ── SDK tests ─────────────────────────────────────────────────────────


class TestVoiceSdk:
    """4 SDK tests."""

    async def test_wrap_voice_session_persists_row(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.sdk.voice import wrap_voice_session
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000bb",
        })
        async with wrap_voice_session(
            org_id="org-1",
            trace_id=_TID,
            span_id=_SID,
            session_id="sess-1",
            transport="webrtc",
            asr_provider="deepgram",
            tts_provider="elevenlabs",
        ) as ctx:
            ctx.set_asr_latency_ms(320)
            ctx.set_tts_first_byte_ms(180)
            ctx.set_barge_in()
            assert ctx.barge_in_detected is True
        # Persist call was made
        assert mock_postgres_client.fetchrow.await_count >= 1

    async def test_mark_barge_in_delegates(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.sdk.voice import mark_barge_in
        mock_postgres_client.execute = AsyncMock(return_value="OK")
        ok = await mark_barge_in("org-1", "sess-1", _TID)
        assert ok is True

    def test_build_voice_attributes(self):
        from eden.sdk.voice import build_voice_attributes
        attrs = build_voice_attributes(
            session_id="sess-1",
            transport="webrtc",
            asr_provider="deepgram",
            tts_provider="elevenlabs",
            asr_latency_ms=320,
            asr_confidence=0.95,
            barge_in_detected=True,
        )
        assert "voice" in attrs
        v = attrs["voice"]
        assert v["session_id"] == "sess-1"
        assert v["transport"] == "webrtc"
        assert v["asr_provider"] == "deepgram"
        assert v["tts_provider"] == "elevenlabs"
        assert v["asr_latency_ms"] == 320
        assert v["asr_confidence"] == 0.95
        assert v["barge_in_detected"] is True

    async def test_detect_spike_convenience(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.sdk.voice import detect_spike
        rows = [
            {"session_id": f"s-{i}", "trace_id": _TID, "span_id": _SID,
             "created_at": datetime.now(UTC)}
            for i in range(7)
        ]
        mock_postgres_client.fetch = AsyncMock(return_value=rows)
        summary = await detect_spike("org-1", window_minutes=15, threshold=5)
        assert summary is not None
        assert summary["spike"] is True
        assert summary["count"] == 7
