"""Phase C — unified AI agent (Cat 14 real, global panel backend).

The headline surface of the new portal: one agent, accessible from
any page via Cmd-J, capable of answering questions about traces,
incidents, costs, judges, drift, satisfaction, and guardrails via
14 registered tools. Uses the ModelRouter T3 tier
(``x-ai/grok-4.5`` primary, with ``minimax/minimax-m3``
and ``xiaomi/mimo-v2.5-pro`` fallback — per
``src/eden/optimization/model_router.py``).

Architecture
─────────────

  ┌─────────────────────────────────────────────────────────────────┐
  │  Portal (Cmd-J panel)                                           │
  │     │                                                           │
  │     │  POST /orgs/{org}/ai/chat   (SSE)                         │
  │     ▼                                                           │
  │  ChatService                                                     │
  │     ├─ System prompt + page context + tool list                 │
  │     ├─ OpenRouterClient (T3 tier: x-ai/grok-4.5)                │
  │     ├─ ReAct loop (max 10 turns)                                │
  │     ├─ Tool registry → 14 tools                                 │
  │     ├─ Chart spec emitter (line/bar/pie/scatter/                │
  │     │                     table/heatmap/sankey)                │
  │     └─ Citation emitter (span / trace / incident / agent)      │
  │     │                                                           │
  │     ▼                                                           │
  │  Postgres (ai_conversations + ai_messages)                      │
  └─────────────────────────────────────────────────────────────────┘

Tools (see ``_TOOL_SPECS`` below for full JSON schemas):

  Data access
    1. ``search_spans``         — Phase B full-text search
    2. ``get_trace_tree``       — span tree for one trace
    3. ``get_trace_messages``   — Phase A reconstructed messages
    4. ``query_sql``            — Cat 18 columnar / Postgres-fallback
  Intelligence (each backed by a Cat service)
    5. ``get_cost_summary``     — Cat 8 cost intelligence
    6. ``list_incidents``       — Cat 2 incident clusters
    7. ``get_drift_alerts``     — Cat 13 PSI + CUSUM drift
    8. ``get_user_satisfaction``— Cat 9 hierarchical Beta-Binomial
    9. ``list_guardrail_violations`` — Cat 10 governance
   10. ``get_eval_results``     — Cat 3 evaluation quality
   11. ``get_outcomes``         — Cat 11 outcome / ROI rollup
  Actions (admin-gated)
   12. ``mark_incident_resolved`` — Cat 2 status mutation
  Cat 23 (PR creation)
   13. ``create_pr_suggestion`` — trigger → diff proposal (read-only)
   14. ``open_pr_suggestion``   — materialise suggestion as PR (admin)

Chart specs are emitted as structured JSON the portal renders with
Recharts. The agent picks the chart type that best conveys the
insight (e.g. "show me p95 latency over the last hour" → line chart).

Citations are clickable refs into spans/traces/incidents/agents —
the agent cites the IDs it used to ground each answer.

Per-org isolation is enforced at the tool layer (every tool takes
``tenant_id`` and uses it in SQL/filter expressions). The ChatService
also accepts a ``user_id`` so per-user conversation visibility works
naturally.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


# ────────────────────────────────────────────────────────────────────
# Schemas
# ────────────────────────────────────────────────────────────────────


@dataclass
class ChartSpec:
    """A single chart the agent emits.

    The portal renders this inline with Recharts. ``type`` picks the
    chart renderer; the other fields are renderer-specific but the
    common shape is ``{x_key, y_key, data: [{...rows...}]}``.
    """

    type: str  # "line" | "bar" | "pie" | "scatter" | "table" | "heatmap" | "sankey"
    title: str
    data: list[dict[str, Any]] = field(default_factory=list)
    x_key: str = ""
    y_key: str = ""
    y2_key: str = ""  # optional second series (e.g. cost overlay)
    group_key: str = ""  # for grouped bar / multi-line
    # Heatmap-specific
    row_key: str = ""
    col_key: str = ""
    value_key: str = ""
    # Sankey-specific
    source_key: str = ""
    target_key: str = ""
    # Table-specific
    columns: list[str] = field(default_factory=list)
    # Common
    unit: str = ""  # "ms" | "$" | "%" | "" — appended to axis labels

    def to_dict(self) -> dict[str, Any]:
        d = {
            "type": self.type,
            "title": self.title,
            "data": list(self.data),
            "unit": self.unit,
        }
        if self.type in ("line", "bar", "scatter"):
            d["x_key"] = self.x_key
            d["y_key"] = self.y_key
            if self.y2_key:
                d["y2_key"] = self.y2_key
            if self.group_key:
                d["group_key"] = self.group_key
        elif self.type == "pie":
            d["label_key"] = self.x_key or "label"
            d["value_key"] = self.y_key or "value"
        elif self.type == "heatmap":
            d["row_key"] = self.row_key
            d["col_key"] = self.col_key
            d["value_key"] = self.value_key
        elif self.type == "sankey":
            d["source_key"] = self.source_key
            d["target_key"] = self.target_key
            d["value_key"] = self.value_key
        elif self.type == "table":
            d["columns"] = self.columns or list(self.data[0].keys()) if self.data else []
        return d


@dataclass
class Citation:
    """A clickable reference the agent emits.

    The portal renders each citation as a chip with a label and a
    click target that navigates to the referenced entity (e.g. a
    span → trace view; an incident → incident detail page).
    """

    kind: str  # "span" | "trace" | "incident" | "agent" | "message" | "tool"
    id: str
    label: str
    excerpt: str = ""
    # For spans: trace_id so the chip can link to the right trace.
    trace_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "id": self.id,
            "label": self.label,
            "excerpt": self.excerpt,
            "trace_id": self.trace_id,
        }


@dataclass
class ToolCall:
    """One tool invocation the model requested."""

    name: str
    args: dict[str, Any] = field(default_factory=dict)
    result: Any = None
    error: str = ""
    latency_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "args": dict(self.args),
            "result": self.result,
            "error": self.error,
            "latency_ms": self.latency_ms,
        }


@dataclass
class AgentChunk:
    """One streaming event the ChatService emits to the portal.

    Tagged-union shape (the ``type`` field picks the variant). The
    portal accumulates ``text_delta`` chunks into the assistant
    message, then renders ``chart``, ``citation``, ``tool_call``,
    ``tool_result`` events inline as they arrive.
    """

    type: str  # "text_delta" | "tool_call" | "tool_result" | "chart" | "citation" | "done" | "error" | "cost" | "meta"
    text: str = ""
    chart: ChartSpec | None = None
    citation: Citation | None = None
    tool_call: ToolCall | None = None
    error: str = ""
    cost_usd: float = 0.0
    turn_cost_usd: float = 0.0
    meta: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        d = {"type": self.type}
        if self.text:
            d["text"] = self.text
        if self.chart:
            d["chart"] = self.chart.to_dict()
        if self.citation:
            d["citation"] = self.citation.to_dict()
        if self.tool_call:
            d["tool_call"] = self.tool_call.to_dict()
        if self.error:
            d["error"] = self.error
            d["message"] = self.error
        if self.type == "cost" or self.cost_usd or self.turn_cost_usd:
            d["cost_usd"] = self.cost_usd
            d["turn_cost_usd"] = self.turn_cost_usd
        if self.meta:
            d.update(self.meta)
            d["meta"] = self.meta
        return d


# ────────────────────────────────────────────────────────────────────
# Tool registry
# ────────────────────────────────────────────────────────────────────


#: JSON-schema-ish description of each tool's args. The portal
#: can use these to render a "what tools does the agent have?" panel
#: in the settings page.
_TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "search_spans",
        "summary": "Full-text search across every span (Laminar parity).",
        "args": {
            "query": {"type": "string", "required": True,
                       "description": "Text to search for across input/output/tool names."},
            "agent_id": {"type": "string", "required": False},
            "tool": {"type": "string", "required": False},
            "outcome": {"type": "string", "required": False,
                         "enum": ["success", "failure", "partial", "timeout", "crash"]},
            "from_ts": {"type": "integer", "required": False,
                         "description": "Lower bound, epoch seconds."},
            "to_ts": {"type": "integer", "required": False},
            "per_page": {"type": "integer", "required": False, "default": 20},
        },
    },
    {
        "name": "get_trace_tree",
        "summary": "Hierarchical span tree for one trace (Cat 1).",
        "args": {
            "trace_id": {"type": "string", "required": True},
        },
    },
    {
        "name": "get_trace_messages",
        "summary": "Reconstruct LLM messages for a trace via content-addressed dedup (Phase A).",
        "args": {
            "trace_id": {"type": "string", "required": True},
            "limit": {"type": "integer", "required": False, "default": 50},
        },
    },
    {
        "name": "query_sql",
        "summary": "Run a SQL query against the columnar engine (Cat 18) with Postgres fallback.",
        "args": {
            "sql": {"type": "string", "required": True,
                     "description": "Read-only SELECT. DROP/DELETE/INSERT/UPDATE rejected."},
        },
    },
    {
        "name": "get_cost_summary",
        "summary": "Per-agent / per-day cost breakdown (Cat 8).",
        "args": {
            "days": {"type": "integer", "required": False, "default": 7},
            "agent_id": {"type": "string", "required": False},
        },
    },
    {
        "name": "list_incidents",
        "summary": "Open / resolved incident clusters (Cat 2).",
        "args": {
            "status": {"type": "string", "required": False,
                        "enum": ["open", "resolved", "all"], "default": "open"},
            "limit": {"type": "integer", "required": False, "default": 20},
        },
    },
    {
        "name": "get_drift_alerts",
        "summary": "Judge-score PSI drift + embedding-histogram drift (Cat 13).",
        "args": {
            "days": {"type": "integer", "required": False, "default": 7},
            "severity": {"type": "string", "required": False,
                          "enum": ["low", "medium", "high"], "default": "all"},
        },
    },
    {
        "name": "get_user_satisfaction",
        "summary": "Coverage-weighted satisfaction via hierarchical Beta-Binomial (Cat 9).",
        "args": {
            "days": {"type": "integer", "required": False, "default": 30},
        },
    },
    {
        "name": "list_guardrail_violations",
        "summary": "PII / secret / toxic violations from runtime guardrails (Cat 10).",
        "args": {
            "days": {"type": "integer", "required": False, "default": 7},
            "severity": {"type": "string", "required": False,
                          "enum": ["low", "medium", "high", "critical"], "default": "all"},
        },
    },
    {
        "name": "get_eval_results",
        "summary": "Recent judge scores per trace / dataset (Cat 3).",
        "args": {
            "trace_id": {"type": "string", "required": False},
            "judge_id": {"type": "string", "required": False},
            "limit": {"type": "integer", "required": False, "default": 20},
        },
    },
    {
        "name": "get_outcomes",
        "summary": "Per-department ROI + outcome rollup (Cat 11).",
        "args": {
            "days": {"type": "integer", "required": False, "default": 30},
            "department": {"type": "string", "required": False},
        },
    },
    {
        "name": "mark_incident_resolved",
        "summary": "Mark an incident cluster as resolved (admin only, Cat 2 action).",
        "args": {
            "cluster_id": {"type": "string", "required": True},
            "note": {"type": "string", "required": False,
                      "description": "Resolution note for the audit log."},
        },
    },
    {
        "name": "create_pr_suggestion",
        "summary": (
            "Create a PR suggestion by analysing an observability trigger "
            "(Cat 23). Returns the suggestion_id the human reviews before "
            "the agent can call open_pr_suggestion to materialise it."
        ),
        "args": {
            "trigger": {
                "type": "string", "required": True,
                "enum": ["rca_cluster", "drift_alert", "retrieval_gap", "judge_regression"],
                "description": "The observability event kind driving the suggestion.",
            },
            "trigger_id": {
                "type": "string", "required": True,
                "description": "The source event id (cluster id, alert id, etc.).",
            },
            "description": {
                "type": "string", "required": False,
                "description": "Plain-English context for the agent — affected files, recent regressions, etc.",
            },
            "affected_files": {
                "type": "array", "required": False,
                "description": "List of file paths the suggestion should touch.",
            },
        },
    },
    {
        "name": "open_pr_suggestion",
        "summary": (
            "Materialise a previously-created PR suggestion as a real GitHub PR. "
            "ADMIN ONLY — this calls the PR provider and mutates the remote repo."
        ),
        "args": {
            "suggestion_id": {
                "type": "string", "required": True,
                "description": "The suggestion_id returned by create_pr_suggestion.",
            },
            "pr_title": {"type": "string", "required": False},
            "pr_body": {"type": "string", "required": False},
            "branch": {"type": "string", "required": False,
                        "description": "Override branch name (default: eden/auto-<id>)."},
            "base": {"type": "string", "required": False, "default": "main"},
            "labels": {"type": "array", "required": False},
            "draft": {"type": "boolean", "required": False, "default": False},
        },
    },
]


def tool_specs() -> list[dict[str, Any]]:
    """Return the public tool catalog for the portal."""
    return list(_TOOL_SPECS)


def _tools_for_prompt() -> str:
    """Render the tool list as a system-prompt-friendly summary."""
    lines: list[str] = []
    for spec in _TOOL_SPECS:
        args_str = ", ".join(
            f"{k}: {v['type']}" + ("" if v.get("required") else "?")
            for k, v in spec["args"].items()
        )
        lines.append(f"- {spec['name']}({args_str}) — {spec['summary']}")
    return "\n".join(lines)


# ────────────────────────────────────────────────────────────────────
# Tool implementations
# ────────────────────────────────────────────────────────────────────


async def _tool_search_spans(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.observability.search_service import get_search_service

    service = get_search_service()
    resp = await service.search(
        tenant_id=tenant_id,
        query=args.get("query", ""),
        agent_id=args.get("agent_id"),
        tool=args.get("tool"),
        outcome=args.get("outcome"),
        from_ts=args.get("from_ts"),
        to_ts=args.get("to_ts"),
        per_page=int(args.get("per_page") or 20),
    )
    return {
        "hits": [h.to_dict() for h in resp.hits],
        "total": resp.total,
        "facet_counts": resp.facet_counts,
        "took_ms": resp.took_ms,
    }


async def _tool_get_trace_tree(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.observability.telemetry_collector import get_telemetry_collector

    trace_id = args["trace_id"]
    collector = await get_telemetry_collector()
    tree = await collector.get_trace_tree(tenant_id, trace_id)
    if tree is None:
        return {"error": f"trace {trace_id} not found", "trace_id": trace_id}
    return {
        "trace_id": tree.trace_id,
        "span_count": tree.span_count,
        "total_duration_ms": tree.total_duration_ms,
        "outcome": tree.outcome,
        "root_spans": tree.root_spans,
        "span_map": tree.span_map,
    }


async def _tool_get_trace_messages(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Reconstruct all messages across all LLM spans for a trace.

    Uses Phase A's MessageStore via dedup; falls back to JSONB
    for pre-migration rows.
    """
    from eden.observability.message_store import get_message_store
    from eden.observability.telemetry_collector import get_telemetry_collector

    trace_id = args["trace_id"]
    limit = int(args.get("limit") or 50)
    get_message_store()
    collector = await get_telemetry_collector()
    tree = await collector.get_trace_tree(tenant_id, trace_id)
    if tree is None:
        return {"error": f"trace {trace_id} not found", "trace_id": trace_id}

    out: list[dict[str, Any]] = []
    # Walk spans in chronological order; reconstruct via dedup.
    for span_id, span in sorted(
        tree.span_map.items(),
        key=lambda kv: kv[1].get("timestamp") or "",
    ):
        rb = span.get("request_body") or {}
        for msg in rb.get("messages") or []:
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and isinstance(b.get("text"), str)
                )
            out.append({
                "span_id": span_id,
                "role": msg.get("role"),
                "content": content if isinstance(content, str) else str(content),
            })
            if len(out) >= limit:
                return {"messages": out, "count": len(out)}
    return {"messages": out, "count": len(out)}


