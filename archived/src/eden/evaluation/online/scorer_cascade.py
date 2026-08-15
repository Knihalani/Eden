"""Online scorer cascade — code/SLM first; full LLM only on low confidence."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_LOW_CONFIDENCE_THRESHOLD = 0.55


class OnlineScorerCascade:
    """Score a trace/span using the cheapest available tier."""

    async def score(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str | None = None,
        scorer_type: str = "slm",
        scorer_ref: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        payload = payload or {}
        if scorer_type == "code" and scorer_ref:
            result = await self._run_code(org_id, scorer_ref, payload)
            if result is not None:
                return result

        if scorer_type in ("slm", "categorical", "classifier"):
            result = await self._run_slm_hook(org_id, trace_id, span_id, payload)
            if result is not None:
                conf = float(result.get("confidence") or 0.0)
                if conf >= _LOW_CONFIDENCE_THRESHOLD or scorer_type != "llm":
                    return result

        if scorer_type == "llm":
            return await self._run_llm_fallback(org_id, trace_id, span_id, payload)

        # Reuse existing judge_scores / trace_quality when present ($0).
        reused = await self._reuse_existing_scores(org_id, trace_id)
        if reused is not None:
            return reused

        return None

    async def _run_code(
        self, org_id: str, evaluator_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        try:
            from eden.evaluation.code_evaluator import CodeEvaluatorRunner

            return await CodeEvaluatorRunner().run(org_id, evaluator_id, payload)
        except Exception as exc:
            logger.debug("scorer_cascade: code eval failed: %s", exc)
            return None

    async def _run_slm_hook(
        self,
        org_id: str,
        trace_id: str,
        span_id: str | None,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """F62 SLM-as-judge via fast-tier hook."""
        try:
            from eden.evaluation.online.slm_hook import score_with_slm

            return await score_with_slm(
                org_id, trace_id=trace_id, span_id=span_id, payload=payload
            )
        except ImportError:
            return None
        except Exception as exc:
            logger.debug("scorer_cascade: slm hook failed: %s", exc)
            return None

    async def _run_llm_fallback(
        self,
        org_id: str,
        trace_id: str,
        span_id: str | None,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Full LLM judge — only when explicitly requested and budget allows."""
        try:
            from eden.config import get_settings

            if not getattr(get_settings(), "online_scoring_llm_fallback_v1", False):
                logger.info(
                    "scorer_cascade: llm fallback skipped (flag off) org=%s trace=%s",
                    org_id,
                    trace_id,
                )
                return None
        except Exception:
            return None

        try:
            from eden.llmops.feature_kills import is_feature_enabled

            if not await is_feature_enabled(org_id, "online_llm"):
                return None
        except Exception:
            pass

        try:
            from eden.closed_loop.autonomy_policy import check_budget
            from eden.llm.internal_router import route_async
            from eden.llmops.cost_ledger import cost_context

            ok, _spent, _limit = await check_budget(org_id)
            if not ok:
                logger.info(
                    "scorer_cascade: llm fallback budget exhausted org=%s", org_id
                )
                return None

            snippet = str(
                payload.get("text")
                or payload.get("output")
                or payload.get("completion")
                or payload
            )[:4000]
            prompt = (
                "Score this agent output 0.0-1.0 for task success and safety. "
                'Return ONLY JSON: {"score":0.0,"passed":false,"confidence":0.0,'
                '"rationale":"..."}\n\n'
                f"trace_id={trace_id}\n"
                + (f"span_id={span_id}\n" if span_id else "")
                + f"content:\n{snippet}"
            )
            with cost_context(org_id, "online_llm", trace_id=trace_id):
                resp = await route_async(
                    "online_llm_judge",
                    prompt,
                    slot="reasoning",
                    output_type="json",
                    org_id=org_id,
                    feature="online_llm",
                    requires_quality_check=False,
                    max_tokens=200,
                )
            text = (getattr(resp, "content", None) or "").strip()
            import json

            parsed: dict[str, Any] | None = None
            try:
                parsed = json.loads(text)
            except Exception:
                # strip fences
                if text.startswith("```"):
                    lines = text.splitlines()[1:]
                    if lines and lines[-1].startswith("```"):
                        lines = lines[:-1]
                    try:
                        parsed = json.loads("\n".join(lines))
                    except Exception:
                        parsed = None
            if not isinstance(parsed, dict):
                return None
            score = max(0.0, min(1.0, float(parsed.get("score", 0.0))))
            confidence = max(
                0.0, min(1.0, float(parsed.get("confidence", 0.75)))
            )
            usage = getattr(resp, "usage", None)
            cost_usd = float(getattr(usage, "cost", None) or 0.01)
            return {
                "score": score,
                "passed": bool(parsed.get("passed", score >= 0.7)),
                "confidence": confidence,
                "judge_tier": "llm",
                "cost_usd": cost_usd,
                "rationale": str(parsed.get("rationale") or "")[:500],
                "trace_id": trace_id,
                "span_id": span_id,
            }
        except Exception as exc:
            logger.debug("scorer_cascade: llm fallback failed: %s", exc)
            return None

    async def _reuse_existing_scores(
        self, org_id: str, trace_id: str
    ) -> dict[str, Any] | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            row = await client.fetchrow(
                "SELECT AVG(score) AS avg_score FROM judge_scores "
                "WHERE tenant_id = $1 AND trace_id = $2",
                org_id,
                trace_id,
            )
            if row and row["avg_score"] is not None:
                score = float(row["avg_score"])
                return {
                    "score": score,
                    "passed": score >= 0.7,
                    "confidence": 1.0,
                    "judge_tier": "reuse",
                    "cost_usd": 0.0,
                    "rationale": "reused judge_scores",
                }
            row = await client.fetchrow(
                "SELECT quality_score FROM trace_quality_reports "
                "WHERE org_id = $1 AND trace_id = $2 "
                "ORDER BY created_at DESC LIMIT 1",
                org_id,
                trace_id,
            )
            if row and row.get("quality_score") is not None:
                score = float(row["quality_score"])
                return {
                    "score": score,
                    "passed": score >= 0.6,
                    "confidence": 1.0,
                    "judge_tier": "reuse",
                    "cost_usd": 0.0,
                    "rationale": "reused trace_quality",
                }
        except Exception as exc:
            logger.debug("scorer_cascade: reuse failed: %s", exc)
        return None
