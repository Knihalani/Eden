"""060_voice_sessions — D.12.4 Voice / audio sessions per upgradespec §B.7.

Revision ID: 060
Revises: 059
Create Date: 2026-06-24

Per spec §B.7 (D.12.4):

    CREATE TABLE voice_sessions (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id            UUID NOT NULL,
        span_id             UUID NOT NULL,
        session_id          TEXT NOT NULL,
        transport           TEXT,              -- 'webrtc' | 'websocket' | 'sip'
        asr_provider         TEXT,              -- 'deepgram' | 'whisper' | 'assemblyai'
        asr_latency_ms       INTEGER,
        asr_confidence      NUMERIC(4,3),
        asr_input_audio_ms  INTEGER,
        llm_first_audio_ms  INTEGER,
        tts_provider         TEXT,              -- 'elevenlabs' | 'cartesia' | 'openai'
        tts_first_byte_ms    INTEGER,
        tts_total_ms         INTEGER,
        barge_in_detected    BOOLEAN DEFAULT FALSE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (trace_id) REFERENCES telemetry_events(id) ON DELETE CASCADE
    );

Ponytail: ``org_id`` added (spine convention) so the service can
org-scope without joining ``telemetry_events``. Spec's exact
transport / asr_provider / tts_provider values are kept as
informal strings (no CHECK constraints) — voice providers are
constantly evolving and a hard enum here would block valid
integrations (LiveKit, Vapi, Retell, Daily, etc.). The service
is best-effort and a fresh provider string is a passing case.
"""

from __future__ import annotations

from alembic import op

revision = "060"
down_revision = "059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS voice_sessions (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID NOT NULL,
            session_id          TEXT NOT NULL,
            transport           TEXT,
            asr_provider         TEXT,
            asr_latency_ms       INTEGER,
            asr_confidence      NUMERIC(4,3),
            asr_input_audio_ms  INTEGER,
            llm_first_audio_ms  INTEGER,
            tts_provider         TEXT,
            tts_first_byte_ms    INTEGER,
            tts_total_ms         INTEGER,
            barge_in_detected    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_voice_sessions_trace "
        "ON voice_sessions(trace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_voice_sessions_session "
        "ON voice_sessions(session_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_voice_sessions_org_barge "
        "ON voice_sessions(org_id, created_at DESC) "
        "WHERE barge_in_detected = TRUE"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_voice_sessions_org_barge")
    op.execute("DROP INDEX IF EXISTS idx_voice_sessions_session")
    op.execute("DROP INDEX IF EXISTS idx_voice_sessions_trace")
    op.execute("DROP TABLE IF EXISTS voice_sessions")
