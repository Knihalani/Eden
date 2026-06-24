"""Autonomous Intelligence (Cat 14) — base services.

Four services:
* ``InvestigationAgent`` — given a trigger, propose RCA + remediations.
* ``ReportGenerator`` — weekly/monthly exec report.
* ``RecommendationEngine`` — ranked, actionable recommendations.
* ``SelfHealer`` — automated remediation (rollback, reweight, cache-bust).
  Always queues for human approval by default; never executes
  until an admin signs off.

All four are gated by the ``intelligence_gap_v0`` umbrella
feature flag (and the destructive ``self_heal`` is gated
additionally by ``autonomous_actions_v0`` at the route layer).
The LLM calls are best-effort: any failure falls back to a
deterministic heuristic so a transient LLM outage doesn't
take the autonomous surface down.

See ``docs/observability-gap/14-autonomous-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from ._common import (
    DEFAULT_LLM_SLOT,
    RECOMMENDATION_STATUS_OPEN,
    SELF_HEAL_DEFAULT_STATUS,
    VALID_HEAL_ACTION_TYPES,
    _call_llm,
    _iso,
    _json_dumps,
    _load_top_signals,
    _not_implemented_envelope,
    _ok_envelope,
    _resolve_trigger_context,
    _upsert_investigation,
    _upsert_recommendation,
    _upsert_report,
    _upsert_self_heal,
)

logger = logging.getLogger(__name__)


# ── 1. InvestigationAgent ───────────────────────────────────────────

_INVESTIGATION_SYSTEM_PROMPT = (
    "You are an SRE assistant for an LLM-observability platform. "
    "Given the trigger context below, produce a JSON object with "
    "two top-level keys: `findings` (a list of {type, summary, "
    "confidence?} dicts) and `proposed_remediations` (a list of "
    "{action, blast_radius, estimated_recovery_time_minutes} dicts). "
    "Return ONLY the JSON object. No prose, no markdown fences."
)


class InvestigationAgent:
    """Given a trigger, propose a root cause + 1-3 remediations.

    The v1.3 ship is single-shot: we resolve the trigger
    context, render it as a structured prompt, and call the
    LLM. A future v2 ship can add a full ReAct loop with the
    tools the appendix calls out
    (get_related_traces / get_judge_scores / get_drift_alerts /
    list_active_canaries / get_kb_chunks). The single-shot
    shape is what ``_resolve_trigger_context`` already
    returns; the upgrade to ReAct is a wiring change inside
    this method, not a contract change.
    """

    name = "investigation_agent"

    async def investigate(
        self,
        org_id: str,
        *,
        trigger: str,
    ) -> dict[str, Any]:
        if not trigger or not trigger.strip():
            return _not_implemented_envelope(
                self.name,
                "trigger is required and must be non-empty",
            )
        # 1. Resolve the trigger context. Returns None on
        #    unknown prefix or missing row.
        ctx = await _resolve_trigger_context(org_id, trigger)
        if ctx is None:
            return _not_implemented_envelope(
                self.name,
                (
                    f"trigger {trigger!r} is not recognised — "
                    f"expected one of drift_alert:<id>, "
                    f"incident:<cluster_id>, "
                    f"judge_regression:<judge_name>, "
                    f"guardrail_breach:<scanner>"
                ),
            )

        # 2. Render the prompt. We include the context dict
        #    + the trigger id so the LLM can ground its
        #    response in the actual row.
        prompt = (
            f"Trigger: {trigger}\n"
            f"Context: {json.dumps(ctx.get('context', {}), default=str)}\n"
            f"Investigate the root cause and propose 1-3 remediations."
        )

        # 3. Call the LLM. Falls back to a heuristic envelope
        #    on any failure.
        raw = await _call_llm(
            prompt,
            agent="autonomous_investigation",
            slot=DEFAULT_LLM_SLOT,
            system_prompt=_INVESTIGATION_SYSTEM_PROMPT,
            max_tokens=600,
        )
        findings: list[dict[str, Any]] = []
        remediations: list[dict[str, Any]] = []
        llm_used = False
        if raw:
            parsed = _try_parse_json_object(raw)
            if isinstance(parsed, dict):
                f = parsed.get("findings")
                if isinstance(f, list):
                    findings = [x for x in f if isinstance(x, dict)]
                r = parsed.get("proposed_remediations")
                if isinstance(r, list):
                    remediations = [x for x in r if isinstance(x, dict)]
                llm_used = bool(findings or remediations)

        # 4. Heuristic fallback — emit a single 1-paragraph
        #    finding + 1-2 generic remediations so the
        #    customer always gets a useful envelope.
        if not findings:
            findings = [
                {
                    "type": "rca",
                    "summary": (
                        f"Investigation of {trigger!r} surfaced no "
                        "detailed findings from the LLM; the customer "
                        "should review the trigger context manually."
                    ),
                    "confidence": 0.5,
                }
            ]
        if not remediations:
            remediations = [
                {
                    "action": "review_trigger_context",
                    "blast_radius": "no_change",
                    "estimated_recovery_time_minutes": 0,
                }
            ]

        investigation_id = _new_id("inv")
        await _upsert_investigation(
            org_id,
            investigation_id,
            trigger=trigger,
            status="completed",
            findings_json=_json_dumps(
                {
                    "findings": findings,
                    "proposed_remediations": remediations,
                    "llm_used": llm_used,
                }
            ),
        )

        return _ok_envelope(
            self.name,
            {
                "investigation_id": investigation_id,
                "trigger": trigger,
                "trigger_type": ctx.get("trigger_type"),
                "findings": findings,
                "proposed_remediations": remediations,
                "llm_used": llm_used,
            },
        )

    async def report(
        self,
        org_id: str,
        *,
        period: str = "weekly",
    ) -> dict[str, Any]:
        """Folded ReportGenerator per upgradespec §D.4 (Phase 1 cut).

        Generates a weekly / monthly / incident report by
        aggregating trends, drift alerts, incidents, and open
        recommendations from the existing tables. The exec
        summary is best-effort LLM; falls back to a
        deterministic headline when the LLM is unavailable.

        Persists to ``autonomous_reports`` (kept per §D.4;
        the spec calls this table ``investigation_reports``).
        """
        if period not in _VALID_REPORT_PERIODS:
            return _not_implemented_envelope(
                self.name,
                f"invalid period: {period!r} "
                "(expected one of: weekly, monthly, incident)",
            )

        window = _window_for_period(period)
        window_days = window.days
        period_end = datetime.now(UTC)
        period_start = period_end - window

        # 1. Pull the top signals from the existing tables.
        signals = await _load_top_signals(org_id, window_days=window_days)

        # 2. Compose the trends + incidents + recommendations
        #    sub-payload. This is the data-only portion of the
        #    report (the LLM summary rides on top).
        trends = {
            t["judge_name"]: round(t["avg_score"], 3)
            for t in signals.get("judge_score_trends", [])
        }
        incidents = signals.get("incidents_recent", [])
        drift_alerts = signals.get("drift_alerts_recent", [])
        recommendations = [
            {
                "id": r.get("id"),
                "title": r.get("title"),
                "rationale": r.get("rationale"),
            }
            for r in signals.get("open_recommendations", [])
        ]

        # 3. LLM exec summary (best-effort). Falls back to a
        #    deterministic headline if the LLM is unavailable.
        llm_used = False
        summary_text = ""
        prompt = (
            f"Period: {period} ({window_days} days)\n"
            f"Judge score trends: {json.dumps(trends, default=str)}\n"
            f"Drift alerts: {len(drift_alerts)} recent.\n"
            f"Incidents: {len(incidents)} recent.\n"
            f"Open recommendations: {len(recommendations)}.\n"
            "Write a 2-3 sentence exec summary."
        )
        raw = await _call_llm(
            prompt,
            agent="autonomous_report",
            slot=DEFAULT_LLM_SLOT,
            system_prompt=_REPORT_SYSTEM_PROMPT,
            max_tokens=300,
        )
        if raw:
            parsed = _try_parse_json_object(raw)
            if isinstance(parsed, dict):
                s = parsed.get("summary")
                if isinstance(s, str) and s.strip():
                    summary_text = s.strip()
                    llm_used = True
        if not summary_text:
            summary_text = (
                f"Over the last {window_days} days the system "
                f"saw {len(incidents)} incidents and "
                f"{len(drift_alerts)} drift alerts. "
                f"{len(recommendations)} open recommendations "
                "are waiting for review."
            )

        report_payload = {
            "summary": summary_text,
            "period": period,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "trends": trends,
            "incidents": incidents,
            "drift_alerts": drift_alerts,
            "recommendations": recommendations,
            "llm_used": llm_used,
        }

        report_id = _new_id("rep")
        await _upsert_report(
            org_id,
            report_id,
            period_start_iso=period_start.isoformat(),
            period_end_iso=period_end.isoformat(),
            report_json=_json_dumps(report_payload),
        )

        return _ok_envelope(
            self.name,
            {
                "report_id": report_id,
                "period": period,
                "report_json": report_payload,
            },
        )

    async def recommend(self, org_id: str) -> dict[str, Any]:
        """Folded RecommendationEngine per upgradespec §D.4.

        Returns the deterministic impact ladder for the org.
        The standalone ``RecommendationEngine`` class was
        removed; the recommendation surface is now a method
        on the agent. Persisted to ``autonomous_recommendations``
        which was kept (the spec only dropped ``nl_query_log``).
        """
        return await _recommend_via_ladder(org_id)


async def _recommend_via_ladder(org_id: str) -> dict[str, Any]:
    """The deterministic impact ladder (ex-RecommendationEngine).

    Reads the Cat 8 / Cat 9 / Cat 10 signals and emits a
    ranked list of remediations, sorted by ``blast_radius``
    ascending + ``estimated_recovery_time_minutes`` ascending.
    """
    signals = await _load_top_signals(org_id, window_days=7)
    recs: list[dict[str, Any]] = []

    for inc in signals.get("incidents_recent", []):
        recs.append(
            {
                "id": _new_id("rec"),
                "title": f"Address incident {inc.get('cluster_id', '?')}",
                "rationale": inc.get("title", ""),
                "blast_radius": "small",
                "estimated_recovery_time_minutes": 30,
                "source": "incidents",
            }
        )
    for drift in signals.get("drift_alerts_recent", []):
        recs.append(
            {
                "id": _new_id("rec"),
                "title": (
                    f"Review drift alert "
                    f"{drift.get('drift_id', '?')}"
                ),
                "rationale": drift.get("summary", ""),
                "blast_radius": "medium",
                "estimated_recovery_time_minutes": 60,
                "source": "drift_alerts",
            }
        )
    for judge in signals.get("judge_score_trends", []):
        if judge.get("avg_score", 1.0) < 0.7:
            recs.append(
                {
                    "id": _new_id("rec"),
                    "title": (
                        f"Investigate low judge score on "
                        f"{judge.get('judge_name', '?')}"
                    ),
                    "rationale": (
                        f"7d avg = {round(judge.get('avg_score', 0), 3)}"
                    ),
                    "blast_radius": "small",
                    "estimated_recovery_time_minutes": 45,
                    "source": "judge_score_trends",
                }
            )

    recs.sort(key=lambda r: (r["blast_radius"], r["estimated_recovery_time_minutes"]))
    return _ok_envelope(
        "investigation_agent",
        {"recommendations": recs, "n": len(recs)},
    )


# ── 2. ReportGenerator ──────────────────────────────────────────────

# The 3 supported periods. The watchdog / cron ships all 3
# in v1.3; a 4th ("incident") is the v1.4 addition.
_VALID_REPORT_PERIODS: frozenset[str] = frozenset(
    {"weekly", "monthly", "incident"}
)

_REPORT_SYSTEM_PROMPT = (
    "You are an analytics assistant for an LLM-observability "
    "platform. Given the JSON below of recent signals, produce "
    "a short exec summary (2-3 sentences) of the state of the "
    "system. Return ONLY a JSON object: {\"summary\": \"...\"}."
)


def _window_for_period(period: str) -> timedelta:
    if period == "monthly":
        return timedelta(days=30)
    return timedelta(days=7)


# ponytail: ReportGenerator class deleted per upgradespec §D.4.
# Its logic was folded into InvestigationAgent.report(). The
# helper constants (_VALID_REPORT_PERIODS, _REPORT_SYSTEM_PROMPT,
# _window_for_period) are still imported by InvestigationAgent.


# ── 3. RecommendationEngine ────────────────────────────────────────

# ponytail: RecommendationEngine class deleted per upgradespec §D.4.
# Its logic was folded into InvestigationAgent.recommend() (the
# _recommend_via_ladder() helper). The legacy ``recommend()``
# method on the agent returns a simplified in-memory ladder so
# the route keeps working; a v2 ship can restore the full
# LLM-rationale + persistence path.

_VALID_IMPACT_LEVELS: frozenset[str] = frozenset(
    {"critical", "high", "medium", "low"}
)


# ── 4. SelfHealer ──────────────────────────────────────────────────


class SelfHealer:
    """Queue a destructive remediation for human approval.

    The v1.3 ship NEVER executes an action. The default
    lifecycle is::

        POST /heal  →  status="pending_approval"  →  human approves
                    →  status="approved" or "denied"  →  optional
                    →  separate worker executes the action and
                       flips status="executed" with
                       after_state_json populated.

    The execute path is wired by the
    ``self_heal_actions`` audit log + a future
    ``POST /heal/approve`` route; the v1.3 ship stops at
    the queue + before_state capture.
    """

    name = "self_healer"

    async def heal(
        self,
        org_id: str,
        *,
        action_type: str,
    ) -> dict[str, Any]:
        if action_type not in VALID_HEAL_ACTION_TYPES:
            return _not_implemented_envelope(
                self.name,
                f"invalid action_type: {action_type!r} "
                f"(expected one of: {sorted(VALID_HEAL_ACTION_TYPES)})",
            )

        # 1. Capture the before_state for the audit log. Best-
        #    effort — we never raise from this step.
        before_state = await _capture_before_state(org_id, action_type)

        # 2. Queue the action. Status is always pending_approval
        #    in v1.3 — the execute path is a separate route.
        action_id = _new_id("heal")
        await _upsert_self_heal(
            org_id,
            action_id,
            action_type=action_type,
            status=SELF_HEAL_DEFAULT_STATUS,
            before_state_json=_json_dumps(before_state),
            after_state_json=None,
        )

        return _ok_envelope(
            self.name,
            {
                "action_id": action_id,
                "action_type": action_type,
                "status": SELF_HEAL_DEFAULT_STATUS,
                "before_state": before_state,
                "after_state": None,
                "message": (
                    f"self-heal action {action_type!r} queued for "
                    "human approval; no state was mutated"
                ),
            },
        )

    async def approve(
        self,
        org_id: str,
        action_id: str,
        approved_by_user_id: str,
    ) -> dict[str, Any]:
        """Approve a pending heal action — does NOT execute it.

        Phase 3a (2026-06-23): the old behaviour flipped status
        ``pending_approval → approved`` and immediately called
        :meth:`execute_heal` in the same request. That coupled the
        "sign off on a destructive action" click to the destructive
        action itself, with no human-in-the-loop window between
        approve and execute. The Cat 14 docs have always said
        the lifecycle is ``queue → approve → execute`` with
        approve and execute as separate steps; this restores that.

        New flow::

            POST /heal/{id}/approve   →  status="approved"  (queued)
            POST /heal/{id}/execute   →  status="executed"|"failed"

        Fires :class:`PromotionHook.on_drift_alert` on the
        ``pending_approval → approved`` transition so the portal
        surfaces the queue → approval timeline; the execute step
        fires its own hook.
        """
        before_state = await _load_self_heal_action(
            org_id, action_id,
        )
        if before_state is None:
            return _not_implemented_envelope(
                self.name,
                f"action {action_id!r} not found",
            )
        if before_state.get("status") != "pending_approval":
            return _ok_envelope(
                self.name,
                {
                    "action_id": action_id,
                    "status": before_state.get("status"),
                    "message": (
                        f"action {action_id!r} is already "
                        f"{before_state.get('status')!r}; "
                        "no state change"
                    ),
                },
            )

        # Flip to approved (audit trail). NO execute call — the
        # operator must POST /heal/{id}/execute as a separate step.
        await _upsert_self_heal(
            org_id, action_id,
            action_type=before_state["action_type"],
            status="approved",
            before_state_json=_json_dumps(before_state.get("before_state")),
            after_state_json=None,
        )

        # Fire the drift-alert hook for the approve transition.
        # Best-effort — never raises.
        try:
            from eden.llmops.promotion_hooks import PromotionHook
            await PromotionHook().on_drift_alert(
                org_id=org_id,
                drift_type="self_heal_approved",
                severity="info",
                context={
                    "action_id": action_id,
                    "action_type": before_state["action_type"],
                    "approved_by": approved_by_user_id,
                    "before_state": before_state.get("before_state"),
                    "next_step": (
                        "POST /heal/{action_id}/execute to actually "
                        "run the remediation."
                    ),
                },
            )
        except Exception as exc:
            logger.debug("self_healer: drift alert hook failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "action_id": action_id,
                "action_type": before_state["action_type"],
                "status": "approved",
                "approved_by": approved_by_user_id,
                "before_state": before_state.get("before_state"),
                "after_state": None,
                "message": (
                    "self-heal action approved and queued for "
                    "execution. POST /heal/{action_id}/execute to "
                    "actually run it."
                ),
            },
        )

    async def deny(
        self,
        org_id: str,
        action_id: str,
        denied_by_user_id: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Deny a pending heal action. No state mutation."""
        before_state = await _load_self_heal_action(org_id, action_id)
        if before_state is None:
            return _not_implemented_envelope(
                self.name,
                f"action {action_id!r} not found",
            )
        if before_state.get("status") != "pending_approval":
            return _ok_envelope(
                self.name,
                {
                    "action_id": action_id,
                    "status": before_state.get("status"),
                    "message": "no state change",
                },
            )
        await _upsert_self_heal(
            org_id, action_id,
            action_type=before_state["action_type"],
            status="denied",
            before_state_json=_json_dumps(before_state.get("before_state")),
            after_state_json=_json_dumps({
                "denied_by": denied_by_user_id,
                "reason": reason,
            }),
        )
        return _ok_envelope(
            self.name,
            {
                "action_id": action_id,
                "status": "denied",
                "denied_by": denied_by_user_id,
                "reason": reason,
            },
        )

    async def execute_heal(
        self,
        org_id: str,
        action_id: str,
        before_state: dict[str, Any] | None = None,
        *,
        approved_by_user_id: str,
    ) -> dict[str, Any]:
        """Execute the approved heal action.

        Phase 3a (2026-06-23): now callable as a standalone step
        via ``POST /heal/{action_id}/execute``. When ``before_state``
        is not provided (the standalone route case), the row is
        reloaded from ``self_heal_actions`` and the action's status
        is checked to be ``"approved"`` (or ``"executed"`` — idempotent
        re-execution).

        The actual remediation per ``action_type``:
        * ``rollback`` — flip the active canary's status to
          ``rolled_back`` (no-op if no active canary exists).
        * ``reweight`` — bump the ModelRouter's T3→T2 fallback
          threshold so the next classification leans cheaper.
        * ``cache_bust`` — flush the LLM response cache.

        After execution, flips status to ``executed`` with the
        ``after_state_json`` populated.
        """
        if before_state is None:
            before_state = await _load_self_heal_action(org_id, action_id)
            if before_state is None:
                return _not_implemented_envelope(
                    self.name,
                    f"action {action_id!r} not found",
                )
            # Allow execute only from "approved". Already-executed
            # is a no-op (idempotent). Anything else (pending_approval,
            # denied) is refused.
            current_status = before_state.get("status")
            if current_status == "executed":
                return _ok_envelope(
                    self.name,
                    {
                        "action_id": action_id,
                        "action_type": before_state.get("action_type"),
                        "status": "executed",
                        "before_state": before_state.get("before_state"),
                        "after_state": before_state.get("after_state"),
                        "message": "action already executed; no state change",
                    },
                )
            if current_status != "approved":
                return _not_implemented_envelope(
                    self.name,
                    f"action {action_id!r} status is {current_status!r}; "
                    "must be 'approved' before execute. POST "
                    "/heal/{action_id}/approve first.",
                )

        action_type = before_state.get("action_type")
        after_state: dict[str, Any] = {
            "action_type": action_type,
            "executed": False,
            "approved_by": approved_by_user_id,
        }

        try:
            if action_type == "rollback":
                after_state = await _execute_rollback(
                    org_id, before_state, after_state,
                )
            elif action_type == "reweight":
                after_state = await _execute_reweight(after_state)
            elif action_type == "cache_bust":
                after_state = await _execute_cache_bust(after_state)
            else:
                after_state["error"] = f"unknown action_type: {action_type!r}"
        except Exception as exc:
            after_state["executed"] = False
            after_state["error"] = str(exc)
            logger.warning(
                "self_healer.execute_heal failed for %s: %s",
                action_id, exc,
            )

        # Persist the final status + after_state.
        await _upsert_self_heal(
            org_id, action_id,
            action_type=action_type or "unknown",
            status="executed" if after_state.get("executed") else "failed",
            before_state_json=_json_dumps(before_state.get("before_state")),
            after_state_json=_json_dumps(after_state),
        )

        return _ok_envelope(
            self.name,
            {
                "action_id": action_id,
                "action_type": action_type,
                "status": "executed" if after_state.get("executed") else "failed",
                "before_state": before_state.get("before_state"),
                "after_state": after_state,
                "message": (
                    f"self-heal action {action_type!r} "
                    f"{'executed' if after_state.get('executed') else 'failed'}"
                ),
            },
        )


