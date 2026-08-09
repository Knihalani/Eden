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
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.closed_loop.events import EventType, LoopEvent
from eden.storage.empty_cooldown import make_empty_cooldown, next_grid_delay

logger = logging.getLogger(__name__)

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None

_verify_in_cooldown, _verify_mark_empty, _verify_clear_cooldown = make_empty_cooldown(
    default_seconds=300.0,
    settings_attr="verify_empty_cooldown_seconds",
)

#: Fallback poll cadence. This used to be spelled three different ways in
#: this one file — ``_cfg("verify_poll_interval_seconds", 180)`` in the
#: claim path, ``60`` in the reschedule path, and ``180`` again in the
#: worker loop — so the lease length, the retry backoff and the actual
#: tick disagreed with each other whenever the setting was unset. One
#: value, read through :func:`_poll_interval`, and it is a multiple of the
#: shared idle grid so the loop lands on the same boundaries as the rest
#: of the fleet.
_DEFAULT_POLL_INTERVAL_SECONDS = 600.0


def _poll_interval() -> float:
    """The single verify poll cadence, in seconds."""
    return float(
        _cfg("verify_loop_interval_seconds", _DEFAULT_POLL_INTERVAL_SECONDS)
    )


def _reset_state_for_tests() -> None:
    """Test-only: clear the module-level empty-poll cooldown.

    The cooldown is process-global by design (it is what keeps the fleet's
    pollers on one grid). That makes it leak across tests: anything that
    starts the real verify worker runs one pass, finds an empty queue, and
    backs off for up to two grid periods — after which every later test
    calling :func:`run_due_verifications` gets the early cooldown return
    and sees ``checked == 0``. Mirrors
    ``eden.workers.sidecars._reset_state_for_tests``.

    Also clears the idle-chore registry + last-run clocks (the defaults
    re-register on the next :func:`start_verify_worker`).
    """
    _verify_clear_cooldown()
    _IDLE_CHORES.clear()
    _CHORE_LAST_RUN.clear()
    global _LOOP_DEAD_LAST_ALERT_MONO
    _LOOP_DEAD_LAST_ALERT_MONO = None


# ── Idle chores ─────────────────────────────────────────────────────
#
# The verify worker is the loop's one always-on poller; rather than add
# new pollers per maintenance task (spec §11: no new pollers), small
# best-effort chores piggyback on its tick. Each chore has its own
# interval cooldown and is exception-isolated — one failing chore never
# kills the worker or the other chores.


@dataclass
class IdleChore:
    name: str
    interval_s: float
    fn: Callable[[], Awaitable[Any]]


_IDLE_CHORES: list[IdleChore] = []
_CHORE_LAST_RUN: dict[str, float] = {}


def register_idle_chore(
    name: str, interval_s: float, fn: Callable[[], Awaitable[Any]]
) -> None:
    """Register (or replace, by name) a chore run on the worker tick."""
    global _IDLE_CHORES
    _IDLE_CHORES = [c for c in _IDLE_CHORES if c.name != name]
    _IDLE_CHORES.append(IdleChore(name=name, interval_s=float(interval_s), fn=fn))


async def _run_idle_chores() -> None:
    """Run every due chore once; failures are logged and isolated."""
    now = time.monotonic()
    for chore in list(_IDLE_CHORES):
        last = _CHORE_LAST_RUN.get(chore.name)
        if last is not None and now - last < chore.interval_s:
            continue
        _CHORE_LAST_RUN[chore.name] = now
        try:
            await chore.fn()
        except Exception as exc:
            logger.warning("idle chore %s failed: %s", chore.name, exc)


def _register_default_chores() -> None:
    """Chores every deployment wants: outbox drain + TTL cleanup (M2),
    fix_pending janitor (M3, D3), stale draft plans (M13 §6.6)."""
    from eden.closed_loop import event_bus

    register_idle_chore("outbox_drain", 60.0, event_bus.drain_outbox)
    register_idle_chore(
        "outbox_ttl_cleanup", 6 * 3600.0, event_bus.cleanup_drained
    )
    register_idle_chore("fix_pending_janitor", 300.0, fix_pending_janitor)
    register_idle_chore("stale_plans_janitor", 3600.0, stale_plans_janitor)
    register_idle_chore("loop_dead_alert", 60.0, loop_dead_alert_check)


