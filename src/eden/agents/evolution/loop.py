"""Background evolution + promotion loop.

Wires the closed-loop flywire into the API lifespan:
  1. :class:`JudgeScorePromptEvolver` — scan judge scores, generate variants
  2. :class:`PromptEvolvers` — enroll pending variants in canaries
  3. :class:`PromotionLoop` — promote/rollback active canaries
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from eden.config import Settings, get_settings

logger = logging.getLogger(__name__)

_loop_task: asyncio.Task[None] | None = None
_stop_event: asyncio.Event | None = None


async def _enroll_pending_canaries() -> int:
    """Enroll variants that have ``ab_test_active`` but no canary yet."""
    from eden.agents.evolution.components import PromptEvolvers
    from eden.storage.postgres import get_postgres_client

    pg = await get_postgres_client()
    if not pg:
        return 0
    try:
        rows = await pg.fetch(
            """
            SELECT agent, version,
                   COALESCE((quality_metrics->>'ab_test_round')::int, 1) AS ab_round
            FROM prompt_versions
            WHERE COALESCE((quality_metrics->>'ab_test_active')::boolean, false) = true
              AND COALESCE(quality_metrics->>'canary_status', '') = ''
            ORDER BY created_at DESC
            LIMIT 20
            """
        )
    except Exception as exc:
        logger.debug("evolution_loop: pending canary query failed: %s", exc)
        return 0

    evolver = PromptEvolvers()
    enrolled = 0
    for row in rows:
        ok = await evolver._auto_create_canary(
            str(row["agent"]),
            int(row["version"]),
            int(row["ab_round"] or 1),
        )
        if ok:
            enrolled += 1
    return enrolled


async def run_evolution_pass() -> dict[str, Any]:
    """One evolution tick — never raises."""
    from eden.agents.evolution.components import JudgeScorePromptEvolver
    from eden.llm.client import OpenRouterClient
    from eden.llmops.cost_ledger import cost_context
    from eden.llmops.evolution_spend import EvolutionSpendBudget
    from eden.llmops.feature_kills import is_feature_enabled
    from eden.llmops.promotion import get_promotion_loop

    summary: dict[str, Any] = {
        "evolver": {},
        "canaries_enrolled": 0,
        "promotion": {},
        "spend_skipped": False,
    }

    # Preflight: evolution spend cap (platform-wide ops budget).
    # When over cap, skip LLM evolver; canary enroll + promotion still run.
    ops_org = "eden-ops"
    try:
        if not await is_feature_enabled(ops_org, "evolution"):
            summary["spend_skipped"] = True
            summary["evolver"] = {"skipped": "feature_kill"}
        else:
            budget = EvolutionSpendBudget(ops_org)
            if not await budget.may_spend(0.05):
                summary["spend_skipped"] = True
                summary["evolver"] = {
                    "skipped": "evolution_spend_cap",
                    **(await budget.status()),
                }
            else:
                with cost_context(ops_org, "evolution"):
                    llm = OpenRouterClient()
                    evolver = JudgeScorePromptEvolver(llm_client=llm)
                    summary["evolver"] = await evolver.run()
                # Debit a conservative estimate when evolver did work.
                evolved = summary["evolver"]
                if isinstance(evolved, dict) and any(
                    int(evolved.get(k) or 0) > 0
                    for k in ("variants_created", "scanned", "candidates")
                    if k in evolved
                ):
                    await budget.record(
                        0.05, kind="evolution_pass", ref_id="loop"
                    )
    except Exception as exc:
        logger.warning("evolution_loop: JudgeScorePromptEvolver failed: %s", exc)

    try:
        summary["canaries_enrolled"] = await _enroll_pending_canaries()
    except Exception as exc:
        logger.warning("evolution_loop: canary enrollment failed: %s", exc)

    try:
        summary["promotion"] = await get_promotion_loop().run_once()
    except Exception as exc:
        logger.warning("evolution_loop: PromotionLoop failed: %s", exc)

    return summary


async def _loop_body(settings: Settings) -> None:
    assert _stop_event is not None
    interval = float(getattr(settings, "evolution_loop_interval_seconds", 300))
    while not _stop_event.is_set():
        try:
            result = await run_evolution_pass()
            if any(result.get("evolver", {}).values()) or result.get("canaries_enrolled"):
                logger.info("evolution_loop tick: %s", result)
        except Exception as exc:
            logger.warning("evolution_loop tick failed: %s", exc)
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=interval)
        except TimeoutError:
            continue


async def start_evolution_loop() -> None:
    """Start the background evolution loop (idempotent)."""
    global _loop_task, _stop_event
    settings = get_settings()
    if not getattr(settings, "evolution_loop_enabled", True):
        logger.info("evolution_loop: disabled via settings")
        return
    if _loop_task and not _loop_task.done():
        return
    _stop_event = asyncio.Event()
    _loop_task = asyncio.create_task(_loop_body(settings), name="eden-evolution-loop")
    logger.info("evolution_loop: started (interval=%ss)", settings.evolution_loop_interval_seconds)


async def stop_evolution_loop() -> None:
    """Stop the background evolution loop."""
    global _loop_task, _stop_event
    if _stop_event:
        _stop_event.set()
    if _loop_task:
        _loop_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _loop_task
    _loop_task = None
    _stop_event = None


def is_evolution_loop_running() -> bool:
    """Return True when the evolution loop asyncio task is alive."""
    return _loop_task is not None and not _loop_task.done()


__all__ = [
    "run_evolution_pass",
    "start_evolution_loop",
    "stop_evolution_loop",
    "is_evolution_loop_running",
]
