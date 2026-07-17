"""F34 — 7-day shadow comparison: classifier vs investigator."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class ShadowComparator:
    """Compare classifier predictions against investigator labels."""

    async def report(
        self,
        org_id: str,
        signal_id: str,
        *,
        window_days: int = 7,
    ) -> dict[str, Any]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return {"status": "unavailable", "agreement_rate": None}
        if pg is None:
            return {"status": "unavailable", "agreement_rate": None}

        try:
            row = await pg.fetchrow(
                """
                SELECT COUNT(*)::int AS n,
                       COUNT(*) FILTER (
                         WHERE shadow_investigator_agree IS TRUE
                       )::int AS agree,
                       COUNT(*) FILTER (
                         WHERE fired IS TRUE
                       )::int AS fired,
                       COUNT(*) FILTER (
                         WHERE investigator_skipped IS TRUE
                       )::int AS skipped,
                       COALESCE(SUM(estimated_savings_usd), 0)::float AS savings
                FROM classifier_predictions
                WHERE org_id = $1
                  AND signal_id = $2
                  AND created_at > NOW() - ($3 || ' days')::interval
                """,
                org_id,
                signal_id,
                str(window_days),
            )
        except Exception as exc:
            logger.debug("shadow_compare: query failed: %s", exc)
            return {"status": "error", "error": str(exc), "agreement_rate": None}

        n = int(row["n"] or 0) if row else 0
        agree = int(row["agree"] or 0) if row else 0
        agreement = (agree / n) if n else None
        return {
            "status": "ok",
            "feature": "f34_shadow_compare",
            "signal_id": signal_id,
            "window_days": window_days,
            "prediction_count": n,
            "agreement_count": agree,
            "agreement_rate": round(agreement, 4) if agreement is not None else None,
            "fired_count": int(row["fired"] or 0) if row else 0,
            "investigator_skipped": int(row["skipped"] or 0) if row else 0,
            "estimated_savings_usd": round(float(row["savings"] or 0), 4) if row else 0.0,
            "promote_ready": bool(agreement is not None and agreement >= 0.8 and n >= 20),
        }
