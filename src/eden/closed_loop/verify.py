"""Closed-loop verify loop (F46, Wave 6).

After a remediation the orchestrator calls :func:`schedule_verify`, which
inserts an ``issue_verifications`` row due ``verify_delay_seconds`` in the
future. :class:`VerifyWorker` polls due rows and confirms the fix held:

* **stumble-rate → 0** — no new stumbles for the issue fingerprint within
  the trailing ``verify_quiet_window_minutes``; and
* **StatGate P0 cleared** — the deterministic scorer no longer flags a P0
  for the issue.

Pass → emit ``verify_passed`` (orchestrator resolves the issue). Fail →
emit ``verify_failed`` (orchestrator regresses + escalates to a human).
The worker retries up to ``verify_max_attempts`` before failing a row, so
a fix that needs a moment to propagate isn't prematurely regressed.

Postgres-backed, no delayed-queue infra — the ``(status, scheduled_at)``
index makes the due-poll a cheap range scan.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from typing import Any

from eden.closed_loop.events import EventType, LoopEvent

logger = logging.getLogger(__name__)

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None


# ── Scheduling ──────────────────────────────────────────────────────


async def schedule_verify(
    org_id: str,
    issue_id: str,
    *,
    ref: str = "",
    delay_seconds: int | None = None,
) -> bool:
    """Insert (or replace) a pending verify row for an issue."""
    client = await _pg()
    if client is None:
        return False
    delay = delay_seconds if delay_seconds is not None else _cfg("verify_delay_seconds", 1800)
    fingerprint = ref
    if not fingerprint:
        try:
            from eden.issues.repo import IssuesRepo

            issue = await IssuesRepo().get_issue(org_id, issue_id)
            fingerprint = issue.fingerprint if issue else ""
        except Exception:
            fingerprint = ""
    try:
        await client.execute(
            """
            INSERT INTO issue_verifications
                (id, org_id, issue_id, fingerprint, ref, scheduled_at, status)
            VALUES ($1::uuid, $2, $3::uuid, $4, $5,
                    NOW() + ($6 || ' seconds')::interval, 'pending')
            ON CONFLICT (org_id, issue_id) WHERE status = 'pending'
            DO UPDATE SET
                scheduled_at = EXCLUDED.scheduled_at,
                fingerprint = EXCLUDED.fingerprint,
                ref = EXCLUDED.ref,
                attempts = 0
            """,
            str(uuid.uuid4()),
            org_id,
            issue_id,
            (fingerprint or "")[:64],
            (ref or "")[:128] or None,
            str(int(delay)),
        )
        logger.info(
            "verify: scheduled issue=%s in %ss (fp=%s)",
            issue_id,
            delay,
            fingerprint,
        )
        return True
    except Exception as exc:
        logger.debug("verify: schedule failed: %s", exc)
        return False


# ── Checks ──────────────────────────────────────────────────────────


async def _verify_issue(org_id: str, issue_id: str, fingerprint: str) -> tuple[bool, dict[str, Any]]:
    """Return ``(passed, detail)`` — did the fix hold?"""
    from eden.issues.repo import IssuesRepo

    repo = IssuesRepo()
    window = _cfg("verify_quiet_window_minutes", 30)
    recent = 0
    if fingerprint:
        recent = await repo.count_recent_stumbles(
            org_id, fingerprint, minutes=window
        )
    detail: dict[str, Any] = {
        "recent_stumbles": recent,
        "quiet_window_minutes": window,
    }
    if recent > 0:
        detail["reason"] = "new stumbles within quiet window"
        return False, detail

    # StatGate P0 must be clear.
    try:
        issue = await repo.get_issue(org_id, issue_id)
        if issue is not None:
            from eden.issues.statgate_scorer import StatGateIncidentScorer

            stumbles = await repo.list_stumbles(
                org_id, fingerprint=fingerprint, limit=20
            )
            score = StatGateIncidentScorer().score(
                {
                    "id": issue.id,
                    "kind": issue.kind,
                    "severity": issue.severity,
                    "stumble_count": issue.stumble_count,
                },
                stumbles,
            )
            detail["statgate_p0"] = score.p0
            if score.p0:
                detail["reason"] = "StatGate still flags P0"
                return False, detail
    except Exception as exc:
        logger.debug("verify: statgate re-score failed: %s", exc)

    detail["reason"] = "quiet window clean + no P0"
    return True, detail


async def run_due_verifications(limit: int = 50) -> dict[str, int]:
    """Process all due verify rows once. Returns a summary counter.

    Public + side-effect-contained so tests can drive a single pass.
    """
    client = await _pg()
    summary = {"checked": 0, "passed": 0, "failed": 0, "retried": 0}
    if client is None:
        return summary
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, issue_id, fingerprint, ref, attempts
            FROM issue_verifications
            WHERE status = 'pending' AND scheduled_at <= NOW()
            ORDER BY scheduled_at ASC
            LIMIT $1
            """,
            int(limit),
        )
    except Exception as exc:
        logger.debug("verify: due query failed: %s", exc)
        return summary

    max_attempts = _cfg("verify_max_attempts", 3)
    for row in rows or []:
        r = dict(row)
        summary["checked"] += 1
        org_id = r["org_id"]
        issue_id = str(r["issue_id"])
        fingerprint = r.get("fingerprint") or ""
        attempts = int(r.get("attempts") or 0) + 1

        passed, detail = await _verify_issue(org_id, issue_id, fingerprint)
        if passed:
            await _complete(client, r["id"], "passed", detail)
            summary["passed"] += 1
            await _emit(org_id, issue_id, r.get("ref") or fingerprint, True, detail)
        elif attempts >= max_attempts:
            await _complete(client, r["id"], "failed", detail)
            summary["failed"] += 1
            await _emit(org_id, issue_id, r.get("ref") or fingerprint, False, detail)
        else:
            # Not settled yet — bump attempts + push the next check out.
            await _reschedule(client, r["id"], attempts)
            summary["retried"] += 1
    return summary


