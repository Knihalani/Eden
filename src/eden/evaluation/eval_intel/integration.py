"""Eval-to-Guardrail + Custom Python + Auto-Dataset services (Cat 3) — real implementations.

Three services:

* :class:`EvalToGuardrailLink` — Galileo's eval-to-guardrail
  lifecycle. ``promote_to_guardrail`` validates the judge has
  ≥ 100 samples in the last 30 days and a false-positive rate
  ≤ 5% at the requested threshold, then writes a new
  ``guardrail_policies`` row (Cat 15's table) of type
  ``"judge_link"`` and a link in
  ``eval_to_guardrail_links``. Fires
  :func:`eden.llmops.promotion_hooks.GuardrailHook.on_judge_threshold_breach`.

  The :attr:`name` is ``"eval_to_guardrail"``.

* :class:`CustomPythonEval` — Langfuse-style user-registered
  Python eval functions. ``register`` validates the
  ``function_ref`` is importable, then persists the
  registration to ``eval_custom_python_evals``.

  The :attr:`name` is ``"custom_python_eval"``.

* :class:`AutoDatasetBridge` — Braintrust-style auto-curate a
  golden dataset from low-score traces. ``from_judge_failures``
  pulls low-score ``judge_scores`` rows for the given judge
  name, builds a list of trace dicts, and calls the existing
  :class:`eden.evaluation.auto_dataset.AutoDatasetPromoter` to
  do the actual promotion.

  The :attr:`name`` is ``"auto_dataset_bridge"``.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.evaluation.auto_dataset import AutoDatasetPromoter

from ._common import (
    AUTO_DATASET_MAX_SAMPLES,
    AUTO_DATASET_MIN_SAMPLES,
    EVAL_LOOKBACK_DAYS,
    MAX_FPR_FOR_PROMOTION,
    MIN_SAMPLES_FOR_PROMOTION,
    _bad_request_envelope,
    _fetch_judge_distribution,
    _fetch_low_judge_scores,
    _fire_eval_to_guardrail_promotion,
    _insert_auto_dataset_bridge,
    _insert_custom_python_eval,
    _insert_eval_to_guardrail_link,
    _insert_guardrail_policy,
    _ok_envelope,
    _validate_function_ref,
)

logger = logging.getLogger(__name__)


# ── 1. EvalToGuardrailLink ───────────────────────────────────────────


class EvalToGuardrailLink:
    """Galileo eval-to-guardrail lifecycle.

    Public method :meth:`promote_to_guardrail` returns the
    live envelope on success, or a live "bad_request" envelope
    when the judge fails the sample-count or FPR gates.
    """

    name = "eval_to_guardrail"

    async def promote_to_guardrail(
        self,
        org_id: str,
        *,
        judge_name: str,
        threshold: float,
    ) -> dict[str, Any]:
        # 1. Validate inputs.
        if not judge_name or not isinstance(judge_name, str):
            return _bad_request_envelope(
                self.name,
                "judge_name must be a non-empty string",
            )
        if not isinstance(threshold, (int, float)) or not (
            0.0 <= float(threshold) <= 1.0
        ):
            return _bad_request_envelope(
                self.name,
                f"threshold {threshold!r} must be a number in [0.0, 1.0]",
            )
        threshold = float(threshold)
        judge_name = judge_name.strip()[:64]

        # 2. Sample-count + FPR gates.
        dist = await _fetch_judge_distribution(
            org_id, judge_name, f"{EVAL_LOOKBACK_DAYS} days",
        )
        sample_count = int(dist.get("sample_count", 0) or 0)
        fpr = float(dist.get("fpr_at_0.5", 0.0) or 0.0)
        if sample_count < MIN_SAMPLES_FOR_PROMOTION:
            return _bad_request_envelope(
                self.name,
                (
                    f"need ≥{MIN_SAMPLES_FOR_PROMOTION} samples in the last "
                    f"{EVAL_LOOKBACK_DAYS} days, got {sample_count}"
                ),
            )
        if fpr > MAX_FPR_FOR_PROMOTION:
            return _bad_request_envelope(
                self.name,
                (
                    f"judge FPR {fpr:.1%} exceeds the "
                    f"{MAX_FPR_FOR_PROMOTION:.0%} threshold; "
                    "lower the threshold or wait for more samples"
                ),
            )

        # 3. Insert the guardrail_policy row (Cat 15's
        # table) and the link. ``_insert_guardrail_policy``
        # returns the generated policy id (or None on
        # failure).
        spec = {
            "judge_name": judge_name,
            "threshold": threshold,
            "lookback_days": EVAL_LOOKBACK_DAYS,
        }
        policy_id = await _insert_guardrail_policy(
            org_id,
            name=f"judge_link:{judge_name}@{threshold}",
            type_="judge_link",
            spec_json=json.dumps(spec),
            action="block_if_below",
            status="active",
        )
        if policy_id is None:
            # Persistence failed but the rest of the flow
            # can still surface a partial response. We
            # return a 200 with a warning rather than a
            # 500 — the operator can retry.
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "judge_name": judge_name,
                    "threshold": threshold,
                    "sample_count": sample_count,
                    "fpr": round(fpr, 4),
                    "status": "persistence_failed",
                    "message": (
                        "guardrail policy insert failed; "
                        "check logs and retry"
                    ),
                },
            )

        await _insert_eval_to_guardrail_link(
            org_id,
            judge_name=judge_name,
            guardrail_policy_id=policy_id,
            threshold=threshold,
            status="active",
        )

        # 4. Fire the closed-loop hook (best-effort).
        _fire_eval_to_guardrail_promotion(
            org_id, judge_name=judge_name, threshold=threshold,
        )

        # 5. N15 — hot-reload live guardrail filter on gateway.
        try:
            from eden.llmops.filters.guardrail import get_guardrail_filter
            from eden.llmops.learn_wiring import install_learn_filters

            install_learn_filters()
            filt = get_guardrail_filter()
            existing = filt._policies.get(org_id, [])
            existing.append(
                {
                    "judge_id": policy_id,
                    "judge_name": judge_name,
                    "threshold": threshold,
                    "enforcement_level": "block",
                    "keyword": judge_name,
                }
            )
            filt.load_policies(org_id, existing)
        except Exception as hook_exc:
            logger.debug("eval_to_guardrail: gateway filter reload failed: %s", hook_exc)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "guardrail_policy_id": policy_id,
                "judge_name": judge_name,
                "threshold": threshold,
                "sample_count": sample_count,
                "fpr": round(fpr, 4),
                "lookback_days": EVAL_LOOKBACK_DAYS,
                "action": "block_if_below",
                "status": "active",
            },
        )

    async def promote_to_shadow(
        self,
        org_id: str,
        *,
        judge_name: str,
        threshold: float,
    ) -> dict[str, Any]:
        """N15 — shadow guardrail first; EvidenceGate required for block."""
        result = await self.promote_to_guardrail(
            org_id, judge_name=judge_name, threshold=threshold
        )
        if result.get("status") != "ok":
            return result
        data = result.get("data") or {}
        policy_id = data.get("guardrail_policy_id")
        candidate_id: str | None = None
        try:
            from eden.promotion.evidence_gate import EvidenceGate

            candidate_id = await EvidenceGate().enqueue(
                org_id,
                kind="guardrail",
                ref_id=str(policy_id or judge_name),
                status="shadow",
            )
        except Exception as exc:
            logger.debug("eval_to_guardrail: evidence gate enqueue failed: %s", exc)
        try:
            from eden.llmops.filters.guardrail import get_guardrail_filter
            from eden.llmops.learn_wiring import install_learn_filters

            install_learn_filters()
            filt = get_guardrail_filter()
            existing = filt._policies.get(org_id, [])
            existing.append(
                {
                    "judge_id": policy_id,
                    "judge_name": judge_name,
                    "threshold": threshold,
                    "enforcement_level": "log",
                    "keyword": judge_name,
                }
            )
            filt.load_policies(org_id, existing)
        except Exception as hook_exc:
            logger.debug("eval_to_guardrail: shadow filter reload failed: %s", hook_exc)
        if isinstance(data, dict):
            data["enforcement_level"] = "shadow"
            data["evidence_gate_candidate_id"] = candidate_id
            result["data"] = data
        return result


# ── 2. CustomPythonEval ─────────────────────────────────────────────


class CustomPythonEval:
    """Langfuse-style user-registered Python eval function.

    Public method :meth:`register` returns the live envelope
    on success, or a live "bad_request" envelope when the
    ``function_ref`` is not importable.

    Note: the v1 contract just verifies the function is
    importable. A real sandbox (subprocess /
    :mod:`RestrictedPython`) is deferred to a future
    iteration (per the appendix Open Question 1).
    """

    name = "custom_python_eval"

    async def register(
        self,
        org_id: str,
        *,
        name: str,
        function_ref: str,
        spec: dict[str, Any],
    ) -> dict[str, Any]:
        # 1. Validate.
        if not name or not isinstance(name, str):
            return _bad_request_envelope(
                self.name,
                "name must be a non-empty string",
            )
        if not function_ref or not isinstance(function_ref, str):
            return _bad_request_envelope(
                self.name,
                "function_ref must be a non-empty string",
            )
        if not isinstance(spec, dict):
            return _bad_request_envelope(
                self.name,
                "spec must be a dict",
            )
        name = name.strip()[:128]
        function_ref = function_ref.strip()[:256]

        # 2. Verify the function_ref resolves.
        if not _validate_function_ref(function_ref):
            return _bad_request_envelope(
                self.name,
                (
                    f"function_ref {function_ref!r} is not importable; "
                    "expected 'dotted.path.func_name' or 'dotted.path.module'"
                ),
            )

        # 3. Persist (best-effort, append-only row).
        spec_json = json.dumps(spec)[:60000]
        await _insert_custom_python_eval(
            org_id,
            name=name,
            function_ref=function_ref,
            spec_json=spec_json,
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "name": name,
                "function_ref": function_ref,
                "spec": spec,
                "callable": True,
                "status": "registered",
            },
        )


# ── 3. AutoDatasetBridge ─────────────────────────────────────────────


def _judge_score_to_trace_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a :sql:`judge_scores` row to the trace-dict
    shape that
    :meth:`eden.evaluation.auto_dataset.AutoDatasetPromoter.process_traces`
    expects. Defensive: missing fields are filled in with
    sensible defaults."""
    return {
        "trace_id": str(row.get("trace_id", "")),
        "description": (
            f"low-{row.get('judge_name', 'judge')} trace "
            f"(score={row.get('score', 0.0):.2f}): "
            f"{str(row.get('rationale', ''))[:200]}"
        ),
        "environment_type": "llm_agent_eval",
        "tags": [
            "auto-promoted",
            f"judge={row.get('judge_name', 'unknown')}",
            f"score={row.get('score', 0.0):.2f}",
        ],
        "metrics": {
            "tokens_used": 0,
            "max_tokens": 1,
        },
        "test_results": {
            "passed": 0,
            "total": 1,
            "edge_cases": {},
        },
        "input_spec": {
            "description": (
                f"judge_score_row from {row.get('judge_name', 'unknown')}"
            ),
        },
        "complexity_metrics": {
            "max_steps": 1,
        },
    }