# ── M2 loop-dead alerting ───────────────────────────────────────────
#
# ``/internal/loop-health`` is passive — someone has to look at it. This
# chore actively pages when the loop stops moving: event publishing has
# been failing for longer than the threshold, or the durable outbox
# (migration 135) is backing up. Debounced module-globally so a dead
# loop pages once per cooldown window, not once per tick.

_LOOP_DEAD_LAST_ALERT_MONO: float | None = None


async def loop_dead_alert_check() -> bool:
    """Alert (alerts pipeline + Slack) when the closed loop looks dead.

    Returns True when an alert was emitted this pass.
    """
    global _LOOP_DEAD_LAST_ALERT_MONO
    from eden.closed_loop import event_bus

    max_age_s = _cfg("loop_dead_publish_failure_max_age_seconds", 120)
    max_depth = _cfg("loop_dead_outbox_depth_threshold", 10_000)
    cooldown_min = _cfg("loop_dead_alert_cooldown_minutes", 30)

    reasons: list[str] = []
    failure_age_s: float | None = None
    failure_ts = event_bus.last_publish_failure_ts
    if failure_ts is not None:
        failure_age_s = time.time() - failure_ts
        if failure_age_s >= max_age_s:
            reasons.append(
                f"event publish failing for {int(failure_age_s)}s "
                f"(threshold {max_age_s}s)"
            )
    depth = await event_bus.outbox_depth()
    if depth > max_depth:
        reasons.append(f"outbox depth {depth} > {max_depth}")
    if not reasons:
        return False

    now_mono = time.monotonic()
    if (
        _LOOP_DEAD_LAST_ALERT_MONO is not None
        and now_mono - _LOOP_DEAD_LAST_ALERT_MONO < cooldown_min * 60
    ):
        return False
    _LOOP_DEAD_LAST_ALERT_MONO = now_mono

    logger.error("loop-dead watchdog: %s", "; ".join(reasons))
    org_id = ""
    try:
        from eden.config import get_settings

        org_id = str(get_settings().loop_dead_alert_org_id or "")
    except Exception:
        org_id = ""
    if not org_id:
        # Alerts pipeline + Slack are org-scoped; without a configured
        # ops org the error log above is the whole alert.
        return True
    try:
        from eden.alerts import repo as alerts_repo

        await alerts_repo.create_alert_event(
            org_id=org_id,
            rule_id=None,
            title="Closed loop dead: " + "; ".join(reasons),
            severity="critical",
            payload={
                "source": "loop_dead_watchdog",
                "reasons": reasons,
                "outbox_depth": depth,
                "publish_failure_age_s": failure_age_s,
            },
        )
    except Exception as exc:
        logger.warning("loop-dead watchdog: alert event failed: %s", exc)
    try:
        from eden.services import slack_notify

        await slack_notify.notify_loop_dead(
            org_id,
            reasons=reasons,
            outbox_depth=depth,
            publish_failure_age_s=failure_age_s,
        )
    except Exception as exc:
        logger.warning("loop-dead watchdog: slack notify failed: %s", exc)
    return True


