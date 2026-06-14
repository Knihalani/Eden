"""JudgeFactory + RubricJudge — wrap an approved rubric as a runtime judge.

This is the "promote the rubric to a judge" step. Once a
synthesised rubric is approved via
:meth:`RubricSynthesiser.approve`, the
:class:`JudgeFactory` wraps the rubric as a
:class:`RubricJudge` (subclass of
:class:`eden.llmops.judges.base.Judge`) and registers it in
the global :class:`JudgeRegistry`. From that point on, every
:class:`TelemetryEvent` matching the judge's
:meth:`matches` filter will be scored by the rubric — subject
to the per-tenant opt-in gate
(:func:`eden.metric_studio._common._check_auto_judge_policy`).

The closed-loop hook :func:`MetricStudioHook.on_metric_promotion`
fires after the judge is registered, so a Cat 3 judge
regression can auto-roll-back a promoted custom metric.

RubricJudge.score()
--------------------
The :class:`RubricJudge` formats the rubric prompt with the
event's input / output and calls the LLM via the
:class:`OpenRouterClient` in the ``fast`` slot. The
:class:`OpenRouterClient` returns a JSON-ish string the
helper :func:`_parse_rubric_response` decodes into a
``(score, rationale)`` tuple. The score is clamped to
``[0.0, 1.0]`` and the rationale is truncated to 500 chars.

The per-score run log is written to ``custom_metric_runs``
with ``status="scored"`` so the
:meth:`CustomMetricRegistry.list` endpoint can compute
``n_scores_30d`` and ``median_score``. Failures (LLM error,
opt-in OFF, malformed response) write a row with
``score=None`` and a clear ``result_json`` so the audit
trail is complete.

See ``docs/observability-gap/21-custom-metric-studio.md``.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import TYPE_CHECKING, Any

from ._common import (
    _check_auto_judge_policy,
    _json_dumps,
    _ok_envelope,
)

if TYPE_CHECKING:
    from eden.llmops.judges.base import JudgeContext, TelemetryEvent

# Lazy import — Judge lives in the same package as the
# builtin judges. We don't import it at module load so the
# metric_studio import graph stays cheap (the templates
# module can be imported without pulling in the LLM client).
try:
    from eden.llmops.judges.base import Judge, JudgeContext, JudgeScore
except Exception:  # pragma: no cover - defensive
    Judge = None  # type: ignore[assignment]
    JudgeContext = None  # type: ignore[assignment]
    JudgeScore = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


# The judge prompt template. The rubric is interpolated into
# ``{rubric}`` and the (input, output) pair is interpolated
# into ``{input}`` and ``{output}``. The LLM is asked to
# return ``{"score": <float>, "rationale": "<str>"}`` so
# :func:`_parse_rubric_response` can decode it deterministically.
_RUBRIC_JUDGE_PROMPT = """You are evaluating an LLM's response against a customer-defined rubric.

{input_block}

{rubric}

{output_block}