async def _tool_query_sql(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Hardened read-only SQL via Cat 18 columnar (W22).

    Rejects writes, multi-statements, and common DDL/DML keywords.
    Returns ``spend_preview``; complex queries require ``confirm_spend``.
    """
    from eden.columnar.query import ColumnarQueryEngine

    sql = (args.get("sql") or "").strip()
    if not sql:
        return {"error": "sql is required"}
    if ";" in sql.rstrip(";"):
        return {"error": "multiple SQL statements are not allowed"}
    sql = sql.rstrip(";").strip()
    head = sql.split(None, 1)[0].upper() if sql else ""
    if head not in ("SELECT", "WITH"):
        return {"error": f"only SELECT/WITH queries are allowed, got {head!r}"}
    banned = (
        " INSERT ", " UPDATE ", " DELETE ", " DROP ", " ALTER ",
        " CREATE ", " GRANT ", " REVOKE ", " TRUNCATE ", " COPY ",
        " EXECUTE ", " CALL ",
    )
    padded = f" {sql.upper()} "
    for token in banned:
        if token in padded:
            return {"error": f"forbidden SQL keyword:{token.strip()}"}

    upper = sql.upper()
    complexity = 1 + sum(
        1 for frag in (" JOIN ", " GROUP BY ", " ORDER BY ") if frag in upper
    )
    estimated_usd = round(0.002 * complexity, 4)
    spend_preview = {
        "estimated_usd": estimated_usd,
        "complexity": complexity,
        "message": (
            f"Estimated query cost ~${estimated_usd:.4f} "
            f"(complexity={complexity}). Read-only; org-scoped."
        ),
    }
    if estimated_usd >= 0.01 and not bool(args.get("confirm_spend")):
        return {
            "approval_required": True,
            "spend_preview": spend_preview,
            "tool": "query_sql",
            "args": {"sql": sql, "confirm_spend": True},
            "message": (
                f"Query spend preview ~${estimated_usd:.4f}. Confirm to run."
            ),
        }

    engine = ColumnarQueryEngine()
    try:
        rows = await engine.execute(sql, params={"org_id": tenant_id})
        rows = rows[:500]
        return {
            "rows": rows,
            "row_count": len(rows),
            "spend_preview": spend_preview,
        }
    except Exception as exc:
        return {"error": str(exc), "spend_preview": spend_preview}


async def _tool_get_cost_summary(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Per-agent / per-day cost summary from usage_events.

    SQL safety: every user-controlled value is passed as a bound
    parameter via ``client.fetch(sql, *params)`` — never interpolated
    into the SQL string. The two branches below are two distinct
    parameterised queries (no f-string composition of SQL).
    """
    days = int(args.get("days") or 7)
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    try:
        agent_id = args.get("agent_id")
        if agent_id:
            rows = await client.fetch(
                """
                SELECT
                    COALESCE(agent_id, 'unknown') AS agent_id,
                    DATE_TRUNC('day', ts) AS day,
                    SUM(cost_usd) AS cost_usd,
                    COUNT(*) AS call_count,
                    SUM(prompt_tokens) AS prompt_tokens,
                    SUM(completion_tokens) AS completion_tokens
                FROM usage_events
                WHERE org_id = $1
                  AND ts > NOW() - ($2 || ' days')::interval
                  AND agent_id = $3
                GROUP BY 1, 2
                ORDER BY 2 DESC, 1
                LIMIT 1000
                """,
                tenant_id, days, agent_id,
            )
        else:
            rows = await client.fetch(
                """
                SELECT
                    COALESCE(agent_id, 'unknown') AS agent_id,
                    DATE_TRUNC('day', ts) AS day,
                    SUM(cost_usd) AS cost_usd,
                    COUNT(*) AS call_count,
                    SUM(prompt_tokens) AS prompt_tokens,
                    SUM(completion_tokens) AS completion_tokens
                FROM usage_events
                WHERE org_id = $1
                  AND ts > NOW() - ($2 || ' days')::interval
                GROUP BY 1, 2
                ORDER BY 2 DESC, 1
                LIMIT 1000
                """,
                tenant_id, days,
            )
        return {
            "rows": [dict(r) for r in rows],
            "days": days,
        }
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_list_incidents(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    status = args.get("status") or "open"
    limit = int(args.get("limit") or 20)
    try:
        if status == "all":
            rows = await client.fetch(
                """
                SELECT cluster_id, severity, title, status, count, first_seen,
                       last_seen, sample_trace_id, summary
                FROM incidents
                WHERE org_id = $1
                ORDER BY last_seen DESC NULLS LAST
                LIMIT $2
                """,
                tenant_id, limit,
            )
        else:
            rows = await client.fetch(
                """
                SELECT cluster_id, severity, title, status, count, first_seen,
                       last_seen, sample_trace_id, summary
                FROM incidents
                WHERE org_id = $1 AND status = $2
                ORDER BY last_seen DESC NULLS LAST
                LIMIT $3
                """,
                tenant_id, status, limit,
            )
        return {"rows": [dict(r) for r in rows], "count": len(rows)}
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_get_drift_alerts(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    days = int(args.get("days") or 7)
    severity = args.get("severity") or "all"
    try:
        if severity == "all":
            rows = await client.fetch(
                """
                SELECT id, drift_type, severity, agent_id, created_at,
                       baseline_mean, current_mean, psi_score
                FROM drift_alerts
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' days')::interval
                ORDER BY created_at DESC
                LIMIT 100
                """,
                tenant_id, days,
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, drift_type, severity, agent_id, created_at,
                       baseline_mean, current_mean, psi_score
                FROM drift_alerts
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' days')::interval
                  AND severity = $3
                ORDER BY created_at DESC
                LIMIT 100
                """,
                tenant_id, days, severity,
            )
        return {"rows": [dict(r) for r in rows], "count": len(rows)}
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_get_user_satisfaction(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    days = int(args.get("days") or 30)
    try:
        rows = await client.fetch(
            """
            SELECT
                DATE_TRUNC('day', created_at) AS day,
                AVG(beta_corrected_score) AS avg_score,
                COUNT(*) AS sample_count,
                SUM(weight) AS total_weight
            FROM user_satisfaction_corrected
            WHERE org_id = $1
              AND created_at > NOW() - ($2 || ' days')::interval
            GROUP BY 1
            ORDER BY 1
            """,
            tenant_id, days,
        )
        return {"rows": [dict(r) for r in rows], "days": days}
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_list_guardrail_violations(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    days = int(args.get("days") or 7)
    severity = args.get("severity") or "all"
    try:
        if severity == "all":
            rows = await client.fetch(
                """
                SELECT id, scanner, severity, created_at, span_id,
                       matched_text, action
                FROM governance_pii_scans
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' days')::interval
                ORDER BY created_at DESC
                LIMIT 100
                """,
                tenant_id, days,
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, scanner, severity, created_at, span_id,
                       matched_text, action
                FROM governance_pii_scans
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' days')::interval
                  AND severity = $3
                ORDER BY created_at DESC
                LIMIT 100
                """,
                tenant_id, days, severity,
            )
        return {"rows": [dict(r) for r in rows], "count": len(rows)}
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_get_eval_results(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    limit = int(args.get("limit") or 20)
    trace_id = args.get("trace_id")
    judge_id = args.get("judge_id")
    try:
        # Four distinct parameterised queries — no SQL composition.
        if trace_id and judge_id:
            rows = await client.fetch(
                """
                SELECT id, trace_id, judge_id, score, label, created_at, notes
                FROM judge_scores
                WHERE org_id = $1 AND trace_id = $2 AND judge_id = $3
                ORDER BY created_at DESC
                LIMIT $4
                """,
                tenant_id, trace_id, judge_id, limit,
            )
        elif trace_id:
            rows = await client.fetch(
                """
                SELECT id, trace_id, judge_id, score, label, created_at, notes
                FROM judge_scores
                WHERE org_id = $1 AND trace_id = $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                tenant_id, trace_id, limit,
            )
        elif judge_id:
            rows = await client.fetch(
                """
                SELECT id, trace_id, judge_id, score, label, created_at, notes
                FROM judge_scores
                WHERE org_id = $1 AND judge_id = $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                tenant_id, judge_id, limit,
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, trace_id, judge_id, score, label, created_at, notes
                FROM judge_scores
                WHERE org_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                tenant_id, limit,
            )
        return {"rows": [dict(r) for r in rows], "count": len(rows)}
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_get_outcomes(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    days = int(args.get("days") or 30)
    department = args.get("department")
    try:
        if department:
            rows = await client.fetch(
                """
                SELECT department,
                       SUM(cost_usd) AS cost_usd,
                       SUM(revenue_usd) AS revenue_usd,
                       COUNT(*) AS outcome_count
                FROM outcomes
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' days')::interval
                  AND department = $3
                GROUP BY 1
                ORDER BY 2 DESC
                """,
                tenant_id, days, department,
            )
        else:
            rows = await client.fetch(
                """
                SELECT department,
                       SUM(cost_usd) AS cost_usd,
                       SUM(revenue_usd) AS revenue_usd,
                       COUNT(*) AS outcome_count
                FROM outcomes
                WHERE org_id = $1
                  AND created_at > NOW() - ($2 || ' days')::interval
                GROUP BY 1
                ORDER BY 2 DESC
                """,
                tenant_id, days,
            )
        return {"rows": [dict(r) for r in rows], "days": days}
    except Exception as exc:
        return {"error": str(exc)}


async def _tool_mark_incident_resolved(tenant_id: str, args: dict[str, Any],
                                         *, user_role: str) -> dict[str, Any]:
    if user_role not in ("owner", "admin", "org_admin"):
        return {"error": "permission_denied: requires admin role"}
    from eden.storage.postgres import get_postgres_client

    cluster_id = args["cluster_id"]
    note = args.get("note") or ""
    client = await get_postgres_client()
    if client is None:
        return {"error": "postgres unavailable"}
    try:
        result = await client.execute(
            """
            UPDATE incidents
            SET status = 'resolved',
                resolved_at = NOW(),
                resolution_note = $3
            WHERE org_id = $1 AND cluster_id = $2
            """,
            tenant_id, cluster_id, note,
        )
        return {"cluster_id": cluster_id, "status": "resolved", "raw": str(result)}
    except Exception as exc:
        return {"error": str(exc)}


# ── Phase 3a (2026-06-23) — Cat 23 PR-suggestion tools ─────────────
#
# These bridge the agent to :class:`eden.agent.PRSuggester` so the
# user can stay in the Cmd-J panel for the full create → review →
# open-PR loop instead of dropping into a separate UI. The suggest
# step is read-only + safe for any role; the open-PR step is gated
# to admin because it mutates the remote repo via the configured
# :class:`eden.providers.pr.PRProvider`.


async def _tool_create_pr_suggestion(tenant_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Read-only: build a PR suggestion from an observability trigger."""
    try:
        from eden.agent import PRSuggester
    except Exception as exc:
        return {"error": f"PRSuggester unavailable: {exc}"}

    trigger = str(args.get("trigger") or "")
    trigger_id = str(args.get("trigger_id") or "")
    if not trigger or not trigger_id:
        return {"error": "trigger and trigger_id are required"}
    if trigger not in ("rca_cluster", "drift_alert", "retrieval_gap", "judge_regression"):
        return {
            "error": (
                f"unknown trigger {trigger!r}; expected one of: "
                "rca_cluster, drift_alert, retrieval_gap, judge_regression"
            )
        }

    payload: dict[str, Any] = {}
    if args.get("description"):
        payload["description"] = args["description"]
    if args.get("affected_files"):
        payload["affected_files"] = list(args["affected_files"])

    try:
        suggester = PRSuggester()
        suggestion = await suggester.suggest(
            tenant_id,
            trigger=trigger,
            trigger_id=trigger_id,
            trigger_payload=payload,
        )
    except Exception as exc:
        return {"error": f"create_pr_suggestion failed: {exc}"}

    return {
        "suggestion_id": suggestion.id,
        "status": suggestion.status,
        "trigger": suggestion.trigger,
        "pr_title": suggestion.pr_title,
        "pr_body_excerpt": (suggestion.pr_body or "")[:500],
        "files": [f.path for f in suggestion.files],
        "blast_radius": suggestion.blast_radius,
        "confidence": suggestion.confidence,
        "created_at": (
            suggestion.created_at.isoformat()
            if hasattr(suggestion.created_at, "isoformat")
            else str(suggestion.created_at)
        ),
        "next_step": (
            "Review the suggestion in /pr-suggestions. When ready, "
            "call open_pr_suggestion(suggestion_id=...) — admin only."
        ),
    }


async def _tool_open_pr_suggestion(tenant_id: str, args: dict[str, Any],
                                     *, user_role: str) -> dict[str, Any]:
    """Destructive: materialise a suggestion as a real PR. Admin only."""
    if user_role not in ("owner", "admin", "org_admin"):
        return {"error": "permission_denied: open_pr_suggestion requires admin role"}

    suggestion_id = str(args.get("suggestion_id") or "")
    if not suggestion_id:
        return {"error": "suggestion_id is required"}

    try:
        from eden.agent import PRSuggester
        from eden.providers import (
            FileEntry,
            PRCreateRequest,
            get_default_pr_provider,
        )
    except Exception as exc:
        return {"error": f"PR tooling unavailable: {exc}"}

    try:
        suggester = PRSuggester()
        suggestion = await suggester.get_suggestion(tenant_id, suggestion_id)
    except Exception as exc:
        return {"error": f"get_suggestion failed: {exc}"}

    if suggestion is None:
        return {"error": f"suggestion {suggestion_id!r} not found"}
    if suggestion.status not in ("pending", "regenerated"):
        return {
            "error": (
                f"suggestion {suggestion_id!r} status is "
                f"{suggestion.status!r}; only 'pending'/'regenerated' "
                "suggestions can be opened"
            )
        }

    try:
        pr_provider = get_default_pr_provider()
        pr_req = PRCreateRequest(
            title=args.get("pr_title") or suggestion.pr_title,
            body=args.get("pr_body") or suggestion.pr_body,
            branch=args.get("branch") or f"eden/auto-{suggestion_id}",
            base=args.get("base") or "main",
            labels=list(args.get("labels") or []),
            reviewers=[],
            draft=bool(args.get("draft") or False),
            files=[
                FileEntry(path=f.path, size=f.size, content=f.content)
                for f in suggestion.files
            ],
            commit_message=(
                f"[Eden Agent] {suggestion.pr_title}\n\n"
                f"Trigger: {suggestion.trigger} {suggestion.trigger_id}\n"
                f"Suggestion: {suggestion.id}"
            ),
        )
        pr_info = await pr_provider.create_pr(pr_req)
    except NotImplementedError as exc:
        return {
            "error": (
                f"PR provider not configured for this org: {exc}. "
                "Set EDEN_PR_PROVIDER=local + EDEN_LOCAL_REPO_PATH, or "
                "configure the GitHub App env vars."
            )
        }
    except Exception as exc:
        return {"error": f"open_pr failed: {exc}"}

    try:
        await suggester.mark_opened(tenant_id, suggestion_id, pr_info.number)
    except Exception as exc:
        # Marking is best-effort; the PR was created so don't fail the call.
        logger.debug("mark_opened failed (PR still opened): %s", exc)

    return {
        "suggestion_id": suggestion_id,
        "pr_number": pr_info.number,
        "pr_title": pr_info.title,
        "pr_url": pr_info.url,
        "branch": pr_info.branch,
        "base": pr_info.base,
        "state": pr_info.state,
        "provider": type(pr_provider).__name__,
    }


# ────────────────────────────────────────────────────────────────────
# Tool dispatcher
# ────────────────────────────────────────────────────────────────────


#: Tools the agent can invoke. The ``requires_role`` field gates
#: write actions behind admin RBAC (enforced in the dispatcher).
_TOOL_REGISTRY: dict[str, dict[str, Any]] = {
    "search_spans": {"fn": _tool_search_spans, "requires_role": None},
    "get_trace_tree": {"fn": _tool_get_trace_tree, "requires_role": None},
    "get_trace_messages": {"fn": _tool_get_trace_messages, "requires_role": None},
    "query_sql": {"fn": _tool_query_sql, "requires_role": None},
    "get_cost_summary": {"fn": _tool_get_cost_summary, "requires_role": None},
    "list_incidents": {"fn": _tool_list_incidents, "requires_role": None},
    "get_drift_alerts": {"fn": _tool_get_drift_alerts, "requires_role": None},
    "get_user_satisfaction": {"fn": _tool_get_user_satisfaction, "requires_role": None},
    "list_guardrail_violations": {"fn": _tool_list_guardrail_violations, "requires_role": None},
    "get_eval_results": {"fn": _tool_get_eval_results, "requires_role": None},
    "get_outcomes": {"fn": _tool_get_outcomes, "requires_role": None},
    "mark_incident_resolved": {"fn": _tool_mark_incident_resolved,
                                "requires_role": "admin"},
    # Phase 3a (2026-06-23) — Cat 23 PR-suggestion tools. The agent
    # can now create + open PR suggestions without leaving the Cmd-J
    # panel. open_pr_suggestion is admin-gated because it mutates
    # the remote repo via the configured PRProvider.
    "create_pr_suggestion": {"fn": _tool_create_pr_suggestion,
                               "requires_role": None},
    "open_pr_suggestion": {"fn": _tool_open_pr_suggestion,
                            "requires_role": "admin"},
}

#: Write tools never auto-execute from the LLM loop. They return
#: ``approval_required`` so the portal ApprovalCard is the only
#: mutation path (W20). Call ``dispatch_tool(..., execute_approved=True)``
#: from the approve endpoint after RBAC + N06 audit.
_APPROVAL_GATED_TOOLS = frozenset({
    "mark_incident_resolved",
    "open_pr_suggestion",
    "create_alert_rule",
    "create_signal",
    "promote_artifact",
    # W23 evaluate mutations
    "create_dataset",
    "promote_trace_to_dataset",
    "create_experiment",
    "create_playground",
    "playground_from_span",
})

#: Spend-preview confirmations (not silent writes). Approve re-runs
#: with ``confirm_spend`` after the operator acknowledges cost.
_SPEND_CONFIRM_TOOLS = frozenset({
    "export_table",
    "query_sql",
    "run_analysis_template",
})

#: Insights write tools that inherit admin RBAC on merge.
_WRITE_INSIGHTS_TOOLS = frozenset({
    "create_alert_rule",
    "create_signal",
    "promote_artifact",
    "create_dataset",
    "promote_trace_to_dataset",
    "create_experiment",
    "create_playground",
    "playground_from_span",
})


async def dispatch_tool(
    name: str,
    args: dict[str, Any],
    *,
    tenant_id: str,
    user_role: str = "user",
    execute_approved: bool = False,
) -> ToolCall:
    """Run one tool and return a :class:`ToolCall` with the result.

    The dispatcher handles RBAC (admin-only tools reject non-admin
    callers with a clear error), approval gating for writes, and
    latency timing.
    """
    start = time.perf_counter()
    spec = _TOOL_REGISTRY.get(name)
    if spec is None:
        return ToolCall(name=name, args=args, error=f"unknown tool: {name}")
    if spec["requires_role"] and user_role not in ("owner", "admin", "org_admin"):
        return ToolCall(
            name=name, args=args,
            error=f"permission_denied: {spec['requires_role']} role required",
        )
    if name in _APPROVAL_GATED_TOOLS and not execute_approved:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        return ToolCall(
            name=name,
            args=args,
            result={
                "approval_required": True,
                "tool": name,
                "args": args,
                "message": "Confirmation required before this write runs.",
            },
            latency_ms=elapsed_ms,
        )
    try:
        # Some tools need user_role; pass it through kwargs.
        if spec["requires_role"]:
            result = await spec["fn"](tenant_id, args, user_role=user_role)
        else:
            result = await spec["fn"](tenant_id, args)
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        # Truncate huge results so a runaway query doesn't blow up the row.
        result_str = json.dumps(result, default=str)
        if len(result_str) > 50_000:
            result = {"_truncated": True, "_size_bytes": len(result_str),
                      "preview": result_str[:50_000]}
        return ToolCall(name=name, args=args, result=result,
                        latency_ms=elapsed_ms)
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        return ToolCall(name=name, args=args, error=str(exc),
                        latency_ms=elapsed_ms)


# ────────────────────────────────────────────────────────────────────
# System prompt
# ────────────────────────────────────────────────────────────────────


SYSTEM_PROMPT = """You are the Eden Agent — Capture → Analyse → Improve.

Capture: traces, spans, live agent runs.
Analyse: latency, cost, judge/eval scores, anomalies, drift.
Improve: agent issues, proposed patches / PR inbox, remediations.

Answer questions about traces, incidents, costs, judges, drift,
satisfaction, guardrails, issues, and patches via the tools below.
You are persistent: you can chain multiple tool calls to answer
compound questions ("which agent caused the cost spike last week,
and was it correlated with a judge-score regression?").

Communication style:
- Concise, technical, no filler. Code blocks for code.
- Cite-before-claim (W23): before asserting facts about a concrete
  trace/span/issue/agent/session id, emit a ```cite block for that id.
  Never name an entity id in prose without a matching citation chip.
- Always cite specific trace_ids, span_ids, agent_ids, issue_ids,
  patch_ids, or cluster_ids the user can click through to.
  Citations appear as chips in the UI.
- Prefer aggregate tools over dumping rows on open-ended questions.
- For dataset / experiment / playground mutations, call the write tool
  (create_dataset, create_experiment, create_playground, …) — the
  runtime surfaces ApprovalCard; never claim the write succeeded until
  the operator confirms.
- Call estimate_chat_cost before long multi-tool or export/SQL runs.
- When you produce structured data, also produce a chart spec so
  the user gets a visualization. Pick the chart type that conveys
  the insight:
    - line for time series
    - bar for comparisons across categories
    - pie for share-of-total breakdowns
    - scatter for two-dimensional correlations
    - heatmap for matrix-shaped data (e.g. cost per agent per day)
    - sankey for flow data (e.g. tool call chains)
    - table for raw tabular data when no chart fits
- Don't ask the user to clarify when the page context already
  provides the answer (pathname, current trace_id, filters). Use it.
- For write actions (mark_incident_resolved), confirm by stating
  the intent before invoking the tool — never silently mutate state.

Available tools:
{tools}

Page context (auto-attached by the frontend):
{page_context}

Output format:
- Plain markdown for prose.
- Emit chart specs by emitting a JSON block fenced with
  ```chart and ending with ``` — the runtime parses these
  out of your text and renders them inline. Schema:
  ```chart
  {{"type": "line|bar|pie|scatter|table|heatmap|sankey",
   "title": "...", "data": [...], "x_key": "...", "y_key": "..."}}
  ```
- Emit citations by emitting a JSON block fenced with ```cite:
  ```cite
  {{"kind": "span|trace|incident|agent", "id": "...", "label": "...",
   "trace_id": "...", "excerpt": "..."}}
  ```
- Tool calls happen automatically when you emit a JSON block
  fenced with ```tool — the runtime executes them and feeds
  results back into the conversation:
  ```tool
  {{"name": "tool_name", "args": {{...}}}}
  ```
"""


def _build_system_prompt(page_context: dict[str, Any]) -> str:
    return SYSTEM_PROMPT.format(
        tools=_tools_for_prompt(),
        page_context=json.dumps(page_context, default=str, indent=2),
    )


# ────────────────────────────────────────────────────────────────────
# ChatService — the agent loop
# ────────────────────────────────────────────────────────────────────


class ChatService:
    """Unified AI agent (Cat 14 real, global panel backend).

    Stateless w.r.t. model selection — picks the T3 tier model from
    :class:`ModelRouter` per call (cheap because the router is
    in-memory). Persists conversations + messages to Postgres.
    Streams :class:`AgentChunk` events back to the caller (the
    API layer turns them into SSE).
    """

    name = "chat_service"

    def __init__(self) -> None:
        self._settings = get_settings()
        self._max_turns = self._settings.ai_agent_max_turns

    async def _pick_model(
        self,
        *,
        user_message: str = "",
        preferred_model: str | None = None,
        preferred_tier: str = "auto",
    ) -> tuple[str, str]:
        """Pick model + tier (W23: T1/SLM vs T3 + operator picker).

        Returns ``(model_id, tier_key)`` where tier_key is t1|t2|t3.
        """
        from eden.llmops.chat_sota import (
            classify_chat_tier,
            model_for_tier,
            resolve_picker_model,
        )
        from eden.optimization.model_router import ModelTier

        explicit, tier_key = resolve_picker_model(
            preferred_model=preferred_model,
            preferred_tier=preferred_tier,
        )
        if explicit:
            return explicit, tier_key if tier_key != "auto" else "t3"

        mt = classify_chat_tier(user_message, preferred_tier=tier_key)
        if mt == ModelTier.T3 and self._settings.ai_agent_t3_model:
            return self._settings.ai_agent_t3_model, "t3"
        if mt == ModelTier.T1:
            return model_for_tier(ModelTier.T1), "t1"
        if mt == ModelTier.T2:
            return model_for_tier(ModelTier.T2), "t2"

        try:
            from eden.llm.internal_router import resolve_models

            _tier, models = await resolve_models(
                "chat_service",
                slot="reasoning",
                description="Multi-turn observability copilot with tools",
                output_type="json",
                requires_novelty=True,
            )
            if models:
                return models[0], "t3"
        except Exception:
            pass
        return model_for_tier(ModelTier.T3), "t3"

    async def _call_llm(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        stream: Callable[[str], Awaitable[None]],
    ) -> dict[str, Any]:
        """Call the LLM and stream text into ``stream``.

        Returns the full assistant message (text + tool_calls +
        charts + citations). Uses OpenRouterChatCompletions with
        function-calling-style JSON-block parsing.
        """
        from eden.llm.client import OpenRouterClient

        client = OpenRouterClient()
        # Anthropic prompt-cache: tag the system message with an
        # ephemeral ``cache_control`` breakpoint so Sonnet/Opus
        # re-bills the prefix at 1/10 cost on subsequent calls.
        # ~4k system-prompt tokens × N chats × 90% saving is the
        # single biggest line item in the agent budget.
        # Call on the instance — tests replace the class with a
        # mock lambda and the staticmethod resolves through the
        # instance attribute.
        is_anthropic = client._is_anthropic_model(model)
        system_msg: dict[str, Any] = {"role": "system", "content": system_prompt}
        if is_anthropic:
            system_msg = {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": system_prompt,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            }
        full_text = ""
        prompt_tokens = 0
        completion_tokens = 0
        ttft_ms: int | None = None
        t0 = time.perf_counter()
        try:
            # Streaming path — use the async client so the event
            # loop isn't blocked while a 60s Opus stream trickles
            # chunks back.
            response = await client.async_client.chat.completions.create(
                model=model,
                messages=[system_msg, *messages],
                max_tokens=4096,
                temperature=0.2,
                stream=True,
            )
            async for chunk in response:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                piece = getattr(delta, "content", None) or ""
                if piece:
                    if ttft_ms is None:
                        ttft_ms = int((time.perf_counter() - t0) * 1000)
                    full_text += piece
                    await stream(piece)
                usage = getattr(chunk, "usage", None)
                if usage:
                    prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
                    completion_tokens = getattr(usage, "completion_tokens", 0) or 0
        except Exception as exc:
            logger.warning(f"Streaming LLM call failed: {exc}; falling back to non-stream")
            # Non-streaming fallback — also async.
            resp = await client.async_client.chat.completions.create(
                model=model,
                messages=[system_msg, *messages],
                max_tokens=4096,
                temperature=0.2,
                stream=False,
            )
            full_text = resp.choices[0].message.content or ""
            if ttft_ms is None:
                ttft_ms = int((time.perf_counter() - t0) * 1000)
            await stream(full_text)
            usage = getattr(resp, "usage", None)
            if usage:
                prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
                completion_tokens = getattr(usage, "completion_tokens", 0) or 0

        # Parse the structured blocks out of the text.
        charts = _extract_blocks(full_text, "chart", _parse_chart)
        citations = _extract_blocks(full_text, "cite", _parse_citation)
        tool_blocks = _extract_blocks(full_text, "tool", _parse_tool_call)
        # Strip the structured blocks from the user-facing text so
        # the portal doesn't render them as raw markdown fences.
        display_text = _strip_blocks(full_text)

        return {
            "text": display_text,
            "raw_text": full_text,
            "tool_calls": tool_blocks,
            "charts": charts,
            "citations": citations,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "ttft_ms": ttft_ms,
            "cost_usd": float(getattr(usage, "cost", 0.0) or 0.0)
            if "usage" in locals() and usage is not None
            else 0.0,
        }

    async def stream_chat(
        self,
        *,
        tenant_id: str,
        user_id: str,
        conversation_id: str | None,
        user_message: str,
        page_context: dict[str, Any] | None,
        user_role: str = "user",
        emit: Callable[[AgentChunk], Awaitable[None]],
    ) -> dict[str, Any]:
        """Drive one user turn through the ReAct loop and stream events.

        Returns the persisted conversation summary (id, message_count,
        token totals). The portal calls this via SSE — every ``await
        emit(chunk)`` lands as one SSE event.
        """
        from eden.storage.postgres import get_postgres_client

        page_context = page_context or {}
        system_prompt = _build_system_prompt(page_context)

        # Resolve conversation (create if missing).
        client = await get_postgres_client()
        conv_id = await self._ensure_conversation(
            client, conversation_id, tenant_id, user_id, user_message,
        )
        # Persist the user message.
        await self._append_message(
            client, conv_id, role="user", content=user_message,
        )

        # Build the message history (last 20 turns to bound context).
        history = await self._load_history(client, conv_id, limit=20)
        preferred_model = page_context.get("preferred_model") or page_context.get(
            "model"
        )
        preferred_tier = str(
            page_context.get("preferred_tier")
            or page_context.get("tier")
            or "auto"
        )
        model, tier_key = await self._pick_model(
            user_message=user_message,
            preferred_model=str(preferred_model) if preferred_model else None,
            preferred_tier=preferred_tier,
        )
        from eden.llmops.chat_sota import (
            cite_before_claim,
            estimate_turn_cost_usd,
            ttft_budget_ms,
            ttft_warning,
        )

        cost_est = estimate_turn_cost_usd(model)
        await emit(
            AgentChunk(
                type="meta",
                meta={
                    "model": model,
                    "tier": tier_key,
                    "cost_estimate": cost_est,
                    "ttft_budget_ms": ttft_budget_ms(tier_key),
                    "session_spend_hint": True,
                },
            )
        )

        # ReAct loop: at most max_turns assistant messages, each
        # possibly followed by tool results.
        total_prompt_tokens = 0
        total_completion_tokens = 0
        total_cost_usd = 0.0
        # DL-15: load the org's hard-limit cap once at the start of
        # the turn. The budget gate fires after each LLM call — if
        # the running total exceeds the cap, we break the loop and
        # emit an error chunk so the user knows why the agent
        # stopped.
        try:
            from eden.services.budget_service import get_budget

            _budget = await get_budget(tenant_id)
        except Exception:
            _budget = {}
        _hard_limit = float(_budget.get("cost_hard_limit_usd", 0.0) or 0.0)
        # Preflight: refuse the turn when already over hard cap or feature killed.
        try:
            from eden.llmops.feature_kills import is_feature_enabled
            from eden.services.budget_service import get_consumption

            if not await is_feature_enabled(tenant_id, "chat_sidebar"):
                await emit(AgentChunk(
                    type="error",
                    error="ChatSidebar is disabled for this organization.",
                ))
                return {"conversation_id": str(conv_id), "turns": 0}
            _cons = await get_consumption(
                tenant_id, window=_budget.get("window", "monthly")
            )
            if (
                _hard_limit > 0
                and float(_cons.get("cost_usd") or 0) >= _hard_limit
                and bool(_budget.get("enforcement_enabled"))
            ):
                await emit(AgentChunk(
                    type="error",
                    error=(
                        f"Budget hard cap already reached "
                        f"(${float(_cons.get('cost_usd') or 0):.4f} / "
                        f"${_hard_limit:.4f})."
                    ),
                ))
                return {"conversation_id": str(conv_id), "turns": 0}
        except Exception as exc:
            logger.debug("ChatService: preflight budget check failed: %s", exc)

        turn = 0
        while turn < self._max_turns:
            turn += 1
            # ── LLM call (streams text deltas) ──
            llm_result: dict[str, Any] = {}
            async def _stream_text(piece: str) -> None:
                await emit(AgentChunk(type="text_delta", text=piece))

            try:
                llm_result = await self._call_llm(
                    model=model,
                    system_prompt=system_prompt,
                    messages=history,
                    stream=_stream_text,
                )
            except Exception as exc:
                logger.exception("ChatService LLM call failed")
                await emit(AgentChunk(type="error",
                                       error=f"LLM call failed: {exc}"))
                break

            total_prompt_tokens += llm_result.get("prompt_tokens", 0)
            total_completion_tokens += llm_result.get("completion_tokens", 0)

            # DL-15: record real-cost usage in the budget service
            # when cost_usd > 0 (the OpenRouter usage.cost field).
            # Best-effort: a budget outage MUST NOT break the chat.
            cost_usd = float(llm_result.get("cost_usd", 0.0) or 0.0)
            total_cost_usd += cost_usd
            if cost_usd > 0:
                try:
                    from eden.llmops.cost_ledger import CostEvent, record_cost_event
                    from eden.services.budget_service import record_usage

                    await record_usage(tenant_id, cost_usd)
                    await record_cost_event(
                        CostEvent(
                            org_id=tenant_id,
                            feature="chat_sidebar",
                            model=model,
                            cost_usd=cost_usd,
                            input_tokens=int(llm_result.get("prompt_tokens") or 0),
                            output_tokens=int(
                                llm_result.get("completion_tokens") or 0
                            ),
                            user_id=user_id,
                            session_id=str(conv_id),
                        )
                    )
                except Exception as exc:
                    logger.debug(
                        "ChatService: record_usage failed: %s", exc,
                    )

            await emit(AgentChunk(
                type="cost",
                cost_usd=total_cost_usd,
                turn_cost_usd=cost_usd,
                meta={
                    "model": model,
                    "tier": tier_key,
                    "ttft_ms": llm_result.get("ttft_ms"),
                    "ttft_budget_ms": ttft_budget_ms(tier_key),
                    "cost_estimate": cost_est,
                },
            ))

            warn = ttft_warning(llm_result.get("ttft_ms"), tier_key)
            if warn:
                await emit(AgentChunk(type="meta", meta={"ttft_warning": warn}))

            # Soft cite-before-claim gate (W23) — warn, do not block.
            cite_check = cite_before_claim(
                llm_result.get("text") or "",
                llm_result.get("citations") or [],
            )
            if not cite_check.get("ok") and cite_check.get("warning"):
                await emit(
                    AgentChunk(
                        type="meta",
                        meta={
                            "cite_before_claim": cite_check,
                            "warning": cite_check["warning"],
                        },
                    )
                )

            # DL-15 budget gate: if the running total exceeds the
            # hard cap, break the loop and emit an error chunk so
            # the user knows why the agent stopped.
            if _hard_limit > 0 and total_cost_usd > _hard_limit:
                await emit(AgentChunk(
                    type="error",
                    error=(
                        f"Budget hard cap exceeded: "
                        f"${total_cost_usd:.4f} > ${_hard_limit:.4f}"
                    ),
                ))
                break

            # Persist the assistant message (full raw text — we
            # reconstruct the display view on read).
            await self._append_message(
                client, conv_id, role="assistant",
                content=llm_result["text"],
                tool_calls=llm_result["tool_calls"],
                chart_specs=llm_result["charts"],
                citations=llm_result["citations"],
                prompt_tokens=llm_result.get("prompt_tokens", 0),
                completion_tokens=llm_result.get("completion_tokens", 0),
                model_used=model,
            )

            # Emit chart + citation chunks now (they don't depend on
            # tool execution).
            for chart_dict in llm_result["charts"]:
                await emit(AgentChunk(
                    type="chart",
                    chart=ChartSpec(**{
                        k: v for k, v in chart_dict.items()
                        if k in ChartSpec.__dataclass_fields__
                    }),
                ))
            for cite_dict in llm_result["citations"]:
                await emit(AgentChunk(
                    type="citation",
                    citation=Citation(**{
                        k: v for k, v in cite_dict.items()
                        if k in Citation.__dataclass_fields__
                    }),
                ))

            # ── Tool execution round ──
            tool_blocks = llm_result["tool_calls"]
            if not tool_blocks:
                # No more tool calls → assistant is done.
                break

            tool_results: list[dict[str, Any]] = []
            for tb in tool_blocks:
                name = tb.get("name")
                args = tb.get("args") or {}
                tc = await dispatch_tool(name, args,
                                          tenant_id=tenant_id,
                                          user_role=user_role)
                await emit(AgentChunk(type="tool_call", tool_call=tc))
                tool_results.append({
                    "name": name,
                    "result": tc.result,
                    "error": tc.error,
                })
                # Persist the tool message so a later chat reload
                # shows the full tool trace.
                await self._append_message(
                    client, conv_id, role="tool",
                    tool_calls=[tc.to_dict()],
                    tool_results=[{"name": name, "result": tc.result,
                                    "error": tc.error}],
                )

            # Add tool results to the history and loop.
            history.append({
                "role": "assistant",
                "content": llm_result["raw_text"],
            })
            history.append({
                "role": "tool",
                "content": json.dumps(tool_results, default=str)[:50_000],
            })

        # Update conversation-level counters.
        await client.execute(
            """
            UPDATE ai_conversations
            SET turn_count = turn_count + $2,
                total_tokens = total_tokens + $3,
                total_cost_usd = total_cost_usd + $4
            WHERE id = $1
            """,
            conv_id, turn,
            total_prompt_tokens + total_completion_tokens,
            total_cost_usd,
        )

        await emit(AgentChunk(
            type="done",
            text="",
            cost_usd=total_cost_usd,
            turn_cost_usd=total_cost_usd,
        ))
        return {
            "conversation_id": str(conv_id),
            "turns": turn,
            "prompt_tokens": total_prompt_tokens,
            "completion_tokens": total_completion_tokens,
            "cost_usd": total_cost_usd,
        }

    # ── Persistence helpers ────────────────────────────────────────

    async def _ensure_conversation(
        self, client: Any, conversation_id: str | None,
        tenant_id: str, user_id: str, first_message: str,
    ) -> Any:
        if conversation_id:
            row = await client.fetchrow(
                "SELECT id FROM ai_conversations WHERE id = $1 AND org_id = $2",
                conversation_id, tenant_id,
            )
            if row:
                return row["id"]
        # Create a new conversation. Title = first 60 chars of the
        # first message (LLM-generated rename comes later via a
        # follow-up T3 call). When the caller already minted a
        # session UUID (ChatSidebar / ai-insights), reuse it so
        # rehydrate lookups hit the same row.
        title = first_message[:60].strip() or "New chat"
        if conversation_id:
            row = await client.fetchrow(
                """
                INSERT INTO ai_conversations (id, org_id, user_id, title, page_context)
                VALUES ($1::uuid, $2, $3, $4, '{}'::jsonb)
                ON CONFLICT (id) DO NOTHING
                RETURNING id
                """,
                conversation_id, tenant_id, user_id, title,
            )
            if row:
                return row["id"]
            # PK conflict: id belongs to another row (e.g. other org).
            # Re-check ours; otherwise mint a fresh conversation.
            row = await client.fetchrow(
                "SELECT id FROM ai_conversations WHERE id = $1 AND org_id = $2",
                conversation_id, tenant_id,
            )
            if row:
                return row["id"]
        row = await client.fetchrow(
            """
            INSERT INTO ai_conversations (org_id, user_id, title, page_context)
            VALUES ($1, $2, $3, '{}'::jsonb)
            RETURNING id
            """,
            tenant_id, user_id, title,
        )
        return row["id"]

    async def _append_message(
        self, client: Any, conversation_id: Any, *,
        role: str, content: str = "",
        tool_calls: list[dict[str, Any]] | None = None,
        tool_results: list[dict[str, Any]] | None = None,
        chart_specs: list[dict[str, Any]] | None = None,
        citations: list[dict[str, Any]] | None = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        model_used: str = "",
    ) -> Any:
        return await client.fetchval(
            """
            INSERT INTO ai_messages (
                conversation_id, role, content,
                tool_calls, tool_results, chart_specs, citations,
                prompt_tokens, completion_tokens, model_used
            )
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
                    $8, $9, $10)
            RETURNING id
            """,
            conversation_id, role, content,
            json.dumps(tool_calls or []),
            json.dumps(tool_results or []),
            json.dumps(chart_specs or []),
            json.dumps(citations or []),
            prompt_tokens, completion_tokens, model_used,
        )

    async def _load_history(
        self, client: Any, conversation_id: Any, *,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        rows = await client.fetch(
            """
            SELECT role, content, tool_calls, tool_results
            FROM ai_messages
            WHERE conversation_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            conversation_id, limit,
        )
        # Reverse to chronological; map to OpenAI chat-completions shape.
        history: list[dict[str, Any]] = []
        for r in reversed(rows):
            role = r["role"]
            content = r["content"]
            if role == "tool":
                # The OpenAI API accepts role=tool only with tool_call_id
                # — we collapse tool messages back into a single user
                # message summarising the result so the model still sees
                # them.
                history.append({
                    "role": "user",
                    "content": f"[tool result] {content}",
                })
            elif role == "assistant":
                history.append({"role": "assistant", "content": content})
            elif role == "user":
                history.append({"role": "user", "content": content})
        return history


# ────────────────────────────────────────────────────────────────────
# Block parsers (```chart / ```cite / ```tool)
# ────────────────────────────────────────────────────────────────────


import re

_BLOCK_RE = re.compile(
    r"```(" + "|".join(["chart", "cite", "tool"]) + r")\s*\n(.*?)```",
    re.DOTALL,
)


def _extract_blocks(text: str, kind: str,
                     parser: Callable[[str], Any]) -> list[Any]:
    """Pull every ```<kind> fenced JSON block out of ``text``."""
    out: list[Any] = []
    for m in _BLOCK_RE.finditer(text):
        if m.group(1) == kind:
            try:
                out.append(parser(m.group(2).strip()))
            except Exception:
                # Skip malformed blocks silently — the model is
                # allowed to emit rough JSON.
                pass
    return out


def _strip_blocks(text: str) -> str:
    """Remove all ```chart/```cite/```tool fences from text."""
    return _BLOCK_RE.sub("", text).strip()


def _parse_chart(raw: str) -> dict[str, Any]:
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("chart block must be an object")
    return obj


def _parse_citation(raw: str) -> dict[str, Any]:
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("citation block must be an object")
    return obj


def _parse_tool_call(raw: str) -> dict[str, Any]:
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("tool block must be an object")
    return obj


def _register_insights_tools() -> None:
    """Merge AI Insights observability tools into the unified agent registry."""
    from eden.llmops.insights_tools import dispatch_tool_call, list_tools

    for tool in list_tools():
        name = tool.name
        if name in _TOOL_REGISTRY:
            continue

        async def _handler(
            tenant_id: str,
            args: dict[str, Any],
            *,
            _tool_name: str = name,
        ) -> Any:
            envelope = await dispatch_tool_call(tenant_id, _tool_name, args or {})
            if envelope.get("status") == "error":
                raise RuntimeError(str(envelope.get("output", "tool error")))
            return envelope.get("output")

        _TOOL_REGISTRY[name] = {
            "fn": _handler,
            "requires_role": "admin" if name in _WRITE_INSIGHTS_TOOLS else None,
        }
        schema = tool.input_schema.get("properties", {})
        _TOOL_SPECS.append({
            "name": name,
            "summary": (tool.description or "").split("\n", 1)[0].strip(),
            "args": {
                k: {
                    "type": v.get("type", "string"),
                    "required": k in (tool.input_schema.get("required") or []),
                }
                for k, v in schema.items()
            },
        })


_register_insights_tools()


# ────────────────────────────────────────────────────────────────────
# Singleton
# ────────────────────────────────────────────────────────────────────

_chat_service: ChatService | None = None


def get_chat_service() -> ChatService:
    global _chat_service
    if _chat_service is None:
        _chat_service = ChatService()
    return _chat_service
