"""Natural Language Interface (Cat 14 — Braintrust Loop AI / Phoenix
Alyx / LangSmith Polly parity).

Three services:
* ``NLQueryEngine`` — NL queries over production observability data.
* ``AutoDashboardBuilder`` — auto-generate dashboard from NL.
* ``NLReportGenerator`` — auto-generate report from NL.

A real implementation translates the question to a structured
query (e.g. against ClickHouse / Postgres) and runs it; the v1.3
ship is single-shot and falls back to heuristic Postgres
aggregates over ``judge_scores`` / ``telemetry_events`` when the
LLM produces invalid SQL or ClickHouse is unavailable.

The NL query surface is gated by the ``intelligence_gap_v0``
umbrella feature flag. The LLM call is best-effort — any
failure returns a live envelope with ``live=True`` and a
clear message.

See ``docs/observability-gap/14-autonomous-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC
from typing import Any

from .._common import (
    DEFAULT_LLM_SLOT,
    _call_llm,
    _json_dumps,
    _not_implemented_envelope,
    _ok_envelope,
    _upsert_report,
)

logger = logging.getLogger(__name__)


# ── Prompts ────────────────────────────────────────────────────────

# The system prompt used by ``NLQueryEngine.query``. The
# LLM is told the v1.3 read-only allowlist so the emitted
# SQL is always safe to run against Postgres.
_NL_TO_SQL_SYSTEM_PROMPT = (
    "You are an analyst for an LLM-observability platform. "
    "Translate the user's question into a single read-only SQL "
    "statement against Postgres. Allowed tables: telemetry_events, "
    "judge_scores, usage_events, outcomes, drift_alerts, "
    "incident_clusters, autonomous_recommendations, "
    "outcome_department_rollups, prompt_canaries. Allowed "
    "columns vary by table — prefer SELECT-only. Always include "
    "a WHERE org_id = '<org_id>' filter. Use parameterised "
    "strings: write ``org_id = $1`` and never inline the value. "
    "Return ONLY a JSON object: {\"sql\": \"...\", \"notes\": \"...\"}."
)

# The system prompt used to summarise the query result.
_NL_SUMMARY_SYSTEM_PROMPT = (
    "You are an analyst for an LLM-observability platform. "
    "Given the original question + a tabular result, write a "
    "1-2 sentence answer that quotes the most relevant number. "
    "Return ONLY a JSON object: {\"summary\": \"...\"}."
)

# The system prompt used by ``AutoDashboardBuilder.build``.
_DASHBOARD_SYSTEM_PROMPT = (
    "You are an analyst for an LLM-observability platform. "
    "Given a natural-language dashboard description, emit a JSON "
    "object with a single key `panels` — a list of 2-5 panels. "
    "Each panel: {\"type\": \"line_chart\"|\"bar_chart\"|\"stat\"|\"table\", "
    "\"metric\": \"...\", \"group_by\": \"...\" | null, "
    "\"window\": \"7d\"|\"30d\"|\"24h\", "
    "\"title\": \"...\"}. Return ONLY the JSON object."
)

# The system prompt used by ``NLReportGenerator.generate``.
_NL_REPORT_SYSTEM_PROMPT = (
    "You are an analyst for an LLM-observability platform. "
    "Given a natural-language report request, extract the "
    "structured fields and return ONLY a JSON object: "
    "{\"period\": \"weekly\"|\"monthly\"|\"incident\", "
    "\"focus\": [\"judge_quality\"|\"cost\"|\"roi\"|\"incidents\"|\"recommendations\"], "
    "\"title\": \"...\"}."
)


# ── 5. NLQueryEngine ───────────────────────────────────────────────


class NLQueryEngine:
    """NL queries over production observability data.

    Flow: NL → SQL via the LLM (best-effort), validate
    read-only guardrails, run against Postgres with
    ``org_id = $1``, summarise. When the LLM is unavailable
    or emits unsafe SQL, falls back to a keyword-heuristic
    aggregate over ``judge_scores`` / ``telemetry_events`` /
    ``usage_events`` so the route always returns live data
    rather than a 501.
    """

    name = "nl_query"

    async def query(
        self,
        org_id: str,
        *,
        question: str,
    ) -> dict[str, Any]:
        if not question or not question.strip():
            return _not_implemented_envelope(
                self.name,
                "question is required and must be non-empty",
            )

        assumptions = [
            "ClickHouse analytics substrate unavailable or unused; "
            "NL queries run against Postgres traces / judge_scores / "
            "usage_events.",
            "SQL is read-only and must include a parameterised "
            "org_id = $1 filter.",
        ]

        # 1. NL → SQL via the LLM. Falls back to None on
        #    any failure.
        prompt = (
            f"Org: {org_id}\n"
            f"Question: {question}\n"
            "Translate to a single SELECT statement."
        )
        raw = await _call_llm(
            prompt,
            agent="autonomous_nl_to_sql",
            slot=DEFAULT_LLM_SLOT,
            system_prompt=_NL_TO_SQL_SYSTEM_PROMPT,
            max_tokens=500,
        )
        sql_text: str | None = None
        if raw:
            parsed = _try_parse_json_object(raw)
            if isinstance(parsed, dict):
                s = parsed.get("sql")
                if isinstance(s, str) and s.strip():
                    sql_text = _validate_readonly_sql(s.strip())

        # 2. Heuristic fallback when LLM SQL is missing/unsafe.
        heuristic_used = False
        if not sql_text:
            sql_text = _heuristic_sql(question)
            heuristic_used = sql_text is not None
            if heuristic_used:
                assumptions.append(
                    "LLM SQL unavailable or rejected; used keyword "
                    "heuristic against Postgres aggregates."
                )

        # 3. Run the SQL. Best-effort.
        rows: list[dict[str, Any]] = []
        sql_used: str | None = sql_text
        if sql_text:
            try:
                from eden.storage.postgres import get_postgres_client

                client = await get_postgres_client()
                if client is not None:
                    rows = await client.fetch(sql_text, org_id)
            except Exception as exc:
                logger.debug(
                    "autonomous nl_query: postgres fetch failed: %s", exc
                )
                rows = []

        # 4. Summarise the result. Best-effort.
        result_preview = _truncate_for_prompt(rows, max_rows=5)
        summary_text = ""
        llm_used = False
        raw2 = await _call_llm(
            (
                f"Question: {question}\n"
                f"Result preview: {json.dumps(result_preview, default=str)}\n"
                "Write a 1-2 sentence answer."
            ),
            agent="autonomous_nl_summariser",
            slot=DEFAULT_LLM_SLOT,
            system_prompt=_NL_SUMMARY_SYSTEM_PROMPT,
            max_tokens=200,
        )
        if raw2:
            parsed2 = _try_parse_json_object(raw2)
            if isinstance(parsed2, dict):
                s = parsed2.get("summary")
                if isinstance(s, str) and s.strip():
                    summary_text = s.strip()
                    llm_used = True
        if not summary_text:
            if rows:
                summary_text = (
                    f"Returned {len(rows)} row(s) from Postgres for "
                    f"the question. See result for details."
                )
            else:
                summary_text = (
                    "I couldn't translate that question to SQL and "
                    "found no matching aggregate rows. Please rephrase "
                    "or use the EQL DSL."
                )

        query_id = _new_id("nlq")
        return _ok_envelope(
            self.name,
            {
                "query_id": query_id,
                "question": question,
                "result": rows[:50],
                "sql_used": sql_used,
                "summary": summary_text,
                "llm_used": llm_used,
                "heuristic_used": heuristic_used,
                "n_rows": len(rows),
                "data_source": "postgres",
                "assumptions": assumptions,
            },
        )


# ── 6. AutoDashboardBuilder ────────────────────────────────────────


class AutoDashboardBuilder:
    """Auto-generate a dashboard spec from an NL description.

    Emits a dashboard spec as JSON. When the LLM is
    unavailable, falls back to a deterministic panel layout
    seeded from Postgres judge / cost / incident aggregates
    so the route returns live data rather than 501.
    """

    name = "auto_dashboard"

    async def build(
        self,
        org_id: str,
        *,
        description: str,
    ) -> dict[str, Any]:
        if not description or not description.strip():
            return _not_implemented_envelope(
                self.name,
                "description is required and must be non-empty",
            )

        assumptions = [
            "Dashboard spec is generated in-memory; panels "
            "reference Postgres-backed metrics (judge_scores, "
            "usage_events, incident_clusters).",
        ]

        # 1. Spec via the LLM. Best-effort.
        raw = await _call_llm(
            description,
            agent="autonomous_dashboard",
            slot=DEFAULT_LLM_SLOT,
            system_prompt=_DASHBOARD_SYSTEM_PROMPT,
            max_tokens=500,
        )
        panels: list[dict[str, Any]] = []
        llm_used = False
        if raw:
            parsed = _try_parse_json_object(raw)
            if isinstance(parsed, dict):
                p = parsed.get("panels")
                if isinstance(p, list):
                    panels = [x for x in p if isinstance(x, dict)]
                    llm_used = bool(panels)

        # 2. Seed preview stats from Postgres so the portal
        #    has something concrete even without LLM panels.
        preview = await _dashboard_preview_stats(org_id)
        if not panels:
            panels = _heuristic_dashboard_panels(description, preview)
            assumptions.append(
                "LLM panel spec unavailable; used keyword heuristic "
                "panels seeded from Postgres aggregates."
            )

        dashboard_id = _new_id("dash")
        return _ok_envelope(
            self.name,
            {
                "dashboard_id": dashboard_id,
                "description": description,
                "spec": {"panels": panels},
                "preview": preview,
                "llm_used": llm_used,
                "data_source": "postgres",
                "assumptions": assumptions,
            },
        )


# ── 7. NLReportGenerator ───────────────────────────────────────────


class NLReportGenerator:
    """Auto-generate a report from a natural-language request.

    The v1.3 ship parses the NL request into a structured
    ``{period, focus, title}`` shape, then reuses the
    existing :class:`InvestigationAgent.report` to render the
    actual report. The NL→structured parse is a small LLM call;
    on failure we default to ``period="weekly"`` and an
    empty focus list.
    """

    name = "nl_report"

    async def generate(
        self,
        org_id: str,
        *,
        request: str,
    ) -> dict[str, Any]:
        if not request or not request.strip():
            return _not_implemented_envelope(
                self.name,
                "request is required and must be non-empty",
            )

        # 1. Parse the NL request into a structured shape.
        raw = await _call_llm(
            request,
            agent="autonomous_nl_report",
            slot=DEFAULT_LLM_SLOT,
            system_prompt=_NL_REPORT_SYSTEM_PROMPT,
            max_tokens=200,
        )
        period = "weekly"
        focus: list[str] = []
        title = request[:120]
        llm_used = False
        if raw:
            parsed = _try_parse_json_object(raw)
            if isinstance(parsed, dict):
                p = parsed.get("period")
                if isinstance(p, str) and p in ("weekly", "monthly", "incident"):
                    period = p
                f = parsed.get("focus")
                if isinstance(f, list):
                    focus = [
                        str(x) for x in f
                        if x in (
                            "judge_quality",
                            "cost",
                            "roi",
                            "incidents",
                            "recommendations",
                        )
                    ]
                t = parsed.get("title")
                if isinstance(t, str) and t.strip():
                    title = t.strip()[:120]
                llm_used = bool(period != "weekly" or focus or title != request[:120])

        # 2. Render the report via InvestigationAgent.report().
        from eden.autonomous.investigation import InvestigationAgent

        report = await InvestigationAgent().report(org_id, period=period)
        if report.get("status") != "ok":
            # Underlying report may return a validation envelope;
            # surface that as a live ok with empty payload rather
            # than pretending the NL surface is unimplemented.
            return _ok_envelope(
                self.name,
                {
                    "request": request,
                    "period": period,
                    "focus": focus,
                    "title": title,
                    "report_json": {},
                    "llm_used": llm_used,
                    "message": (
                        f"NL report parse succeeded but the underlying "
                        f"report generation failed: "
                        f"{report.get('message', 'unknown')}"
                    ),
                },
            )
        report_json = report["data"].get("report_json") or {}

        # 3. Stamp the focus + title on the persisted report.
        report_id = report["data"].get("report_id") or _new_id("rep")
        merged = dict(report_json)
        merged["nl_request"] = request
        merged["nl_focus"] = focus
        merged["nl_title"] = title
        merged["nl_llm_used"] = llm_used
        from datetime import datetime, timedelta

        period_end = datetime.now(UTC)
        window = (
            timedelta(days=30) if period == "monthly" else timedelta(days=7)
        )
        period_start = period_end - window
        await _upsert_report(
            org_id,
            report_id,
            period_start_iso=period_start.isoformat(),
            period_end_iso=period_end.isoformat(),
            report_json=_json_dumps(merged),
        )

        return _ok_envelope(
            self.name,
            {
                "report_id": report_id,
                "request": request,
                "period": period,
                "focus": focus,
                "title": title,
                "report_json": merged,
                "llm_used": llm_used,
            },
        )


# ── helpers ────────────────────────────────────────────────────────


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _try_parse_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort JSON-object parser (mirror of the
    investigation.py helper — kept local so the package
    boundary holds)."""
    if not text:
        return None
    candidate = text.strip()
    if candidate.startswith("```"):
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


