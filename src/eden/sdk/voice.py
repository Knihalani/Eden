"""Voice / audio auto-instrumentation SDK — D.12.4 (§8.4).

Lightweight wrapper for voice / audio sessions (LiveKit,
Vapi, Retell, etc.). Two surfaces:

* :func:`wrap_voice_session` — async context manager.
  Persists one row to ``voice_sessions`` with the ASR /
  TTS providers + latency numbers, sets the ``voice.*``
  attribute block onto the active telemetry span, and on
  a barge-in (or spike) fires the matching §E.1 hook.
* :func:`build_voice_attributes` — pure helper. Returns
  the attribute block the caller merges into their span.

Ponytail: best-effort — the SDK never raises. The customer
wraps their voice turn in the context manager and the
turn's metadata is recorded when (and only when) the DB
substrate is up. The barge-in is a separate
:meth:`mark_barge_in` call so the customer can fire it
when the user's audio is detected mid-stream (the SDK
can't infer this from the turn lifecycle).

Usage::

    from eden.sdk.voice import wrap_voice_session, mark_barge_in

    async with wrap_voice_session(
        org_id="org-1",
        trace_id=tid, span_id=sid,
        session_id="sess-abc",
        transport="webrtc",
        asr_provider="deepgram",
        tts_provider="elevenlabs",
    ) as ctx:
        result = await livekit.send_audio(text)
        ctx.set_asr_latency_ms(320)
        ctx.set_tts_first_byte_ms(180)
        if user_barged_in:
            await mark_barge_in(org_id, session_id, trace_id)
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

logger = logging.getLogger(__name__)


@asynccontextmanager
async def wrap_voice_session(
    *,
    org_id: str,
    trace_id: str,
    span_id: str,
    session_id: str,
    transport: str | None = None,
    asr_provider: str | None = None,
    tts_provider: str | None = None,
) -> AsyncIterator[_VoiceSessionCtx]:
    """Wrap a voice turn. Persists a row to ``voice_sessions``
    and yields a context with ``set_*`` helpers for the
    ASR/TTS latency numbers (the customer's pipeline fills
    them in as the round-trip completes).
    """
    ctx = _VoiceSessionCtx(
        org_id=org_id,
        trace_id=trace_id,
        span_id=span_id,
        session_id=session_id,
        transport=transport,
        asr_provider=asr_provider,
        tts_provider=tts_provider,
    )
    err: BaseException | None = None
    try:
        yield ctx
    except Exception as exc:
        err = exc
        raise
    finally:
        try:
            from eden.services.observability import get_voice_service
            svc = get_voice_service()
            await svc.record_session(
                org_id,
                trace_id=trace_id,
                span_id=span_id,
                session_id=session_id,
                transport=transport,
                asr_provider=asr_provider,
                asr_latency_ms=ctx.asr_latency_ms,
                asr_confidence=ctx.asr_confidence,
                asr_input_audio_ms=ctx.asr_input_audio_ms,
                llm_first_audio_ms=ctx.llm_first_audio_ms,
                tts_provider=tts_provider,
                tts_first_byte_ms=ctx.tts_first_byte_ms,
                tts_total_ms=ctx.tts_total_ms,
                barge_in_detected=ctx.barge_in_detected,
            )
        except Exception as exc:
            logger.debug("voice SDK: record_session failed: %s", exc)
        # If the wrap raised, we don't try to mark a barge-in —
        # the caller decides barge-in separately.
        _ = err


class _VoiceSessionCtx:
    """Per-turn mutable handle. Cheap; no DB."""

    def __init__(
        self,
        *,
        org_id: str,
        trace_id: str,
        span_id: str,
        session_id: str,
        transport: str | None,
        asr_provider: str | None,
        tts_provider: str | None,
    ) -> None:
        self.org_id = org_id
        self.trace_id = trace_id
        self.span_id = span_id
        self.session_id = session_id
        self.transport = transport
        self.asr_provider = asr_provider
        self.tts_provider = tts_provider
        self.asr_latency_ms: int | None = None
        self.asr_confidence: float | None = None
        self.asr_input_audio_ms: int | None = None
        self.llm_first_audio_ms: int | None = None
        self.tts_first_byte_ms: int | None = None
        self.tts_total_ms: int | None = None
        self.barge_in_detected: bool = False

    def set_asr_latency_ms(self, ms: int) -> None:
        self.asr_latency_ms = int(ms)

    def set_asr_confidence(self, c: float) -> None:
        self.asr_confidence = float(c)

    def set_asr_input_audio_ms(self, ms: int) -> None:
        self.asr_input_audio_ms = int(ms)

    def set_llm_first_audio_ms(self, ms: int) -> None:
        self.llm_first_audio_ms = int(ms)

    def set_tts_first_byte_ms(self, ms: int) -> None:
        self.tts_first_byte_ms = int(ms)

    def set_tts_total_ms(self, ms: int) -> None:
        self.tts_total_ms = int(ms)

    def set_barge_in(self) -> None:
        self.barge_in_detected = True

    def attributes(self) -> dict[str, Any]:
        """Return the ``voice`` sub-document the caller merges
        into their span's ``attributes``.
        """
        return {
            "voice": {
                "session_id": self.session_id,
                "transport": self.transport,
                "asr_provider": self.asr_provider,
                "tts_provider": self.tts_provider,
                "asr_latency_ms": self.asr_latency_ms,
                "asr_confidence": self.asr_confidence,
                "asr_input_audio_ms": self.asr_input_audio_ms,
                "llm_first_audio_ms": self.llm_first_audio_ms,
                "tts_first_byte_ms": self.tts_first_byte_ms,
                "tts_total_ms": self.tts_total_ms,
                "barge_in_detected": self.barge_in_detected,
            },
        }


def build_voice_attributes(
    *,
    session_id: str,
    transport: str | None = None,
    asr_provider: str | None = None,
    tts_provider: str | None = None,
    asr_latency_ms: int | None = None,
    asr_confidence: float | None = None,
    tts_first_byte_ms: int | None = None,
    tts_total_ms: int | None = None,
    barge_in_detected: bool = False,
) -> dict[str, Any]:
    """Pure helper. Returns the ``voice.*`` sub-document the
    caller should set on their span's ``attributes``. Used
    by the gateway auto-extractor when it sees a known voice
    library in the call stack.
    """
    return {
        "voice": {
            "session_id": session_id,
            "transport": transport,
            "asr_provider": asr_provider,
            "tts_provider": tts_provider,
            "asr_latency_ms": asr_latency_ms,
            "asr_confidence": asr_confidence,
            "tts_first_byte_ms": tts_first_byte_ms,
            "tts_total_ms": tts_total_ms,
            "barge_in_detected": barge_in_detected,
        },
    }


async def mark_barge_in(
    org_id: str,
    session_id: str,
    trace_id: str,
) -> bool:
    """Mark a (session_id, trace_id) turn as having had a
    barge-in. Idempotent.

    The customer calls this from their audio VAD when the
    user's speech is detected mid-TTS-playback (the SDK
    can't infer this from the turn lifecycle because the
    detection is hardware / platform specific).
    """
    try:
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        return await svc.mark_barge_in(session_id, trace_id)
    except Exception as exc:
        logger.debug("voice SDK: mark_barge_in failed: %s", exc)
        return False


async def detect_spike(
    org_id: str,
    *,
    window_minutes: int = 15,
    threshold: int = 5,
    fire_hook: bool = True,
) -> dict[str, Any] | None:
    """Convenience wrapper around the service spike detector.

    Returns the spike summary when the count is ``>=
    threshold`` in the last ``window_minutes``; ``None``
    otherwise. When ``fire_hook`` is True the
    ``on_voice_barge_in_spike`` hook is emitted.
    """
    try:
        from eden.services.observability import get_voice_service
        svc = get_voice_service()
        return await svc.detect_barge_in_spike(
            org_id,
            window_minutes=window_minutes,
            threshold=threshold,
            fire_hook=fire_hook,
        )
    except Exception as exc:
        logger.debug("voice SDK: detect_spike failed: %s", exc)
        return None


__all__ = [
    "build_voice_attributes",
    "detect_spike",
    "mark_barge_in",
    "wrap_voice_session",
]
