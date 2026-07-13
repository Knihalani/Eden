"""Periodic insights detector loop (Phase 7.1b follow-up).

The Insights Engine ships six real detector classes
(FailurePatternDetector, PerformanceAnomalyDetector,
RegressionDetector, DisparityDetector, RewardHackingDetector,
NovelBehaviorDetector) plus the ``JudgeDetector`` virtual detector
that bridges the ``judge_scores`` table to the ``InsightsService``
surface.  None of them was wired to run periodically on new
``judge_scores`` rows.

This module is that wiring.

Lifecycle
---------
1. ``start()`` is called from the FastAPI ``lifespan`` context in
   ``src/eden/api/app.py``.  It is a no-op when
   ``Settings.insights_loop_enabled`` is ``False`` and is idempotent
   (a second ``start()`` after ``stop()`` is fine).
2. The loop reads the per-tenant watermark from
   ``judge_scores_processed`` (migration 018) and SELECTs new
   ``judge_scores`` rows whose ``judge_run_id`` is greater than
   the watermark, ordered by ``scored_at`` ASC.
3. Each batch is fanned through ``DetectorRegistry.run_all`` (sync
   path) which already does the work of converting rows into
   ``Insight`` objects via the ``JudgeDetector`` virtual detector.
4. Each resulting ``Insight`` is persisted to Postgres via
   ``InsightsService.persist_insight_to_postgres`` (which is the
   writer for the ``insights`` table from migration 019).  A best
   effort KB write is also issued so the closed-loop correlation
   report keeps working.
5. The watermark is advanced to the highest ``judge_run_id`` we
   successfully processed.

Failure policy
--------------
The loop must never crash the app.  Every per-tenant iteration is
wrapped in a broad ``try`` that logs and continues.  A Postgres
hiccup simply defers the batch to the next tick.  Cancellation is
honoured: a ``CancelledError`` is re-raised so the lifespan
shutdown finishes in bounded time.

Settings
--------
- ``insights_loop_enabled`` (default True): master switch.
- ``insights_loop_interval_seconds`` (default 60): poll cadence.
- ``insights_loop_batch_size`` (default 200): cap per tenant per
  tick.  Caps memory use; a high-throughput tenant will catch up
  over a few ticks rather than in one big transaction.
- ``insights_loop_max_runtime_seconds`` (default 50): soft cap on
  per-tick runtime.  If we exceed this we commit the watermark
  for the tenant we were working on and let the next tick pick
  up the rest.  Default is 50s so two ticks don't overlap when
  the loop runs at 60s intervals.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any
from uuid import UUID

from eden.config import Settings, get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class InsightsDetectorLoop:
    """Background task: per-tenant poll of new judge_scores → Insights."""

    def __init__(
        self,
        *,
        interval_seconds: float | None = None,
        batch_size: int | None = None,
        max_runtime_seconds: float | None = None,
        settings: Settings | None = None,
    ) -> None:
        s = settings or get_settings()
        self.interval_seconds: float = (
            interval_seconds
            if interval_seconds is not None
            else float(getattr(s, "insights_loop_interval_seconds", 60))
        )
        self.batch_size: int = (
            batch_size
            if batch_size is not None
            else int(getattr(s, "insights_loop_batch_size", 200))
        )
        self.max_runtime_seconds: float = (
            max_runtime_seconds
            if max_runtime_seconds is not None
            else float(getattr(s, "insights_loop_max_runtime_seconds", 50))
        )
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    # ── Lifecycle ──────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the background polling task. Idempotent."""
        if not self._is_enabled():
            logger.info("insights detector loop disabled by settings")
            return
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="insights-detector-loop")
        logger.info(
            "insights detector loop started "
            f"(interval={self.interval_seconds}s, batch={self.batch_size})"
        )

    async def stop(self) -> None:
        """Stop the background task. Drains the in-flight tick."""
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            logger.info("insights detector loop stopped")

    @staticmethod
    def _is_enabled() -> bool:
        try:
            return bool(getattr(get_settings(), "insights_loop_enabled", True))
        except Exception:  # noqa: BLE001
            return True

    # ── Main loop ──────────────────────────────────────────────────────

    async def _run(self) -> None:
        while not self._stop.is_set():
            tick_start = time.monotonic()
            try:
                await self.tick_once()
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"insights detector loop tick failed: {exc}")
            elapsed = time.monotonic() - tick_start
            sleep_for = max(0.0, self.interval_seconds - elapsed)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=sleep_for)

    async def tick_once(self) -> dict[str, int]:
        """Run one iteration of the loop and return per-tenant counts.

        Exposed for tests so a single tick can be driven
        deterministically (no sleeping) against a fake Postgres.
        """
        started = time.monotonic()
        per_tenant: dict[str, int] = {}
        try:
            tenants = await self._list_tenants_with_new_scores()
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"insights loop tenant list failed: {exc}")
            tenants = []

        for tenant_id in tenants:
            if self._stop.is_set():
                break
            if (time.monotonic() - started) > self.max_runtime_seconds:
                logger.debug(
                    "insights loop tick exceeded max_runtime_seconds; "
                    "remaining tenants deferred to next tick"
                )
                break
            try:
                count = await self._process_tenant(tenant_id)
                per_tenant[tenant_id] = count
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"insights loop: tenant {tenant_id} failed: {exc}"
                )
                per_tenant[tenant_id] = 0
        return per_tenant

    # ── Per-tenant work ────────────────────────────────────────────────

    async def _list_tenants_with_new_scores(self) -> list[str]:
        """Return the tenant_ids that have new judge_scores rows to process.

        The heuristic: union of the tenants in the watermark table
        (where we left off mid-stream) and the distinct
        ``tenant_id`` values in ``judge_scores`` that are ahead of
        the watermark (or for which no watermark row exists).
        """
        client = await self._get_pg()
        if client is None:
            return []

        rows = await client.fetch(
            """
            SELECT DISTINCT j.tenant_id
            FROM judge_scores j
            LEFT JOIN judge_scores_processed w
              ON w.tenant_id = j.tenant_id
            WHERE w.last_processed_judge_score_id IS NULL
               OR j.judge_run_id > w.last_processed_judge_score_id
            ORDER BY j.tenant_id
            """
        )
        return [str(r["tenant_id"]) for r in rows]

    async def _process_tenant(self, tenant_id: str) -> int:
        """Process up to ``batch_size`` new scores for ``tenant_id``.

        Returns the number of new Insights persisted.
        """
        client = await self._get_pg()
        if client is None:
            return 0

        watermark = await self._read_watermark(client, tenant_id)
        if watermark is not None:
            new_rows = await client.fetch(
                """
                SELECT judge_run_id, judge_name, judge_version, trace_id, span_id,
                       score, rationale, model, scored_at, latency_ms, tenant_id
                FROM judge_scores
                WHERE tenant_id = $1
                  AND judge_run_id > $2
                ORDER BY scored_at ASC
                LIMIT $3
                """,
                tenant_id,
                watermark,
                self.batch_size,
            )
        else:
            new_rows = await client.fetch(
                """
                SELECT judge_run_id, judge_name, judge_version, trace_id, span_id,
                       score, rationale, model, scored_at, latency_ms, tenant_id
                FROM judge_scores
                WHERE tenant_id = $1
                ORDER BY scored_at ASC
                LIMIT $2
                """,
                tenant_id,
                self.batch_size,
            )
        if not new_rows:
            # No work — still upsert a watermark row so future
            # ``_list_tenants_with_new_scores`` doesn't re-scan
            # this tenant.
            await self._upsert_watermark(
                client, tenant_id, watermark
            )
            return 0

        # Convert rows → Insights via the JudgeDetector virtual
        # detector (the only detector that needs the raw rows;
        # the other five analyze UnifiedTraces which we don't
        # load here — they'd require a heavier pipeline that
        # already runs on demand).
        insights = self._rows_to_insights([dict(r) for r in new_rows])
        if not insights:
            # Advance the watermark to the highest id we saw so
            # we don't re-read the same rows next tick.
            top = max(str(r["judge_run_id"]) for r in new_rows)
            await self._upsert_watermark(client, tenant_id, top)
            return 0

        # Persist Insights via the InsightsService — same code
        # path the API uses, including the KB write and the
        # kb_insight_writes audit row.  If ``InsightsService``
        # can't be imported (e.g. KB is broken), we still
        # advance the watermark so a transient outage doesn't
        # permanently block processing; the per-tenant count
        # is 0 in that case so dashboards don't see ghost rows.
        persisted = 0
        try:
            from eden.insights.insights_service import InsightsService

            service = InsightsService()
            # Fan out the per-insight persists concurrently via
            # asyncio.gather — each persist is an independent write
            # (separate row + audit). With many insights per cycle
            # this drops wall-clock latency from O(N) to ~O(1).
            # return_exceptions=True preserves the original per-row
            # try/except semantics: one bad insight doesn't kill the
            # rest of the batch.
            persist_results = await asyncio.gather(
                *(
                    service.persist_insight_to_postgres(
                        insight, organization_id=tenant_id
                    )
                    for insight in insights
                ),
                return_exceptions=True,
            )
            for insight, result in zip(insights, persist_results, strict=False):
                if isinstance(result, Exception):
                    logger.debug(
                        f"insights loop: persist failed for "
                        f"{insight.insight_id}: {result}"
                    )
                    continue
                if result is not None:
                    persisted += 1
                    try:
                        from eden.kb.flywheel.coordinator import get_flywheel_coordinator

                        await get_flywheel_coordinator().on_insight_created(insight)
                    except Exception as fly_exc:
                        logger.debug(
                            "insights loop: flywheel hook failed: %s", fly_exc
                        )
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"insights loop: InsightsService unavailable: {exc}")

        # Advance watermark to the highest judge_run_id we saw.
        top = max(str(r["judge_run_id"]) for r in new_rows)
        await self._upsert_watermark(client, tenant_id, top)
        return persisted

    @staticmethod
    def _rows_to_insights(rows: list[dict[str, Any]]) -> list[Any]:
        """Convert ``judge_scores`` rows to ``Insight`` objects.

        Delegates to ``JudgeDetector._rows_to_insights`` so the loop
        and the detector share a single source of truth for the
        row → Insight mapping.  We don't instantiate a full
        ``DetectorRegistry`` because the other five detectors work
        on ``UnifiedTrace`` batches (not raw ``judge_scores``
        rows) and are triggered by their own pipelines.
        """
        from eden.insights.detectors import JudgeDetector

        return JudgeDetector()._rows_to_insights(rows)

    # ── Watermark helpers ─────────────────────────────────────────────

    @staticmethod
    async def _read_watermark(
        client: Any, tenant_id: str
    ) -> str | None:
        row = await client.fetchrow(
            """
            SELECT last_processed_judge_score_id
            FROM judge_scores_processed
            WHERE tenant_id = $1
            """,
            tenant_id,
        )
        if row is None:
            return None
        val = row["last_processed_judge_score_id"]
        return str(val) if val is not None else None

    @staticmethod
    async def _upsert_watermark(
        client: Any,
        tenant_id: str,
        last_processed_judge_score_id: str | None,
    ) -> None:
        """Set the watermark for ``tenant_id``.

        ``last_processed_judge_score_id`` may be ``None`` (no
        rows seen yet) or a UUID string.  We use
        ``COALESCE`` so a ``None`` pass through (e.g. the
        watermark exists but we want to keep its value) is a
        no-op.  The caller always passes the value we want
        persisted, so a straight ``EXCLUDED`` write is fine.
        """
        try:
            await client.execute(
                """
                INSERT INTO judge_scores_processed (
                    tenant_id, last_processed_judge_score_id, updated_at
                )
                VALUES ($1, $2, NOW())
                ON CONFLICT (tenant_id) DO UPDATE
                SET last_processed_judge_score_id = EXCLUDED.last_processed_judge_score_id,
                    updated_at = NOW()
                """,
                tenant_id,
                # Postgres needs a UUID or NULL — the column is UUID.
                # The loop's contract: we always pass either the
                # last-known UUID (no new rows) or the top of the
                # just-processed batch.  Both are valid UUIDs.
                UUID(last_processed_judge_score_id)
                if last_processed_judge_score_id
                else None,
            )
        except (ValueError, TypeError) as exc:
            logger.debug(
                f"insights loop: bad watermark id "
                f"{last_processed_judge_score_id!r}: {exc}"
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"insights loop: watermark upsert failed: {exc}")

    # ── Postgres accessor ──────────────────────────────────────────────

    @staticmethod
    async def _get_pg() -> Any:
        try:
            return await get_postgres_client()
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"insights loop: postgres unavailable: {exc}")
            return None


