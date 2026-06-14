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


class ReportGenerator:
    """Generate a weekly / monthly / incident report.

    The v1.3 ship aggregates trends, drift alerts, incidents,
    and open recommendations from the existing tables and
    (best-effort) calls the LLM to write a 2-3 sentence exec
    summary. A v2 ship can add per-section LLM summaries +
    a markdown renderer.
    """

    name = "report_generator"

    async def generate(
        self,
        org_id: str,
        *,
        period: str = "weekly",
    ) -> dict[str, Any]:
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


# ── 3. RecommendationEngine ────────────────────────────────────────

# The deterministic impact ladder. Used when the LLM is
# unavailable and as a sanity check on the LLM's output
# (the LLM's ``estimated_impact`` must be one of these).
_VALID_IMPACT_LEVELS: frozenset[str] = frozenset(
    {"critical", "high", "medium", "low"}
)


class RecommendationEngine:
    """Generate ranked, actionable recommendations.

    The v1.3 ship reads drift alerts, retrieval knowledge
    gaps, judge regressions, and high-cost lines, then ranks
    them by impact using a simple deterministic ladder. The
    LLM is used (best-effort) to write a one-line rationale
    per recommendation; on LLM failure the rationale is a
    generic one-liner.

    Recommendations are read-only. The customer must invoke
    the corresponding action endpoint
    (e.g. ``POST /heal``) to apply one.
    """

    name = "recommendation_engine"

    async def recommend(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        signals = await _load_top_signals(org_id, window_days=7)
        recs: list[dict[str, Any]] = []

        # 3.1. Drift alerts → recommend review / rollback.
        for d in signals.get("drift_alerts_recent", [])[:5]:
            severity = (d.get("severity") or "").lower()
            if severity not in ("high", "critical"):
                continue
            drift_type = d.get("drift_type") or "drift"
            title = f"Investigate {drift_type} drift alert"
            rationale = await _llm_rationale(
                "drift_review",
                f"drift_type={drift_type}, severity={severity}",
            )
            recs.append(
                await _new_recommendation(
                    org_id=org_id,
                    title=title,
                    rationale=rationale,
                    action={
                        "type": "investigation.trigger",
                        "params": {"trigger": f"drift_alert:{d.get('id')}"},
                    },
                    estimated_impact="high" if severity == "critical" else "medium",
                    risk="low",
                )
            )

        # 3.2. Open incidents with severity=critical → recommend
        #     a rollback if there's an active canary.
        for inc in signals.get("incidents_recent", [])[:5]:
            if (inc.get("severity") or "").lower() != "critical":
                continue
            title = "Review critical incident cluster"
            rationale = await _llm_rationale(
                "incident_review",
                f"cluster_id={inc.get('cluster_id')}, member_count={inc.get('member_count')}",
            )
            recs.append(
                await _new_recommendation(
                    org_id=org_id,
                    title=title,
                    rationale=rationale,
                    action={
                        "type": "investigation.trigger",
                        "params": {"trigger": f"incident:{inc.get('cluster_id')}"},
                    },
                    estimated_impact="high",
                    risk="low",
                )
            )

        # 3.3. Judge scores below 0.7 → recommend rubric
        #     review.
        for t in signals.get("judge_score_trends", []):
            avg = float(t.get("avg_score") or 0.0)
            if avg >= 0.7:
                continue
            title = f"Judge {t.get('judge_name')} trending low"
            rationale = await _llm_rationale(
                "judge_review",
                f"judge={t.get('judge_name')}, avg_score={avg:.3f}, n={t.get('n')}",
            )
            recs.append(
                await _new_recommendation(
                    org_id=org_id,
                    title=title,
                    rationale=rationale,
                    action={
                        "type": "judge.review_threshold",
                        "params": {
                            "judge_name": t.get("judge_name"),
                            "current_avg": avg,
                        },
                    },
                    estimated_impact="medium",
                    risk="low",
                )
            )

        # 3.4. Rank by impact ladder (critical > high > medium > low).
        rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        recs.sort(
            key=lambda r: rank.get(r.get("estimated_impact", "low"), 1),
            reverse=True,
        )

        return _ok_envelope(
            self.name,
            {
                "recommendations": [
                    {
                        "id": r["id"],
                        "title": r["title"],
                        "rationale": r["rationale"],
                        "action": r["action"],
                        "estimated_impact": r["estimated_impact"],
                        "risk": r["risk"],
                        "status": r["status"],
                    }
                    for r in recs
                ],
                "n_recommendations": len(recs),
            },
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