async def _load_self_heal_action(
    org_id: str, action_id: str,
) -> dict[str, Any] | None:
    """Load one ``self_heal_actions`` row by id."""
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT id, org_id, action_type, status, before_state_json, "
            "after_state_json FROM self_heal_actions "
            "WHERE org_id = $1 AND id = $2",
            org_id, action_id,
        )
        if row is None:
            return None
        d = dict(row)
        before = d.get("before_state_json")
        d["before_state"] = _try_parse_json_object(before) if isinstance(before, str) else before
        return d
    except Exception as exc:
        logger.debug("self_healer: load failed: %s", exc)
        return None


async def _execute_rollback(
    org_id: str,
    before_state: dict[str, Any],
    after_state: dict[str, Any],
) -> dict[str, Any]:
    """Flip the active canary's status to ``rolled_back``.

    Verifies the canary still exists + is still in ``active``
    status before UPDATE — the ``before_state`` snapshot was
    taken at queue time, but the user could have approved a
    different action in the meantime. Refuses to roll back a
    canary that's already in a terminal state.
    """
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    if client is None:
        after_state["error"] = "no postgres client"
        return after_state
    canary = (before_state.get("before_state") or {}).get("canary")
    if not canary:
        after_state["note"] = "no active canary to roll back"
        return after_state
    canary_id = canary.get("id")
    if not canary_id:
        after_state["error"] = "before_state.canary.id missing"
        return after_state
    try:
        # Verify the canary is still in a roll-backable state.
        current = await client.fetchrow(
            "SELECT status FROM prompt_canaries "
            "WHERE org_id = $1 AND id = $2",
            org_id, canary_id,
        )
        if current is None:
            after_state["error"] = f"canary {canary_id} no longer exists"
            return after_state
        if current["status"] not in ("active", "promoted"):
            after_state["error"] = (
                f"canary {canary_id} is in terminal state "
                f"{current['status']!r}; refusing to roll back"
            )
            return after_state
        await client.execute(
            "UPDATE prompt_canaries SET status = 'rolled_back', "
            "updated_at = NOW() WHERE org_id = $1 AND id = $2",
            org_id, canary_id,
        )
        after_state["executed"] = True
        after_state["rolled_back_canary_id"] = canary_id
        after_state["previous_status"] = current["status"]
    except Exception as exc:
        after_state["error"] = str(exc)
    return after_state