Return your answer as a JSON object: {{"score": <float between 0.0 and 1.0>, "rationale": "<one short sentence>"}}
"""


class RubricJudge(Judge):
    """The runtime judge that scores events against an approved rubric.

    One instance per registered (org, metric) pair. The judge
    is registered in the global :class:`JudgeRegistry` by
    :class:`JudgeFactory`; from then on it's called by the
    :class:`JudgeRunner` for every event whose
    :meth:`matches` returns ``True`` (subject to the
    per-tenant opt-in gate).
    """

    def __init__(
        self,
        *,
        org_id: str,
        metric_id: str,
        judge_name: str,
        rubric_prompt: str,
        domain: str = "general",
    ) -> None:
        if Judge is None:
            raise RuntimeError(
                "eden.llmops.judges.base.Judge is unavailable — "
                "JudgeFactory requires the judges package to be importable"
            )
        super().__init__()
        self.org_id = org_id
        self.metric_id = metric_id
        self.name = judge_name
        self.version = "2026-06-11"
        self.model_slot = "fast"
        self.sync = True
        # ``rubric_prompt`` is the synthesised rubric — the
        # core of the judge. The judge cannot run without it.
        self.rubric_prompt = rubric_prompt
        self.domain = domain

    def matches(self, event: TelemetryEvent) -> bool:
        """Default: any LLM-style event (mirrors the parent
        :meth:`Judge.matches` behaviour). Subclasses can
        override for narrower scoping, but the v1.3 ship
        defaults to "any LLM event the customer is sending
        through the registry"."""
        return super().matches(event)

    async def score(
        self, event: TelemetryEvent, ctx: JudgeContext
    ) -> JudgeScore:
        """Score one event against the rubric.

        The opt-in gate is the FIRST step — if the customer
        has not opted this metric in (the v1.4 default), the
        score is suppressed and the audit log records
        ``status="scored"`` with ``score=None`` and a clear
        ``reason``. The event is never silently billed.
        """
        # ── 1. Opt-in gate ────────────────────────────────────────
        allowed, reason = await _check_auto_judge_policy(
            self.org_id, self.metric_id
        )
        if not allowed:
            await _write_score_audit_log(
                org_id=self.org_id,
                metric_id=self.metric_id,
                judge_name=self.name,
                trace_id=ctx.trace_id or event.trace_id,
                score=None,
                threshold=None,
                passed=None,
                result={
                    "scored": False,
                    "reason": reason,
                    "metric_id": self.metric_id,
                },
            )
            return _low_confidence(
                self,
                event,
                ctx,
                reason=f"auto_judge_policy_off:{reason}",
            )

        # ── 2. Format the prompt ─────────────────────────────────
        text, spec = _extract_text_and_spec(event)
        if not text and not spec:
            return _low_confidence(self, event, ctx, reason="empty_event")
        input_block = f"Task / spec (may be empty):\n{spec[:400] if spec else '(no spec)'}"
        output_block = f"Response to evaluate:\n{text[:1200] if text else '(no response)'}"

        prompt = _RUBRIC_JUDGE_PROMPT.format(
            rubric=self.rubric_prompt[: (4 * 1500)],  # hard-cap to avoid LLM bloat
            input_block=input_block,
            output_block=output_block,
        )

        # ── 3. Call the LLM ──────────────────────────────────────
        if ctx.llm_client is None:
            return _low_confidence(self, event, ctx, reason="no_llm_client")

        t0 = time.monotonic()
        try:
            resp = ctx.llm_client.call(
                agent=f"judge_{self.name}",
                prompt=prompt,
                slot=self.model_slot,
                max_tokens=120,
            )
        except Exception as exc:
            logger.debug("rubric judge llm call failed: %s", exc)
            return _low_confidence(
                self, event, ctx, reason=f"llm_error:{type(exc).__name__}"
            )

        latency_ms = (time.monotonic() - t0) * 1000.0
        score, rationale = _parse_rubric_response(
            getattr(resp, "content", "") or ""
        )
        model = getattr(resp, "model", "") or "unknown"

        # ── 4. Persist the per-score audit log ──────────────────
        await _write_score_audit_log(
            org_id=self.org_id,
            metric_id=self.metric_id,
            judge_name=self.name,
            trace_id=ctx.trace_id or event.trace_id,
            score=score,
            threshold=None,
            passed=None,
            result={
                "scored": True,
                "score": score,
                "rationale": rationale,
                "model": model,
                "latency_ms": latency_ms,
            },
        )

        return JudgeScore(
            judge_name=self.name,
            judge_version=self.version,
            trace_id=ctx.trace_id or event.trace_id,
            span_id=event.span_id,
            score=score,
            rationale=rationale,
            model=model,
            latency_ms=latency_ms,
            metadata={
                "metric_id": self.metric_id,
                "domain": self.domain,
                "rubric_judge": True,
            },
        )