async def fix_pending_janitor(limit: int = 50) -> int:
    """M3 (D3): unstick issues stranded in ``fix_pending``.

    Issues sitting in ``fix_pending`` longer than
    ``fix_pending_max_age_minutes`` (a crash between transitions, a heal
    or patch that never reported back) are returned to ``triaged``, an
    ``autonomy_audit_log`` row records the sweep, and the issue's
    ``triage_result`` gains a ``stuck`` badge for the cockpit. Returns
    the number of issues swept.
    """
    client = await _pg()
    if client is None:
        return 0
    max_age_min = _cfg("fix_pending_max_age_minutes", 120)
    try:
        rows = await client.fetch(
            "SELECT id, org_id, "
            "EXTRACT(EPOCH FROM (NOW() - updated_at)) AS age_seconds "
            "FROM agent_issues WHERE status = 'fix_pending' "
            "AND updated_at < NOW() - ($1 || ' minutes')::interval "
            "ORDER BY updated_at ASC LIMIT $2",
            str(int(max_age_min)),
            int(limit),
        )
    except Exception as exc:
        logger.debug("fix_pending_janitor: scan failed: %s", exc)
        return 0
    swept = 0
    for row in rows or []:
        r = dict(row)
        org_id = r["org_id"]
        issue_id = str(r["id"])
        age_min = int(float(r.get("age_seconds") or 0) / 60)
        try:
            from eden.issues.repo import IssuesRepo

            repo = IssuesRepo()
            ok = await repo.set_status(org_id, issue_id, "triaged")
            if not ok:
                continue
            # Cockpit "stuck" badge — merged into triage_result like the
            # patch_blocked stamp.
            issue = await repo.get_issue(org_id, issue_id)
            if issue is not None:
                triage = dict(issue.triage_result or {})
                triage["stuck"] = {
                    "by": "fix_pending_janitor",
                    "age_minutes": age_min,
                    "returned_to": "triaged",
                }
                await repo.set_triage_result(org_id, issue_id, triage)
            from eden.closed_loop.autonomy_policy import audit

            await audit(
                org_id,
                agent_id=None,
                action="fix_pending_janitor",
                tier="janitor",
                decision="allow",
                reason=(
                    f"issue {issue_id} stuck in fix_pending for "
                    f"{age_min}m (max {max_age_min}m); returned to triaged"
                ),
            )
            swept += 1
        except Exception as exc:
            logger.warning(
                "fix_pending_janitor: sweep failed for %s: %s", issue_id, exc
            )
    if swept:
        logger.info("fix_pending_janitor: swept %s stuck issue(s)", swept)
    return swept


