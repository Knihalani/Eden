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
        leftover_snap = await self._pre_merge_leftover(org_id, agent_id)
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
                         opened_at, closes_at, pre_issue_rate, evidence)
                    VALUES ($1, $2, $3, $4, now(),
                            now() + make_interval(hours => $5), $6, $7::jsonb)
                    ON CONFLICT (org_id, plan_id, window_hours) DO NOTHING
                    RETURNING id
                    """,
                    org_id,
                    plan_id,
                    agent_id,
                    hours,
                    hours,
                    pre_rate,
                    leftover_snap,
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

    async def _pre_merge_leftover(self, org_id: str, agent_id: str) -> str:
        """Snapshot extra-work into evidence JSONB. No new column."""
        import json

        stats = await self._leftover_window_stats(
            None, org_id, agent_id, lookback_hours=_BASELINE_LOOKBACK_HOURS
        )
        return json.dumps({"leftover_pre": stats})

    async def _leftover_window_stats(
        self,
        client: Any | None,
        org_id: str,
        agent_id: str,
        *,
        opened_at: Any = None,
        closes_at: Any = None,
        lookback_hours: int | None = None,
    ) -> dict[str, Any]:
        """Extra-work counts on the mapped channel. fetchrow so existing
        issue-rate tests (fetchval) are unaffected when this returns None."""
        empty = {
            "extra_work_n": 0,
            "resolved_n": 0,
            "unknown_n": 0,
            "rate": 0.0,
            "mapped_channel": False,
            "listen_silent": True,
        }
        try:
            if client is None:
                from eden.storage.postgres import get_postgres_client

                client = await get_postgres_client()
            if client is None:
                return empty
            row = await client.fetchrow(
                """
                SELECT
                    count(*) FILTER (
                      WHERE polarity = 'extra_work'
                        AND confidence IN ('high', 'medium')
                    )::int AS extra_n,
                    count(*) FILTER (
                      WHERE polarity = 'extra_work'
                        AND confidence IN ('high', 'medium')
                        AND session_id IS NULL
                    )::int AS ambient_n
                FROM extra_work_events
                WHERE org_id = $1 AND agent_id = $2
                  AND (
                    ($3::timestamptz IS NOT NULL
                     AND observed_at >= $3 AND observed_at < $4)
                    OR ($3::timestamptz IS NULL
                        AND observed_at >= now()
                            - make_interval(hours => $5))
                  )
                """,
                org_id,
                agent_id,
                opened_at,
                closes_at,
                int(lookback_hours or _BASELINE_LOOKBACK_HOURS),
            )
            extra_n = int((row or {}).get("extra_n") or 0) if row else 0
            ambient_n = int((row or {}).get("ambient_n") or 0) if row else 0
            mapped = False
            listen_silent = False
            try:
                from eden.integrations.slack import store as slack_store

                install = await slack_store.get_install(org_id)
                if install is None or install.get("revoked_at"):
                    listen_silent = True
                elif slack_store.needs_reconsent(install):
                    listen_silent = True
                ch = await client.fetchrow(
                    """
                    SELECT channel_id FROM agent_slack_channels
                    WHERE org_id = $1 AND agent_id = $2
                      AND agent_id IS NOT NULL
                    LIMIT 1
                    """,
                    org_id,
                    agent_id,
                )
                mapped = bool(ch and ch.get("channel_id"))
            except Exception:
                listen_silent = True
            resolved_n = max(extra_n, ambient_n)
            return {
                "extra_work_n": extra_n,
                "resolved_n": resolved_n,
                "unknown_n": 0,
                "rate": extra_n / max(resolved_n, 1),
                "mapped_channel": mapped,
                "listen_silent": listen_silent or not mapped,
            }
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: leftover stats failed: %s", exc)
            return empty

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
            issue_degrading = (
                post_count >= _MIN_POST_ISSUES and delta_pct >= threshold
            )
        else:
            # No pre-merge baseline (agent was clean or too new): any
            # material post-merge issue count is a brand-new failure mode
            # — the most important regression to catch. Delta is undefined
            # without a baseline, so the verdict rides on the count floor
            # alone and the portal shows no misleading %.
            delta_pct = None
            issue_degrading = post_count >= _MIN_POST_ISSUES

        leftover_post = await self._leftover_window_stats(
            client,
            org_id,
            agent_id,
            opened_at=window.get("opened_at"),
            closes_at=window.get("closes_at"),
        )
        pre_ev = window.get("evidence") or {}
        if isinstance(pre_ev, str):
            import json as _json

            try:
                pre_ev = _json.loads(pre_ev)
            except Exception:
                pre_ev = {}
        pre_left = (pre_ev or {}).get("leftover_pre") or {}
        from eden.issues.statgate_p0_rail import leftover_work_verdict

        leftover_verdict, leftover_detail = leftover_work_verdict(
            n_control=int(pre_left.get("resolved_n") or 0),
            n_treatment=int(leftover_post.get("resolved_n") or 0),
            extra_work_rate_control=float(pre_left.get("rate") or 0.0),
            extra_work_rate_treatment=float(leftover_post.get("rate") or 0.0),
            unknown_share=float(leftover_post.get("unknown_n") or 0)
            / max(
                int(leftover_post.get("resolved_n") or 0)
                + int(leftover_post.get("unknown_n") or 0),
                1,
            ),
            listen_silent=bool(
                leftover_post.get("listen_silent")
                or pre_left.get("listen_silent")
            ),
            mapped_channel=bool(leftover_post.get("mapped_channel")),
        )
        # Leftover-work is the only SHIP/ok check. Issue-rate quiet
        # cannot mark ok. Issue-rate regression still degrades (hygiene).
        leftover_block = leftover_verdict == "BLOCK"
        leftover_ship = leftover_verdict == "SHIP"
        degrading = issue_degrading or leftover_block
        if leftover_ship and not issue_degrading:
            status = "ok"
        elif degrading:
            status = "degrading"
        else:
            # thin n / listen silent / extra-work unchanged: not a ship
            status = "pending"
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
                _json_evidence(
                    window,
                    post_count,
                    pre_rate,
                    post_rate,
                    delta_pct,
                    leftover=leftover_detail,
                    leftover_status=status,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_merge: window update failed: %s", exc)
            return status, follow_up_id

        # Append-only event trail (FEAT-30) + portal surfacing.
        # Pending/inconclusive leftover is not a clean ship — do not emit ok.
        if status == "pending":
            return status, follow_up_id
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
    leftover: dict[str, Any] | None = None,
    leftover_status: str | None = None,
) -> str:
    import json

    payload: dict[str, Any] = {
        "post_issue_count": post_count,
        "post_issue_rate": post_rate,
        "pre_issue_rate": pre_rate,
        "delta_pct": delta_pct if delta_pct is None else round(delta_pct, 2),
        "window_hours": window.get("window_hours"),
    }
    if leftover:
        payload["leftover"] = leftover
    if leftover_status == "pending":
        payload["reason"] = "inconclusive"
    return json.dumps(payload)


__all__ = ["PostMergeMonitor"]