# The read-only SQL allowlist. A real LLM can emit a wide
# range of read-only statements; the v1.3 ship enforces
# these guardrails so a hallucinated DROP/INSERT/etc.
# cannot run.
_FORBIDDEN_SQL_TOKENS: tuple[str, ...] = (
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "create",
    "grant",
    "revoke",
    "copy",
)


def _validate_readonly_sql(sql: str) -> str | None:
    """Return the SQL string if it looks safe to run, else
    ``None``. Enforces:

    * leading ``SELECT`` or ``WITH``
    * no forbidden write tokens (``INSERT``/``UPDATE``/...)
    * contains the parameterised ``org_id = $1`` filter
    """
    if not sql:
        return None
    s = sql.strip().rstrip(";").strip()
    lowered = s.lower()
    if not (
        lowered.startswith("select")
        or lowered.startswith("with")
    ):
        return None
    for token in _FORBIDDEN_SQL_TOKENS:
        # Match the token as a word boundary so ``updated_at``
        # (column name) does not trip on ``update``.
        if re.search(rf"\b{token}\b", lowered):
            return None
    if "org_id = $1" not in lowered and "org_id=$1" not in lowered:
        return None
    return s


def _heuristic_sql(question: str) -> str | None:
    """Keyword → canned read-only SQL against Postgres.

    Keeps the NL query surface live when the LLM is down.
    """
    q = (question or "").lower()
    if any(k in q for k in ("cost", "spend", "usage", "token")):
        return (
            "SELECT DATE(created_at) AS day, "
            "COALESCE(SUM(cost_usd), 0) AS cost_usd, "
            "COUNT(*) AS n "
            "FROM usage_events "
            "WHERE org_id = $1 "
            "AND created_at >= NOW() - INTERVAL '7 days' "
            "GROUP BY 1 ORDER BY 1 ASC"
        )
    if any(k in q for k in ("incident", "cluster", "outage")):
        return (
            "SELECT id AS cluster_id, severity, member_count, created_at "
            "FROM incident_clusters "
            "WHERE org_id = $1 "
            "ORDER BY created_at DESC LIMIT 20"
        )
    if any(k in q for k in ("drift", "psi", "shift")):
        return (
            "SELECT id, drift_type, severity, created_at "
            "FROM drift_alerts "
            "WHERE org_id = $1 "
            "ORDER BY created_at DESC LIMIT 20"
        )
    if any(k in q for k in ("trace", "latency", "error", "telemetry")):
        return (
            "SELECT DATE(created_at) AS day, COUNT(*) AS traces, "
            "AVG(latency_ms) AS avg_latency_ms "
            "FROM telemetry_events "
            "WHERE org_id = $1 "
            "AND created_at >= NOW() - INTERVAL '7 days' "
            "GROUP BY 1 ORDER BY 1 ASC"
        )
    # Default: judge-score trends — the most useful default.
    return (
        "SELECT judge_name, AVG(score) AS avg_score, COUNT(*) AS n "
        "FROM judge_scores "
        "WHERE org_id = $1 "
        "AND created_at >= NOW() - INTERVAL '7 days' "
        "GROUP BY judge_name ORDER BY judge_name ASC"
    )


