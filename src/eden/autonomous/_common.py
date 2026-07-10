"""Shared helpers for Cat 14 (Autonomous Intelligence) services.

Centralises:
* the envelope shape used for live (non-stub) responses
  (``_ok_envelope``, ``_not_implemented_envelope``) — same
  shape as Cat 16 / Cat 21 so the front-end renders uniformly
* JSON helpers (``_json_dumps``, ``_json_loads``) that match
  the patterns in the other Cat ``_common.py`` modules
* persistence helpers for the 5 Cat 14 tables
  (``_upsert_investigation``, ``_upsert_report``,
  ``_upsert_recommendation``, ``_upsert_self_heal``,
  ``_upsert_nl_query_log``) — best-effort, all swallow
  exceptions so the service still returns a live envelope
  on infra failures
* LLM call helper :func:`_call_llm` — wraps the
  :class:`OpenRouterClient` and falls back to a stub
  envelope on any LLM error so a transient outage doesn't
  take the autonomous surface down
* trigger resolver :func:`_resolve_trigger_context` — the
  dispatcher the :class:`InvestigationAgent` uses to fetch
  the trigger's underlying context (drift alert row,
  incident cluster row, judge regression, or guardrail
  breach) before calling the LLM
* action types the :class:`SelfHealer` accepts (and the
  default ``pending_approval`` lifecycle)

The package boundary hides the per-service glue. Cat 14 is
the "Automation" half of the Observation → Explanation →
Evaluation → Attribution → Optimization → **Automation**
chain (Article 1).
"""

from __future__ import annotations

import asyncio  # Audit 2026-07-02 P-7 (gather on the 4 subqueries)
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, cast

logger = logging.getLogger(__name__)


# ── Constants ────────────────────────────────────────────────────────

# The default LLM slot for autonomous work. The appendix's
# "NL query model" open question resolved to ``"fast"`` for
# the v0 ship — the same slot the judges use for routine
# classification. A v1.4 upgrade can route heavy investigations
# to the ``"reasoning"`` slot.
DEFAULT_LLM_SLOT: str = "fast"

# The 4 trigger types the :class:`InvestigationAgent` knows
# how to resolve. Unknown prefixes return ``None`` and the
# agent surfaces an "unsupported trigger" envelope.
KNOWN_TRIGGER_TYPES: frozenset[str] = frozenset(
    {"drift_alert", "incident", "judge_regression", "guardrail_breach", "issue"}
)

# The 3 destructive action types the :class:`SelfHealer`
# accepts. Everything else returns an invalid-action envelope.
VALID_HEAL_ACTION_TYPES: frozenset[str] = frozenset(
    {"rollback", "reweight", "cache_bust"}
)

# Cat 14 safety: the self-healer NEVER executes by default.
# A real implementation flips this when the org has the
# ``autonomous_actions_v0`` feature flag ON AND a human
# approver signs off via the ``POST /heal/approve`` route.
SELF_HEAL_DEFAULT_STATUS: str = "pending_approval"

# The trigger types a recommendation can be tagged with.
# Free-form for now (the RecommendationEngine stores the
# raw action dict in ``action_json``).
RECOMMENDATION_STATUS_OPEN: str = "open"
RECOMMENDATION_STATUS_APPLIED: str = "applied"
RECOMMENDATION_STATUS_DISMISSED: str = "dismissed"


# ── Envelope helpers ────────────────────────────────────────────────


def _new_trace_id() -> str:
    return f"aut_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The live-response envelope — ``status="ok"`` and ``live=True``
    to signal real data.

    Mirrors :func:`eden.metric_studio._common._ok_envelope` so the
    front-end treats every intelligence response uniformly.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data,
    }


def _not_implemented_envelope(
    feature: str,
    message: str,
    *,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Live envelope returned when a service is registered but a
    sub-capability is not yet implemented (e.g. a future admin
    tool). Distinct from the stub
    :func:`eden.intelligence_envelope.not_implemented` helper —
    we still want ``live=True`` because the surface IS live;
    it's the sub-feature that isn't.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data or {},
        "message": message,
    }


# ── JSON helpers ────────────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    """JSON serialiser with a stable, Postgres-friendly default."""
    return json.dumps(obj, default=str, ensure_ascii=False)