async def _emit(
    org_id: str,
    issue_id: str,
    ref: str,
    passed: bool,
    detail: dict[str, Any],
) -> None:
    try:
        from eden.closed_loop.event_bus import publish

        await publish(
            LoopEvent(
                type=EventType.VERIFY_PASSED if passed else EventType.VERIFY_FAILED,
                org_id=org_id,
                issue_id=issue_id,
                ref=ref or "",
                payload={"verify": detail},
            )
        )
    except Exception as exc:
        logger.debug("verify: emit failed: %s", exc)


async def _complete(
    client: Any, row_id: Any, status: str, detail: dict[str, Any]
) -> None:
    with contextlib.suppress(Exception):
        await client.execute(
            "UPDATE issue_verifications "
            "SET status = $2, detail = $3::jsonb, attempts = attempts + 1, "
            "completed_at = NOW() WHERE id = $1",
            row_id,
            status,
            json.dumps(detail, default=str),
        )


async def _reschedule(client: Any, row_id: Any, attempts: int) -> None:
    poll = _cfg("verify_poll_interval_seconds", 60)
    with contextlib.suppress(Exception):
        await client.execute(
            "UPDATE issue_verifications "
            "SET attempts = $2, "
            "scheduled_at = NOW() + ($3 || ' seconds')::interval "
            "WHERE id = $1",
            row_id,
            attempts,
            str(int(poll) * 2),
        )


# ── Worker lifecycle ────────────────────────────────────────────────


async def _run(stop: asyncio.Event) -> None:
    poll = _cfg("verify_poll_interval_seconds", 60)
    logger.info("verify worker: started (poll=%ss)", poll)
    while not stop.is_set():
        try:
            await run_due_verifications()
        except Exception as exc:
            logger.debug("verify worker: pass failed: %s", exc)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=poll)
    logger.info("verify worker: stopped")


async def start_verify_worker() -> None:
    global _TASK, _STOP
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "closed_loop_orchestrator_v1", True):
            logger.info("verify worker: disabled by Settings")
            return
    except Exception:
        pass
    if _TASK is not None and not _TASK.done():
        return
    _STOP = asyncio.Event()
    _TASK = asyncio.create_task(_run(_STOP), name="closed_loop_verify")


async def stop_verify_worker() -> None:
    global _TASK, _STOP
    if _STOP is None:
        return
    _STOP.set()
    if _TASK is not None:
        try:
            await asyncio.wait_for(_TASK, timeout=10.0)
        except TimeoutError:
            _TASK.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await _TASK
    _TASK = None
    _STOP = None


def is_verify_worker_running() -> bool:
    return _TASK is not None and not _TASK.done()


# ── helpers ─────────────────────────────────────────────────────────


def _cfg(name: str, default: int) -> int:
    try:
        from eden.config import get_settings

        return int(getattr(get_settings(), name, default))
    except Exception:
        return default


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None