async def _dashboard_preview_stats(org_id: str) -> dict[str, Any]:
    """Best-effort Postgres preview stats for dashboard seed."""
    out: dict[str, Any] = {
        "judge_avg": None,
        "trace_count_7d": 0,
        "cost_usd_7d": 0.0,
        "incident_count_7d": 0,
    }
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return out
        row = await client.fetchrow(
            "SELECT AVG(score) AS avg_score FROM judge_scores "
            "WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
            org_id,
        )
        if row and row.get("avg_score") is not None:
            out["judge_avg"] = float(row["avg_score"])
        row = await client.fetchrow(
            "SELECT COUNT(*) AS n FROM telemetry_events "
            "WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
            org_id,
        )
        if row:
            out["trace_count_7d"] = int(row.get("n") or 0)
        row = await client.fetchrow(
            "SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage_events "
            "WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
            org_id,
        )
        if row:
            out["cost_usd_7d"] = float(row.get("cost") or 0.0)
        row = await client.fetchrow(
            "SELECT COUNT(*) AS n FROM incident_clusters "
            "WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
            org_id,
        )
        if row:
            out["incident_count_7d"] = int(row.get("n") or 0)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomous dashboard preview failed: %s", exc)
    return out


def _heuristic_dashboard_panels(
    description: str, preview: dict[str, Any]
) -> list[dict[str, Any]]:
    """Deterministic panels when the LLM is unavailable."""
    q = (description or "").lower()
    panels: list[dict[str, Any]] = [
        {
            "type": "stat",
            "metric": "trace_count",
            "group_by": None,
            "window": "7d",
            "title": "Total traces (last 7 days)",
            "value": preview.get("trace_count_7d"),
        },
        {
            "type": "line_chart",
            "metric": "judge_score_avg",
            "group_by": "judge_name",
            "window": "7d",
            "title": "Judge quality (last 7 days)",
            "value": preview.get("judge_avg"),
        },
    ]
    if any(k in q for k in ("cost", "spend", "budget")):
        panels.append(
            {
                "type": "stat",
                "metric": "cost_usd",
                "group_by": None,
                "window": "7d",
                "title": "LLM cost (last 7 days)",
                "value": preview.get("cost_usd_7d"),
            }
        )
    if any(k in q for k in ("incident", "outage", "alert")):
        panels.append(
            {
                "type": "table",
                "metric": "incidents",
                "group_by": "severity",
                "window": "7d",
                "title": "Recent incidents",
                "value": preview.get("incident_count_7d"),
            }
        )
    return panels[:5]


def _truncate_for_prompt(
    rows: list[dict[str, Any]], *, max_rows: int = 5
) -> list[dict[str, Any]]:
    """Trim a result set down to ``max_rows`` rows for the
    summariser prompt. Each row is a plain dict; we drop
    keys whose value is non-JSON-serialisable."""
    out: list[dict[str, Any]] = []
    for r in rows[:max_rows]:
        if not isinstance(r, dict):
            continue
        out.append(
            {
                k: (v if isinstance(v, (str, int, float, bool, type(None))) else str(v))
                for k, v in r.items()
            }
        )
    return out


__all__ = [
    "AutoDashboardBuilder",
    "NLQueryEngine",
    "NLReportGenerator",
    "_validate_readonly_sql",
    "_truncate_for_prompt",
]
