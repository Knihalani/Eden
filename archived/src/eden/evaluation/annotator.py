"""T1 trace annotator — semantic headline tags after Layer A ($ soft).

Layer A already owns deterministic float scores
(``tool_selection_quality``, ``action_completion``, ``groundedness``,
``safety``, ``efficiency``, ``trace_quality``). This module does **not**
re-score those axes.

It only adds searchable ``eval:llm:*`` tags for semantic gaps Layer A is
weak on (wrong tool intent, ignored result nuance, hallucination,
incomplete goal, user frustration). Never creates Issues or stumbles.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Operator-facing headline tags the T1 model may emit.
ALLOWED_TAGS: frozenset[str] = frozenset(
    {
        "wrong_tool",
        "ignored_result",
        "hallucination",
        "incomplete",
        "user_frustrated",
        "needs_review",
        "success",
        "cost_spike",
        "timeout",
        "jailbreak",
        "pii_risk",
    }
)

# Layer A primary descriptor ids that already cover a headline tag —
# skip re-emitting the LLM twin when Layer A already fired.
_LAYER_A_COVERS: dict[str, frozenset[str]] = {
    "wrong_tool": frozenset({"wrong_tool", "unnecessary_tool_call", "extra_tool_call"}),
    "ignored_result": frozenset({"result_ignore", "partial_result_use", "stale_tool_result"}),
    "hallucination": frozenset({"output_fabrication", "inaccuracy"}),
    "incomplete": frozenset({"action_incomplete", "goal_abandoned", "dead_end"}),
    "cost_spike": frozenset({"cost_spike"}),
    "timeout": frozenset({"timeout"}),
    "jailbreak": frozenset({"jailbreak_attempt"}),
    "pii_risk": frozenset({"pii_leak_risk"}),
}

_SYSTEM = """You label agent traces for search and human review.
Return ONLY JSON: {"tags": ["..."], "confidence": 0.0}
Use ONLY tags from this list (omit if not applicable):
wrong_tool, ignored_result, hallucination, incomplete, user_frustrated,
needs_review, success, cost_spike, timeout, jailbreak, pii_risk.
Prefer empty tags over guesses. Do not invent scores or new tag names."""


@dataclass
class AnnotatorResult:
    tags: list[str] = field(default_factory=list)
    confidence: float = 0.0
    model: str = ""
    cost_usd: float = 0.0
    skipped_reason: str | None = None


def _enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "trace_annotator_v1", True))
    except Exception:
        return True


def _sample_rate() -> float:
    """Fraction of finalized traces that get an LLM annotation."""
    try:
        from eden.config import get_settings

        raw = getattr(get_settings(), "trace_annotator_sample_rate", 0.02)
        rate = float(0.02 if raw is None else raw)
    except Exception:
        rate = 0.02
    return min(1.0, max(0.0, rate))


def sampled_in(trace_id: str, rate: float | None = None) -> bool:
    """Deterministic per-trace sample gate.

    Keyed off the trace id (never a random draw) so the finalized-trace
    consumer's retry ladder gets the same answer on every attempt -- a
    random draw would let a 3x retry turn a 10% sample into ~27%.
    """
    r = _sample_rate() if rate is None else min(1.0, max(0.0, float(rate)))
    if r >= 1.0:
        return True
    if r <= 0.0:
        return False
    try:
        from eden.experiments._common import _hash_to_unit_interval
    except Exception:  # pragma: no cover - defensive import guard
        return False
    return _hash_to_unit_interval("trace_annotator", trace_id) < r


async def _budget_ok(org_id: str) -> bool:
    """Org kill switch + daily maintenance budget + system lane cap.

    Checks three gates in order (cheapest first):
    1. Feature kill switch (org-level opt-out).
    2. Per-org daily maintenance budget via autonomy_policy (Redis).
    3. OOM W3-5 system-wide annotator lane daily cap (LaneDailyBudget).

    Fails CLOSED for (1) and (2) because an unreachable budget backend
    must not be a licence to spend.  Gate (3) is fail-open per the OOM
    W3-5 spec: if Redis is down the lane continues and a WARNING is logged.
    """
    try:
        from eden.llmops.feature_kills import is_feature_enabled

        if not await is_feature_enabled(org_id, "trace_annotator"):
            return False
    except Exception as exc:
        logger.debug("annotator: feature kill check failed: %s", exc)
        return False

    try:
        from eden.closed_loop.autonomy_policy import check_budget

        ok, _spent, _limit = await check_budget(org_id)
        if not ok:
            logger.info("annotator: budget exhausted org=%s", org_id)
            return False
    except Exception as exc:
        logger.debug("annotator: budget check failed: %s", exc)
        return False

    # OOM W3-5 — system-wide annotator lane daily cap (fail-open).
    try:
        from eden.llmops.evolution_spend import LaneDailyBudget

        allowed, spent, cap = await LaneDailyBudget("annotator").check()
        if not allowed:
            logger.warning(
                "annotator: system lane budget exceeded "
                "(spent=%.4f cap=%.4f) — skipping LLM call",
                spent,
                cap,
            )
            return False
    except Exception as exc:
        logger.debug("annotator: lane budget check failed (fail-open): %s", exc)

    return True


def compact_events(events: list[dict[str, Any]], *, max_chars: int = 1000) -> str:
    """Compress trajectory into a short prompt body."""
    lines: list[str] = []
    for ev in events[:25]:
        et = str(ev.get("event_type") or ev.get("type") or "")
        name = str(ev.get("name") or ev.get("span_name") or "")
        attrs = ev.get("attributes") or ev.get("data") or {}
        if not isinstance(attrs, dict):
            attrs = {}
        snippet = ""
        for key in ("content", "output", "input", "arguments", "result", "error"):
            val = attrs.get(key) or ev.get(key)
            if val is None:
                continue
            text = val if isinstance(val, str) else json.dumps(val, default=str)
            snippet = text[:240]
            break
        line = f"{et}|{name}|{snippet}".strip("|")
        if line:
            lines.append(line)
        if sum(len(x) for x in lines) > max_chars:
            break
    body = "\n".join(lines)
    return body[:max_chars]


def parse_annotator_response(raw: str) -> tuple[list[str], float]:
    """Parse model JSON into allowed tags + confidence."""
    text = (raw or "").strip()
    if not text:
        return [], 0.0
    # Strip markdown fences if present.
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return [], 0.0
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return [], 0.0
    if not isinstance(data, dict):
        return [], 0.0
    raw_tags = data.get("tags") or []
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = sorted(
        {
            str(t).strip().lower().replace(" ", "_")
            for t in raw_tags
            if str(t).strip().lower().replace(" ", "_") in ALLOWED_TAGS
        }
    )
    try:
        conf = float(data.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))
    return tags, conf


def filter_covered_by_layer_a(
    tags: list[str], layer_a_ids: set[str] | frozenset[str]
) -> list[str]:
    """Drop LLM tags already covered by Layer A primary/heuristic hits."""
    out: list[str] = []
    for tag in tags:
        covered = _LAYER_A_COVERS.get(tag)
        if covered and (covered & set(layer_a_ids)):
            continue
        out.append(tag)
    return out


def tags_to_persist(tags: list[str], confidence: float) -> dict[str, str]:
    """Build merge_trace_tags payload (``eval:llm:*``)."""
    if not tags:
        return {}
    conf_s = f"{confidence:.3f}"
    out = {f"eval:llm:{t}": conf_s for t in tags}
    out["eval:llm"] = ",".join(sorted(tags))
    return out


async def annotate_trace(
    org_id: str,
    trace_id: str,
    events: list[dict[str, Any]],
    *,
    layer_a_ids: set[str] | frozenset[str] | None = None,
    llm_client: Any | None = None,
) -> AnnotatorResult:
    """Run T1 ModelRouter annotator; return tags (no Issues)."""
    if not _enabled():
        return AnnotatorResult(skipped_reason="disabled")
    if not events:
        return AnnotatorResult(skipped_reason="no_events")
    # Cheap gates before the paid ones: sampling first (pure hash), then
    # the org kill-switch + daily budget round trip.
    if not sampled_in(trace_id):
        return AnnotatorResult(skipped_reason="not_sampled")
    if not await _budget_ok(org_id):
        return AnnotatorResult(skipped_reason="budget_exhausted")

    body = compact_events(events)
    if not body.strip():
        return AnnotatorResult(skipped_reason="empty_compact")

    try:
        from eden.llm.internal_router import route_async
    except Exception as exc:
        logger.debug("annotator: router import failed: %s", exc)
        return AnnotatorResult(skipped_reason="router_unavailable")

    prompt = f"Trace {trace_id} trajectory:\n{body}\n\nLabel this trace."
    try:
        resp = await route_async(
            "trace_annotator",
            prompt,
            slot="fast",
            system_prompt=_SYSTEM,
            description="agent trace headline tags",
            output_type="json",
            expected_min_length=10,
            requires_quality_check=False,
            llm_client=llm_client,
            org_id=org_id,
            feature="trace_annotator",
        )
    except Exception as exc:
        logger.debug("annotator: route_async failed: %s", exc)
        return AnnotatorResult(skipped_reason=f"llm_error:{exc}")

    content = getattr(resp, "content", None) or getattr(resp, "text", "") or ""
    tags, conf = parse_annotator_response(str(content))
    if layer_a_ids:
        tags = filter_covered_by_layer_a(tags, layer_a_ids)
    # Cost lives on ``resp.usage.cost`` (``UsageStats.cost``), NOT on the
    # response itself — ``LLMResponse`` is
    # ``(content, usage, model, finish_reason, raw_response)`` and has no
    # ``cost_usd`` field. Reading it via getattr with a 0.0 default meant
    # ``cost`` was ALWAYS 0.0, so the ``if cost > 0`` below never fired,
    # ``record_spend`` was never called, and the daily maintenance budget
    # that ``_budget_ok`` checks at the top of this function could never
    # accumulate — the cap could not trip no matter how much was spent.
    # This is the only LLM feature that is on by default
    # (``trace_annotator_v1``), so it was the one gate that most needed to
    # work. ``sibling judges/unified.py`` already reads ``.usage.cost``.
    #
    # ``cost_usd`` is still accepted as a fallback so a caller passing a
    # duck-typed response object keeps working.
    usage = getattr(resp, "usage", None)
    cost = float(
        getattr(usage, "cost", None)
        or getattr(resp, "cost_usd", 0.0)
        or 0.0
    )
    model = str(getattr(resp, "model", "") or "")
    # Feed the spend back into the same ledger ``_budget_ok`` reads, or the
    # budget gate above can never trip.
    if cost > 0:
        try:
            from eden.closed_loop.autonomy_policy import record_spend

            await record_spend(org_id, cost)
        except Exception as exc:
            logger.debug("annotator: record_spend failed: %s", exc)
    return AnnotatorResult(
        tags=tags,
        confidence=conf,
        model=model,
        cost_usd=cost,
    )


async def annotate_and_persist(
    org_id: str,
    trace_id: str,
    events: list[dict[str, Any]],
    *,
    layer_a_ids: set[str] | frozenset[str] | None = None,
    llm_client: Any | None = None,
) -> AnnotatorResult:
    """Annotate then merge ``eval:llm:*`` tags onto the trace."""
    result = await annotate_trace(
        org_id,
        trace_id,
        events,
        layer_a_ids=layer_a_ids,
        llm_client=llm_client,
    )
    payload = tags_to_persist(result.tags, result.confidence)
    if not payload:
        return result
    try:
        from eden.observability._trace_common import merge_trace_tags

        await merge_trace_tags(org_id, trace_id, payload)
    except Exception as exc:
        logger.debug("annotator: persist tags failed: %s", exc)
    return result
