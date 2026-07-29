"""F34 — classifier inference before F06 investigator on trace.finalized."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# Cost of running F06 investigator per trace (measured / budgeted).
#: Notional cost of one investigator run, for the savings comparison.
#:
#: NOT a real price. The per-signal LLM investigator was removed —
#: signals/investigator.py is heuristics only — so skipping it saves
#: compute and database writes, not model spend. This figure is what an
#: LLM investigator *would* have cost, kept so the shadow-mode
#: comparison has a yardstick.
#:
#: It is deliberately only ever added to the local ``savings`` counter
#: below. It must not be written to ``cost_usd`` on a CostEvent: the
#: per-org budgets read that ledger, and fabricated spend there consumes
#: real allowance. trace_finalized_consumer used to do exactly that.
INVESTIGATOR_COST_USD = 0.03


async def run_classifiers_before_investigator(
    org_id: str,
    trace_id: str,
    *,
    events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run promoted/shadow classifiers; skip investigator when safe.

    Returns:
        skip_investigator: True when any promoted classifier fired
            with investigator_disabled.
        savings_usd: estimated $ avoided by skipping investigator.
        predictions: list of prediction records.
    """
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "signal_classifiers_v1", True):
            return {
                "skip_investigator": False,
                "savings_usd": 0.0,
                "predictions": [],
                "status": "disabled",
            }
    except Exception:
        pass

    classifiers = await _load_active_classifiers(org_id)
    if not classifiers:
        return {
            "skip_investigator": False,
            "savings_usd": 0.0,
            "predictions": [],
            "status": "no_classifiers",
        }

    features = _extract_features(events or [], trace_id)
    predictions: list[dict[str, Any]] = []
    skip = False
    savings = 0.0

    from eden.signals.classifier_pipeline import ClassifierTrainingPipeline

    pipeline = ClassifierTrainingPipeline()
    for clf in classifiers:
        signal_id = str(clf["signal_id"])
        classifier_id = str(clf["id"])
        fired, score = await pipeline.infer_with_blob(
            clf.get("model_blob"), features
        )
        investigator_disabled = bool(clf.get("investigator_disabled"))
        shadow_mode = bool(clf.get("shadow_mode", True))

        investigator_skipped = bool(fired and investigator_disabled and not shadow_mode)
        est = INVESTIGATOR_COST_USD if investigator_skipped else 0.0
        if investigator_skipped:
            skip = True
            savings += est

        rec = {
            "id": str(uuid.uuid4()),
            "classifier_id": classifier_id,
            "signal_id": signal_id,
            "score": score,
            "fired": fired,
            "shadow_mode": shadow_mode,
            "investigator_skipped": investigator_skipped,
            "estimated_savings_usd": est,
        }
        predictions.append(rec)
        await _persist_prediction(org_id, trace_id, rec)
        if investigator_skipped:
            await _record_savings_cost_event(org_id, trace_id, est, signal_id)

    return {
        "skip_investigator": skip,
        "savings_usd": round(savings, 6),
        "predictions": predictions,
        "status": "ok",
    }


async def _load_active_classifiers(org_id: str) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return []
    if pg is None:
        return []
    try:
        rows = await pg.fetch(
            """
            SELECT DISTINCT ON (signal_id)
                id, signal_id, model_blob, shadow_mode,
                COALESCE(investigator_disabled, FALSE) AS investigator_disabled
            FROM signal_classifiers
            WHERE org_id = $1
            ORDER BY signal_id, trained_at DESC
            LIMIT 50
            """,
            org_id,
        )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug("classifier_worker: load failed: %s", exc)
        return []


def _extract_features(events: list[dict[str, Any]], trace_id: str) -> list[float]:
    from eden.signals.classifier_pipeline import ClassifierTrainingPipeline

    text = json.dumps(
        {"trace_id": trace_id, "events": events[:40]},
        default=str,
    )[:8000]
    return ClassifierTrainingPipeline._hash_features(text)


async def _persist_prediction(
    org_id: str, trace_id: str, rec: dict[str, Any]
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return
    if pg is None:
        return
    try:
        await pg.execute(
            """
            INSERT INTO classifier_predictions (
                id, org_id, trace_id, classifier_id, signal_id,
                score, fired, investigator_skipped, estimated_savings_usd
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            rec["id"],
            org_id,
            trace_id,
            rec["classifier_id"],
            rec["signal_id"],
            float(rec["score"]),
            bool(rec["fired"]),
            bool(rec["investigator_skipped"]),
            float(rec["estimated_savings_usd"]),
        )
    except Exception as exc:
        logger.debug("classifier_worker: persist failed: %s", exc)


async def _record_savings_cost_event(
    org_id: str, trace_id: str, savings_usd: float, signal_id: str
) -> None:
    """Ledger a $0 classifier event + metadata savings for FinOps."""
    try:
        from eden.llmops.cost_ledger import CostEvent, record_cost_event

        await record_cost_event(
            CostEvent(
                org_id=org_id,
                feature="signal_classifier",
                model="f34_logistic",
                cost_usd=0.0,
                trace_id=trace_id,
                metadata={
                    "signal_id": signal_id,
                    "estimated_savings_usd": savings_usd,
                    "avoided_feature": "signal_investigator",
                },
            )
        )
    except Exception as exc:
        logger.debug("classifier_worker: cost event failed: %s", exc)
