"""F42 weekly drift baseline worker."""

from __future__ import annotations

import logging
from typing import Any

from eden.insights.drift_reports import DRIFT_DIMENSIONS, DriftReportBuilder
from eden.storage.watermark import advance_watermark, fetch_stale_candidates

logger = logging.getLogger(__name__)

#: Peak concurrent dimension histograms / upserts per weekly tick (OPT-25).
#: Each (org_id, agent_id) pair touches ``len(DRIFT_DIMENSIONS)`` independent
#: DB round-trips; overlap them under the shared gather semaphore so a slow
#: dimension cannot monopolise the tick — mirrors auto_curator's limit=8.
_DRIFT_BASELINE_CONCURRENCY = 8

#: Watermark table created by migration 147_drift_baseline_watermark
#: (OPT-8). ``agent_issues.org_id``/``agent_id`` are ``VARCHAR`` (not
#: FK'd to a UUID primary key — see 084_agent_issues), so the composite
#: key is joined/upserted with no ``::uuid`` cast (``id_cast=None``
#: below), unlike ``classifier_retrain_watermark``'s genuinely-UUID
#: ``(org_id, signal_id)`` pair (OPT-7, same wave).
_WATERMARK_TABLE = "drift_baseline_watermark"


def _org_agent_key(org_id: str, agent_id: str) -> str:
    """Combine an (org_id, agent_id) pair into one string for logging/tests.

    ``drift_baseline_watermark``'s primary key is the genuine two-column
    composite ``(org_id, agent_id)`` — ``fetch_stale_candidates``/
    ``advance_watermark`` bind each column separately (see
    ``eden.storage.watermark``), this helper never touches SQL parameter
    binding. It just gives call sites (logging, tests) a single
    hashable identifier for a pair instead of juggling a 2-tuple.
    """
    return f"{org_id}:{agent_id}"


