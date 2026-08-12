"""Wave 4 — post-merge guard (the missing ship→verify node).

The approve flow schedules a one-shot N01 *replay* verify when a plan's
PR merges, but nothing watches the agent's **production** issue rate
after the merge. This module closes that gap:

* :func:`PostMergeMonitor.schedule_for_plan` — written from
  ``plans_repo.mark_merged`` (the single choke point every merge path
  funnels through: approve auto-merge, supervise, GitHub webhook). Opens
  a 1h/24h/7d ``post_merge_windows`` watch per merged plan, snapshotting
  the agent's pre-merge issue rate as the baseline.
* :func:`PostMergeMonitor.run_due` — cheap cron scan (every tick is
  fine: a ``closes_at <= now AND status='pending'`` indexed lookup).
  For each due window it compares the agent's post-merge issue rate to
  the snapshot baseline; a material regression (delta ≥ threshold with a
  minimum sample floor) marks ``degrading``, emits a plan event, and
  files an ``advisory`` follow-up plan linked via ``parent_plan_id`` so
  the portal renders the chain. Clean windows become ``ok``.

Everything is best-effort — a monitoring failure must never break the
merge/verify pipeline it hooks, so every public entry point swallows
transport errors after logging.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Watch windows in hours — matches the table CHECK + the plan's
#: ``min_post_merge_window_hours`` policy default (24h).
_WINDOWS_HOURS: tuple[int, int, int] = (1, 24, 168)

#: Minimum post-merge issues before a regression can be called — guards
#: against calling a regression on 1-2 issues of noise.
_MIN_POST_ISSUES = 3

#: Default regression threshold (delta %) when the org policy has no
#: ``revert_threshold_pct``.
_DEFAULT_THRESHOLD_PCT = 10.0

#: Baseline lookback in hours (pre-merge rate = issues / lookback).
_BASELINE_LOOKBACK_HOURS = 168


class PostMergeMonitor:
    """Open + close ``post_merge_windows`` watches for merged plans."""

    async def schedule_for_plan(
        self, org_id: str, plan: dict[str, Any]
    ) -> int:
        """Open a 1h/24h/7d watch for a freshly-merged plan.

        Returns the number of windows written. Idempotent via
        ``UNIQUE (org_id, plan_id, window_hours)`` — a re-delivered merge
        event re-opens nothing.
        """
        plan_id = str(plan.get("id") or "")
        agent_id = str(plan.get("agent_id") or "") or None
        if not plan_id or not agent_id:
            return 0

        pre_rate = await self._pre_merge_issue_rate(org_id, agent_id)
        opened = 0
        for hours in _WINDOWS_HOURS:
            try:
                from eden.storage.postgres import get_postgres_client

                client = await get_postgres_client()
                if client is None:
                    return opened
                rows = await client.fetch(
                    """
                    INSERT INTO post_merge_windows
                        (org_id, plan_id, agent_id, window_hours,
                         opened_at, closes_at, pre_issue_rate)
                    VALUES ($1, $2, $3, $4, now(),
                            now() + make_interval(hours => $5), $6)
                    ON CONFLICT (org_id, plan_id, window_hours) DO NOTHING
                    RETURNING id
                    """,
                    org_id,
                    plan_id,
                    agent_id,
                    hours,
                    hours,
                    pre_rate,
                )
                opened += len(rows or [])
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "post_merge: schedule window failed org=%s plan=%s "
                    "hours=%s: %s",
                    org_id,
                    plan_id,
                    hours,
                    exc,
                )
        return opened

    async def _pre_merge_issue_rate(self, org_id: str, agent_id: str) -> float:
        """Issues per hour for this agent over the 7d baseline lookback."""
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return 0.0
            count = await client.fetchval(
                """
                SELECT COUNT(*)::float
                FROM agent_issues
                WHERE org_id = $1 AND agent_id = $2
                  AND first_seen >= now() - make_interval(hours => $3)
                """,
                org_id,
                agent_id,
                _BASELINE_LOOKBACK_HOURS,
            )
            return float(count or 0.0) / _BASELINE_LOOKBACK_HOURS
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: baseline rate failed: %s", exc)
            return 0.0

    # ── comparator ──────────────────────────────────────────────────

    async def run_due(self, *, limit: int = 200) -> dict[str, Any]:
        """Close due watch windows: ok or degrading + follow-up.

        Cheap enough for every cron tick — the due-window lookup is
        indexed on ``(closes_at, status)``. Returns a summary dict.
        """
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"skipped": True, "reason": "postgres_unavailable"}
            rows = await client.fetch(
                """
                SELECT id, org_id, plan_id, agent_id, window_hours,
                       opened_at, closes_at, pre_issue_rate
                FROM post_merge_windows
                WHERE status = 'pending' AND closes_at <= now()
                ORDER BY closes_at ASC
                LIMIT $1
                """,
                limit,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: due scan failed: %s", exc)
            return {"skipped": True, "reason": str(exc)[:200]}

        out = {"inspected": 0, "ok": 0, "degrading": 0, "follow_ups": 0}
        affected_orgs: set[str] = set()
        for row in rows or []:
            out["inspected"] += 1
            org_id = str(row.get("org_id") or "")
            if org_id:
                affected_orgs.add(org_id)
            outcome, follow_up_id = await self._evaluate_window(
                client, dict(row)
            )
            if outcome == "degrading":
                out["degrading"] += 1
                if follow_up_id:
                    out["follow_ups"] += 1
            elif outcome == "ok":
                out["ok"] += 1

        # Wave 6 — earned autonomy: a closed window may have advanced an
        # org's clean-merge streak, so re-evaluate the affected orgs.
        # Best-effort — a grant failure must never break the tick.
        out["earned_grants"] = 0
        for org_id in affected_orgs:
            try:
                from eden.improvement.earned_autonomy import grant_if_earned

                result = await grant_if_earned(org_id)
                if result.get("granted") is True:
                    out["earned_grants"] += 1
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "post_merge: earned-autonomy grant failed org=%s: %s",
                    org_id,
                    exc,
                )
        return out

    async def _evaluate_window(
        self, client: Any, window: dict[str, Any]
    ) -> tuple[str, str | None]:
        """One due window: compute post rate, decide, persist.

        Returns ``(status, follow_up_plan_id)``.
        """
        window_id = str(window["id"])
        org_id = str(window["org_id"])
        plan_id = str(window["plan_id"])
        agent_id = str(window.get("agent_id") or "")
        hours = int(window["window_hours"])
        pre_rate = float(window.get("pre_issue_rate") or 0.0)

        try:
            post_count = int(
                await client.fetchval(
                    """
                    SELECT COUNT(*)::int
                    FROM agent_issues
                    WHERE org_id = $1 AND agent_id = $2
                      AND first_seen >= $3 AND first_seen < $4
                    """,
                    org_id,
                    agent_id,
                    window["opened_at"],
                    window["closes_at"],
                )
                or 0
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: post rate failed: %s", exc)
            return "pending", None

        post_rate = post_count / max(hours, 1)
        threshold = await self._threshold_pct(org_id)

        if pre_rate > 0:
            delta_pct = (post_rate - pre_rate) / pre_rate * 100.0
            degrading = (
                post_count >= _MIN_POST_ISSUES and delta_pct >= threshold
            )
        else:
            # No pre-merge baseline (agent was clean or too new): any
            # material post-merge issue count is a brand-new failure mode
            # — the most important regression to catch. Delta is undefined
            # without a baseline, so the verdict rides on the count floor
            # alone and the portal shows no misleading %.
            delta_pct = None
            degrading = post_count >= _MIN_POST_ISSUES
        status = "degrading" if degrading else "ok"
        # None-safe: no baseline means delta is undefined (not 0%).
        delta_out = delta_pct if delta_pct is None else round(delta_pct, 2)

        follow_up_id: str | None = None
        if degrading:
            follow_up_id = await self._file_follow_up(
                org_id, plan_id, agent_id, window
            )

        try:
            await client.execute(
                """
                UPDATE post_merge_windows
                SET status = $3, post_issue_rate = $4, delta_pct = $5,
                    evaluated_at = now(),
                    follow_up_plan_id = $6,
                    evidence = COALESCE(evidence, '{}'::jsonb) || $7::jsonb
                WHERE id = $1 AND org_id = $2
                """,
                window_id,
                org_id,
                status,
                post_rate,
                delta_out,
                follow_up_id,
                _json_evidence(window, post_count, pre_rate, post_rate, delta_pct),
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: window update failed: %s", exc)
            return status, follow_up_id

        # Append-only event trail (FEAT-30) + portal surfacing.
        try:
            from eden.improvement.plans_repo import emit_event

            await emit_event(
                org_id,
                plan_id,
                "post_merge_degrading" if degrading else "post_merge_ok",
                actor="eden:post_merge_monitor",
                detail=(
                    f"{hours}h window: post issue rate {post_rate:.4f}/h vs "
                    f"baseline {pre_rate:.4f}/h"
                    + (
                        f" ({delta_pct:+.1f}%)"
                        if delta_pct is not None
                        else " (no pre-merge baseline)"
                    )
                ),
                payload={
                    "window_hours": hours,
                    "post_issue_rate": post_rate,
                    "pre_issue_rate": pre_rate,
                    "delta_pct": delta_out,
                    "follow_up_plan_id": follow_up_id,
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: event emit failed: %s", exc)
        return status, follow_up_id

    async def _file_follow_up(
        self,
        org_id: str,
        plan_id: str,
        agent_id: str,
        window: dict[str, Any],
    ) -> str | None:
        """Advisory follow-up linked via parent_plan_id (D9-safe).

        The guardian path drafts revert/follow-up code patches for a
        *known regression issue*; a rate-based watch has no single issue,
        so we file an ``advisory`` plan (never an approvable empty
        code_patch) pointing at the parent plan for the portal chain.
        """
        try:
            from eden.improvement import plans_repo

            hours = int(window["window_hours"])
            pre = float(window.get("pre_issue_rate") or 0.0)
            # Idempotent follow-ups: an evaluation retry (e.g. the window
            # UPDATE failed after a first follow-up was filed) must not
            # create a second advisory plan for the same window.
            fingerprint = f"post_merge:{plan_id}:{hours}"
            existing = await plans_repo.find_open_by_fingerprint(
                org_id, fingerprint
            )
            if existing is not None:
                return str(existing["id"])
            plan = await plans_repo.create_plan(
                org_id,
                plan_kind="advisory",
                title=f"Post-merge watch: agent {agent_id} regressed ({hours}h)",
                agent_id=agent_id,
                summary=(
                    f"Post-merge {hours}h window detected a material issue-rate "
                    f"regression vs the pre-merge baseline ({pre:.4f}/h). "
                    "Investigate before further auto-fixes for this agent."
                ),
                source_ref=f"post_merge:{plan_id}",
                source_fingerprint=fingerprint,
                evidence={
                    "post_merge": {
                        "window_hours": hours,
                        "pre_issue_rate": pre,
                        "parent_plan_id": plan_id,
                        "watch_type": "rate_regression",
                    }
                },
                parent_plan_id=plan_id,
            )
            return str(plan["id"]) if plan else None
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: follow-up failed: %s", exc)
            return None

    async def _threshold_pct(self, org_id: str) -> float:
        """Code-change policy ``revert_threshold_pct`` (org-overridable).

        Reads the same per-org policy dict ``promotion_hooks`` uses for
        ``min_post_merge_window_hours`` (``CodeChangePolicyService``,
        defaults + stored overrides from ``patches/_common.py``); falls
        back to ``_DEFAULT_THRESHOLD_PCT`` on any failure.
        """
        try:
            from eden.patches.policy import CodeChangePolicyService

            resp = await CodeChangePolicyService().get(org_id)
            policy = ((resp or {}).get("data") or {}).get("policy") or {}
            return float(
                policy.get("revert_threshold_pct", _DEFAULT_THRESHOLD_PCT)
                or _DEFAULT_THRESHOLD_PCT
            )
        except Exception:  # noqa: BLE001
            return _DEFAULT_THRESHOLD_PCT


def _json_evidence(
    window: dict[str, Any],
    post_count: int,
    pre_rate: float,
    post_rate: float,
    delta_pct: float | None,
) -> str:
    import json

    return json.dumps(
        {
            "post_issue_count": post_count,
            "post_issue_rate": post_rate,
            "pre_issue_rate": pre_rate,
            "delta_pct": delta_pct if delta_pct is None else round(delta_pct, 2),
            "window_hours": window.get("window_hours"),
        }
    )


__all__ = ["PostMergeMonitor"]