async def stale_plans_janitor(limit: int = 50) -> int:
    """M13 (§6.6): auto-close draft plans older than 2× plan_stale_after_days.

    Default: plan_stale_after_days=14 → close at 30d with
    ``closed_reason=\"stale\"`` (stored as rejection_reason + evidence patch).
    """
    client = await _pg()
    if client is None:
        return 0
    stale_after = int(_cfg("plan_stale_after_days", 14) or 14)
    close_after = max(stale_after * 2, stale_after + 1)  # 30d when default 14
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id
            FROM improvement_plans
            WHERE status = 'draft'
              AND created_at < NOW() - ($1 || ' days')::interval
            ORDER BY created_at ASC
            LIMIT $2
            """,
            str(int(close_after)),
            int(limit),
        )
    except Exception as exc:
        logger.debug("stale_plans_janitor: scan failed: %s", exc)
        return 0
    closed = 0
    for row in rows or []:
        r = dict(row)
        org_id = str(r["org_id"])
        plan_id = str(r["id"])
        try:
            # Stamp closed_reason into evidence jsonb (best-effort).
            with contextlib.suppress(Exception):
                await client.execute(
                    """
                    UPDATE improvement_plans SET
                        evidence = COALESCE(evidence, '{}'::jsonb)
                                   || '{"closed_reason":"stale"}'::jsonb,
                        updated_at = NOW()
                    WHERE org_id = $1 AND id = $2::uuid AND status = 'draft'
                    """,
                    org_id,
                    plan_id,
                )
            from eden.improvement import plans_repo

            updated = await plans_repo.mark_closed(
                org_id,
                plan_id,
                reason="stale",
                write_rejection=False,  # don't poison rejection memory for age
            )
            if updated and updated.get("status") == "closed":
                closed += 1
        except Exception as exc:
            logger.debug(
                "stale_plans_janitor: close failed plan=%s: %s", plan_id, exc
            )
    if closed:
        logger.info("stale_plans_janitor: closed %s stale draft(s)", closed)
    return closed


# ── Scheduling ──────────────────────────────────────────────────────

#: M10 (§5.3): ``ref`` prefixes distinguish the verify source. Heal
#: verifies run on a fast path (a runtime rollback settles in minutes);
#: merge verifies keep the code-propagation defaults. Legacy rows whose
#: ``ref`` is a raw fingerprint/branch keep the default behaviour.
HEAL_REF_PREFIX = "heal:"
MERGE_REF_PREFIX = "merge:"
# M15 (§9): canary auto-merge uses a 10-min fast verify window.
AUTO_MERGE_REF_PREFIX = "auto_merge:"


def _is_heal_ref(ref: str | None) -> bool:
    return bool(ref) and str(ref).startswith(HEAL_REF_PREFIX)


def _is_auto_merge_ref(ref: str | None) -> bool:
    return bool(ref) and str(ref).startswith(AUTO_MERGE_REF_PREFIX)


def _quiet_window_minutes(ref: str | None) -> int:
    """Quiet window for one verification, derived from its ref prefix.

    Derived at check time (not stored per-row) — the row's ``ref`` is
    already persisted verbatim, so the prefix is the honest single
    source of which path scheduled the verify.
    """
    if _is_heal_ref(ref):
        return _cfg("verify_quiet_window_minutes_heal", 10)
    if _is_auto_merge_ref(ref):
        # M15 (§9): canary auto-merge fast window.
        return _cfg("verify_quiet_window_minutes_auto_merge", 10)
    return _cfg("verify_quiet_window_minutes", 30)


async def schedule_verify(
    org_id: str,
    issue_id: str,
    *,
    ref: str = "",
    delay_seconds: int | None = None,
) -> str | None:
    """Insert (or replace) a pending verify row for an issue.

    Returns the verification row id on success, or ``None`` on failure.
    """
    client = await _pg()
    if client is None:
        return None
    if delay_seconds is not None:
        delay = delay_seconds
    elif _is_heal_ref(ref):
        # M10 (§5.3): heal fast-path — verify a rollback in minutes.
        delay = _cfg("verify_delay_seconds_heal", 300)
    elif _is_auto_merge_ref(ref):
        # M15 (§9): canary auto-merge — 10-min fast verify window.
        delay = _cfg("verify_delay_seconds_auto_merge", 600)
    else:
        delay = _cfg("verify_delay_seconds", 1800)
    # A prefixed ref (``heal:``/``merge:``/``auto_merge:``) is a source
    # tag, not a fingerprint — derive the fingerprint from the issue
    # row instead. Legacy callers passing a raw fingerprint keep the
    # old behaviour.
    prefixed = str(ref or "").startswith(
        (HEAL_REF_PREFIX, MERGE_REF_PREFIX, AUTO_MERGE_REF_PREFIX)
    )
    fingerprint = "" if prefixed else ref
    if not fingerprint:
        try:
            from eden.issues.repo import IssuesRepo

            issue = await IssuesRepo().get_issue(org_id, issue_id)
            fingerprint = issue.fingerprint if issue else ""
        except Exception:
            fingerprint = ""
        if not fingerprint and _is_heal_ref(ref):
            # ``heal:<fingerprint_or_issue_id>`` — the suffix is the best
            # remaining fingerprint candidate when the issue lookup fails
            # (unless it is just the issue id, which is not a fingerprint;
            # _verify_issue re-derives / fails honestly in that case).
            suffix = str(ref).split(":", 1)[1]
            if suffix != issue_id:
                fingerprint = suffix
    verify_id = str(uuid.uuid4())
    try:
        _verify_clear_cooldown()
        row = await client.fetchrow(
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
            RETURNING id
            """,
            verify_id,
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
        if row and row.get("id") is not None:
            return str(row["id"])
        return verify_id
    except Exception as exc:
        logger.debug("verify: schedule failed: %s", exc)
        return None