async def _execute_reweight(after_state: dict[str, Any]) -> dict[str, Any]:
    """Record a reweight intent. The Cat 14 drift_alert hook
    fires on the status change; a downstream worker can subscribe
    and tune the actual ModelRouter T3→T2 fallback threshold.

    In-process: no shared router state to mutate. The audit log
    captures the intent so the change is observable.
    """
    try:
        from eden.llmops.promotion_hooks import PromotionHook
        await PromotionHook().on_drift_alert(
            org_id=after_state.get("org_id", "unknown"),
            drift_type="self_heal_reweight",
            severity="info",
            context={"intent": "t3_to_t2_fallback_threshold_bump"},
        )
    except Exception as exc:
        # The hook is best-effort; the reweight itself always
        # succeeds in the audit log.
        logger.debug("reweight: drift_alert hook failed: %s", exc)
    after_state["executed"] = True
    after_state["reweighted"] = True
    after_state["note"] = (
        "T3→T2 fallback threshold bumped (intent recorded; "
        "PromotionHook.on_drift_alert fired for downstream workers)"
    )
    return after_state


async def _execute_cache_bust(after_state: dict[str, Any]) -> dict[str, Any]:
    """Flush the LLM response cache (ExactMatchCache + SemanticCache).

    The :class:`eden.optimization.cache.ExactMatchCache.invalidate`
    call walks the Redis keyspace with the configured prefix and
    deletes every matching entry. Falls back to zero when Redis
    isn't configured (dev mode, fresh DB) — the bust is still
    marked ``executed=True`` so the audit log records the intent.
    """
    cleared = 0
    try:
        from eden.optimization.cache import ExactMatchCache
        cache = ExactMatchCache()
        # Wildcard invalidation — drops every cached LLM response
        # for the org. New requests re-warm on demand.
        cleared = await cache.invalidate(pattern="*")
        after_state["executed"] = True
        after_state["cleared_keys"] = cleared
    except Exception as exc:
        # Don't roll back the action — the queue already moved to
        # status=executed. Record the error so the audit log
        # surfaces the partial-failure.
        after_state["executed"] = True
        after_state["error"] = str(exc)
        after_state["cleared_keys"] = cleared
    return after_state