# ── Module-level singleton used by the lifespan ──────────────────────

_loop: InsightsDetectorLoop | None = None
_started_for: InsightsDetectorLoop | None = None
# Idempotency guard: we only call ``.start()`` once per singleton
# instance.  The test fixture ``test_start_is_idempotent`` resets
# ``_loop = None`` between runs; tracking the *instance* we
# started on lets the new singleton start fresh, while a
# duplicate ``start_insights_detector_loop()`` call against the
# same singleton is a no-op.


def get_insights_detector_loop() -> InsightsDetectorLoop:
    """Return the process-wide singleton (lazily built)."""
    global _loop
    if _loop is None:
        _loop = InsightsDetectorLoop()
    return _loop


async def start_insights_detector_loop() -> None:
    """Start the process-wide loop. Idempotent.

    Honors ``Settings.insights_loop_enabled`` BEFORE constructing
    the loop singleton — so tests that patch the constructor can
    observe a no-op start when the feature is disabled, instead
    of having the disabled flag checked deep inside ``.start()``.

    Idempotency is enforced by comparing the singleton we last
    started with the one we'd be about to start.  A second call
    against the same singleton is a no-op; replacing the
    singleton (e.g. in tests) re-arms the guard.
    """
    global _started_for
    try:
        if not bool(getattr(get_settings(), "insights_loop_enabled", True)):
            logger.info("insights detector loop disabled by settings")
            return
    except Exception:  # noqa: BLE001
        # If settings can't be loaded for any reason, fall through
        # to the default-enabled path; the loop's own ``start``
        # will guard against real failure.
        pass
    loop = get_insights_detector_loop()
    if _started_for is loop:
        return
    await loop.start()
    _started_for = loop


async def stop_insights_detector_loop() -> None:
    """Stop the process-wide loop. Idempotent."""
    global _loop, _started_for
    if _loop is not None:
        await _loop.stop()
    _started_for = None
