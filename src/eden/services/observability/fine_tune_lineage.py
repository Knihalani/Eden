"""Fine-tune lineage service — D.12.5 (§8.7).

Read + write surface over the ``fine_tuning_runs`` +
``dataset_trace_lineage`` + ``fine_tune_trace_usage`` tables.

Public surface:

* :class:`FineTuneLineageService` — service class
* :func:`get_fine_tune_service` — singleton getter

The lineage graph goes both ways (per spec §8.7):

* **Backward** — the traces that built the dataset
  (``dataset_trace_lineage``).
* **Forward** — the traces that used the fine-tuned model
  in production (``fine_tune_trace_usage``).

Webhook ingest (per spec R-12) is keyed on the provider's
``fine_tune_id`` (e.g. OpenAI's ``ftjob-xxx``) so re-deliveries
don't double-write. The partial unique index
``uq_fine_tuning_provider_id`` enforces this at the DB layer.

Ponytail: best-effort — DB errors fall through to ``[]`` /
``None`` so the route layer never 500s.
"""

from __future__ import annotations

import json
import logging
import math
import uuid
from typing import Any

logger = logging.getLogger(__name__)


# 4 spec'd statuses (per §B.9). Kept as a tuple so callers can
# validate cheaply.
STATUSES: tuple[str, ...] = (
    "pending", "running", "succeeded", "failed",
)
# 3 spec'd providers (per §B.9). See Voice service comment for
# why we don't add a CHECK — providers evolve.
PROVIDERS: tuple[str, ...] = ("openai", "together", "anyscale")

