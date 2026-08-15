"""DecisionScorer — score the quality of a trace's decisions using
the 3 Galileo Luna-2 judges.

For each event in the trace:

1. Build a :class:`_LightEvent` from the row.
2. Ask each of the 3 registered Galileo judges
   (``ActionCompletionJudge``, ``ToolSelectionQualityJudge``,
   ``ReasoningCoherenceJudge``) whether it applies via
   ``judge.matches(event)``. Only applicable judges run.
3. Execute the applicable judges via :class:`JudgeRunner` — this
   also persists the per-event ``JudgeScore`` rows to
   ``judge_scores``.

After all events are scored, the scorer:

* Aggregates per-judge mean across events.
* Computes a weighted overall score
  (``0.4 * action_completion + 0.3 * tool_selection_quality
  + 0.3 * reasoning_coherence``).
* Fires the Cat 17 closed-loop hooks on degradation:
  - :func:`GuardrailHook.on_judge_below_floor` once per
    low-component judge.
  - :func:`PromotionHook.on_judge_regression` once if the
    weighted overall drops below the configured floor.
* Persists one row to ``decision_scores`` per (org, trace).

Failure policy: any judge exception is logged and skipped; the
scorer still produces a result. A missing ``OPENROUTER_API_KEY``
causes the ``OpenRouterClient`` constructor to raise — the
scorer catches this and proceeds with ``llm_client = None``,
which the judges handle by returning a low-confidence score.
The scorer is therefore always able to write a row, even in
degraded environments.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from ._common import (
    _build_light_event,
    _delete_then_insert,
    _fetch_trace_events,
    _json_dumps,
    _not_found_envelope,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


class DecisionScorer:
    """Score one trace via the 3 Galileo Luna-2 metrics."""

    name = "decision_scorer"

    #: Per-judge weight in the weighted overall score. Weights
    #: sum to 1.0. Tune by overriding the class attribute in a
    #: subclass.
    WEIGHTS: dict[str, float] = {
        "action_completion": 0.4,
        "tool_selection_quality": 0.3,
        "reasoning_coherence": 0.3,
    }

    #: Component score below this is "degraded" and fires
    #: ``GuardrailHook.on_judge_below_floor``.
    LOW_SCORE_THRESHOLD: float = 0.3

    #: Weighted overall below this fires
    #: ``PromotionHook.on_judge_regression``.
    OVERALL_LOW_THRESHOLD: float = 0.4

    #: Identifier used for the synthetic "overall" judge in the
    #: regression hook call so callers can grep for it in
    #: audit logs.
    OVERALL_JUDGE_NAME: str = "decision_scorer_overall"

    async def score(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        events = await _fetch_trace_events(org_id, trace_id)
        if not events:
            return _not_found_envelope(self.name, trace_id)

        judges = self._get_galileo_judges()
        if not judges:
            # No Galileo judges registered — there's nothing
            # useful to score. Return an empty components dict
            # so the caller can see the gap, and persist a row
            # with ``score=None`` so the absence is auditable.
            logger.warning(
                "decision_scorer: no Galileo judges registered"
            )
            await _delete_then_insert(
                org_id,
                trace_id,
                "decision_scores",
                ["score", "components_json"],
                [
                    None,
                    _json_dumps(
                        {
                            "components": {},
                            "low_judges": [],
                            "sample_count": 0,
                            "note": "no_galileo_judges_registered",
                        }
                    ),
                ],
            )
            return _ok_envelope(
                self.name,
                {
                    "trace_id": trace_id,
                    "overall_score": None,
                    "components": {},
                    "low_scores": [],
                    "verdict": "no_judges",
                    "sample_count": 0,
                },
            )

        llm_client = self._try_get_llm_client()
        runner = self._make_runner(llm_client)

        all_scores = await self._run_judges(events, judges, runner, trace_id)

        # Aggregate per-judge mean across events.
        per_judge: dict[str, list[float]] = defaultdict(list)
        per_judge_rationales: dict[str, list[str]] = defaultdict(list)
        for s in all_scores:
            if s.score is None:
                continue
            per_judge[s.judge_name].append(float(s.score))
            if s.rationale:
                per_judge_rationales[s.judge_name].append(s.rationale)

        components: dict[str, float] = {}
        for name, scores in per_judge.items():
            if scores:
                components[name] = sum(scores) / len(scores)

        # Weighted overall — components absent from
        # ``per_judge`` count as 0.0 (the agent never
        # produced events the judge could score).
        overall = sum(
            components.get(name, 0.0) * weight
            for name, weight in self.WEIGHTS.items()
        )

        low_judges = [
            name
            for name, score in components.items()
            if score < self.LOW_SCORE_THRESHOLD
        ]

        # Fire Cat 17 closed-loop hooks.
        self._fire_low_score_hooks(org_id, low_judges)
        if (
            overall < self.OVERALL_LOW_THRESHOLD
            and low_judges
        ):
            self._fire_regression_hook(org_id, trace_id, overall, low_judges)

        # Persist a single decision_scores row per (org, trace).
        components_payload = _json_dumps(
            {
                "components": components,
                "low_judges": low_judges,
                "sample_count": len(all_scores),
                "rationales": {
                    name: (rs[-1] if rs else None)
                    for name, rs in per_judge_rationales.items()
                },
            }
        )
        await _delete_then_insert(
            org_id,
            trace_id,
            "decision_scores",
            ["score", "components_json"],
            [overall, components_payload],
        )

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "overall_score": overall,
                "components": components,
                "low_scores": low_judges,
                "verdict": (
                    "degraded"
                    if overall < self.OVERALL_LOW_THRESHOLD
                    else "ok"
                ),
                "sample_count": len(all_scores),
                "live": True,
            },
        )

    # ── Helpers ────────────────────────────────────────────────────

    def _get_galileo_judges(self) -> list[Any]:
        """Return UnifiedJudge (or unique WEIGHTS-axis judges).

        Production registers one UnifiedJudge under ``unified`` and
        every axis alias; ``for_event`` / this helper dedupe by
        identity so only one LLM call runs. Tests may still inject
        separate per-axis fakes.
        """
        try:
            from eden.llmops.judges.registry import get_judge_registry
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("decision_scorer: registry import failed: %s", exc)
            return []
        try:
            registry = get_judge_registry()
        except Exception as exc:
            logger.debug("decision_scorer: get_judge_registry failed: %s", exc)
            return []
        unified = registry.get("unified")
        if unified is not None:
            return [unified]
        out: list[Any] = []
        seen: set[int] = set()
        for name in self.WEIGHTS:
            j = registry.get(name)
            if j is None:
                continue
            jid = id(j)
            if jid in seen:
                continue
            seen.add(jid)
            out.append(j)
        return out

    def _try_get_llm_client(self) -> Any:
        """Construct the LLM client, returning ``None`` on any
        failure (missing key, missing dep, etc.). Judges handle
        ``llm_client = None`` by returning a low-confidence
        score — the scorer still produces a row.
        """
        try:
            from eden.llm.client import OpenRouterClient

            return OpenRouterClient()
        except Exception as exc:
            logger.debug(
                "decision_scorer: OpenRouterClient unavailable (%s); "
                "judges will return low-confidence scores",
                exc,
            )
            return None

    def _make_runner(self, llm_client: Any) -> Any:
        try:
            from eden.llmops.judges.runner import JudgeRunner
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("decision_scorer: JudgeRunner import failed: %s", exc)
            return None
        return JudgeRunner(llm_client=llm_client)

    async def _run_judges(
        self,
        events: list[dict[str, Any]],
        judges: list[Any],
        runner: Any,
        trace_id: str,
    ) -> list[Any]:
        """Run judges on the last matching LLM event only (1 call/trace)."""
        from eden.llmops.judges.base import JudgeScore

        all_scores: list[JudgeScore] = []
        if runner is None or not judges:
            return all_scores

        # Prefer the last applicable event so long agent traces don't
        # fan out one UnifiedJudge call per span.
        chosen = None
        for event in events:
            ev = _build_light_event(event, tenant_id=event.get("tenant_id") or "")
            if any(j.matches(ev) for j in judges):
                chosen = (ev, event)
        if chosen is None:
            return all_scores
        ev, event = chosen
        applicable = [j for j in judges if j.matches(ev)]
        try:
            scores = await runner.run_for_event(ev, applicable, trace_id=trace_id)
            all_scores.extend(scores)
        except Exception as exc:
            logger.warning(
                "decision_scorer: judge run failed for event %s: %s",
                event.get("event_id"),
                exc,
            )
        return all_scores

    def _fire_low_score_hooks(
        self, org_id: str, low_judges: list[str]
    ) -> None:
        """Fire :func:`GuardrailHook.on_judge_below_floor` for each
        judge whose mean component score is below the floor.
        Failure to import the hook is logged and skipped.
        """
        if not low_judges:
            return
        try:
            from eden.llmops.promotion_hooks import get_guardrail_hook
        except Exception as exc:
            logger.debug(
                "decision_scorer: guardrail hook import failed: %s", exc
            )
            return
        try:
            hook = get_guardrail_hook()
        except Exception as exc:
            logger.debug(
                "decision_scorer: get_guardrail_hook failed: %s", exc
            )
            return
        for jname in low_judges:
            try:
                # ``on_judge_below_floor`` is ``async def`` and this
                # method is sync — a bare call dropped every floor alert.
                from eden.async_tasks import fire_and_forget

                fire_and_forget(
                    hook.on_judge_below_floor(org_id, judge_name=jname),
                    name="decision-judge-below-floor-hook",
                )
            except Exception as exc:
                logger.debug(
                    "decision_scorer: on_judge_below_floor(%s) failed: %s",
                    jname,
                    exc,
                )

    def _fire_regression_hook(
        self,
        org_id: str,
        trace_id: str,
        overall: float,
        low_judges: list[str],
    ) -> None:
        """Fire :func:`PromotionHook.on_judge_regression` once when
        the overall score drops below the floor. The
        ``judge_name`` is set to :attr:`OVERALL_JUDGE_NAME` so
        downstream consumers can grep for it.
        """
        try:
            from eden.llmops.promotion_hooks import get_promotion_hook
        except Exception as exc:
            logger.debug(
                "decision_scorer: promotion hook import failed: %s", exc
            )
            return
        try:
            hook = get_promotion_hook()
        except Exception as exc:
            logger.debug(
                "decision_scorer: get_promotion_hook failed: %s", exc
            )
            return
        try:
            # ``on_judge_regression`` is ``async def`` and this method is
            # sync — a bare call dropped every overall-regression alert.
            from eden.async_tasks import fire_and_forget

            fire_and_forget(
                hook.on_judge_regression(
                    org_id,
                    judge_name=self.OVERALL_JUDGE_NAME,
                    trace_id=trace_id,
                    score=overall,
                ),
                name="decision-judge-regression-hook",
            )
        except Exception as exc:
            logger.debug(
                "decision_scorer: on_judge_regression failed: %s", exc
            )
