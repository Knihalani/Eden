"""Wave 6 — earned autonomy (the T4 dogfood program).

``auto_merge.py`` documents the acceptance criterion for widening the
customer offer: dogfood proves 5 consecutive clean auto-merges with zero
guardian regressions. This module turns that documented milestone into a
measured, published, and *grantable* state:

* :func:`clean_auto_merge_streak` — walks an org's auto-merged plans
  (manual merges of Eden PRs stamp ``evidence.auto_merge.merged=true``
  too, so a human-approved track record is what earns the ladder) and
  counts consecutive *proven* clean merges: every post-merge watch
  window (Wave 4) evaluated ``ok``. A plan still being watched is
  ``in_flight`` (provisional — not yet judged); a plan with no windows
  is ``unproven`` (pre-Wave-4 merge or the watch never opened) and stops
  the count conservatively; a ``degrading`` window breaks the streak.
* :func:`grant_if_earned` — when the proven streak clears the threshold
  (``earned_autonomy_min_streak``, default 5) and the org opted into the
  earned-autonomy program (``earned_autonomy_enabled`` on the N22
  policy), flip ``auto_code_patch_merge=True`` org-scoped and audit the
  grant. Idempotent; inert under observe mode and blocked for
  ``hipaa``/``soc2_strict`` by the policy engine anyway.

The natural trigger is the post-merge monitor: every time a watch window
closes the affected org is re-evaluated, so the grant lands the moment
the 7d window of the 5th clean merge closes. Everything is best-effort —
a grant failure must never break the monitor tick that feeds it.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Documented milestone — ``auto_merge.py`` + ``auto-merge-rollout.md``.
#: Overridable via ``Settings.earned_autonomy_min_streak``.
_DEFAULT_STREAK_THRESHOLD = 5

#: Cap on how many auto-merged plans the walk inspects (newest first).
_MAX_INSPECT = 50

#: Compliance profiles that never receive the auto-merge grant (mirrors
#: the N22 ``decide()`` hard overrides).
_BLOCKED_COMPLIANCE = frozenset({"hipaa", "soc2_strict"})


def _streak_threshold() -> int:
    try:
        from eden.config import get_settings

        value = getattr(get_settings(), "earned_autonomy_min_streak", None)
        return max(1, int(value or _DEFAULT_STREAK_THRESHOLD))
    except Exception:  # noqa: BLE001
        return _DEFAULT_STREAK_THRESHOLD


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:  # noqa: BLE001
        return None


def _error_status(reason: str) -> dict[str, Any]:
    """A full-shape failure status so callers/UI never see partial dicts."""
    return {
        "ok": False,
        "reason": reason,
        "streak": 0,
        "threshold": _streak_threshold(),
        "earned": False,
        "total_auto_merged": 0,
        "in_flight": 0,
        "unproven": 0,
        "breaking_plan_id": None,
        "recent": [],
    }


async def clean_auto_merge_streak(org_id: str) -> dict[str, Any]:
    """Count consecutive *proven* clean auto-merges for ``org_id``.

    One JOIN query pulls every auto-merged plan (``status='merged'`` AND
    ``evidence.auto_merge.merged=true`` — covering both the M15 canary
    ladder and manual merges of Eden PRs) with its post-merge watch
    windows; the walk happens in Python. Returns a status dict:

    * ``streak`` — consecutive proven-clean plans (newest first); a plan
      counts only when every watch window evaluated ``ok``. Stops early
      once the threshold is earned, so a long-earned org reports the
      threshold, never a huge number.
    * ``in_flight`` — head plans still being watched (provisional,
      uncounted; they join the proven streak once judged).
    * ``unproven`` — a plan with no windows (pre-Wave-4 / watch never
      opened) — stops the count conservatively.
    * ``breaking_plan_id`` — the plan whose ``degrading`` window broke
      the streak, if any.
    * ``recent`` — newest plans with their per-plan verdict for the
      portal trail (``clean`` / ``in_flight`` / ``breaking``).

    Best-effort: every failure path returns the full ``_error_status``
    shape (``ok: False``), never a partial dict.
    """
    client = await _pg()
    if client is None:
        return _error_status("postgres_unavailable")

    try:
        rows = await client.fetch(
            """
            SELECT p.id AS plan_id, p.title, p.agent_id,
                   p.updated_at AS merged_at, p.evidence,
                   w.status AS window_status, w.window_hours
            FROM improvement_plans p
            LEFT JOIN post_merge_windows w
              ON w.plan_id = p.id AND w.org_id = p.org_id
            WHERE p.org_id = $1
              AND p.status = 'merged'
              AND COALESCE(
                    (p.evidence->'auto_merge'->>'merged')::boolean, false
                  ) = true
            ORDER BY p.updated_at DESC, w.window_hours ASC
            LIMIT 600
            """,
            org_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("earned_autonomy: streak query failed: %s", exc)
        return _error_status(str(exc)[:160])

    try:
        # Group windows per plan, preserving newest-first order. The SQL
        # guarantees the columns; the defensive .get() keeps the walk
        # from raising on any malformed row a partial reader could inject.
        plans: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        for r in rows or []:
            pid_raw = r.get("plan_id")
            if pid_raw is None:
                continue
            pid = str(pid_raw)
            if pid not in plans:
                evidence = r.get("evidence")
                evidence = evidence if isinstance(evidence, dict) else {}
                am = evidence.get("auto_merge") if isinstance(evidence, dict) else {}
                am = am if isinstance(am, dict) else {}
                merged_at = r.get("merged_at")
                plans[pid] = {
                    "plan_id": pid,
                    "title": r.get("title"),
                    "agent_id": r.get("agent_id"),
                    "merged_at": (
                        merged_at.isoformat()
                        if hasattr(merged_at, "isoformat")
                        else merged_at
                    ),
                    "manual": bool(am.get("manual")),
                    "windows": [],
                }
                order.append(pid)
            if r.get("window_status"):
                plans[pid]["windows"].append(
                    {"status": r["window_status"], "hours": r["window_hours"]}
                )
    except Exception as exc:  # noqa: BLE001
        logger.debug("earned_autonomy: streak walk failed: %s", exc)
        return _error_status(str(exc)[:160])

    threshold = _streak_threshold()
    streak = 0
    in_flight = 0
    unproven = 0
    breaking_plan_id: str | None = None
    recent: list[dict[str, Any]] = []

    for pid in order[:_MAX_INSPECT]:
        plan = plans[pid]
        statuses = {w["status"] for w in plan["windows"]}
        verdict = "clean"
        if "degrading" in statuses:
            verdict = "breaking"
            breaking_plan_id = pid
            break
        if "pending" in statuses:
            verdict = "in_flight"
            in_flight += 1
            recent.append(_recent_plan(plan, verdict))
            continue
        if not statuses:
            # Merged but no watch windows — pre-Wave-4 or the watch never
            # opened. Cannot be proven clean: stop the count (conservative).
            unproven += 1
            verdict = "unproven"
            recent.append(_recent_plan(plan, verdict))
            break
        streak += 1
        recent.append(_recent_plan(plan, verdict))
        if streak >= threshold:
            # Earned — nothing beyond this point changes the verdict, and
            # the UI should never show "50 of 5" for a long-earned org.
            break

    return {
        "ok": True,
        "streak": streak,
        "threshold": threshold,
        "earned": streak >= threshold,
        "total_auto_merged": len(order),
        "in_flight": in_flight,
        "unproven": unproven,
        "breaking_plan_id": breaking_plan_id,
        "recent": recent[:_MAX_INSPECT],
    }


def _recent_plan(plan: dict[str, Any], verdict: str) -> dict[str, Any]:
    """Compact per-plan row for the portal trail."""
    summary = ", ".join(
        f"{w['hours']}h:{w['status']}" for w in plan["windows"]
    )
    return {
        "plan_id": plan["plan_id"],
        "title": plan.get("title"),
        "agent_id": plan.get("agent_id"),
        "merged_at": plan.get("merged_at"),
        "manual": plan.get("manual"),
        "status": verdict,
        "window_summary": summary,
    }


async def grant_if_earned(
    org_id: str, *, dry_run: bool = False
) -> dict[str, Any]:
    """Flip ``auto_code_patch_merge=True`` when the org earned it.

    Requires, in order: streak earned (``clean_auto_merge_streak``),
    org opted into the program (``earned_autonomy_enabled``), grant not
    already held, and compliance not in the blocked set. Writes the
    policy via the N22 upsert (which audits the change) plus an explicit
    ``earned_autonomy_grant`` audit row explaining *why*.

    Timing note (deliberate): the streak is *retrospective* — it is the
    org's proven track record, so a merge that happens *after* the fifth
    clean one (still being watched, ``in_flight``) does not delay or
    revoke the grant. A future regression in that merge is caught by its
    own post-merge watch and the guardian path, not by re-locking T4.
    """
    status = await clean_auto_merge_streak(org_id)
    base = {
        "streak": int(status.get("streak") or 0),
        "threshold": int(status.get("threshold") or _streak_threshold()),
        "earned": bool(status.get("earned")),
        "total_auto_merged": int(status.get("total_auto_merged") or 0),
    }
    if not status.get("ok"):
        return {
            **base,
            "granted": False,
            "reason": str(status.get("reason") or "streak_unavailable"),
        }
    if not base["earned"]:
        return {**base, "granted": False, "reason": "streak_not_earned"}

    try:
        from eden.closed_loop.autonomy_policy import (
            audit,
            resolve,
            upsert_policy,
        )

        policy = await resolve(org_id)
    except Exception as exc:  # noqa: BLE001
        return {**base, "granted": False, "reason": f"policy_resolve_failed:{str(exc)[:120]}"}

    if not bool(policy.earned_autonomy_enabled):
        return {**base, "granted": False, "reason": "not_opted_in"}
    if bool(policy.auto_code_patch_merge):
        return {**base, "granted": False, "reason": "already_granted"}
    if policy.compliance_profile in _BLOCKED_COMPLIANCE:
        return {
            **base,
            "granted": False,
            "reason": f"compliance:{policy.compliance_profile}",
        }

    if dry_run:
        return {**base, "granted": "would"}

    try:
        await upsert_policy(
            org_id,
            agent_id=None,
            patch={"auto_code_patch_merge": True},
            updated_by="eden:earned_autonomy",
        )
        # ``upsert_policy`` swallows DB errors, so verify the flip landed
        # on disk before claiming success — read the org-default row
        # directly (not ``resolve``: the Redis cache may lag 60s).
        persisted = await _grant_persisted(org_id)
        if not persisted:
            logger.warning(
                "earned_autonomy: grant not persisted org=%s", org_id
            )
            return {**base, "granted": False, "reason": "grant_persist_failed"}
        await audit(
            org_id,
            agent_id=None,
            action="earned_autonomy_grant",
            tier="auto_code_patch_merge",
            decision="allow",
            reason=(
                f"org earned T4: {base['streak']} consecutive clean "
                f"auto-merges (threshold {base['threshold']})"
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("earned_autonomy: grant failed org=%s: %s", org_id, exc)
        return {**base, "granted": False, "reason": f"grant_failed:{str(exc)[:120]}"}

    return {**base, "granted": True}


async def _grant_persisted(org_id: str) -> bool:
    """True when the org-default policy row actually holds T4 on disk."""
    client = await _pg()
    if client is None:
        return False
    try:
        row = await client.fetchrow(
            "SELECT policy FROM autonomy_policies "
            "WHERE org_id = $1 AND agent_id IS NULL",
            org_id,
        )
        if not row:
            return False
        raw = row.get("policy")
        policy = raw if isinstance(raw, dict) else {}
        if isinstance(raw, str):
            import json as _json

            try:
                policy = _json.loads(raw)
            except (TypeError, ValueError):
                policy = {}
        return bool(policy.get("auto_code_patch_merge"))
    except Exception as exc:  # noqa: BLE001
        logger.debug("earned_autonomy: grant verify failed: %s", exc)
        return False


__all__ = ["clean_auto_merge_streak", "grant_if_earned", "_streak_threshold"]