def _json_loads(s: str | None, default: Any = None) -> Any:
    """Best-effort JSON deserialiser — returns ``default`` on
    any failure."""
    if not s:
        return default
    try:
        return json.loads(s)
    except (ValueError, TypeError) as exc:
        logger.debug("autonomous._common: json load failed: %s", exc)
        return default


# ── LLM call helper ────────────────────────────────────────────────


async def _call_llm(
    prompt: str,
    *,
    agent: str,
    slot: str = DEFAULT_LLM_SLOT,
    system_prompt: str | None = None,
    max_tokens: int = 600,
) -> str | None:
    """Best-effort LLM call. Returns the response ``content``
    string on success, or ``None`` on any failure (LLM down,
    no API key, JSON parse error, etc.). A v0 autonomous
    surface that gracefully degrades to "no LLM" beats a
    surface that 500s when the LLM is offline.

    The caller checks for ``None`` and falls back to a
    heuristic-based answer (e.g. the
    :class:`RecommendationEngine` ranks signals with a
    deterministic impact ladder when the LLM is unavailable).
    """
    try:
        from eden.llm.client import get_llm_client

        client = get_llm_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: get_llm_client failed: %s", exc)
        return None
    if client is None:
        return None
    try:
        # OpenRouterClient exposes both ``call`` (sync) and
        # ``acall`` (async). The autonomous services are async,
        # so we use ``acall`` when available and fall back to
        # running the sync call in a thread.
        if hasattr(client, "acall"):
            try:
                resp = await client.acall(
                    agent=agent,
                    prompt=prompt,
                    slot=slot,
                    system_prompt=system_prompt,
                    max_tokens=max_tokens,
                )
            except TypeError:
                # Older signature without max_tokens kwarg.
                resp = await client.acall(
                    agent=agent,
                    prompt=prompt,
                    slot=slot,
                    system_prompt=system_prompt,
                )
        else:
            import asyncio
            loop = asyncio.get_event_loop()
            try:
                resp = await loop.run_in_executor(
                    None,
                    lambda: client.call(
                        agent=agent,
                        prompt=prompt,
                        slot=slot,
                        system_prompt=system_prompt,
                        max_tokens=max_tokens,
                    ),
                )
            except TypeError:
                resp = await loop.run_in_executor(
                    None,
                    lambda: client.call(
                        agent=agent,
                        prompt=prompt,
                        slot=slot,
                        system_prompt=system_prompt,
                    ),
                )
        content = getattr(resp, "content", None) or ""
        if isinstance(content, str):
            return content.strip()
        return str(content).strip() if content else None
    except Exception as exc:
        logger.debug("autonomous._common: LLM call failed: %s", exc)
        return None


# ── Trigger context resolver ────────────────────────────────────────


