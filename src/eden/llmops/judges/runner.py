"""JudgeRunner — runs a list of Judges on a single TelemetryEvent
and persists the results.

The runner is best-effort: any single judge failure is logged and
the runner continues with the remaining judges. Telemetry
emission failures (writing to ``judge_scores``) are also
best-effort and never raise.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from typing import TYPE_CHECKING

from .base import Judge, JudgeContext, JudgeScore

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


class JudgeRunner:
    """Runs a set of Judges for a single event and persists the
    results to the ``judge_scores`` Postgres table.

    The runner is a stateless helper — instantiate per call, or
    reuse across calls. The LLM client is injected at call time
    so the runner can be tested with a fake.
    """

    def __init__(
        self,
        *,
        llm_client: object | None = None,
        max_concurrent_per_tenant: int = 4,
    ) -> None:
        self.llm_client = llm_client
        self.max_concurrent_per_tenant = max_concurrent_per_tenant
        # Per-runner semaphore so a single event's judges don't fan
        # out unboundedly. Per-tenant semaphores live elsewhere
        # (the calling service owns them).
        self._sem: asyncio.Semaphore | None = (
            asyncio.Semaphore(max_concurrent_per_tenant)
            if max_concurrent_per_tenant > 0
            else None
        )

    async def run_for_event(
        self,
        event: TelemetryEvent,
        judges: Iterable[Judge],
        *,
        trace_id: str | None = None,
    ) -> list[JudgeScore]:
        """Score one event with each judge. Returns the list of
        scores (also persisted as a side-effect)."""

        judges = list(judges)
        if not judges:
            return []

        # Build per-judge contexts. Use the runner's llm_client as the
        # default; per-judge overrides aren't supported yet (Phase 3
        # will add per-tenant judge models).
        ctx = JudgeContext(
            event=event,
            llm_client=self.llm_client,
            model_slot=judges[0].model_slot,
            trace_id=trace_id or event.trace_id,
        )

        # Run judges concurrently via asyncio.gather so a 4-judge
        # event scores in ~100ms (one LLM call's worth of latency)
        # rather than ~400ms (sequential). The per-tenant semaphore
        # in self._sem (set in __init__) bounds total fan-out so a
        # noisy tenant can't starve other tenants.
        async def _score_one(judge: Judge) -> JudgeScore | None:
            try:
                score = await judge.score(event, ctx)
            except Exception as exc:
                logger.debug(
                    f"judge {judge.name} raised unexpectedly: {exc}"
                )
                return None
            await self._persist(score)
            return score

        if self._sem is not None:
            async def _guarded(judge: Judge) -> JudgeScore | None:
                async with self._sem:
                    return await _score_one(judge)
            tasks = [_guarded(j) for j in judges]
        else:
            tasks = [_score_one(j) for j in judges]
        scored = await asyncio.gather(*tasks, return_exceptions=False)
        results: list[JudgeScore] = [s for s in scored if s is not None]
        return results

    async def _persist(self, score: JudgeScore) -> None:
        """Write one score to the ``judge_scores`` table. Best-effort.

        The migration is in ``src/eden/db_migrations/versions/010_judge_scores.py``.
        We import lazily so the runner module is importable before
        the migration has run (e.g. in unit tests).
        """
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            await client.execute(
                """
                INSERT INTO judge_scores (
                    judge_run_id, tenant_id, trace_id, span_id,
                    judge_name, judge_version, score, rationale,
                    model, scored_at, latency_ms, source_event_id
                )
                VALUES (
                    gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                )
                ON CONFLICT (judge_run_id) DO NOTHING
                """,
                # tenant_id: fall back to "default" if the event
                # doesn't carry one (e.g.Phase 0 decoders always do).
                getattr(score, "metadata", {}).get("tenant_id", "default"),
                score.trace_id,
                score.span_id,
                score.judge_name,
                score.judge_version,
                score.score,
                score.rationale,
                score.model,
                score.scored_at,
                score.latency_ms,
                getattr(score, "metadata", {}).get("event_id"),
            )
        except Exception as exc:
            logger.debug(f"judge_scores persist failed: {exc}")


async def run_judges_for_event(
    event: TelemetryEvent,
    judges: Iterable[Judge],
    *,
    llm_client: object | None = None,
) -> list[JudgeScore]:
    """Convenience wrapper for one-off judge runs.

    Mirrors the pattern in ``src/eden/observability/telemetry_collector.py``
    where top-level helpers wrap the singleton and the per-call class.
    """
    runner = JudgeRunner(llm_client=llm_client)
    return await runner.run_for_event(event, judges)