class DriftBaselineWorker:
    """Refresh drift_baselines histograms for active agents (weekly)."""

    async def run_once(self, *, limit: int = 100) -> dict[str, Any]:
        updated = 0
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"updated": 0}

            # Watermarked, oldest-processed-first selection (OPT-8) — the
            # prior bare ``SELECT DISTINCT ... LIMIT $1`` with no
            # ``ORDER BY`` returned the same stable-but-arbitrary subset of
            # (org_id, agent_id) pairs every single weekly run forever,
            # silently starving everything past the limit. See
            # ``eden.storage.watermark`` for the shared idiom and
            # ``147_drift_baseline_watermark`` for why this table's
            # composite key is ``VARCHAR`` rather than ``UUID``. The
            # 7-day activity floor is expressed as a WHERE clause inside
            # the ``candidate_table`` subquery rather than a new
            # ``fetch_stale_candidates`` parameter, so the shared
            # watermark module (other Wave 2 items depend on it too)
            # doesn't need to grow an arbitrary-WHERE knob for this one
            # caller.
            rows = await fetch_stale_candidates(
                client,
                candidate_table=(
                    "(SELECT DISTINCT org_id, agent_id "
                    "FROM agent_issues "
                    "WHERE last_seen >= now() - interval '7 days' "
                    "AND agent_id IS NOT NULL)"
                ),
                watermark_table=_WATERMARK_TABLE,
                candidate_id_column=("org_id", "agent_id"),
                watermark_id_column=("org_id", "agent_id"),
                id_alias=("org_id", "agent_id"),
                limit=limit,
            )

            from eden.workers.leader import record_watermark_batch

            try:
                candidate_total = await client.fetchval(
                    "SELECT COUNT(*) FROM ("
                    "SELECT DISTINCT org_id, agent_id FROM agent_issues "
                    "WHERE last_seen >= now() - interval '7 days' "
                    "AND agent_id IS NOT NULL"
                    ") t"
                )
            except Exception:
                candidate_total = None
            record_watermark_batch(
                "drift_baselines",
                batch_size=len(rows),
                candidate_total=(
                    int(candidate_total) if candidate_total is not None else None
                ),
            )

            builder = DriftReportBuilder()
            from eden.async_tasks import bounded_gather

            async def _refresh_pair(row: Any) -> int:
                org_id = str(row["org_id"])
                agent_id = str(row["agent_id"])
                pair_updated = 0
                try:

                    async def _refresh_dimension(dim: str) -> int:
                        counts = await self._histogram(org_id, agent_id, dim)
                        if counts:
                            await builder.upsert_baseline(
                                org_id,
                                agent_id,
                                dim,
                                counts,
                                sample_count=sum(counts),
                            )
                            return 1
                        return 0

                    # Was a nested sequential loop: up to ``limit`` pairs ×
                    # ``len(DRIFT_DIMENSIONS)`` histogram + upsert RTs each,
                    # all awaited one-at-a-time (~1400 RTs/tick at limit=100).
                    dim_outcomes = await bounded_gather(
                        *(
                            _refresh_dimension(dim)
                            for dim in DRIFT_DIMENSIONS
                        ),
                        limit=_DRIFT_BASELINE_CONCURRENCY,
                        return_exceptions=True,
                    )
                    for dim, outcome in zip(
                        DRIFT_DIMENSIONS, dim_outcomes, strict=True
                    ):
                        if isinstance(outcome, BaseException):
                            logger.exception(
                                "drift baseline dimension=%s failed pair=%s: %s",
                                dim,
                                _org_agent_key(org_id, agent_id),
                                outcome,
                            )
                            continue
                        pair_updated += int(outcome)
                except Exception:
                    # Isolate one poison pair's failure to itself — without
                    # this, an exception here would propagate past the
                    # ``finally`` below and out of the pair batch entirely,
                    # silently skipping (and never watermark-advancing) every
                    # remaining pair. Each pair must be independent, mirroring
                    # ``cron_tick._run_org_and_advance_watermark``'s
                    # per-entity isolation.
                    logger.exception(
                        "drift baseline dimension pass failed pair=%s",
                        _org_agent_key(org_id, agent_id),
                    )
                finally:
                    # Advance once per pair, after the full DRIFT_DIMENSIONS
                    # pass finishes (success or failure) — not per-dimension
                    # — so a pair only cycles to the back of the watermark
                    # ordering once its whole baseline refresh pass is
                    # done. A poison pair that always raises must still
                    # advance, or it permanently occupies the front of
                    # fetch_stale_candidates's ordering and starves every
                    # pair behind it forever.
                    try:
                        await advance_watermark(
                            client,
                            watermark_table=_WATERMARK_TABLE,
                            entity_id=(org_id, agent_id),
                            watermark_id_column=("org_id", "agent_id"),
                            id_cast=None,
                        )
                    except Exception:
                        logger.exception(
                            "drift baseline watermark advance failed pair=%s",
                            _org_agent_key(org_id, agent_id),
                        )
                return pair_updated

            pair_outcomes = await bounded_gather(
                *(_refresh_pair(row) for row in (rows or [])),
                limit=_DRIFT_BASELINE_CONCURRENCY,
                return_exceptions=True,
            )
            for outcome in pair_outcomes:
                if isinstance(outcome, BaseException):
                    logger.exception(
                        "drift baseline pair pass failed: %s", outcome
                    )
                    continue
                updated += int(outcome)
        except Exception as exc:
            logger.warning("drift baseline worker failed: %s", exc)
        return {"updated": updated}

    async def _histogram(
        self, org_id: str, agent_id: str, dimension: str
    ) -> list[float]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            if dimension == "stumble_rate":
                rate = await client.fetchval(
                    """
                    SELECT AVG(CASE WHEN status = 'open' THEN 1.0 ELSE 0.0 END)
                    FROM agent_issues
                    WHERE org_id = $1 AND agent_id = $2
                      AND last_seen >= now() - interval '7 days'
                    """,
                    org_id,
                    agent_id,
                )
                base = float(rate or 0.1)
                return [base * (1 + i * 0.05) for i in range(10)]
            count = await client.fetchval(
                """
                SELECT COUNT(*) FROM agent_issues
                WHERE org_id = $1 AND agent_id = $2
                  AND last_seen >= now() - interval '7 days'
                """,
                org_id,
                agent_id,
            )
            c = max(int(count or 0), 1)
            return [float(c // 10 + (1 if i < c % 10 else 0)) for i in range(10)]
        except Exception:
            return [10.0] * 10
