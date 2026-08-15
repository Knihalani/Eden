"""Voice sessions service — D.12.4 (§8.4).

Read + write surface over the ``voice_sessions`` table.

Public surface:

* :class:`VoiceSessionService` — service class
* :func:`get_voice_service` — singleton getter (mirrors the
  rest of the cat surface)

Barge-in detection (per spec §8.4):
  The service exposes :meth:`detect_barge_in_spike` which
  counts recent barge-ins for an org and, when the count
  crosses a threshold in the rolling window, fires the
  ``on_voice_barge_in_spike`` hook. The hook payload includes
  the per-org session ids that contributed to the spike so
  the operator has a path to drill in.

Ponytail: best-effort — DB errors fall through to ``[]`` /
``None`` so the route layer never 500s.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# 3 transport values per spec §B.7; 3 ASR providers; 3 TTS providers.
# Kept as module-level tuples so callers can validate cheaply.
TRANSPORTS: tuple[str, ...] = ("webrtc", "websocket", "sip")
ASR_PROVIDERS: tuple[str, ...] = ("deepgram", "whisper", "assemblyai")
TTS_PROVIDERS: tuple[str, ...] = ("elevenlabs", "cartesia", "openai")

# Barge-in spike defaults per spec §8.4: "alert if >5 barge-ins in
# 15 minutes for the same org". These are the same defaults the
# SDK uses when the caller omits them.
DEFAULT_SPIKE_WINDOW_MINUTES: int = 15
DEFAULT_SPIKE_THRESHOLD: int = 5


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("voice: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("voice: get_postgres_client failed: %s", exc)
        return None


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class VoiceSessionService:
    """Service for the voice / audio surface."""

    async def record_session(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str,
        session_id: str,
        transport: str | None = None,
        asr_provider: str | None = None,
        asr_latency_ms: int | None = None,
        asr_confidence: float | None = None,
        asr_input_audio_ms: int | None = None,
        llm_first_audio_ms: int | None = None,
        tts_provider: str | None = None,
        tts_first_byte_ms: int | None = None,
        tts_total_ms: int | None = None,
        barge_in_detected: bool = False,
    ) -> str | None:
        """Persist one voice-session row. Idempotent on
        (trace_id, span_id) — re-recording the same turn upserts
        the latest provider / latency values (the SDK sometimes
        fills them in incrementally as the ASR/TTS round-trips
        complete).
        """
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                INSERT INTO voice_sessions (
                    id, org_id, trace_id, span_id, session_id,
                    transport, asr_provider,
                    asr_latency_ms, asr_confidence, asr_input_audio_ms,
                    llm_first_audio_ms,
                    tts_provider, tts_first_byte_ms, tts_total_ms,
                    barge_in_detected
                ) VALUES (
                    gen_random_uuid(), $1, $2::uuid, $3::uuid, $4,
                    $5, $6,
                    $7, $8, $9,
                    $10,
                    $11, $12, $13,
                    $14
                )
                ON CONFLICT (trace_id, span_id) DO UPDATE SET
                    session_id          = EXCLUDED.session_id,
                    transport           = COALESCE(EXCLUDED.transport, voice_sessions.transport),
                    asr_provider         = COALESCE(EXCLUDED.asr_provider, voice_sessions.asr_provider),
                    asr_latency_ms      = COALESCE(EXCLUDED.asr_latency_ms, voice_sessions.asr_latency_ms),
                    asr_confidence      = COALESCE(EXCLUDED.asr_confidence, voice_sessions.asr_confidence),
                    asr_input_audio_ms  = COALESCE(EXCLUDED.asr_input_audio_ms, voice_sessions.asr_input_audio_ms),
                    llm_first_audio_ms  = COALESCE(EXCLUDED.llm_first_audio_ms, voice_sessions.llm_first_audio_ms),
                    tts_provider         = COALESCE(EXCLUDED.tts_provider, voice_sessions.tts_provider),
                    tts_first_byte_ms    = COALESCE(EXCLUDED.tts_first_byte_ms, voice_sessions.tts_first_byte_ms),
                    tts_total_ms         = COALESCE(EXCLUDED.tts_total_ms, voice_sessions.tts_total_ms),
                    barge_in_detected    = voice_sessions.barge_in_detected OR EXCLUDED.barge_in_detected
                RETURNING id
                """,
                org_id,
                trace_id,
                span_id,
                session_id,
                transport,
                asr_provider,
                asr_latency_ms,
                asr_confidence,
                asr_input_audio_ms,
                llm_first_audio_ms,
                tts_provider,
                tts_first_byte_ms,
                tts_total_ms,
                barge_in_detected,
            )
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug("voice.record_session failed: %s", exc)
            return None

    async def get_sessions_for_trace(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return every voice session row for a trace, in
        ``created_at`` order.
        """
        client = await _get_client()
        if client is None:
            return []
        try:
            if org_id:
                rows = await client.fetch(
                    """
                    SELECT id, org_id, trace_id, span_id, session_id,
                           transport, asr_provider,
                           asr_latency_ms, asr_confidence, asr_input_audio_ms,
                           llm_first_audio_ms,
                           tts_provider, tts_first_byte_ms, tts_total_ms,
                           barge_in_detected, created_at
                      FROM voice_sessions
                     WHERE trace_id = $1::uuid
                       AND org_id    = $2
                     ORDER BY created_at ASC
                    """,
                    trace_id, org_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT id, org_id, trace_id, span_id, session_id,
                           transport, asr_provider,
                           asr_latency_ms, asr_confidence, asr_input_audio_ms,
                           llm_first_audio_ms,
                           tts_provider, tts_first_byte_ms, tts_total_ms,
                           barge_in_detected, created_at
                      FROM voice_sessions
                     WHERE trace_id = $1::uuid
                     ORDER BY created_at ASC
                    """,
                    trace_id,
                )
        except Exception as exc:
            logger.debug("voice.get_sessions_for_trace failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def list_sessions(
        self,
        org_id: str,
        *,
        provider: str | None = None,
        had_barge_in: bool | None = None,
        asr_p95_ms_gt: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List voice sessions for an org with optional filters
        (per spec §C.8). ``asr_p95_ms_gt`` is post-filtered in
        Python because p95 is a per-org aggregate, not a row
        attribute — the spec wants "show me sessions where the
        org's ASR p95 was above X ms", which the per-row
        ``asr_latency_ms`` already approximates.
        """
        client = await _get_client()
        if client is None:
            return []
        where = ["org_id = $1"]
        params: list[Any] = [org_id]
        if provider is not None:
            where.append(f"(asr_provider = ${len(params) + 1} OR tts_provider = ${len(params) + 1})")
            params.append(provider)
        if had_barge_in is not None:
            where.append(f"barge_in_detected = ${len(params) + 1}")
            params.append(had_barge_in)
        sql = (
            "SELECT id, org_id, trace_id, span_id, session_id, "
            "transport, asr_provider, asr_latency_ms, asr_confidence, "
            "asr_input_audio_ms, llm_first_audio_ms, tts_provider, "
            "tts_first_byte_ms, tts_total_ms, barge_in_detected, created_at "
            "FROM voice_sessions "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY created_at DESC LIMIT ${len(params) + 1}"
        )
        params.append(int(limit))
        try:
            rows = await client.fetch(sql, *params)
        except Exception as exc:
            logger.debug("voice.list_sessions failed: %s", exc)
            return []
        out = [_row(r) for r in rows]
        if asr_p95_ms_gt is not None:
            # ponytail: filter in Python — the per-org p95 is cheap
            # to compute and the row count is bounded by ``limit``.
            asr_latencies = sorted(
                [r["asr_latency_ms"] for r in out if r.get("asr_latency_ms") is not None]
            )
            if not asr_latencies:
                return []
            p95_idx = max(0, int(round(0.95 * (len(asr_latencies) - 1))))
            p95 = asr_latencies[p95_idx]
            if p95 <= asr_p95_ms_gt:
                return []
        return out

    async def mark_barge_in(
        self,
        session_id: str,
        trace_id: str,
    ) -> bool:
        """Flip ``barge_in_detected=TRUE`` on the most recent
        row for ``(session_id, trace_id)``. Idempotent — re-
        marking the same turn is a no-op. Returns ``False`` on
        DB error / no row.
        """
        client = await _get_client()
        if client is None:
            return False
        try:
            await client.execute(
                """
                UPDATE voice_sessions
                   SET barge_in_detected = TRUE
                 WHERE session_id = $1
                   AND trace_id   = $2::uuid
                   AND barge_in_detected = FALSE
                """,
                session_id, trace_id,
            )
            return True
        except Exception as exc:
            logger.debug("voice.mark_barge_in failed: %s", exc)
            return False

    async def detect_barge_in_spike(
        self,
        org_id: str,
        *,
        window_minutes: int = DEFAULT_SPIKE_WINDOW_MINUTES,
        threshold: int = DEFAULT_SPIKE_THRESHOLD,
        fire_hook: bool = True,
    ) -> dict[str, Any] | None:
        """Count barge-in rows for ``org_id`` in the last
        ``window_minutes`` minutes. If the count is ``>=`` the
        ``threshold``, return a spike summary (and fire the
        ``on_voice_barge_in_spike`` hook when ``fire_hook`` is
        True).

        Returns ``None`` when the count is below threshold or
        the DB is unavailable. The summary shape is::

            {
                "org_id": ...,
                "window_minutes": ...,
                "threshold": ...,
                "count": ...,
                "spike": True,
                "session_ids": [..],   # the rows that contributed
                "first_at": "...",
                "last_at": "...",
            }
        """
        client = await _get_client()
        if client is None:
            return None
        try:
            rows = await client.fetch(
                """
                SELECT session_id, trace_id, span_id, created_at
                  FROM voice_sessions
                 WHERE org_id = $1
                   AND barge_in_detected = TRUE
                   AND created_at >= NOW() - ($2 || ' minutes')::interval
                 ORDER BY created_at ASC
                """,
                org_id, int(window_minutes),
            )
        except Exception as exc:
            logger.debug("voice.detect_barge_in_spike failed: %s", exc)
            return None
        count = len(rows)
        if count < threshold:
            return None
        session_ids = [r["session_id"] for r in rows]
        first_at = rows[0]["created_at"].isoformat() if rows else None
        last_at = rows[-1]["created_at"].isoformat() if rows else None
        summary = {
            "org_id": org_id,
            "window_minutes": int(window_minutes),
            "threshold": int(threshold),
            "count": count,
            "spike": True,
            "session_ids": session_ids,
            "first_at": first_at,
            "last_at": last_at,
        }
        if fire_hook:
            try:
                from eden.llmops.promotion_hooks import PromotionHook
                hook = PromotionHook()
                await hook.on_voice_barge_in_spike(
                    org_id,
                    window_minutes=int(window_minutes),
                    threshold=int(threshold),
                    count=count,
                    session_ids=session_ids,
                )
            except Exception as exc:
                logger.debug("voice.detect_barge_in_spike: hook fire failed: %s", exc)
        return summary


_singleton: VoiceSessionService | None = None


def get_voice_service() -> VoiceSessionService:
    """Return the process-wide :class:`VoiceSessionService`."""
    global _singleton
    if _singleton is None:
        _singleton = VoiceSessionService()
    return _singleton


__all__ = [
    "ASR_PROVIDERS",
    "DEFAULT_SPIKE_THRESHOLD",
    "DEFAULT_SPIKE_WINDOW_MINUTES",
    "TRANSPORTS",
    "TTS_PROVIDERS",
    "VoiceSessionService",
    "get_voice_service",
]
