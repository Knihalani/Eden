"""HallucinationJudge — built-in judge that scores LLM output for
factual / fabrication issues.

Patterned after ``QualityValidator._judge_quality`` at
``src/eden/optimization/model_router.py:365`` but operating on a
``TelemetryEvent`` rather than a ``PipelineTask`` / content pair.
The judge prompt is small and stable; ``version`` is bumped when
the prompt changes so historical scores can be filtered.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


_HALLUCINATION_PROMPT = """You are a careful fact-checker. The following is an LLM-generated response.

Task / spec (may be empty):
{spec}

Response to evaluate:
{response}

On a scale of 0.0 (definitely a hallucination / fabrication) to 1.0 (clearly factual and on-spec), rate the response.

Return your answer as a JSON object: {{"score": <float>, "rationale": "<one short sentence>"}}
"""


class HallucinationJudge(Judge):
    """LLM-as-judge for hallucination / factual accuracy."""

    name = "hallucination"
    version = "2026-06-03"
    model_slot = "fast"

    def matches(self, event: TelemetryEvent) -> bool:
        """Only fire on events that carry generated text in the payload.

        The judge is also sample-gated at 1% (deterministic SHA-256
        of ``trace_id``) so flipping the global LLM-judge toggle on
        doesn't bill every telemetry event.
        """
        if not super().matches(event):
            return False
        payload = event.payload or {}
        if not any(
            key in payload
            for key in (
                "openai", "anthropic", "bedrock", "gemini", "langfuse",
                "helicone", "otel",
            )
        ):
            return False
        # Deterministic 1% sampling — every trace_id hashes to the
        # same bucket so a single trace's judge scores stay
        # consistent across re-evaluations. SHA-256 (not ``int(x, 16)``)
        # because trace ids can include non-hex characters (``tr_…``).
        # Bypassable via ``EDEN_DISABLE_PRODUCTION_SAMPLING=1`` so
        # unit tests don't have to construct a hashing trace_id.
        import os as _os
        trace_id = event.trace_id or ""
        if not trace_id:
            return False
        if _os.environ.get("EDEN_DISABLE_PRODUCTION_SAMPLING") == "1":
            return True
        import hashlib as _hl
        digest = _hl.sha256(trace_id.encode("utf-8")).digest()
        return digest[0] < 3  # ~1.2% of byte values are < 3

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        if ctx.llm_client is None:
            return self._low_confidence(event, ctx, reason="no llm_client")

        text, spec = _extract_text_and_spec(event)
        if not text:
            return self._low_confidence(event, ctx, reason="empty_response")

        prompt = _HALLUCINATION_PROMPT.format(
            spec=spec[:400] if spec else "(no spec provided)",
            response=text[:1200],
        )
        t0 = time.monotonic()
        try:
            resp = ctx.llm_client.call(
                agent=f"judge_{self.name}",
                prompt=prompt,
                slot=self.model_slot,
                max_tokens=120,
            )
            latency_ms = (time.monotonic() - t0) * 1000.0
            score, rationale = _parse_judge_response(resp.content)
            return JudgeScore(
                judge_name=self.name,
                judge_version=self.version,
                trace_id=ctx.trace_id or event.trace_id,
                span_id=event.span_id,
                score=score,
                rationale=rationale,
                model=getattr(resp, "model", "") or "unknown",
                latency_ms=latency_ms,
                metadata={"event_id": event.event_id},
            )
        except Exception as exc:
            logger.debug(f"hallucination judge failed: {exc}")
            return self._low_confidence(
                event, ctx, reason=f"judge_error:{type(exc).__name__}"
            )

    def _low_confidence(
        self, event: TelemetryEvent, ctx: JudgeContext, *, reason: str
    ) -> JudgeScore:
        """Return a neutral score with a clear rationale when we
        cannot produce a real judgment (no LLM, empty content, etc).
        Score 0.5 is "unknown" so it doesn't skew downstream
        aggregations."""
        return JudgeScore(
            judge_name=self.name,
            judge_version=self.version,
            trace_id=ctx.trace_id or event.trace_id,
            span_id=event.span_id,
            score=0.5,
            rationale=f"no_score:{reason}",
            model="n/a",
            metadata={"event_id": event.event_id, "reason": reason},
        )


def _extract_text_and_spec(event: TelemetryEvent) -> tuple[str, str]:
    """Pull the response text + spec from a TelemetryEvent's payload.

    The decoder-specific payload schemas are heterogeneous (Phase 0
    ships 7 decoders). We look for the common field names. When
    nothing matches, we return empty text so the caller can decide
    what to do (e.g. emit a "no_score" with reason="empty_response").
    """
    payload = event.payload or {}
    text = ""

    # Per-decoder "field to read" mapping. Each entry says: if the
    # payload has a sub-dict for this provider, look in it for one
    # of these fields (in order). First hit wins.
    candidates: list[tuple[str, list[str]]] = [
        ("openai", ["first_message_content", "response_text"]),
        ("anthropic", ["content_text"]),
        ("gemini", ["first_text"]),
        ("langfuse", ["output", "first_message_content"]),
        ("helicone", ["response_text", "response"]),
        ("bedrock", ["response_text"]),
        ("otel", ["output", "response_text", "first_text"]),
    ]
    for provider, field_names in candidates:
        sub_obj = payload.get(provider)
        if not isinstance(sub_obj, dict):
            continue
        for fname in field_names:
            v = sub_obj.get(fname)
            if isinstance(v, str) and v:
                text = v
                break
        if text:
            break

    spec = str(payload.get("task") or payload.get("spec") or "")
    return text, spec


def _parse_judge_response(content: str) -> tuple[float, str]:
    """Parse the LLM judge's JSON-shaped response.

    Accepts several shapes:
      - Strict JSON: ``{"score": 0.8, "rationale": "..."}``
      - JSON with surrounding prose
      - Bare float: ``"0.85"`` (degenerate case)
    Returns ``(score, rationale)``. Clamps score to [0.0, 1.0].
    """
    import json
    import re

    content = (content or "").strip()
    if not content:
        return 0.5, "empty_judge_response"

    # Try strict JSON first
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            score = float(obj.get("score", 0.5))
            rationale = str(obj.get("rationale", ""))
            return max(0.0, min(1.0, score)), rationale[:500]
        if isinstance(obj, (int, float)):
            return max(0.0, min(1.0, float(obj))), ""
    except (ValueError, TypeError):
        pass

    # Try to extract a JSON object from surrounding prose
    m = re.search(r"\{[^{}]*\"score\"[^{}]*\}", content)
    if m:
        try:
            obj = json.loads(m.group(0))
            score = float(obj.get("score", 0.5))
            rationale = str(obj.get("rationale", ""))
            return max(0.0, min(1.0, score)), rationale[:500]
        except (ValueError, TypeError):
            pass

    # Bare number fallback
    m = re.search(r"\b0?\.\d+\b", content)
    if m:
        try:
            return max(0.0, min(1.0, float(m.group(0)))), content[:200]
        except ValueError:
            pass

    return 0.5, content[:200]