async def _resolve_trigger_context(
    org_id: str,
    trigger: str,
) -> dict[str, Any] | None:
    """Resolve a trigger string (e.g. ``"drift_alert:abc123"``)
    into the underlying row + a small set of "related signals"
    the :class:`InvestigationAgent` feeds to the LLM.

    Returns ``None`` when the trigger prefix is unknown or
    the underlying row is missing. The caller surfaces a
    "trigger not found" envelope.
    """
    if not trigger or ":" not in trigger:
        return None
    prefix, _, _ = trigger.partition(":")
    if prefix not in KNOWN_TRIGGER_TYPES:
        return None
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: postgres import failed: %s", exc)
        return None
    try:
        client = await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        # A real Postgres connection failure (DB down,
        # misconfigured pool) is treated the same as a
        # missing row — the caller falls back to the
        # "trigger not recognised" envelope.
        logger.debug(
            "autonomous._common: get_postgres_client raised: %s", exc
        )
        return None
    if client is None:
        return None
    if prefix == "drift_alert":
        try:
            row = await client.fetchrow(
                "SELECT * FROM drift_alerts "
                "WHERE org_id = $1 AND id = $2 "
                "ORDER BY created_at DESC LIMIT 1",
                org_id,
                trigger.split(":", 1)[1],
            )
        except Exception as exc:
            logger.debug("autonomous._common: drift_alert fetch failed: %s", exc)
            return None
        if row is None:
            return None
        return {
            "trigger_type": "drift_alert",
            "trigger_id": trigger,
            "row": dict(row),
            "context": {
                "drift_type": dict(row).get("drift_type"),
                "severity": dict(row).get("severity"),
                "created_at": _iso(dict(row).get("created_at")),
            },
        }
    if prefix == "incident":
        try:
            row = await client.fetchrow(
                "SELECT * FROM incident_clusters "
                "WHERE org_id = $1 AND id = $2",
                org_id,
                trigger.split(":", 1)[1],
            )
        except Exception as exc:
            logger.debug("autonomous._common: incident fetch failed: %s", exc)
            return None
        if row is None:
            return None
        return {
            "trigger_type": "incident",
            "trigger_id": trigger,
            "row": dict(row),
            "context": {
                "severity": dict(row).get("severity"),
                "member_count": dict(row).get("member_count"),
            },
        }
    if prefix == "issue":
        # issue:<uuid> — F30 triage trigger. Load the grouped issue
        # plus its most-recent example stumbles so the investigator has
        # concrete evidence to ground the RCA.
        issue_id = trigger.split(":", 1)[1]
        try:
            row = await client.fetchrow(
                "SELECT * FROM agent_issues "
                "WHERE org_id = $1 AND id = $2::uuid",
                org_id,
                issue_id,
            )
        except Exception as exc:
            logger.debug("autonomous._common: issue fetch failed: %s", exc)
            return None
        if row is None:
            return None
        issue = dict(row)
        stumbles: list[dict[str, Any]] = []
        try:
            srows = await client.fetch(
                "SELECT trace_id, kind, title, detail, severity, span_id, "
                "detected_at FROM agent_stumbles "
                "WHERE org_id = $1 AND fingerprint = $2 "
                "ORDER BY detected_at DESC LIMIT 5",
                org_id,
                issue["fingerprint"],
            )
            stumbles = [dict(s) for s in srows]
        except Exception as exc:
            logger.debug("autonomous._common: issue stumbles fetch failed: %s", exc)
        return {
            "trigger_type": "issue",
            "trigger_id": trigger,
            "row": issue,
            "context": {
                "issue_id": issue_id,
                "kind": issue.get("kind"),
                "severity": issue.get("severity"),
                "title": issue.get("title"),
                "stumble_count": issue.get("stumble_count"),
                "user_count": issue.get("user_count"),
                "agent_id": issue.get("agent_id"),
                "sample_stumbles": [
                    {
                        "trace_id": s.get("trace_id"),
                        "title": s.get("title"),
                        "detail": s.get("detail"),
                    }
                    for s in stumbles
                ],
            },
        }
    if prefix == "judge_regression":
        # judge_regression:<judge_name> — fetch the latest
        # regression row for the judge.
        try:
            row = await client.fetchrow(
                "SELECT judge_name, score, trace_id, created_at "
                "FROM judge_scores "
                "WHERE org_id = $1 AND judge_name = $2 "
                "ORDER BY created_at DESC LIMIT 1",
                org_id,
                trigger.split(":", 1)[1],
            )
        except Exception as exc:
            logger.debug(
                "autonomous._common: judge_regression fetch failed: %s", exc
            )
            return None
        return {
            "trigger_type": "judge_regression",
            "trigger_id": trigger,
            "row": dict(row) if row else {},
            "context": {
                "judge_name": trigger.split(":", 1)[1],
            },
        }
    if prefix == "guardrail_breach":
        # guardrail_breach:<scanner> — the intervention_log
        # table is the canonical source.
        try:
            row = await client.fetchrow(
                "SELECT verdict, reason, trace_id, created_at "
                "FROM intervention_log "
                "WHERE org_id = $1 "
                "ORDER BY created_at DESC LIMIT 1",
                org_id,
            )
        except Exception as exc:
            logger.debug(
                "autonomous._common: guardrail_breach fetch failed: %s", exc
            )
            return None
        return {
            "trigger_type": "guardrail_breach",
            "trigger_id": trigger,
            "row": dict(row) if row else {},
            "context": {
                "scanner": trigger.split(":", 1)[1],
            },
        }
    return None


