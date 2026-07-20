"""Cold-path cache warming for F39/F40 gateway hot path (0 DB on apply)."""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

_WARM_INFLIGHT: set[str] = set()


def _key(org_id: str, agent_id: str) -> str:
    return f"{org_id}:{agent_id}"


async def warm_learn_caches(
    org_id: str,
    agent_id: str,
    *,
    task_text: str = "",
) -> dict[str, bool]:
    """Populate org flags, nudge cache, and ledger pack cache.

    Returns a proof dict so callers (EvidenceGate / gateway) can assert
    warm-cache completed for F39 promote inject.

    The three warmers are independent I/O — run concurrently.
    """
    from eden.kb.ledger.retrieve import LedgerRetriever
    from eden.nudges.engine import NudgeEngine
    from eden.preview.gates import warm_org_flags

    proof = {"flags": False, "nudges": False, "ledger": False}

    async def _flags() -> bool:
        try:
            await warm_org_flags(org_id)
            return True
        except Exception as exc:
            logger.debug("warm flags failed: %s", exc)
            return False

    async def _nudges() -> bool:
        try:
            await NudgeEngine().warm_cache(org_id, agent_id)
            return True
        except Exception as exc:
            logger.debug("warm nudges failed: %s", exc)
            return False

    async def _ledger() -> bool:
        try:
            await LedgerRetriever().pack_for_request(
                org_id, agent_id, task_text=task_text
            )
            return True
        except Exception as exc:
            logger.debug("warm ledger failed: %s", exc)
            return False

    flags_ok, nudges_ok, ledger_ok = await asyncio.gather(
        _flags(), _nudges(), _ledger()
    )
    proof["flags"] = flags_ok
    proof["nudges"] = nudges_ok
    proof["ledger"] = ledger_ok
    return proof


def schedule_warm_learn(org_id: str, agent_id: str, *, task_text: str = "") -> None:
    """Fire-and-forget warm for gateway first touch (sync callers)."""
    cache_key = _key(org_id, agent_id)
    if cache_key in _WARM_INFLIGHT:
        return
    _WARM_INFLIGHT.add(cache_key)

    async def _run() -> None:
        try:
            await warm_learn_caches(org_id, agent_id, task_text=task_text)
        except Exception as exc:
            logger.debug("warm_learn_caches failed org=%s agent=%s: %s", org_id, agent_id, exc)
        finally:
            _WARM_INFLIGHT.discard(cache_key)

    try:
        asyncio.get_running_loop()
        from eden.async_tasks import bounded_create_task

        bounded_create_task(_run(), name="warm-learn")
    except RuntimeError:
        asyncio.run(_run())