# Data-drift detector defaults per spec §8.7. We track the
# most recent ``eval_results.mean_score`` and fire the
# ``on_fine_tune_data_drift`` hook when the rolling z-score
# against historical eval scores crosses ``Z_THRESHOLD``.
DEFAULT_DRIFT_WINDOW: int = 5
DEFAULT_DRIFT_Z_THRESHOLD: float = 2.0


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("fine_tune: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("fine_tune: get_postgres_client failed: %s", exc)
        return None


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class FineTuneLineageService:
    """Service for the fine-tune lineage surface."""

    async def register_run(
        self,
        org_id: str,
        *,
        provider: str,
        base_model: str,
        fine_tuned_model: str,
        dataset_id: str,
        training_params: dict[str, Any] | None = None,
        provider_fine_tune_id: str | None = None,
        status: str = "pending",
        eval_results: dict[str, Any] | None = None,
    ) -> str | None:
        """Register a fine-tuning run.

        Idempotent on ``(provider, provider_fine_tune_id)`` —
        the webhook ingest path re-delivers on the same
        provider id and gets the same row back (R-12).
        When ``provider_fine_tune_id`` is None, a fresh
        row is inserted (manual registration).
        """
        if status not in STATUSES:
            raise ValueError(
                f"unknown status: {status!r} (expected one of {STATUSES})"
            )
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                INSERT INTO fine_tuning_runs (
                    id, org_id, provider, provider_fine_tune_id,
                    base_model, fine_tuned_model, dataset_id,
                    training_params, status, eval_results
                ) VALUES (
                    gen_random_uuid(), $1, $2, $3,
                    $4, $5, $6::uuid,
                    $7::jsonb, $8, $9::jsonb
                )
                ON CONFLICT (provider, provider_fine_tune_id)
                    WHERE provider_fine_tune_id IS NOT NULL
                DO UPDATE SET
                    status       = EXCLUDED.status,
                    eval_results = COALESCE(EXCLUDED.eval_results, fine_tuning_runs.eval_results),
                    completed_at = CASE
                        WHEN EXCLUDED.status IN ('succeeded', 'failed')
                             AND fine_tuning_runs.completed_at IS NULL
                        THEN NOW()
                        ELSE fine_tuning_runs.completed_at
                    END
                RETURNING id
                """,
                org_id,
                provider,
                provider_fine_tune_id,
                base_model,
                fine_tuned_model,
                dataset_id,
                json.dumps(training_params or {}),
                status,
                json.dumps(eval_results) if eval_results is not None else None,
            )
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug("fine_tune.register_run failed: %s", exc)
            return None

    async def update_status(
        self,
        run_id: str,
        *,
        status: str,
        eval_results: dict[str, Any] | None = None,
    ) -> bool:
        """Update the status of a run. Idempotent on ``run_id``
        — re-running with the same status is a no-op. When
        the new status is ``succeeded`` or ``failed`` AND
        ``completed_at`` is NULL, ``completed_at`` is set to
        ``now()`` server-side.
        """
        if status not in STATUSES:
            raise ValueError(
                f"unknown status: {status!r} (expected one of {STATUSES})"
            )
        client = await _get_client()
        if client is None:
            return False
        try:
            await client.execute(
                """
                UPDATE fine_tuning_runs
                   SET status       = $2,
                       eval_results = COALESCE($3::jsonb, eval_results),
                       completed_at = CASE
                           WHEN $2 IN ('succeeded', 'failed')
                                AND completed_at IS NULL
                           THEN NOW()
                           ELSE completed_at
                       END
                 WHERE id = $1::uuid
                """,
                run_id, status,
                json.dumps(eval_results) if eval_results is not None else None,
            )
            return True
        except Exception as exc:
            logger.debug("fine_tune.update_status failed: %s", exc)
            return False

    async def get_run(
        self,
        run_id: str,
        *,
        org_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the run by id (or None if not found)."""
        client = await _get_client()
        if client is None:
            return None
        try:
            if org_id:
                row = await client.fetchrow(
                    """
                    SELECT id, org_id, provider, provider_fine_tune_id,
                           base_model, fine_tuned_model, dataset_id,
                           training_params, status, eval_results,
                           created_at, completed_at
                      FROM fine_tuning_runs
                     WHERE id = $1::uuid AND org_id = $2
                    """,
                    run_id, org_id,
                )
            else:
                row = await client.fetchrow(
                    """
                    SELECT id, org_id, provider, provider_fine_tune_id,
                           base_model, fine_tuned_model, dataset_id,
                           training_params, status, eval_results,
                           created_at, completed_at
                      FROM fine_tuning_runs
                     WHERE id = $1::uuid
                    """,
                    run_id,
                )
        except Exception as exc:
            logger.debug("fine_tune.get_run failed: %s", exc)
            return None
        return _row(row) if row else None

    async def list_runs_for_org(
        self,
        org_id: str,
        *,
        status: str | None = None,
        provider: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List fine-tuning runs for an org, newest first.
        ``status`` / ``provider`` are optional filters.
        """
        client = await _get_client()
        if client is None:
            return []
        where = ["org_id = $1"]
        params: list[Any] = [org_id]
        if status is not None:
            where.append(f"status = ${len(params) + 1}")
            params.append(status)
        if provider is not None:
            where.append(f"provider = ${len(params) + 1}")
            params.append(provider)
        params.append(int(limit))
        sql = (
            "SELECT id, org_id, provider, provider_fine_tune_id, "
            "base_model, fine_tuned_model, dataset_id, "
            "training_params, status, eval_results, "
            "created_at, completed_at "
            "FROM fine_tuning_runs "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY created_at DESC LIMIT ${len(params)}"
        )
        try:
            rows = await client.fetch(sql, *params)
        except Exception as exc:
            logger.debug("fine_tune.list_runs_for_org failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def link_dataset_to_traces(
        self,
        dataset_id: str,
        *,
        trace_ids: list[str],
        span_id_by_trace: dict[str, str] | None = None,
    ) -> int:
        """Bulk-link a dataset to the traces that built it.

        Idempotent on ``(dataset_id, trace_id)`` — re-linking
        a (dataset, trace) pair is a no-op. Returns the
        number of new rows actually inserted (best-effort
        when the DB is down → 0).
        """
        if not trace_ids:
            return 0
        client = await _get_client()
        if client is None:
            return 0
        try:
            inserted = 0
            for tid in trace_ids:
                span_id = (
                    (span_id_by_trace or {}).get(tid) if span_id_by_trace else None
                )
                result = await client.execute(
                    """
                    INSERT INTO dataset_trace_lineage (
                        dataset_id, trace_id, span_id
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid)
                    ON CONFLICT (dataset_id, trace_id) DO NOTHING
                    """,
                    dataset_id, tid, span_id,
                )
                # ponytail: best-effort count via the execute result
                # string. asyncpg returns "INSERT 0 1" on success
                # and "INSERT 0 0" on conflict; we just count +1
                # for the success path. (The exact parsing is
                # provider-specific; for v0 we count on the
                # "INSERT 0 1" substring.)
                if isinstance(result, str) and "INSERT 0 1" in result:
                    inserted += 1
            return inserted
        except Exception as exc:
            logger.debug("fine_tune.link_dataset_to_traces failed: %s", exc)
            return 0

    async def record_trace_usage(
        self,
        run_id: str,
        *,
        trace_id: str,
    ) -> bool:
        """Record that a trace used the fine-tuned model. Idempotent
        on ``(run_id, trace_id)``.
        """
        client = await _get_client()
        if client is None:
            return False
        try:
            await client.execute(
                """
                INSERT INTO fine_tune_trace_usage (
                    fine_tuning_run_id, trace_id
                ) VALUES ($1::uuid, $2::uuid)
                ON CONFLICT (fine_tuning_run_id, trace_id) DO NOTHING
                """,
                run_id, trace_id,
            )
            return True
        except Exception as exc:
            logger.debug("fine_tune.record_trace_usage failed: %s", exc)
            return False

    async def get_lineage_for_run(
        self,
        run_id: str,
        *,
        org_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the full lineage for a run (per spec §C.8).

        Shape::

            {
                "run": { ... },                  # the run itself
                "backward": {
                    "dataset_id": "...",
                    "trace_ids": ["..."],        # the dataset's source traces
                },
                "forward": {
                    "fine_tuning_run_id": "...",
                    "fine_tuned_model": "...",
                    "trace_ids": ["..."],        # traces that used it
                },
            }
        """
        run = await self.get_run(run_id, org_id=org_id)
        if run is None:
            return None
        client = await _get_client()
        if client is None:
            return None
        try:
            backward_rows = await client.fetch(
                """
                SELECT trace_id, span_id, added_at
                  FROM dataset_trace_lineage
                 WHERE dataset_id = $1::uuid
                 ORDER BY added_at ASC
                """,
                run["dataset_id"],
            )
            forward_rows = await client.fetch(
                """
                SELECT trace_id, first_used_at
                  FROM fine_tune_trace_usage
                 WHERE fine_tuning_run_id = $1::uuid
                 ORDER BY first_used_at ASC
                """,
                run_id,
            )
        except Exception as exc:
            logger.debug("fine_tune.get_lineage_for_run failed: %s", exc)
            return None
        return {
            "run": run,
            "backward": {
                "dataset_id": run["dataset_id"],
                "trace_ids": [str(r["trace_id"]) for r in backward_rows],
            },
            "forward": {
                "fine_tuning_run_id": run_id,
                "fine_tuned_model": run["fine_tuned_model"],
                "trace_ids": [str(r["trace_id"]) for r in forward_rows],
            },
        }

    async def detect_data_drift(
        self,
        run_id: str,
        *,
        window: int = DEFAULT_DRIFT_WINDOW,
        z_threshold: float = DEFAULT_DRIFT_Z_THRESHOLD,
        fire_hook: bool = True,
    ) -> dict[str, Any] | None:
        """Look at the recent ``window`` eval scores for runs
        sharing the same ``base_model`` in this org. The
        most recent run's ``eval_results.mean_score`` z-score
        is computed against the trailing mean + stdev.

        Returns a drift summary (and fires the
        ``on_fine_tune_data_drift`` hook) when the z-score
        magnitude crosses ``z_threshold``. Returns
        ``None`` when the org has fewer than 3 prior
        runs (drift can't be computed) or the most
        recent run has no ``eval_results.mean_score``.
        """
        client = await _get_client()
        if client is None:
            return None
        try:
            target = await client.fetchrow(
                """
                SELECT id, org_id, base_model, eval_results,
                       created_at, status
                  FROM fine_tuning_runs
                 WHERE id = $1::uuid
                """,
                run_id,
            )
            if target is None:
                return None
            if not target["eval_results"]:
                return None
            try:
                current_score = float((target["eval_results"] or {}).get("mean_score"))
            except (TypeError, ValueError):
                return None
            if math.isnan(current_score):
                return None
            # Pull the previous (window) runs for the same
            # base_model + org, newest first (excluding the
            # target itself).
            prior = await client.fetch(
                """
                SELECT eval_results
                  FROM fine_tuning_runs
                 WHERE org_id = $1
                   AND base_model = $2
                   AND id != $3::uuid
                   AND eval_results IS NOT NULL
                 ORDER BY created_at DESC
                 LIMIT $4
                """,
                target["org_id"], target["base_model"], run_id, int(window),
            )
        except Exception as exc:
            logger.debug("fine_tune.detect_data_drift failed: %s", exc)
            return None
        prior_scores: list[float] = []
        for r in prior:
            try:
                s = float((r["eval_results"] or {}).get("mean_score"))
            except (TypeError, ValueError):
                continue
            if not math.isnan(s):
                prior_scores.append(s)
        if len(prior_scores) < 3:
            # ponytail: need at least 3 prior points for a
            # meaningful z-score. If the customer only has
            # 1-2 runs, drift detection is silently skipped.
            return None
        mean = sum(prior_scores) / len(prior_scores)
        # Sample stdev (n-1 denominator).
        variance = sum((s - mean) ** 2 for s in prior_scores) / (len(prior_scores) - 1)
        stdev = math.sqrt(variance) if variance > 0 else 0.0
        if stdev == 0.0:
            return None
        z = (current_score - mean) / stdev
        if abs(z) < z_threshold:
            return None
        direction = "regression" if z < 0 else "improvement"
        summary = {
            "run_id": run_id,
            "org_id": target["org_id"],
            "base_model": target["base_model"],
            "current_score": current_score,
            "prior_mean": mean,
            "prior_stdev": stdev,
            "window": int(window),
            "z_threshold": float(z_threshold),
            "z_score": z,
            "direction": direction,
            "drift": True,
        }
        if fire_hook:
            try:
                from eden.llmops.promotion_hooks import PromotionHook
                hook = PromotionHook()
                await hook.on_fine_tune_data_drift(
                    target["org_id"],
                    run_id=run_id,
                    base_model=target["base_model"],
                    current_score=current_score,
                    prior_mean=mean,
                    prior_stdev=stdev,
                    z_score=z,
                    direction=direction,
                )
            except Exception as exc:
                logger.debug("fine_tune.detect_data_drift: hook fire failed: %s", exc)
        return summary


_singleton: FineTuneLineageService | None = None


def get_fine_tune_service() -> FineTuneLineageService:
    """Return the process-wide :class:`FineTuneLineageService`."""
    global _singleton
    if _singleton is None:
        _singleton = FineTuneLineageService()
    return _singleton


__all__ = [
    "DEFAULT_DRIFT_WINDOW",
    "DEFAULT_DRIFT_Z_THRESHOLD",
    "FineTuneLineageService",
    "PROVIDERS",
    "STATUSES",
    "get_fine_tune_service",
]