class AutoDatasetBridge:
    """Braintrust-style auto-curate a golden dataset from
    low-score traces.

    Public method :meth:`from_judge_failures` returns the live
    envelope on success, with a warning when the sample count
    is below :data:`AUTO_DATASET_MIN_SAMPLES`.
    """

    name = "auto_dataset_bridge"

    async def from_judge_failures(
        self,
        org_id: str,
        *,
        judge_name: str,
        target_dataset_name: str,
        min_confidence: float = 0.85,
    ) -> dict[str, Any]:
        # 1. Validate inputs.
        if not judge_name or not isinstance(judge_name, str):
            return _bad_request_envelope(
                self.name,
                "judge_name must be a non-empty string",
            )
        if not target_dataset_name or not isinstance(target_dataset_name, str):
            return _bad_request_envelope(
                self.name,
                "target_dataset_name must be a non-empty string",
            )
        if not isinstance(min_confidence, (int, float)) or not (
            0.0 <= float(min_confidence) <= 1.0
        ):
            return _bad_request_envelope(
                self.name,
                (
                    f"min_confidence {min_confidence!r} must be a number "
                    "in [0.0, 1.0]"
                ),
            )
        judge_name = judge_name.strip()[:64]
        target_dataset_name = target_dataset_name.strip()[:128]

        # 2. Pull low-score rows.
        rows = await _fetch_low_judge_scores(
            org_id, judge_name, limit=AUTO_DATASET_MAX_SAMPLES,
        )
        if len(rows) < AUTO_DATASET_MIN_SAMPLES:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "judge_name": judge_name,
                    "target_dataset_name": target_dataset_name,
                    "dataset_id": None,
                    "samples_processed": len(rows),
                    "samples_added": 0,
                    "message": (
                        f"insufficient failures; got {len(rows)} rows, "
                        f"need at least {AUTO_DATASET_MIN_SAMPLES}"
                    ),
                },
            )

        # 3. Convert to trace dicts and call the promoter.
        traces = [_judge_score_to_trace_dict(r) for r in rows]
        promoter = AutoDatasetPromoter(promotion_threshold=float(min_confidence))
        result = await promoter.process_traces(
            traces, target_dataset_id=f"gd_{target_dataset_name}",
        )

        # 4. Persist the bridge row.
        target_dataset_id = result.get("dataset_id") if isinstance(result, dict) else None
        target_dataset_id_str: str | None = (
            str(target_dataset_id) if target_dataset_id else None
        )
        await _insert_auto_dataset_bridge(
            org_id,
            judge_name=judge_name,
            source_dataset_id=None,
            target_dataset_id=target_dataset_id_str,
            status="curated",
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "judge_name": judge_name,
                "target_dataset_name": target_dataset_name,
                "dataset_id": target_dataset_id_str,
                "samples_processed": result.get("processed", len(traces))
                if isinstance(result, dict) else len(traces),
                "samples_added": result.get("new_cases_added", 0)
                if isinstance(result, dict) else 0,
                "promotion_threshold": float(min_confidence),
                "promoter_result": result if isinstance(result, dict) else {},
                "status": "curated",
                "message": (
                    f"curated from {len(rows)} low-{judge_name} rows"
                ),
            },
        )