# ── Checks ──────────────────────────────────────────────────────────


def _recent_only(
    stumbles: list[dict[str, Any]], since: datetime
) -> list[dict[str, Any]]:
    """Keep only stumbles detected at/after ``since`` (belt-and-braces
    client-side filter on top of the SQL ``since`` clause)."""
    out: list[dict[str, Any]] = []
    for s in stumbles:
        ts = s.get("detected_at")
        if isinstance(ts, str):
            try:
                ts = datetime.fromisoformat(ts)
            except ValueError:
                ts = None
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=UTC)
            if ts < since:
                continue
        out.append(s)
    return out


async def _verify_issue(
    org_id: str, issue_id: str, fingerprint: str, ref: str = ""
) -> tuple[bool | None, dict[str, Any]]:
    """Return ``(passed, detail)`` — did the fix hold?

    ``passed`` is ``True`` (fix held), ``False`` (failed) or ``None``
    (**inconclusive** — the StatGate re-score errored; the caller
    consumes an attempt and retries, failing with
    ``reason="statgate_error"`` once attempts run out) (M3, D6).

    M10 (§5.3): the quiet window depends on the verify source — ``ref``
    prefixed ``heal:`` gets the fast-path window; everything else (merge
    refs, legacy raw fingerprints) keeps the default.
    """
    from eden.issues.repo import IssuesRepo

    repo = IssuesRepo()
    window = _quiet_window_minutes(ref)
    issue = None
    # M3 (D6): an empty fingerprint must never auto-pass — re-derive it
    # from the issue row, and fail the verification when still empty.
    if not fingerprint:
        try:
            issue = await repo.get_issue(org_id, issue_id)
            fingerprint = (issue.fingerprint if issue else "") or ""
        except Exception:
            fingerprint = ""
        if not fingerprint:
            return False, {
                "recent_stumbles": None,
                "quiet_window_minutes": window,
                "reason": "no_fingerprint",
            }
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

    # StatGate P0 must be clear — judged on RECENT evidence only (M3,
    # D29): the issue's stored severity/stumble_count date from detection
    # time; re-scoring them verbatim meant a healed P0 could never pass.
    # With a clean quiet window the recent-stumble list is what decides.
    try:
        if issue is None:
            issue = await repo.get_issue(org_id, issue_id)
        if issue is not None:
            from eden.issues.statgate_scorer import StatGateIncidentScorer

            since = datetime.now(UTC) - timedelta(minutes=window)
            stumbles = await repo.list_stumbles(
                org_id, fingerprint=fingerprint, since=since, limit=20
            )
            recent_stumbles = _recent_only(stumbles, since)
            score = StatGateIncidentScorer().score(
                {
                    "id": issue.id,
                    "kind": issue.kind,
                    # Stored severity is only as fresh as the stumbles
                    # backing it — with zero recent stumbles it must not
                    # re-flag P0 on its own.
                    "severity": issue.severity if recent_stumbles else "",
                    "stumble_count": len(recent_stumbles),
                },
                recent_stumbles,
            )
            detail["statgate_p0"] = score.p0
            if score.p0:
                detail["reason"] = "StatGate still flags P0"
                return False, detail
    except Exception as exc:
        # M3 (D6): a broken scorer is not a pass — report inconclusive.
        logger.warning("verify: statgate re-score failed (inconclusive): %s", exc)
        detail["reason"] = "statgate_error"
        detail["error"] = str(exc)[:300]
        return None, detail

    detail["reason"] = "quiet window clean + no P0"
    return True, detail