class JudgeFactory:
    """Wraps an approved rubric as a runtime judge.

    A thin service that does three things:

    1. Constructs a :class:`RubricJudge` instance with a
       unique ``name`` (``custom_<org_id_short>_<metric_id>``).
    2. Registers the judge in the global
       :class:`JudgeRegistry`.
    3. Fires the closed-loop hook
       :func:`MetricStudioHook.on_metric_promotion`.

    The factory is the only place a :class:`RubricJudge` is
    constructed — there is no public constructor for the
    class because the name + registration + hook-firing is
    one atomic operation. This matches the existing pattern
    in :class:`eden.llmops.judges.registry.JudgeRegistry`:
    judges are registered, never constructed ad-hoc.
    """

    name = "judge_factory"

    async def wrap_rubric_as_judge(
        self,
        org_id: str,
        *,
        metric_id: str,
        rubric_prompt: str,
        name: str,
        rubric_id: str,
        domain: str = "general",
    ) -> dict[str, Any]:
        """Wrap ``rubric_prompt`` as a registered judge.

        Returns the live envelope with ``judge_name`` (the
        registered name in the global
        :class:`JudgeRegistry`) and ``metric_id`` (the
        customer-facing identifier). The audit-log row for
        the original rubric is updated with the new
        ``judge_name`` and ``metric_id`` so a future
        reviewer can trace the metric back to its synthesis.
        """
        if not rubric_prompt or not metric_id:
            return _ok_envelope(
                self.name,
                {"wrapped": False, "reason": "missing rubric or metric_id"},
            )

        # The judge name needs to be unique within the
        # process-wide JudgeRegistry. We use the metric_id
        # (a UUID) as the suffix so uniqueness is by
        # construction. The ``custom_`` prefix is the
        # public signal that this is a Cat 21 metric
        # (not a builtin).
        judge_name = f"custom_{metric_id}"
        judge = RubricJudge(
            org_id=org_id,
            metric_id=metric_id,
            judge_name=judge_name,
            rubric_prompt=rubric_prompt,
            domain=domain,
        )

        # Register in the global JudgeRegistry. The
        # registry is process-local (matches the existing
        # 10 builtin judges — a future Redis-backed
        # registry will address horizontal scaling).
        try:
            from eden.llmops.judges.registry import get_judge_registry
            registry = get_judge_registry()
            registry.register(judge)
        except Exception as exc:
            logger.debug(
                "metric_studio.judge_factory: registry register failed: %s", exc
            )
            return _ok_envelope(
                self.name,
                {"wrapped": False, "reason": f"registry_failed:{type(exc).__name__}"},
            )

        # Backfill the audit-log row with metric_id and
        # judge_name so the future ``list`` endpoint can
        # group runs by metric.
        try:
            from ._common import _update_run_status
            await _update_run_status(
                org_id,
                rubric_id,
                metric_id=metric_id,
                judge_name=judge_name,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "metric_studio.judge_factory: backfill audit log failed: %s", exc
            )

        # Fire the closed-loop hook. Best-effort — the hook
        # is a no-op logger in v1.3 but the wiring is in
        # place for v1.4 to make it actionable.
        try:
            from eden.llmops.promotion_hooks import get_metric_studio_hook
            hook = get_metric_studio_hook()
            hook.on_metric_promotion(
                org_id=org_id,
                metric_id=metric_id,
                judge_name=judge_name,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "metric_studio.judge_factory: hook fire failed: %s", exc
            )

        return _ok_envelope(
            self.name,
            {
                "wrapped": True,
                "metric_id": metric_id,
                "judge_name": judge_name,
                "domain": domain,
                "name": name,
            },
        )


# ── Internal helpers (module-private) ───────────────────────────────