def _iso(v: Any) -> str | None:
    """Coerce a datetime to its ISO string. Returns ``None`` for
    non-datetime inputs."""
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        try:
            return cast(str | None, v.isoformat())
        except Exception:  # pragma: no cover - defensive
            return None
    return str(v)


# ── Persistence helpers (best-effort) ──────────────────────────────


async def _upsert_investigation(
    org_id: str,
    investigation_id: str,
    *,
    trigger: str,
    status: str,
    findings_json: str,
) -> None:
    """Insert (or replace) one row in ``investigations``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "INSERT INTO investigations "
            "(id, org_id, trigger, status, findings_json) "
            "VALUES ($1, $2, $3, $4, $5) "
            "ON CONFLICT (id) DO UPDATE SET "
            "status = EXCLUDED.status, "
            "findings_json = EXCLUDED.findings_json",
            investigation_id,
            org_id,
            trigger,
            status,
            findings_json,
        )
    except Exception as exc:
        logger.debug(
            "autonomous._common: investigations upsert failed: %s", exc
        )


async def _upsert_report(
    org_id: str,
    report_id: str,
    *,
    period_start_iso: str,
    period_end_iso: str,
    report_json: str,
) -> None:
    """Insert (or replace) one row in ``autonomous_reports``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "INSERT INTO autonomous_reports "
            "(id, org_id, period_start, period_end, report_json) "
            "VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5) "
            "ON CONFLICT (id) DO UPDATE SET "
            "report_json = EXCLUDED.report_json, "
            "period_end = EXCLUDED.period_end",
            report_id,
            org_id,
            period_start_iso,
            period_end_iso,
            report_json,
        )
    except Exception as exc:
        logger.debug(
            "autonomous._common: autonomous_reports upsert failed: %s", exc
        )


async def _upsert_recommendation(
    org_id: str,
    recommendation_id: str,
    *,
    title: str,
    rationale: str | None,
    action_json: str,
    status: str,
) -> None:
    """Insert (or replace) one row in ``autonomous_recommendations``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "INSERT INTO autonomous_recommendations "
            "(id, org_id, title, rationale, action_json, status) "
            "VALUES ($1, $2, $3, $4, $5, $6) "
            "ON CONFLICT (id) DO UPDATE SET "
            "title = EXCLUDED.title, "
            "rationale = EXCLUDED.rationale, "
            "action_json = EXCLUDED.action_json, "
            "status = EXCLUDED.status",
            recommendation_id,
            org_id,
            title,
            rationale,
            action_json,
            status,
        )
    except Exception as exc:
        logger.debug(
            "autonomous._common: autonomous_recommendations upsert failed: %s",
            exc,
        )


async def _upsert_self_heal(
    org_id: str,
    action_id: str,
    *,
    action_type: str,
    status: str,
    before_state_json: str | None,
    after_state_json: str | None = None,
) -> None:
    """Insert (or replace) one row in ``self_heal_actions``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "INSERT INTO self_heal_actions "
            "(id, org_id, action_type, status, before_state_json, after_state_json) "
            "VALUES ($1, $2, $3, $4, $5, $6) "
            "ON CONFLICT (id) DO UPDATE SET "
            "status = EXCLUDED.status, "
            "after_state_json = EXCLUDED.after_state_json",
            action_id,
            org_id,
            action_type,
            status,
            before_state_json,
            after_state_json,
        )
    except Exception as exc:
        logger.debug(
            "autonomous._common: self_heal_actions upsert failed: %s", exc
        )


