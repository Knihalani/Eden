"""Natural Language Interface (Cat 14 — Braintrust Loop AI / Phoenix
Alyx / LangSmith Polly parity).

Three services:
* ``NLQueryEngine`` — NL queries over production observability data.
* ``AutoDashboardBuilder`` — auto-generate dashboard from NL.
* ``NLReportGenerator`` — auto-generate report from NL.

A real implementation translates the question to a structured
query (e.g. against ClickHouse / Postgres) and runs it; the v1.3
ship is single-shot and falls back to a graceful "I couldn't
translate that" envelope when the LLM produces invalid SQL.

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


# ponytail: NLQueryEngine removed per upgradespec §D.4.
# The deep-linked route returns a stable 501 envelope via
# ``intelligence_autonomous.py::_deferred``.

# ── 6. AutoDashboardBuilder ────────────────────────────────────────


class NLReportGenerator:
    """Auto-generate a report from a natural-language request.

    The v1.3 ship parses the NL request into a structured
    ``{period, focus, title}`` shape, then reuses the
    existing :class:`ReportGenerator` to render the actual
    report. The NL→structured parse is a small LLM call;
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

        # 2. Render the report via the InvestigationAgent.report()
        #    method (ReportGenerator was folded into the agent
        #    per upgradespec §D.4).
        from eden.autonomous.investigation import InvestigationAgent

        report = await InvestigationAgent().report(org_id, period=period)
        if report.get("status") != "ok":
            return _not_implemented_envelope(
                self.name,
                (
                    f"NL report parse succeeded but the underlying "
                    f"report generation failed: {report.get('message', 'unknown')}"
                ),
            )
        report_json = report["data"].get("report_json") or {}

        # 3. Stamp the focus + title on the persisted report
        #    by re-upserting with a merged JSON. The
        #    ReportGenerator already wrote a row; we update
        #    the same row to include the NL metadata so the
        #    audit log reflects the NL→structured path.
        report_id = report["data"].get("report_id") or _new_id("rep")
        merged = dict(report_json)
        merged["nl_request"] = request
        merged["nl_focus"] = focus
        merged["nl_title"] = title
        merged["nl_llm_used"] = llm_used
        from datetime import datetime

        period_end = datetime.now(UTC)
        try:
            from datetime import timedelta

            window = (
                timedelta(days=30) if period == "monthly" else timedelta(days=7)
            )
        except Exception:
            window = timedelta(days=7)
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
    "NLReportGenerator",
    "_validate_readonly_sql",
    "_truncate_for_prompt",
]