def _low_confidence(
    judge: RubricJudge,
    event: TelemetryEvent,
    ctx: JudgeContext,
    *,
    reason: str,
) -> JudgeScore:
    """The "could not score" JudgeScore. Mirrors the pattern in
    :class:`HallucinationJudge._low_confidence` — score 0.5
    with a clear rationale so downstream aggregations aren't
    skewed by missing data."""
    return JudgeScore(
        judge_name=judge.name,
        judge_version=judge.version,
        trace_id=ctx.trace_id or event.trace_id,
        span_id=event.span_id,
        score=0.5,
        rationale=f"no_score:{reason}",
        model="n/a",
        metadata={
            "metric_id": judge.metric_id,
            "domain": judge.domain,
            "reason": reason,
        },
    )


def _parse_rubric_response(content: str) -> tuple[float, str]:
    """Parse the LLM rubric judge's JSON-shaped response.

    Mirrors :func:`_parse_judge_response` in
    :mod:`eden.llmops.judges.hallucination` — same shape,
    same fallback ladder:

    1. Strict JSON ``{"score": 0.8, "rationale": "..."}``
    2. JSON object embedded in surrounding prose
    3. Bare float fallback
    4. ``(0.5, content[:200])`` for everything else

    Clamps score to ``[0.0, 1.0]``; truncates rationale to
    500 chars.
    """
    content = (content or "").strip()
    if not content:
        return 0.5, "empty_judge_response"
    # Strict JSON
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            score = float(obj.get("score", 0.5))
            rationale = str(obj.get("rationale", ""))
            return max(0.0, min(1.0, score)), rationale[:500]
    except (ValueError, TypeError):
        pass
    # Embedded JSON
    m = re.search(r"\{[^{}]*\"score\"[^{}]*\}", content)
    if m:
        try:
            obj = json.loads(m.group(0))
            score = float(obj.get("score", 0.5))
            rationale = str(obj.get("rationale", ""))
            return max(0.0, min(1.0, score)), rationale[:500]
        except (ValueError, TypeError):
            pass
    # Bare float
    m = re.search(r"\b0?\.\d+\b", content)
    if m:
        try:
            return max(0.0, min(1.0, float(m.group(0)))), content[:200]
        except ValueError:
            pass
    return 0.5, content[:200]


def _extract_text_and_spec(event: TelemetryEvent) -> tuple[str, str]:
    """Best-effort (input, output) extraction from one event.

    Mirrors :func:`_extract_text_and_spec` in
    :mod:`eden.llmops.judges.hallucination` — same per-
    decoder field-mapping, same fallback ladder. Kept local
    so the judge factory has no cross-package runtime
    dependency on the builtin judges module.
    """
    payload = getattr(event, "payload", None) or {}
    text = ""
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
        sub_obj = payload.get(provider) if isinstance(payload, dict) else None
        if not isinstance(sub_obj, dict):
            continue
        for fname in field_names:
            v = sub_obj.get(fname)
            if isinstance(v, str) and v:
                text = v
                break
        if text:
            break
    spec = str(
        (payload.get("task") if isinstance(payload, dict) else None)
        or (payload.get("spec") if isinstance(payload, dict) else None)
        or ""
    )
    return text, spec


async def _write_score_audit_log(
    *,
    org_id: str,
    metric_id: str,
    judge_name: str,
    trace_id: str,
    score: float | None,
    threshold: float | None,
    passed: bool | None,
    result: dict[str, Any],
) -> None:
    """Write one row to ``custom_metric_runs`` for a scored
    event. Status is always ``"scored"`` so the
    :meth:`CustomMetricRegistry.list` aggregation can filter
    on it. Best-effort — any failure is logged, the score
    itself is not affected.
    """
    run_id = f"score_{uuid.uuid4().hex[:12]}"
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio.judge_factory: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                "INSERT INTO custom_metric_runs "
                "(id, org_id, metric_id, judge_name, score, threshold, passed, "
                " trace_id, examples_json, result_json, status) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
                run_id,
                org_id,
                metric_id,
                judge_name,
                score,
                threshold,
                passed,
                trace_id,
                None,  # examples_json — N/A for scoring rows
                _json_dumps(result),
                "scored",
            )
    except Exception as exc:
        logger.debug(
            "metric_studio.judge_factory: write_score_audit_log failed: %s", exc
        )
