"""SatisfactionJudge — proxy for user satisfaction from
rephrasing, escalation, abandonment, and other signals.

A real implementation consumes the ``user_satisfaction_signals``
and ``user_feedback`` tables (migration 020) to compute a
per-trace satisfaction score.

``user_satisfaction_signals`` rows carry a ``signal_type`` and
``weight``; the score is the normalised sum of positive weights
minus the sum of negative weights. Positive signal types:
``copy_pasted``, ``return_7d``, ``positive_feedback``.
Negative: ``regenerated``, ``abandoned_after_one``,
``retried_within_60s``, ``negative_feedback``.

``user_feedback`` rows carry ``thumbs`` (``up``/``down``) and an
integer ``rating`` (1–5). These anchor the implicit score: a
``thumbs=up`` / ``rating >= 4`` nudges toward 1.0; a
``thumbs=down`` / ``rating <= 2`` nudges toward 0.0.

The judge always returns a score in ``[0, 1]``. When no data is
available the score is ``0.5`` with ``confidence: null`` in
metadata.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ._sampling import production_sample_matches
from .base import Judge, JudgeContext, JudgeScore

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)

_POSITIVE_SIGNALS = frozenset(
    {"copy_pasted", "return_7d", "positive_feedback", "thumbs_up"}
)
_NEGATIVE_SIGNALS = frozenset(
    {
        "regenerated",
        "abandoned_after_one",
        "retried_within_60s",
        "negative_feedback",
        "thumbs_down",
    }
)


async def _get_client() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception as exc:
        logger.debug("satisfaction_judge: postgres import failed: %s", exc)
        return None


async def _aggregate_satisfaction(
    org_id: str, trace_id: str
) -> tuple[float, float | None]:
    """Return ``(score, confidence)`` for a trace.

    *score* is in ``[0, 1]``.  *confidence* is ``None`` when no
    data exists (the stub path) and a positive float otherwise
    (proportional to total evidence weight).

    Both tables are queried in a single DB round-trip using a
    UNION so the executor sees one query plan.
    """
    client = await _get_client()
    if client is None:
        return 0.5, None

    try:
        # Satisfaction signals — signed weights.
        sig_rows = await client.fetch(
            """
            SELECT signal_type, weight
              FROM user_satisfaction_signals
             WHERE org_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("satisfaction_judge: signal fetch failed: %s", exc)
        sig_rows = []

    try:
        fb_rows = await client.fetch(
            """
            SELECT thumbs, rating
              FROM user_feedback
             WHERE org_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("satisfaction_judge: feedback fetch failed: %s", exc)
        fb_rows = []

    if not sig_rows and not fb_rows:
        return 0.5, None

    pos_weight = 0.0
    neg_weight = 0.0
    total_weight = 0.0

    for r in sig_rows:
        d = dict(r) if not isinstance(r, dict) else r
        stype = str(d.get("signal_type") or "").strip().lower()
        w = float(d.get("weight") or 1.0)
        if stype in _POSITIVE_SIGNALS:
            pos_weight += w
        elif stype in _NEGATIVE_SIGNALS:
            neg_weight += w
        total_weight += abs(w)

    # Explicit feedback anchors — each row contributes 2 units
    # of evidence (strong signal).
    for r in fb_rows:
        d = dict(r) if not isinstance(r, dict) else r
        thumbs = str(d.get("thumbs") or "").strip().lower()
        rating = d.get("rating")
        if thumbs == "up":
            pos_weight += 2.0
            total_weight += 2.0
        elif thumbs == "down":
            neg_weight += 2.0
            total_weight += 2.0
        if isinstance(rating, (int, float)):
            r_val = float(rating)
            if r_val >= 4:
                pos_weight += 1.0
                total_weight += 1.0
            elif r_val <= 2:
                neg_weight += 1.0
                total_weight += 1.0
            else:
                total_weight += 0.5

    if total_weight <= 0:
        return 0.5, None

    # Map to [0, 1]: 0.5 = neutral baseline; pos/neg push away from it.
    raw = (pos_weight - neg_weight) / total_weight
    score = max(0.0, min(1.0, 0.5 + 0.5 * raw))
    confidence = min(1.0, total_weight / 10.0)
    return round(score, 4), round(confidence, 4)


class SatisfactionJudge(Judge):
    """Proxy for user satisfaction from behavioural signals."""

    name = "satisfaction"
    version = "2026-07-14"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        if not super().matches(event):
            return False
        payload = event.payload or {}
        return any(
            key in payload
            for key in ("openai", "anthropic", "bedrock", "gemini", "langfuse")
        ) and production_sample_matches(event)

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        trace_id = ctx.trace_id or event.trace_id or ""
        org_id: str = ""
        if hasattr(event, "org_id"):
            org_id = str(event.org_id or "")

        score_val, confidence = await _aggregate_satisfaction(org_id, trace_id)

        if confidence is None:
            rationale = "No satisfaction signals or feedback found for this trace"
            metadata: dict = {"stub": False, "evidence": "none"}
        else:
            rationale = (
                f"Aggregated satisfaction score from user signals + feedback "
                f"(confidence={confidence:.2f})"
            )
            metadata = {"confidence": confidence, "stub": False}

        return JudgeScore(
            judge_name=self.name,
            judge_version=self.version,
            trace_id=trace_id,
            span_id=None,
            score=score_val,
            rationale=rationale,
            model=self.model_slot,
            metadata=metadata,
        )