async def _upsert_nl_query_log(
    org_id: str,
    query_id: str,
    *,
    user_id: str | None,
    question: str,
    result_json: str | None,
) -> None:
    """Insert one row in ``nl_query_log`` (immutable audit log)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "INSERT INTO nl_query_log "
            "(id, org_id, user_id, question, result_json) "
            "VALUES ($1, $2, $3, $4, $5)",
            query_id,
            org_id,
            user_id,
            question,
            result_json,
        )
    except Exception as exc:
        logger.debug(
            "autonomous._common: nl_query_log insert failed: %s", exc
        )


# ── Signal aggregator (used by Report + Recommendation) ────────────


async def _load_top_signals(org_id: str, *, window_days: int = 7) -> dict[str, Any]:
    """Read a small bundle of recent signals (judge score trends,
    drift alerts, recent incidents) the
    :class:`ReportGenerator` and :class:`RecommendationEngine`
    use as input.

    Best-effort: any exception returns an empty dict so the
    callers degrade gracefully.
    """
    out: dict[str, Any] = {
        "judge_score_trends": [],
        "drift_alerts_recent": [],
        "incidents_recent": [],
        "low_roi_departments": [],
        "open_recommendations": [],
    }
    try:
        from datetime import timedelta

        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return out
        since = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
        # Audit 2026-07-02 P-7: 4 subqueries fire in parallel via
        # asyncio.gather — collapse 4 × ~10ms into ~10ms.
        async def _judge_trends() -> list:
            rows = await client.fetch(
                "SELECT judge_name, AVG(score) AS avg_score, "
                "COUNT(*) AS n "
                "FROM judge_scores "
                "WHERE org_id = $1 AND created_at >= $2 "
                "GROUP BY judge_name "
                "ORDER BY judge_name ASC",
                org_id,
                since,
            )
            return [
                {
                    "judge_name": r.get("judge_name"),
                    "avg_score": float(r.get("avg_score") or 0.0),
                    "n": int(r.get("n") or 0),
                }
                for r in rows
            ]

        async def _drift() -> list:
            rows = await client.fetch(
                "SELECT id, drift_type, severity, created_at "
                "FROM drift_alerts "
                "WHERE org_id = $1 AND created_at >= $2 "
                "ORDER BY created_at DESC LIMIT 20",
                org_id,
                since,
            )
            return [
                {
                    "id": r.get("id"),
                    "drift_type": r.get("drift_type"),
                    "severity": r.get("severity"),
                    "created_at": _iso(r.get("created_at")),
                }
                for r in rows
            ]

        async def _incidents() -> list:
            rows = await client.fetch(
                "SELECT cluster_id, severity, member_count, created_at "
                "FROM incident_clusters "
                "WHERE org_id = $1 AND created_at >= $2 "
                "ORDER BY created_at DESC LIMIT 20",
                org_id,
                since,
            )
            return [
                {
                    "cluster_id": r.get("cluster_id"),
                    "severity": r.get("severity"),
                    "member_count": int(r.get("member_count") or 0),
                    "created_at": _iso(r.get("created_at")),
                }
                for r in rows
            ]

        async def _open_recs() -> list:
            rows = await client.fetch(
                "SELECT id, title, rationale, action_json, created_at "
                "FROM autonomous_recommendations "
                "WHERE org_id = $1 AND status = 'open' "
                "ORDER BY created_at DESC LIMIT 20",
                org_id,
            )
            return [
                {
                    "id": r.get("id"),
                    "title": r.get("title"),
                    "rationale": r.get("rationale"),
                    "action": _json_loads(r.get("action_json"), default={}),
                    "created_at": _iso(r.get("created_at")),
                }
                for r in rows
            ]

        results = await asyncio.gather(
            _judge_trends(),
            _drift(),
            _incidents(),
            _open_recs(),
            return_exceptions=True,
        )
        if not isinstance(results[0], Exception):
            out["judge_score_trends"] = results[0]
        if not isinstance(results[1], Exception):
            out["drift_alerts_recent"] = results[1]
        if not isinstance(results[2], Exception):
            out["incidents_recent"] = results[2]
        if not isinstance(results[3], Exception):
            out["open_recommendations"] = results[3]
    except Exception as exc:
        logger.debug("autonomous._common: load_top_signals failed: %s", exc)
    return out


__all__ = [
    "DEFAULT_LLM_SLOT",
    "KNOWN_TRIGGER_TYPES",
    "VALID_HEAL_ACTION_TYPES",
    "SELF_HEAL_DEFAULT_STATUS",
    "RECOMMENDATION_STATUS_OPEN",
    "RECOMMENDATION_STATUS_APPLIED",
    "RECOMMENDATION_STATUS_DISMISSED",
    "_ok_envelope",
    "_not_implemented_envelope",
    "_json_dumps",
    "_json_loads",
    "_call_llm",
    "_resolve_trigger_context",
    "_iso",
    "_upsert_investigation",
    "_upsert_report",
    "_upsert_recommendation",
    "_upsert_self_heal",
    "_upsert_nl_query_log",
    "_load_top_signals",
]