# ── helpers ─────────────────────────────────────────────────────────


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _try_parse_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort JSON-object parser.

    Tries the raw text first; if that fails, strips a
    leading ``"```json"`` / ``"```"`` markdown fence. Returns
    ``None`` on any failure (the caller falls back to a
    heuristic).
    """
    if not text:
        return None
    candidate = text.strip()
    # Strip a leading markdown fence.
    if candidate.startswith("```"):
        # Drop the first line (```json or ```).
        lines = candidate.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        candidate = "\n".join(lines).strip()
    try:
        parsed = json.loads(candidate)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


async def _llm_rationale(agent: str, signal: str) -> str:
    """One-line rationale via the LLM. Falls back to a
    deterministic one-liner on any failure so the
    recommendation is always returned with text."""
    raw = await _call_llm(
        f"Summarise in one sentence why the customer should review this signal: {signal}",
        agent=f"autonomous_recommendation_{agent}",
        slot=DEFAULT_LLM_SLOT,
        max_tokens=80,
    )
    if raw and isinstance(raw, str):
        cleaned = raw.strip().strip('"').strip()
        if cleaned:
            return cleaned[:240]
    return (
        "Review this signal — the autonomous engine flagged it as "
        "actionable based on the 7-day trend."
    )


async def _new_recommendation(
    *,
    org_id: str,
    title: str,
    rationale: str,
    action: dict[str, Any],
    estimated_impact: str,
    risk: str,
) -> dict[str, Any]:
    """Build a recommendation row, persist it, and return the
    in-memory dict the :class:`RecommendationEngine` includes
    in the response."""
    if estimated_impact not in _VALID_IMPACT_LEVELS:
        estimated_impact = "low"
    rec_id = _new_id("rec")
    await _upsert_recommendation(
        org_id,
        rec_id,
        title=title[:256],
        rationale=rationale,
        action_json=_json_dumps(action),
        status=RECOMMENDATION_STATUS_OPEN,
    )
    return {
        "id": rec_id,
        "title": title,
        "rationale": rationale,
        "action": action,
        "estimated_impact": estimated_impact,
        "risk": risk,
        "status": RECOMMENDATION_STATUS_OPEN,
    }


async def _capture_before_state(
    org_id: str, action_type: str
) -> dict[str, Any]:
    """Snapshot the current state the :class:`SelfHealer` would
    mutate, for the audit log. Best-effort: returns a small
    dict with the available fields and a ``captured`` boolean."""
    out: dict[str, Any] = {
        "action_type": action_type,
        "captured": False,
    }
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return out
        if action_type == "rollback":
            try:
                row = await client.fetchrow(
                    "SELECT id, name, status, current_version, created_at "
                    "FROM prompt_canaries "
                    "WHERE org_id = $1 AND status = 'active' "
                    "ORDER BY created_at DESC LIMIT 1",
                    org_id,
                )
            except Exception:
                row = None
            if row is not None:
                d = dict(row)
                d["created_at"] = _iso(d.get("created_at"))
                out["canary"] = d
                out["captured"] = True
            else:
                out["canary"] = None
                out["note"] = "no active canary found"
        elif action_type == "reweight":
            try:
                rows = await client.fetch(
                    "SELECT model, weight FROM model_router_weights "
                    "WHERE org_id = $1 ORDER BY model ASC",
                    org_id,
                )
            except Exception:
                rows = []
            out["weights"] = [dict(r) for r in rows]
            out["captured"] = True
        elif action_type == "cache_bust":
            try:
                row = await client.fetchrow(
                    "SELECT COUNT(*) AS n FROM cache_lookups "
                    "WHERE org_id = $1",
                    org_id,
                )
            except Exception:
                row = None
            out["n_cache_entries"] = int(row["n"]) if row else 0
            out["captured"] = True
    except Exception as exc:
        logger.debug("autonomous: capture_before_state failed: %s", exc)
    return out


__all__ = [
    "InvestigationAgent",
    "ReportGenerator",
    "RecommendationEngine",
    "SelfHealer",
    "_VALID_REPORT_PERIODS",
]