async def run_due_verifications(limit: int = 50) -> dict[str, int]:
    """Process all due verify rows once. Returns a summary counter.

    Public + side-effect-contained so tests can drive a single pass.
    """
    if _verify_in_cooldown():
        return {"checked": 0, "passed": 0, "failed": 0, "retried": 0}
    client = await _pg()
    summary = {"checked": 0, "passed": 0, "failed": 0, "retried": 0}
    if client is None:
        return summary

    # Claim due rows atomically so concurrent workers cannot double-process.
    # Lease via scheduled_at bump (status CHECK has no 'running' value).
    poll = _poll_interval()
    lease_secs = max(int(poll) * 3, 180)
    try:
        rows = await client.fetch(
            """
            WITH due AS (
                SELECT id
                FROM issue_verifications
                WHERE status = 'pending' AND scheduled_at <= NOW()
                ORDER BY scheduled_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT $1
            )
            UPDATE issue_verifications iv
            SET scheduled_at = NOW() + ($2 || ' seconds')::interval
            FROM due
            WHERE iv.id = due.id
            RETURNING iv.id, iv.org_id, iv.issue_id, iv.fingerprint, iv.ref, iv.attempts
            """,
            int(limit),
            str(lease_secs),
        )
    except Exception as exc:
        logger.debug("verify: due claim failed: %s", exc)
        return summary

    if not rows:
        _verify_mark_empty()
        return summary
    _verify_clear_cooldown()

    max_attempts = _cfg("verify_max_attempts", 3)

    async def _handle(row: Any) -> str:
        r = dict(row)
        org_id = r["org_id"]
        issue_id = str(r["issue_id"])
        fingerprint = r.get("fingerprint") or ""
        attempts = int(r.get("attempts") or 0) + 1

        passed, detail = await _verify_issue(
            org_id, issue_id, fingerprint, str(r.get("ref") or "")
        )
        if passed:
            await _complete(client, r["id"], "passed", detail, attempts)
            await _emit(org_id, issue_id, r.get("ref") or fingerprint, True, detail)
            return "passed"
        if passed is None:
            # Inconclusive (M3, D6): consume the attempt + retry; once
            # attempts run out the row fails with reason=statgate_error.
            if attempts >= max_attempts:
                detail = {**detail, "reason": "statgate_error"}
                await _complete(client, r["id"], "failed", detail, attempts)
                await _emit(
                    org_id, issue_id, r.get("ref") or fingerprint, False, detail
                )
                return "failed"
            await _reschedule(client, r["id"], attempts)
            return "retried"
        if attempts >= max_attempts:
            await _complete(client, r["id"], "failed", detail, attempts)
            await _emit(org_id, issue_id, r.get("ref") or fingerprint, False, detail)
            return "failed"
        await _reschedule(client, r["id"], attempts)
        return "retried"

    if rows:
        sem = asyncio.Semaphore(8)

        async def _bounded(row: Any) -> str:
            async with sem:
                return await _handle(row)

        outcomes = await asyncio.gather(*(_bounded(row) for row in rows))
        for outcome in outcomes:
            summary["checked"] += 1
            summary[outcome] += 1
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
    client: Any, row_id: Any, status: str, detail: dict[str, Any], attempts: int
) -> None:
    with contextlib.suppress(Exception):
        await client.execute(
            "UPDATE issue_verifications "
            "SET status = $2, detail = $3::jsonb, attempts = $4, "
            "completed_at = NOW() WHERE id = $1",
            row_id,
            status,
            json.dumps(detail, default=str),
            int(attempts),
        )


async def _reschedule(client: Any, row_id: Any, attempts: int) -> None:
    poll = _poll_interval()
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
    poll = _poll_interval()
    logger.info("verify worker: started (poll=%ss)", poll)
    while not stop.is_set():
        try:
            await run_due_verifications()
        except Exception as exc:
            logger.debug("verify worker: pass failed: %s", exc)
        try:
            await _run_idle_chores()
        except Exception as exc:
            logger.debug("verify worker: idle chores failed: %s", exc)
        # Wait for the next shared grid boundary rather than a fixed
        # offset from wherever this pass finished. The PG hit is already
        # cooldown-gated in run_due_verifications, but an unaligned *phase*
        # still lets this worker wake in the gaps between the other
        # pollers, which is what fragments the DB-quiet window.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=next_grid_delay(poll))
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
    _register_default_chores()
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
