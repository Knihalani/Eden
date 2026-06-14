"""Root Cause Analysis (Cat 2) — real implementation.

Auto-categorises failures as ``retrieval``, ``tool``, ``prompt``,
``model``, ``memory``, or ``user_issue`` and returns a confidence
score plus top-k contributing signals. The implementation is a
**rule-based pre-filter** that walks a 6-rule table in priority
order and returns the first match. Confidence is then adjusted
by signal-multiplicity, trace-size, and judge-corroboration
heuristics.

Phase 1 upgrade path (deferred): an LLM-as-judge fallback for
cases where no rule fires with confidence > 0.6. The LLM would
use the existing :class:`eden.llmops.judges.builtin_v9` registry
the same way :class:`eden.decision.decision_scorer.DecisionScorer`
does. For this run the response carries
``model: "rule_based_v1"`` so the front-end knows what it got.

See ``docs/observability-gap/02-root-cause-incidents.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.insights.rca._common import (
    CATEGORIES,
    _classify_events,
    _delete_then_insert_rca,
    _error_type_from_event,
    _fetch_judge_scores,
    _fetch_similar_rca_analyses,
    _fetch_trace_events,
    _first_failed_event,
    _json_dumps,
    _make_explanation,
    _not_found_envelope,
    _ok_envelope,
    _pick_top_signals,
)

logger = logging.getLogger(__name__)


class RootCauseAnalyzer:
    """Categorise a failed trace into one of six failure classes.

    The 6-class taxonomy is fixed; the public surface returns the
    same shape regardless of the rule that fired so consumers
    (UI, downstream services) can render a single card.
    """

    name = "rca_analyzer"

    #: Re-exported so callers can introspect the taxonomy without
    #: importing :mod:`eden.insights.rca._common`.
    CATEGORIES = CATEGORIES

    # ── Confidence adjustment constants ───────────────────────────
    #: Cap so we never claim > 97% confidence from a rule-only
    #: pre-filter. An LLM-as-judge (Phase 1) can push past this.
    CONFIDENCE_CAP: float = 0.97
    #: Additive bonus when 2+ independent signals point to the
    #: same category (rare today — only judges can give a 2nd
    #: signal — but documented for the LLM-as-judge upgrade).
    MULTI_SIGNAL_BONUS: float = 0.05
    #: Penalty when the trace has only a single event (low
    #: statistical power; the rule may have been triggered by
    #: noise).
    SINGLE_EVENT_PENALTY: float = 0.10
    #: Penalty when no ``judge_scores`` rows exist at all — the
    #: rules that depend on judge corroboration (rules 3 + 4) are
    #: then blind, so confidence drops.
    NO_JUDGES_PENALTY: float = 0.05

    # ── Public API ────────────────────────────────────────────────

    async def categorize(
        self, org_id: str, trace_id: str
    ) -> dict[str, Any]:
        """Classify ``trace_id`` and persist the result.

        Returns the live envelope: ``{status, feature, live,
        trace_id, timestamp, data}`` where ``data`` carries
        ``category``, ``confidence``, ``signals`` (top-3),
        ``trace_id``, and ``model: "rule_based_v1"``. On a missing
        trace the envelope is ``status="not_found"``.
        """
        events = await _fetch_trace_events(org_id, trace_id)
        if not events:
            return _not_found_envelope(self.name, trace_id=trace_id)

        judge_scores = await _fetch_judge_scores(org_id, trace_id)
        category, confidence, raw_signals = _classify_events(
            events, judge_scores
        )

        # Adjustments
        if len(events) == 1:
            confidence -= self.SINGLE_EVENT_PENALTY
        if not judge_scores:
            confidence -= self.NO_JUDGES_PENALTY
        # Multi-signal bonus: only meaningful when the same
        # category appears in 2+ independent rule outputs. Our
        # first-match-wins design means the bonus is rare; we
        # still apply it so the formula is symmetric across
        # services.
        if len(raw_signals) >= 2:
            confidence += self.MULTI_SIGNAL_BONUS
        confidence = max(0.0, min(self.CONFIDENCE_CAP, confidence))

        top_signals = _pick_top_signals(raw_signals, k=3)
        explanation = _make_explanation(category, top_signals)
        # Extract error_type from the first failed event so
        # :func:`explain` can do a precise LIKE filter when
        # looking up similar incidents. We use the event's
        # ``error.type`` column (not the human-readable signal
        # text) so the filter matches the actual error class,
        # not the tool name.
        first_failed = _first_failed_event(events)
        error_type = _error_type_from_event(first_failed)

        # Persist (best-effort — the inner helper already swallows
        # DB errors, but we add a defensive guard so an exception
        # raised by a test mock or by an import-time error in the
        # persistence module doesn't break the live response).
        try:
            await _delete_then_insert_rca(
                org_id,
                trace_id,
                category=category,
                confidence=confidence,
                signals_json=_json_dumps(top_signals),
                explanation=explanation,
            )
        except Exception as exc:
            logger.debug("analyzer.categorize: persist failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "category": category,
                "confidence": round(confidence, 4),
                "signals": top_signals,
                "explanation": explanation,
                "error_type": error_type,
                "model": "rule_based_v1",
            },
        )

    async def explain(
        self, org_id: str, trace_id: str
    ) -> dict[str, Any]:
        """Return the 1-sentence cause + top-3 contributing
        factors + similar incidents from the last 30 days.

        Internally re-uses :func:`categorize` so the
        classification is the same; we just add the
        "explainability" payload (cause sentence, similar
        incidents). We do NOT re-persist the categorize row
        (would clobber the latest classify), but we DO read the
        rca_analyses table for similar incidents.
        """
        cat = await self.categorize(org_id, trace_id)
        if cat.get("status") == "not_found":
            return cat
        data = cat.get("data") or {}
        category = data.get("category", "model")
        signals = data.get("signals", [])
        explanation = data.get("explanation", "")

        # Build the 1-sentence cause
        cause = f"{category} failure: {signals[0]}" if signals else f"{category} failure."

        # Pull similar incidents: same category + (precise) same
        # error type. The error_type comes from the categorize
        # response (extracted from the first failed event's
        # ``error.type`` column) — not from parsing the signal
        # text, which would pick up the tool name in tool-failure
        # signals.
        error_type = data.get("error_type") or ""
        similar = await _fetch_similar_rca_analyses(
            org_id, category=category, error_type=error_type,
            exclude_trace_id=trace_id, limit=5,
        )

        # Compute similarity per row. Same (category, error_type)
        # → 1.0; same category only → 0.7; no match → exclude.
        similar_incidents: list[dict[str, Any]] = []
        for row in similar:
            sig = (row.get("signals_json") or "").lower()
            sim = 1.0 if error_type and error_type.lower() in sig else 0.7
            similar_incidents.append(
                {
                    "trace_id": row.get("trace_id"),
                    "category": row.get("category"),
                    "confidence": row.get("confidence"),
                    "similarity": sim,
                    "explanation": row.get("explanation"),
                }
            )

        envelope_data: dict[str, Any] = {
            "trace_id": trace_id,
            "category": category,
            "cause": cause,
            "contributing_factors": signals[:3],
            "confidence": data.get("confidence"),
            "explanation": explanation,
            "similar_incidents": similar_incidents,
        }
        if not similar_incidents:
            envelope_data["note"] = "no similar incidents found"

        return _ok_envelope(self.name, envelope_data)
