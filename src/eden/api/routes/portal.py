"""Portal read-model routes — enriched projections for later FE wire-up.

Mounted at ``/orgs/{org_id}/portal``. Each handler prefers live tables /
services when available and returns ``[]`` (or a safe default workspace)
when sources are missing or fail. Contracts live in
``eden.api.portal_contracts``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.portal_contracts import (
    AbExperimentCard,
    AgentCard,
    AlertEventCard,
    AlertRuleCard,
    ApiKeyCard,
    AssistantThreadCard,
    AuditEventCard,
    AuditPackCard,
    CostDriverCard,
    DatasetCard,
    DebuggerSessionCard,
    ExperimentSummary,
    GuardrailPolicyCard,
    ImprovePlanCard,
    IssueCard,
    MemberCard,
    PlaygroundCard,
    SessionRollup,
    SignalCard,
    TraceListItem,
    TraceSignalSummary,
    TranscriptStep,
    WorkspaceCard,
    WorkspacePrefs,
)
from eden.api.utils.redact import redact_all
from eden.storage.sql_safe import (
    safe_cost_sum_nullable_sql,
    safe_input_token_sum_sql,
    safe_output_token_sum_sql,
    safe_token_sum_sql,
)

logger = logging.getLogger(__name__)

# Prefer a concrete model id for cost estimates (dated suffixes ok —
# estimate_cost_usd fuzzy-matches the seed catalog).
_PREFERRED_MODEL_SQL = """(ARRAY_AGG(
    COALESCE(
        NULLIF(e.model, ''),
        NULLIF(e.model_name, ''),
        NULLIF(e.model_version, ''),
        NULLIF(e.payload->>'model_normalized', ''),
        NULLIF(e.payload->>'model', ''),
        NULLIF(e.attributes->>'model', '')
    )
    ORDER BY e.timestamp DESC
) FILTER (WHERE COALESCE(
    NULLIF(e.model, ''),
    NULLIF(e.model_name, ''),
    NULLIF(e.model_version, ''),
    NULLIF(e.payload->>'model_normalized', ''),
    NULLIF(e.payload->>'model', ''),
    NULLIF(e.attributes->>'model', '')
) IS NOT NULL))[1]"""

_PREFERRED_MODEL_SQL_UNALIASED = """(ARRAY_AGG(
    COALESCE(
        NULLIF(model, ''),
        NULLIF(model_name, ''),
        NULLIF(model_version, ''),
        NULLIF(payload->>'model_normalized', ''),
        NULLIF(payload->>'model', ''),
        NULLIF(attributes->>'model', '')
    )
    ORDER BY timestamp DESC
) FILTER (WHERE COALESCE(
    NULLIF(model, ''),
    NULLIF(model_name, ''),
    NULLIF(model_version, ''),
    NULLIF(payload->>'model_normalized', ''),
    NULLIF(payload->>'model', ''),
    NULLIF(attributes->>'model', '')
) IS NOT NULL))[1]"""

router = APIRouter(
    prefix="/orgs/{org_id}/portal",
    tags=["portal"],
    dependencies=[Depends(get_current_user), Depends(require_path_org_access)],
)


# ── helpers ───────────────────────────────────────────────────────


def _iso(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat()
    return str(value)


def _clip_text(value: Any, max_chars: int = 800) -> str:
    """Bound list-card text fields so triage JSON can't bloat responses."""
    text = str(value or "")
    if len(text) <= max_chars:
        return text
    if max_chars <= 1:
        return text[:max_chars]
    return text[: max_chars - 1] + "…"


def _parse_window(window: str) -> timedelta:
    raw = (window or "24h").strip().lower()
    try:
        if raw.endswith("h"):
            return timedelta(hours=max(1, int(raw[:-1])))
        if raw.endswith("d"):
            return timedelta(days=max(1, int(raw[:-1])))
        if raw.endswith("m"):
            return timedelta(minutes=max(1, int(raw[:-1])))
        return timedelta(hours=max(1, int(raw)))
    except (TypeError, ValueError):
        return timedelta(hours=24)


def _as_dict(settings: Any) -> dict[str, Any]:
    if settings is None:
        return {}
    if isinstance(settings, dict):
        return settings
    if isinstance(settings, str):
        try:
            parsed = json.loads(settings)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _map_issue_status(raw: str | None) -> str:
    s = (raw or "open").lower()
    if s in ("open",):
        return "open"
    if s in ("resolved", "ignored"):
        return "resolved"
    # triaged / fix_pending / verifying / learning / regressed / acknowledged
    if s in ("acknowledged", "triaged", "fix_pending", "verifying", "learning", "regressed"):
        return "acknowledged"
    return "open"


def _map_issue_severity(raw: str | None) -> str:
    s = (raw or "").lower()
    if s in ("error", "critical", "p0", "p1", "high"):
        return "error"
    return "warn"


def _map_trace_outcome(outcome: str | None) -> tuple[str, str]:
    """Return (status, severity) for TraceListItem."""
    o = (outcome or "").lower()
    if o in ("error", "failed", "failure", "fail", "errored"):
        return "error", "error"
    if o in ("warn", "warning", "partial", "degraded"):
        return "ok", "warn"
    return "ok", "none"


def _trace_signal_summary(
    *,
    name: str,
    severity: str,
    status: str,
) -> TraceSignalSummary:
    """Human summary for the Signals pane (never leave title blank)."""
    label = name or "Run"
    if severity == "error" or status == "error":
        return TraceSignalSummary(
            title="Run failed",
            body=f"{label} ended with an error outcome.",
            count=1,
        )
    if severity == "warn":
        return TraceSignalSummary(
            title="Degraded run",
            body=f"{label} completed with warnings.",
            count=1,
        )
    return TraceSignalSummary(
        title="Clean run",
        body="No detectors matched this successful run.",
        count=0,
    )


def _resolved_trace_cost_usd(
    *,
    cost_usd: float | None,
    input_tokens: int,
    output_tokens: int,
    model: str | None,
) -> float | None:
    """Prefer stamped cost; else estimate from tokens + seed pricing.

    Returns ``None`` when cost was never stamped and there are no tokens
    to estimate from — callers should render ``—``, not ``$0.00``.
    """
    if cost_usd is not None and cost_usd > 0:
        return round(cost_usd, 6)
    if input_tokens <= 0 and output_tokens <= 0:
        return None if cost_usd is None else round(float(cost_usd), 6)
    try:
        from eden.llmops.pricing import estimate_cost_usd

        estimated = estimate_cost_usd(
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            existing=float(cost_usd or 0),
        )
        if estimated > 0:
            return round(estimated, 6)
        return None if cost_usd is None else round(float(cost_usd), 6)
    except Exception:  # noqa: BLE001
        return None if cost_usd is None else round(float(cost_usd), 6)


def _normalize_notify_channel(raw: object | None) -> str:
    """Map legacy ``slack`` (removed 2026-07-23) onto email for portal cards."""
    ch = str(raw or "").strip().lower()
    if ch == "slack":
        return "email"
    if ch in ("email", "webhook"):
        return ch
    return "email"


def _pick_channel(channels: dict[str, Any] | None) -> tuple[str, str]:
    """Pick email|webhook + destination from NL alert channels blob."""
    ch = channels if isinstance(channels, dict) else {}
    for key in ("email", "webhook"):
        val = ch.get(key)
        if val is True:
            return key, str(ch.get("destination") or ch.get(f"{key}_destination") or "")
        if isinstance(val, str) and val.strip():
            return key, val.strip()
        if isinstance(val, dict):
            dest = val.get("destination") or val.get("url") or val.get("webhook") or ""
            if dest or val.get("enabled"):
                return key, str(dest or "")
    # Legacy slack blobs still in DB — treat as email destination if present.
    slack_val = ch.get("slack")
    if slack_val is True or isinstance(slack_val, (str, dict)):
        dest = ""
        if isinstance(slack_val, str):
            dest = slack_val.strip()
        elif isinstance(slack_val, dict):
            dest = str(
                slack_val.get("destination")
                or slack_val.get("url")
                or slack_val.get("webhook")
                or ""
            )
        return "email", dest or str(ch.get("destination") or "")
    if ch.get("in_app"):
        return "email", ""
    return "email", str(ch.get("destination") or "")


def _alert_severity(raw: str | None) -> str:
    s = (raw or "warn").lower()
    if s in ("critical", "crit", "p0"):
        return "critical"
    if s in ("error", "err", "high", "p1"):
        return "error"
    if s in ("warning", "warn", "medium", "p2"):
        return "warn"
    return "warn"


def _alert_event_status(*, acknowledged: bool, verdict: str | None) -> str:
    if acknowledged:
        return "muted"
    v = (verdict or "").lower()
    if v in ("resolved", "benign", "duplicate"):
        return "resolved"
    return "firing"


def _signal_kind_from_rule(rule: Any) -> str:
    metric = ""
    if isinstance(rule, dict):
        metric = str(rule.get("metric") or "").lower()
    if "latenc" in metric or "duration" in metric:
        return "latency"
    if "cost" in metric or "token" in metric:
        return "cost"
    if "error" in metric or "fail" in metric:
        return "error"
    if "policy" in metric or "pii" in metric or "guard" in metric:
        return "policy"
    return "custom"


def _cost_driver_kind(detector: str, summary: str) -> str:
    blob = f"{detector} {summary}".lower()
    if "tool" in blob or "fanout" in blob:
        return "tool_fanout"
    if "model" in blob or "swap" in blob or "router" in blob:
        return "model_swap"
    if "token" in blob or "loop" in blob:
        return "token_loop"
    if "regress" in blob or "eval" in blob:
        return "eval_regress"
    if "cost" in blob or "waste" in blob or "anomal" in blob:
        return "token_loop"
    return "healthy"


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal: postgres unavailable: %s", redact_all(str(exc)))
        return None


# ── Phase 2a — trace transcript steps ──────────────────────────────
# Populates ``TraceListItem.steps`` for a single selected trace by
# reusing ``TelemetryCollector.get_trace_tree`` — the exact helper
# backing ``GET /observability/traces/{id}/tree`` — instead of a
# second, drift-prone SQL implementation. Only wired into the
# single-trace detail route below; ``list_portal_traces`` deliberately
# keeps ``steps=[]`` to avoid an N+1 of per-trace decompression work.

_ERROR_OUTCOMES = {"error", "failed", "failure", "fail", "errored", "crash", "timeout"}
_OK_OUTCOMES = {"success", "ok", "completed", "complete"}


def _step_kind(event_type: str | None, name: str | None) -> str:
    et = (event_type or "").lower()
    nm = (name or "").lower()
    if "llm" in et or "completion" in et or "chat" in et or "llm" in nm:
        return "llm"
    if "tool" in et or "tool" in nm:
        return "tool"
    if "bash" in et or "shell" in et or "command" in nm or "bash" in nm:
        return "bash"
    if et in ("task", "run", "agent_run", "session"):
        return "task"
    return "span"


def _step_status(outcome: str | None) -> str | None:
    o = (outcome or "").lower()
    if o in _ERROR_OUTCOMES:
        return "error"
    if o in _OK_OUTCOMES:
        return "ok"
    return None


def _preview(value: Any, limit: int = 400) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        if not value:
            return None
        try:
            text = json.dumps(value, default=str)
        except Exception:  # noqa: BLE001
            text = str(value)
    else:
        text = str(value)
    text = text.strip()
    if not text:
        return None
    return text[:limit]


def _message_content_text(content: Any) -> str:
    """Flatten OpenAI/Anthropic message ``content`` (str or parts list)."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                if part.get("type") == "text" or "text" in part:
                    parts.append(str(part.get("text") or ""))
                elif part.get("type") == "output_text":
                    parts.append(str(part.get("text") or ""))
        return "\n".join(p for p in parts if p)
    return str(content)


def _strip_think_blocks(text: str) -> str:
    """Drop model chain-of-thought wrappers (MiniMax ``<think>…</think>``)."""
    import re

    cleaned = re.sub(
        r"<think\b[^>]*>[\s\S]*?</think>",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return cleaned.strip()


def _humanize_io_preview(value: Any, *, limit: int = 800) -> str | None:
    """Readable transcript preview — messages/content, not raw JSON dumps."""
    if value is None:
        return None

    parsed: Any = value
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:  # noqa: BLE001
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text[0] in "{[":
            try:
                parsed = json.loads(text)
            except Exception:  # noqa: BLE001
                return _strip_think_blocks(text)[:limit]
        else:
            return _strip_think_blocks(text)[:limit]

    if isinstance(parsed, list):
        if parsed and isinstance(parsed[0], dict) and (
            "role" in parsed[0] or "content" in parsed[0]
        ):
            lines: list[str] = []
            for msg in parsed:
                if not isinstance(msg, dict):
                    continue
                role = str(msg.get("role") or "message")
                body = _strip_think_blocks(_message_content_text(msg.get("content")))
                if body:
                    lines.append(f"{role}: {body}")
            if lines:
                return "\n\n".join(lines)[:limit]
        return _preview(parsed, limit=limit)

    if not isinstance(parsed, dict):
        return _preview(parsed, limit=limit)

    choices = parsed.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0] if isinstance(choices[0], dict) else {}
        msg = first.get("message") if isinstance(first.get("message"), dict) else {}
        content = _strip_think_blocks(_message_content_text(msg.get("content")))
        if content:
            return content[:limit]
        text = first.get("text")
        if isinstance(text, str) and text.strip():
            return _strip_think_blocks(text.strip())[:limit]

    messages = parsed.get("messages")
    if isinstance(messages, list) and messages:
        humanized = _humanize_io_preview(messages, limit=limit)
        if humanized:
            return humanized

    for key in (
        "content",
        "output",
        "completion",
        "response",
        "text",
        "prompt",
        "input",
        "output_text",
    ):
        raw = parsed.get(key)
        if isinstance(raw, str) and raw.strip():
            return _strip_think_blocks(raw.strip())[:limit]
        if isinstance(raw, (dict, list)):
            nested = _humanize_io_preview(raw, limit=limit)
            if nested:
                return nested

    # Last resort — still better than blank; callers may prefer this over None.
    return _preview(parsed, limit=limit)


def _coerce_token_count(value: Any) -> int | None:
    """Token metrics often land as ``198.0`` / ``\"198.0\"`` — never bare ``int``."""
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _usage_token_counts(*sources: Any) -> tuple[int | None, int | None]:
    """Pull prompt/completion tokens from OpenAI-style ``usage`` blocks."""
    for source in sources:
        if not isinstance(source, dict):
            continue
        usage = source.get("usage")
        if not isinstance(usage, dict):
            nested = source.get("openai")
            if isinstance(nested, dict) and isinstance(nested.get("usage"), dict):
                usage = nested["usage"]
            else:
                continue
        tin = _coerce_token_count(
            usage.get("prompt_tokens")
            if usage.get("prompt_tokens") is not None
            else usage.get("input_tokens")
        )
        tout = _coerce_token_count(
            usage.get("completion_tokens")
            if usage.get("completion_tokens") is not None
            else usage.get("output_tokens")
        )
        if tin is not None or tout is not None:
            return tin, tout
    return None, None


def _tree_node_to_step(node: dict[str, Any]) -> TranscriptStep:
    """Map one ``TraceTree`` span node to a portal ``TranscriptStep``."""
    # asyncpg / some poolers return JSONB as a JSON *string* — isinstance
    # dict checks used to drop metrics/payload and leave tokens/cost blank.
    attrs = _as_dict(node.get("attributes"))
    metrics = _as_dict(node.get("metrics"))
    payload = _as_dict(node.get("payload"))
    span_id = str(node.get("span_id") or "")
    name = str(node.get("name") or node.get("event_type") or "span")
    outcome = node.get("outcome")

    error_message: str | None = None
    if outcome and str(outcome).lower() in _ERROR_OUTCOMES:
        error_message = str(
            attrs.get("error") or payload.get("error") or node.get("finish_reason") or outcome
        )

    # Bodies may also arrive as JSON strings — parse when possible so
    # nested message/content previews still resolve.
    request_body = node.get("request_body")
    response_body = node.get("response_body")
    if isinstance(request_body, str):
        request_body = _as_dict(request_body) or request_body
    if isinstance(response_body, str):
        response_body = _as_dict(response_body) or response_body

    tokens_in = (
        metrics.get("input_tokens")
        if metrics.get("input_tokens") is not None
        else payload.get("input_tokens")
    )
    tokens_out = (
        metrics.get("output_tokens")
        if metrics.get("output_tokens") is not None
        else payload.get("output_tokens")
    )
    tokens_in_i = _coerce_token_count(tokens_in)
    tokens_out_i = _coerce_token_count(tokens_out)
    if tokens_in_i is None and tokens_out_i is None:
        usage_in, usage_out = _usage_token_counts(
            response_body if isinstance(response_body, dict) else None,
            payload,
            request_body if isinstance(request_body, dict) else None,
        )
        tokens_in_i = usage_in
        tokens_out_i = usage_out

    cost = (
        metrics.get("cost_usd")
        if metrics.get("cost_usd") is not None
        else (
            payload.get("cost_usd")
            if payload.get("cost_usd") is not None
            else attrs.get("cost_usd")
        )
    )
    # Nested provider payloads (OpenAI-compatible) often stash the model
    # under payload.openai.model when top-level model fields are empty.
    nested_openai = payload.get("openai") if isinstance(payload.get("openai"), dict) else {}
    req_model = (
        request_body.get("model")
        if isinstance(request_body, dict)
        else None
    )
    resp_model = (
        response_body.get("model")
        if isinstance(response_body, dict)
        else None
    )
    model = (
        attrs.get("model")
        or attrs.get("openai.model")
        or attrs.get("anthropic.model")
        or payload.get("model_normalized")
        or payload.get("model")
        or nested_openai.get("model")
        or req_model
        or resp_model
        or node.get("model_version")
    )
    # Ignore placeholder / tier labels that poison pricing lookup.
    if isinstance(model, str) and model.strip().lower() in {"", "standard", "default", "unknown"}:
        model = (
            req_model
            or resp_model
            or nested_openai.get("model")
            or payload.get("model")
            or None
        )
    provider = attrs.get("provider")

    # Estimate per-span cost when ingest never stamped cost_usd but
    # tokens are present — otherwise the header and step chips stay $0.
    cost_f: float | None
    try:
        cost_f = float(cost) if cost is not None else None
    except (TypeError, ValueError):
        cost_f = None
    if (cost_f is None or cost_f <= 0) and (tokens_in_i is not None or tokens_out_i is not None):
        try:
            from eden.llmops.pricing import estimate_cost_usd

            estimated = estimate_cost_usd(
                model=str(model) if model else None,
                input_tokens=int(tokens_in_i or 0),
                output_tokens=int(tokens_out_i or 0),
                existing=cost_f,
            )
            if estimated > 0:
                cost_f = estimated
        except Exception:  # noqa: BLE001
            pass

    safe_attrs = {k: v for k, v in attrs.items() if isinstance(v, (str, int, float, bool))} or None

    return TranscriptStep(
        id=span_id or str(node.get("timestamp") or name),
        kind=_step_kind(node.get("event_type"), name),  # type: ignore[arg-type]
        title=name,
        durationMs=int(round(float(node.get("duration_ms") or 0))),
        status=_step_status(outcome),  # type: ignore[arg-type]
        startedAt=_iso(node.get("timestamp")) or None,
        spanId=span_id or None,
        parentId=str(node["parent_span_id"]) if node.get("parent_span_id") else None,
        model=str(model) if model else None,
        provider=str(provider) if provider else None,
        tokensIn=tokens_in_i,
        tokensOut=tokens_out_i,
        costUsd=cost_f,
        attributes=safe_attrs,
        # Prefer dedicated bodies; fall back to payload fields when the
        # portal path skips message_store / body-zstd hydrate.
        inputPreview=_humanize_io_preview(request_body)
        or _humanize_io_preview(
            payload.get("messages") or payload.get("input") or payload.get("prompt")
        ),
        outputPreview=_humanize_io_preview(response_body)
        or _humanize_io_preview(
            payload.get("output")
            or payload.get("content")
            or payload.get("completion")
            or payload.get("response")
            or payload.get("openai")
        ),
        errorMessage=error_message,
        metadata=None,
    )


def _flatten_tree(root_spans: list[dict[str, Any]]) -> list[TranscriptStep]:
    """Depth-first flatten of ``TraceTree.root_spans`` into transcript steps."""
    steps: list[TranscriptStep] = []

    def _walk(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            steps.append(_tree_node_to_step(node))
            children = node.get("children") or []
            if children:
                _walk(children)

    _walk(root_spans)
    return steps


# Prefer user/session agent_id over synthetic framework instrument names
# (pydantic-ai:OpenAIChatModel(), langchain:…, etc.) when collapsing spans.
_PREFERRED_AGENT_ID_SQL = """
COALESCE(
  (ARRAY_AGG(agent_id ORDER BY timestamp ASC)
    FILTER (
      WHERE agent_id IS NOT NULL
        AND agent_id NOT LIKE 'pydantic-ai:%%'
        AND agent_id NOT LIKE 'langchain:%%'
        AND agent_id NOT LIKE 'langgraph:%%'
        AND agent_id NOT LIKE 'openai:%%'
        AND agent_id NOT LIKE 'anthropic:%%'
        AND agent_id NOT LIKE 'crewai:%%'
    ))[1],
  (ARRAY_AGG(agent_id ORDER BY timestamp ASC)
    FILTER (WHERE agent_id IS NOT NULL))[1]
)
"""

# Template form kept for unit tests that assert ``::numeric`` + format(alias=).
# Runtime SQL uses :func:`eden.storage.sql_safe.safe_token_sum_sql`.
_SAFE_TOKEN_SUM_SQL = (
    "COALESCE(SUM(\n"
    "  COALESCE((NULLIF({alias}metrics->>'input_tokens', ''))::numeric, 0)\n"
    "  + COALESCE((NULLIF({alias}metrics->>'output_tokens', ''))::numeric, 0)\n"
    "), 0)::int"
)
_SAFE_COST_SUM_SQL = (
    "COALESCE(SUM(\n"
    "  COALESCE((NULLIF({alias}metrics->>'cost_usd', ''))::float, 0)\n"
    "), 0)::float"
)


# ── GET /agents ───────────────────────────────────────────────────


@router.get("/agents", response_model=list[AgentCard])
async def list_portal_agents(
    org_id: str = Depends(require_path_org_access),
    window: str = Query("24h", description="Lookback window, e.g. 24h / 7d"),
    _user: dict = Depends(get_current_user),
) -> list[AgentCard]:
    """Enriched agent cards (registry + bounded telemetry + open issues).

    Skips FleetHealthService.summary() on this hot path — that path
    re-queried registry, ran four GROUP BYs, and wrote agent_registry.
    Open issues come from a single cheap aggregate instead.
    """
    import asyncio

    delta = _parse_window(window)
    window_secs = int(delta.total_seconds())
    client = await _pg()
    if client is None:
        # Same contract as traces: do not render infra outage as
        # "you have no agents yet".
        raise HTTPException(
            status_code=503,
            detail="Agent registry is temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    async def _load_registry() -> list[Any]:
        try:
            return list(
                await client.fetch(
                    """
                    SELECT agent_id, name, framework, repo_url, last_seen_at,
                           created_at, updated_at
                    FROM agent_registrations
                    WHERE org_id = $1
                    ORDER BY last_seen_at DESC NULLS LAST
                    LIMIT 200
                    """,
                    org_id,
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal agents: registry query failed: %s", redact_all(str(exc)))
            try:
                return list(
                    await client.fetch(
                        """
                        -- agent_registry tracks lifecycle as
                        -- first_seen / last_seen; it has no created_at or
                        -- updated_at. Aliased so the response keys are unchanged.
                        SELECT agent_id, display_name AS name, tier AS framework,
                               NULL AS repo_url, last_seen AS last_seen_at,
                               first_seen AS created_at, last_seen AS updated_at
                        FROM agent_registry
                        WHERE org_id = $1
                        ORDER BY last_seen DESC NULLS LAST
                        LIMIT 200
                        """,
                        org_id,
                    )
                )
            except Exception as exc2:  # noqa: BLE001
                logger.debug("portal agents: registry fallback failed: %s", exc2)
                raise HTTPException(
                    status_code=503,
                    detail="Agent registry is temporarily unavailable; please retry",
                    headers={"Retry-After": "5"},
                ) from exc2

    async def _load_metrics() -> dict[str, dict[str, Any]]:
        """Bounded window scan — success from scored outcomes only;
        real p50/p95 via percentile_cont (not duplicated AVG)."""
        metrics_by_id: dict[str, dict[str, Any]] = {}
        try:
            mrows = await client.fetch(
                f"""
                WITH recent AS (
                    SELECT agent_id, trace_id, outcome, duration_ms, metrics,
                           timestamp
                    FROM telemetry_events
                    WHERE tenant_id = $1
                      AND agent_id IS NOT NULL
                      AND timestamp > NOW() - ($2::int * INTERVAL '1 second')
                    ORDER BY timestamp DESC
                    -- Bound sample for card metrics (was 15000). Cards are
                    -- approximate; full-window GROUP BY is too expensive
                    -- for hot tenants on every agents page load.
                    LIMIT 4000
                ),
                -- Collapse framework instrument ids (pydantic-ai:…) onto the
                -- preferred SDK agent_id per trace — same rule as the traces
                -- list — so registered agents do not show 0 runs while their
                -- preferred-id traces appear in the feed.
                trace_agent AS (
                    SELECT trace_id,
                           {_PREFERRED_AGENT_ID_SQL} AS agent_id
                    FROM recent
                    GROUP BY trace_id
                )
                SELECT ta.agent_id,
                       COUNT(DISTINCT r.trace_id)::int AS runs,
                       {safe_cost_sum_nullable_sql(alias="r.")} AS cost_usd,
                       {safe_token_sum_sql(alias="r.")} AS tokens,
                       AVG(
                           CASE
                               WHEN lower(coalesce(r.outcome, '')) IN
                                    ('error','failed','failure','fail')
                               THEN 0.0
                               WHEN lower(coalesce(r.outcome, '')) IN
                                    ('ok','success','succeeded','completed',
                                     'pass','passed')
                               THEN 1.0
                               ELSE NULL
                           END
                       )::float AS success_rate,
                       percentile_cont(0.5) WITHIN GROUP (
                           ORDER BY r.duration_ms
                       )::float AS p50,
                       percentile_cont(0.95) WITHIN GROUP (
                           ORDER BY r.duration_ms
                       )::float AS p95,
                       MAX(r.timestamp) AS last_seen
                FROM recent r
                INNER JOIN trace_agent ta ON ta.trace_id = r.trace_id
                WHERE ta.agent_id IS NOT NULL
                GROUP BY ta.agent_id
                ORDER BY runs DESC
                LIMIT 200
                """,
                org_id,
                window_secs,
            )
            for r in mrows:
                metrics_by_id[str(r["agent_id"])] = dict(r)
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal agents: telemetry metrics skipped: %s", redact_all(str(exc)))
            # Cast failures must not erase SDK-only agents when the
            # registry is empty. Discover agent_ids with a cast-free
            # query so cards still appear (runs/tokens stay zero).
            try:
                id_rows = await client.fetch(
                    f"""
                    WITH recent AS (
                        SELECT agent_id, trace_id, timestamp
                        FROM telemetry_events
                        WHERE tenant_id = $1
                          AND agent_id IS NOT NULL
                          AND timestamp > NOW() - ($2::int * INTERVAL '1 second')
                        ORDER BY timestamp DESC
                        LIMIT 4000
                    ),
                    trace_agent AS (
                        SELECT trace_id,
                               {_PREFERRED_AGENT_ID_SQL} AS agent_id
                        FROM recent
                        GROUP BY trace_id
                    )
                    SELECT ta.agent_id,
                           COUNT(DISTINCT r.trace_id)::int AS runs,
                           MAX(r.timestamp) AS last_seen
                    FROM recent r
                    INNER JOIN trace_agent ta ON ta.trace_id = r.trace_id
                    WHERE ta.agent_id IS NOT NULL
                    GROUP BY ta.agent_id
                    ORDER BY runs DESC
                    LIMIT 200
                    """,
                    org_id,
                    window_secs,
                )
                for r in id_rows:
                    metrics_by_id[str(r["agent_id"])] = {
                        "runs": int(r["runs"] or 0),
                        # Do not invent 100% success / $0 — FE should
                        # treat missing cost/success as unknown.
                        "success_rate": None,
                        "cost_usd": None,
                        "tokens": 0,
                        "p50": 0.0,
                        "p95": 0.0,
                        "last_seen": r.get("last_seen"),
                    }
            except Exception as exc2:  # noqa: BLE001
                logger.warning(
                    "portal agents: telemetry id discovery skipped: %s",
                    redact_all(str(exc2)),
                )
        return metrics_by_id

    async def _load_open_issues() -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        try:
            rows = await client.fetch(
                """
                SELECT agent_id,
                       COUNT(*)::int AS open_issues,
                       COUNT(*) FILTER (
                           WHERE lower(coalesce(severity, '')) IN
                                 ('critical', 'p0', 'fatal')
                       )::int AS open_p0
                FROM agent_issues
                WHERE org_id = $1
                  AND agent_id IS NOT NULL
                  AND status NOT IN ('resolved', 'ignored')
                GROUP BY agent_id
                """,
                org_id,
            )
            for r in rows:
                out[str(r["agent_id"])] = {
                    "open_issues": int(r["open_issues"] or 0),
                    "open_p0": int(r["open_p0"] or 0),
                }
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal agents: open issues skipped: %s", redact_all(str(exc)))
        return out

    rows, metrics_by_id, issues_by_id = await asyncio.gather(
        _load_registry(),
        _load_metrics(),
        _load_open_issues(),
    )

    out: list[AgentCard] = []
    seen: set[str] = set()

    def _build(agent_id: str, name: str, purpose: str, last_seen: Any) -> AgentCard:
        metrics = metrics_by_id.get(agent_id) or {}
        issues = issues_by_id.get(agent_id) or {}
        runs = int(metrics.get("runs") or 0)
        raw_success = metrics.get("success_rate")
        # None = unknown (no scored outcomes / degraded metrics). Never invent
        # 0% or 100% — FE renders "—".
        success: float | None
        if runs <= 0:
            success = None
        elif raw_success is None:
            success = None
        else:
            success = max(0.0, min(1.0, float(raw_success)))
        open_issues = int(issues.get("open_issues") or 0)
        open_p0 = int(issues.get("open_p0") or 0)
        # Prefer telemetry last_seen when present — registry heartbeats alone
        # should not drive "active" and can lag behind windowed runs.
        last = _iso(metrics.get("last_seen") or last_seen)
        # Windowed runs imply activity in the lookback; register-only stays idle.
        status: str = "idle"
        if open_p0 > 0:
            status = "error"
        elif runs > 0:
            status = "live"

        raw_cost = metrics.get("cost_usd")
        cost_usd = round(float(raw_cost), 4) if raw_cost is not None else None

        raw_p50 = metrics.get("p50")
        raw_p95 = metrics.get("p95")
        p50 = int(round(float(raw_p50))) if raw_p50 is not None else 0
        p95 = int(round(float(raw_p95))) if raw_p95 is not None else 0

        return AgentCard(
            id=agent_id,
            name=name or agent_id,
            purpose=purpose or "",
            status=status,  # type: ignore[arg-type]
            env="",
            model="",
            runs24h=runs,
            successRate=round(success, 4) if success is not None else None,
            errorRate=(round(1.0 - success, 4) if success is not None else None),
            p50Ms=p50,
            p95Ms=p95,
            costUsd24h=cost_usd,
            tokens24h=int(metrics.get("tokens") or 0),
            openIssues=open_issues,
            lastSeen=last,
            topError=None,
        )

    for row in rows:
        agent_id = str(row["agent_id"])
        seen.add(agent_id)
        purpose = str(row.get("framework") or row.get("repo_url") or "")
        metrics = metrics_by_id.get(agent_id) or {}
        out.append(
            _build(
                agent_id,
                str(row.get("name") or agent_id),
                purpose,
                row.get("last_seen_at") or metrics.get("last_seen"),
            )
        )

    # SDK-only agents: telemetry has agent_id but no registry row yet.
    for agent_id, metrics in metrics_by_id.items():
        if not agent_id or agent_id in seen:
            continue
        seen.add(agent_id)
        out.append(
            _build(
                agent_id,
                agent_id,
                "Seen in recent traces",
                metrics.get("last_seen"),
            )
        )

    return out


# ── GET /traces ───────────────────────────────────────────────────


@router.get("/traces", response_model=list[TraceListItem])
async def list_portal_traces(
    org_id: str = Depends(require_path_org_access),
    window: str = Query("24h"),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[TraceListItem]:
    """Trace list mapped to portal ``TraceListItem`` (empty OK)."""
    delta = _parse_window(window)
    window_secs = int(delta.total_seconds())
    client = await _pg()
    if client is None:
        # "The database is down" and "you have not sent a trace yet"
        # must not render as the same empty state. A new customer who
        # sees an empty trace list concludes their SDK is misconfigured
        # and goes off debugging their own code — the worst possible
        # failure mode during onboarding.
        raise HTTPException(
            status_code=503,
            detail="Trace storage is temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    try:
        # Id discovery scans a bounded recent event sample, then
        # aggregates *all* window events for those trace_ids so span
        # totals are complete (the old LIMIT-8000 CTE truncated early
        # spans and still scanned up to 8k rows every list call).
        rows = await client.fetch(
            f"""
            WITH recent AS (
                SELECT trace_id, timestamp
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND timestamp > NOW() - ($2::int * INTERVAL '1 second')
                ORDER BY timestamp DESC
                LIMIT 3000
            ),
            ids AS (
                SELECT trace_id
                FROM recent
                GROUP BY trace_id
                ORDER BY MAX(timestamp) DESC
                LIMIT $3
            )
            SELECT e.trace_id,
                   {_PREFERRED_AGENT_ID_SQL} AS agent_id,
                   (ARRAY_AGG(e.name ORDER BY e.timestamp ASC)
                      FILTER (WHERE e.name IS NOT NULL))[1] AS name,
                   MIN(e.timestamp) AS started_at,
                   (ARRAY_AGG(e.outcome ORDER BY e.timestamp DESC)
                      FILTER (WHERE e.outcome IS NOT NULL))[1] AS outcome,
                   MAX(e.duration_ms) AS duration_ms,
                   {safe_token_sum_sql(alias="e.")} AS tokens,
                   {safe_input_token_sum_sql(alias="e.")} AS input_tokens,
                   {safe_output_token_sum_sql(alias="e.")} AS output_tokens,
                   {safe_cost_sum_nullable_sql(alias="e.")} AS cost_usd,
                   {_PREFERRED_MODEL_SQL} AS model,
                   MAX(e.attributes->>'session_id') AS session_id
            FROM telemetry_events e
            INNER JOIN ids ON ids.trace_id = e.trace_id
            WHERE e.tenant_id = $1
              AND e.timestamp > NOW() - ($2::int * INTERVAL '1 second')
            GROUP BY e.trace_id
            ORDER BY MIN(e.timestamp) DESC
            """,
            org_id,
            window_secs,
            limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal traces: query failed: %s", redact_all(str(exc)))
        # As above: a failed query is not an empty account. An empty
        # `rows` is still returned as [] below, which is the honest
        # answer for a customer who genuinely has no traces yet.
        raise HTTPException(
            status_code=503,
            detail="Could not load traces; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    items: list[TraceListItem] = []
    for r in rows:
        status, severity = _map_trace_outcome(r.get("outcome"))
        name = str(r["name"] or r["trace_id"])
        cost_usd = _resolved_trace_cost_usd(
            cost_usd=(
                float(r["cost_usd"]) if r.get("cost_usd") is not None else None
            ),
            input_tokens=int(r["input_tokens"] or 0),
            output_tokens=int(r["output_tokens"] or 0),
            model=str(r["model"]) if r.get("model") else None,
        )
        items.append(
            TraceListItem(
                id=str(r["trace_id"]),
                agentId=str(r["agent_id"] or ""),
                name=name,
                status=status,  # type: ignore[arg-type]
                startedAt=_iso(r.get("started_at")),
                durationMs=int(round(float(r["duration_ms"] or 0))),
                tokens=int(r["tokens"] or 0),
                costUsd=cost_usd,
                severity=severity,  # type: ignore[arg-type]
                sessionId=str(r["session_id"]) if r.get("session_id") else None,
                signals=_trace_signal_summary(name=name, severity=severity, status=status),
                steps=[],
            )
        )
    return items


# ── GET /traces/{trace_id} ────────────────────────────────────────


@router.get("/traces/{trace_id}", response_model=TraceListItem)
async def get_portal_trace(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(..., description="Trace ID"),
    _user: dict = Depends(get_current_user),
) -> TraceListItem:
    """Single-trace detail — same shape as ``list_portal_traces`` rows,
    but with ``steps`` populated so ``RunTranscript`` has real spans.

    Steps come from ``TelemetryCollector.get_trace_tree`` — the same
    helper backing ``GET /observability/traces/{id}/tree`` — so this
    route can't drift from the observability transcript. Scoped by
    ``tenant_id = org_id`` on every query, matching RLS.
    """
    client = await _pg()
    if client is None:
        raise HTTPException(status_code=503, detail="Trace temporarily unavailable")

    async def _summary_row() -> Any:
        return await client.fetchrow(
            f"""
            SELECT trace_id,
                   {_PREFERRED_AGENT_ID_SQL} AS agent_id,
                   (ARRAY_AGG(name ORDER BY timestamp ASC)
                      FILTER (WHERE name IS NOT NULL))[1] AS name,
                   MIN(timestamp) AS started_at,
                   (ARRAY_AGG(outcome ORDER BY timestamp DESC)
                      FILTER (WHERE outcome IS NOT NULL))[1] AS outcome,
                   MAX(duration_ms) AS duration_ms,
                   {safe_token_sum_sql()} AS tokens,
                   {safe_input_token_sum_sql()} AS input_tokens,
                   {safe_output_token_sum_sql()} AS output_tokens,
                   {safe_cost_sum_nullable_sql()} AS cost_usd,
                   {_PREFERRED_MODEL_SQL_UNALIASED} AS model,
                   MAX(attributes->>'session_id') AS session_id
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            GROUP BY trace_id
            """,
            org_id,
            trace_id,
        )

    async def _trace_tree() -> Any:
        from eden.observability.telemetry_collector import get_telemetry_collector

        collector = await get_telemetry_collector()
        # Portal transcript needs span structure + timing; skip expensive
        # per-span message_store reconstruct (full bodies stay on
        # observability tree routes).
        return await collector.get_trace_tree(org_id, trace_id, hydrate_bodies=False)

    try:
        row, tree = await asyncio.gather(
            _summary_row(),
            _trace_tree(),
            return_exceptions=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal trace detail: parallel fetch failed: %s", redact_all(str(exc)))
        raise HTTPException(status_code=503, detail="Trace temporarily unavailable") from exc

    if isinstance(row, BaseException):
        logger.warning("portal trace detail: summary query failed: %s", row)
        raise HTTPException(status_code=503, detail="Trace temporarily unavailable") from row

    if row is None:
        raise HTTPException(status_code=404, detail="Trace not found")

    def _steps_from_tree(tree_val: Any) -> list[TranscriptStep]:
        if tree_val is None or isinstance(tree_val, BaseException):
            return []
        try:
            return _flatten_tree(tree_val.root_spans)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "portal trace detail: flatten tree failed for %s: %s",
                trace_id,
                redact_all(str(exc)),
            )
            # Propagate so the empty-transcript retry / 503 path runs —
            # never return steps=[] on a flatten fault (looks like "no spans").
            raise

    steps: list[TranscriptStep] = []
    try:
        steps = _steps_from_tree(tree)
    except Exception as exc:  # noqa: BLE001 — flatten fault; retry/503 below
        logger.warning(
            "portal trace detail: steps from tree failed for %s: %s",
            trace_id,
            redact_all(str(exc)),
        )
    if isinstance(tree, BaseException):
        logger.warning(
            "portal trace detail: get_trace_tree failed for %s: %s",
            trace_id,
            tree,
        )
    # Summary found the run but the transcript is empty — retry the tree
    # sequentially (avoids rare pinned-conn races) before failing hard.
    # Returning 200 + steps=[] painted "No spans" forever and hid the
    # real failure from the FE error panel.
    if not steps:
        try:
            tree_retry = await _trace_tree()
            steps = _steps_from_tree(tree_retry)
            if isinstance(tree_retry, BaseException):
                raise tree_retry
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "portal trace detail: tree retry failed for %s: %s",
                trace_id,
                redact_all(str(exc)),
            )
            raise HTTPException(
                status_code=503,
                detail="Trace transcript temporarily unavailable",
            ) from exc
        if not steps:
            logger.warning(
                "portal trace detail: empty transcript for %s despite summary row",
                trace_id,
            )
            raise HTTPException(
                status_code=503,
                detail="Trace transcript temporarily unavailable",
            )

    status, severity = _map_trace_outcome(row.get("outcome"))
    name = str(row["name"] or row["trace_id"])
    cost_usd = _resolved_trace_cost_usd(
        cost_usd=(
            float(row["cost_usd"]) if row.get("cost_usd") is not None else None
        ),
        input_tokens=int(row["input_tokens"] or 0),
        output_tokens=int(row["output_tokens"] or 0),
        model=str(row["model"]) if row.get("model") else None,
    )
    # Prefer per-step cost rollup when the tree hydrated stamped costs.
    known_step_costs = [
        float(s.costUsd) for s in steps if s.costUsd is not None
    ]
    step_cost = sum(known_step_costs) if known_step_costs else None
    if step_cost is not None and (cost_usd is None or step_cost > cost_usd):
        cost_usd = round(step_cost, 6)
    return TraceListItem(
        id=str(row["trace_id"]),
        agentId=str(row["agent_id"] or ""),
        name=name,
        status=status,  # type: ignore[arg-type]
        startedAt=_iso(row.get("started_at")),
        durationMs=int(round(float(row["duration_ms"] or 0))),
        tokens=int(row["tokens"] or 0),
        costUsd=cost_usd,
        severity=severity,  # type: ignore[arg-type]
        sessionId=str(row["session_id"]) if row.get("session_id") else None,
        signals=_trace_signal_summary(name=name, severity=severity, status=status),
        steps=steps,
    )


# ── GET /sessions ─────────────────────────────────────────────────


@router.get("/sessions", response_model=list[SessionRollup])
async def list_portal_sessions(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[SessionRollup]:
    """Session rollups mapped to portal ``SessionRollup`` (empty OK)."""
    try:
        from eden.services.agent_sessions import AgentSessionService

        sessions = await AgentSessionService().list_sessions(
            org_id, limit=limit, preview_trace_limit=40
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal sessions: service unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Sessions temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[SessionRollup] = []
    for s in sessions:
        data = s.to_dict() if hasattr(s, "to_dict") else dict(s)
        success = data.get("success")
        if success is True:
            outcome = "ok"
        elif success is False:
            outcome = "error"
        else:
            outcome = "mixed"
        duration_ms = 0
        try:
            started = data.get("started_at")
            ended = data.get("ended_at")
            if started and ended:
                st = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                en = datetime.fromisoformat(str(ended).replace("Z", "+00:00"))
                duration_ms = max(0, int((en - st).total_seconds() * 1000))
        except Exception:
            duration_ms = 0
        trace_ids = list(data.get("trace_ids") or [])
        turn_count = int(data.get("turn_count") or len(trace_ids))
        failure_reason = data.get("failure_reason")
        diagnosis = None
        if failure_reason:
            diagnosis = str(failure_reason)
        elif outcome == "error":
            diagnosis = "Session ended unsuccessfully"
        elif outcome == "ok" and turn_count > 0:
            diagnosis = f"{turn_count} turn{'s' if turn_count != 1 else ''} completed"
        session_id = str(data.get("id") or "")
        out.append(
            SessionRollup(
                id=session_id,
                agentId=str(data.get("agent_id") or ""),
                userId=str(data["user_id"]) if data.get("user_id") else None,
                startedAt=_iso(data.get("started_at")),
                endedAt=_iso(data.get("ended_at")) or None,
                turnCount=turn_count,
                outcome=outcome,  # type: ignore[arg-type]
                durationMs=duration_ms,
                totalTokens=int(data.get("total_tokens") or 0),
                costUsd=(
                    float(data["cost_usd"])
                    if data.get("cost_usd") is not None
                    else None
                ),
                lastErrorSummary=str(failure_reason) if failure_reason else None,
                diagnosis=diagnosis,
                relatedIssueIds=[],  # filled below
                traceIds=[str(t) for t in trace_ids],
            )
        )

    related = await _related_issue_ids_by_session(
        org_id, [s.id for s in out if s.id]
    )
    for s in out:
        s.relatedIssueIds = related.get(s.id, [])[:10]
    return out


# ── GET /issues ───────────────────────────────────────────────────


@router.get("/issues", response_model=list[IssueCard])
async def list_portal_issues(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[IssueCard]:
    """Issue cards with status mapped to open|acknowledged|resolved."""
    try:
        from eden.issues.repo import IssuesRepo

        issues = await IssuesRepo().list_issues(org_id, limit=limit, offset=0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal issues: repo unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Issues temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    # ``example_stumble_ids`` are stumble UUIDs — portal FE matches
    # ``occurrenceTraceIds`` against run ids. Resolve to real trace_ids.
    stumble_to_trace, _stumble_to_session = await _resolve_stumble_refs(
        org_id,
        [sid for i in issues for sid in (getattr(i, "example_stumble_ids", None) or [])],
    )

    out: list[IssueCard] = []
    for i in issues:
        triage = getattr(i, "triage_result", None) or {}
        if not isinstance(triage, dict):
            triage = {}
        example_ids = [str(x) for x in (getattr(i, "example_stumble_ids", None) or [])]
        occurrence: list[str] = []
        seen: set[str] = set()
        for sid in example_ids:
            tid = stumble_to_trace.get(sid)
            if tid and tid not in seen:
                seen.add(tid)
                occurrence.append(tid)
        out.append(
            IssueCard(
                id=str(i.id),
                title=_clip_text(i.title or "", 240),
                summary=_clip_text(triage.get("summary") or i.title or "", 400),
                body=_clip_text(triage.get("body") or triage.get("detail") or "", 800),
                severity=_map_issue_severity(getattr(i, "severity", None)),  # type: ignore[arg-type]
                status=_map_issue_status(getattr(i, "status", None)),  # type: ignore[arg-type]
                agentId=str(getattr(i, "agent_id", None) or ""),
                fingerprint=str(getattr(i, "fingerprint", None) or ""),
                detector=str(getattr(i, "kind", None) or ""),
                environment=str(triage.get("environment") or ""),
                occurrenceTraceIds=occurrence[:20],
                firstSeen=_iso(getattr(i, "first_seen", None)),
                lastSeen=_iso(getattr(i, "last_seen", None)),
                signalCount=int(getattr(i, "stumble_count", 0) or 0),
                relatedSignalId=None,
                errorSample=_clip_text(
                    triage.get("error_sample") or triage.get("error") or "", 400
                ),
                impact=_clip_text(triage.get("impact") or "", 400),
                suggestedFix=_clip_text(
                    triage.get("suggested_fix") or triage.get("fix") or "", 400
                ),
                tags=[],
            )
        )
    return out


async def _resolve_stumble_refs(
    org_id: str,
    stumble_ids: list[Any],
) -> tuple[dict[str, str], dict[str, str]]:
    """Map stumble UUID → ``(trace_id, session_id)``."""
    ids = sorted({str(x) for x in stumble_ids if x})
    if not ids:
        return {}, {}
    client = await _pg()
    if client is None:
        return {}, {}
    try:
        rows = await client.fetch(
            """
            SELECT id::text AS id, trace_id, session_id
            FROM agent_stumbles
            WHERE org_id = $1 AND id = ANY($2::uuid[])
            """,
            org_id,
            ids,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("portal issues: stumble resolve failed: %s", redact_all(str(exc)))
        return {}, {}
    to_trace: dict[str, str] = {}
    to_session: dict[str, str] = {}
    for r in rows:
        sid = str(r["id"])
        if r.get("trace_id"):
            to_trace[sid] = str(r["trace_id"])
        if r.get("session_id"):
            to_session[sid] = str(r["session_id"])
    return to_trace, to_session


async def _related_issue_ids_by_session(
    org_id: str,
    session_ids: list[str],
) -> dict[str, list[str]]:
    """Map session_id → open/active issue ids via agent_stumbles."""
    ids = sorted({s for s in session_ids if s})
    if not ids:
        return {}
    client = await _pg()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT DISTINCT s.session_id::text AS session_id,
                            i.id::text AS issue_id
            FROM agent_stumbles s
            INNER JOIN agent_issues i
              ON i.org_id = s.org_id
             AND i.fingerprint = s.fingerprint
            WHERE s.org_id = $1
              AND s.session_id = ANY($2::text[])
              AND COALESCE(i.status, 'open') NOT IN ('resolved', 'ignored')
            ORDER BY s.session_id, i.id
            LIMIT 500
            """,
            org_id,
            ids,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "portal sessions: related issues lookup failed: %s",
            redact_all(str(exc)),
        )
        return {}
    out: dict[str, list[str]] = {}
    for r in rows:
        sid = str(r["session_id"] or "")
        iid = str(r["issue_id"] or "")
        if not sid or not iid:
            continue
        bucket = out.setdefault(sid, [])
        if iid not in bucket:
            bucket.append(iid)
    return out


# ── GET /signals ──────────────────────────────────────────────────


@router.get("/signals", response_model=list[SignalCard])
async def list_portal_signals(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> list[SignalCard]:
    """Signal cards (notify defaults when fields absent)."""
    client = await _pg()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Signals temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    try:
        rows = await client.fetch(
            """
            SELECT id, description, rule, enabled, match_count,
                   cluster_id, created_at, updated_at
            FROM nl_signals
            WHERE org_id = $1
            ORDER BY updated_at DESC
            LIMIT 200
            """,
            org_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal signals: query failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Signals temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[SignalCard] = []
    for r in rows:
        rule = r.get("rule")
        if isinstance(rule, str):
            try:
                rule = json.loads(rule)
            except Exception:
                rule = {}
        if not isinstance(rule, dict):
            rule = {}
        scope = rule.get("scope") if isinstance(rule.get("scope"), dict) else {}
        agent_id = scope.get("agent_id") or scope.get("agentId")
        condition = ""
        if rule.get("metric"):
            condition = (
                f"{rule.get('metric')} {rule.get('op', '')} {rule.get('threshold', '')}".strip()
            )
        notify = bool(rule.get("notify", False))
        raw_channel = rule.get("channel") or rule.get("notify_channel")
        channel = _normalize_notify_channel(raw_channel) if raw_channel not in (None, "") else None
        out.append(
            SignalCard(
                id=str(r["id"]),
                name=str(r.get("description") or "")[:80],
                description=str(r.get("description") or ""),
                kind=_signal_kind_from_rule(rule),  # type: ignore[arg-type]
                severity="warn",
                condition=condition or str(r.get("description") or ""),
                agentId=str(agent_id) if agent_id else None,
                enabled=bool(r.get("enabled", True)),
                notify=notify,
                channel=channel,  # type: ignore[arg-type]
                destination=str(rule.get("destination") or rule.get("notify_destination") or "")
                or None,
                hits24h=int(r.get("match_count") or 0),
                lastHit=_iso(r.get("updated_at")) or None,
                relatedIssueIds=[],
                exampleTraceIds=[],
            )
        )
    return out


# ── GET /alerts/rules + /alerts/events ────────────────────────────


@router.get("/alerts/rules", response_model=list[AlertRuleCard])
async def list_portal_alert_rules(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> list[AlertRuleCard]:
    """Alert rules from NL alert sources when importable."""
    try:
        from eden.alerts import repo as alerts_repo

        rules = await alerts_repo.list_nl_rules(org_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal alert rules: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Alert rules temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[AlertRuleCard] = []
    for r in rules:
        channel, destination = _pick_channel(r.get("channels"))
        out.append(
            AlertRuleCard(
                id=str(r.get("id") or ""),
                name=str(r.get("name") or ""),
                description=str(r.get("nl_text") or ""),
                condition=str(r.get("compiled_eql") or r.get("nl_text") or ""),
                severity="warn",
                agentId=None,
                channel=channel,  # type: ignore[arg-type]
                destination=destination,
                enabled=bool(r.get("enabled", True)),
                fireCount24h=0,
                signalId=None,
            )
        )
    return out


@router.get("/alerts/events", response_model=list[AlertEventCard])
async def list_portal_alert_events(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[AlertEventCard]:
    """Alert events from NL alert sources when importable."""
    try:
        from eden.alerts import repo as alerts_repo

        events, _total = await alerts_repo.list_alert_events(org_id, limit=limit, offset=0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal alert events: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Alert events temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[AlertEventCard] = []
    for e in events:
        payload = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        out.append(
            AlertEventCard(
                id=str(e.get("id") or ""),
                ruleId=str(e.get("rule_id") or ""),
                title=str(e.get("title") or ""),
                body=str(payload.get("body") or e.get("triage_reason") or ""),
                severity=_alert_severity(e.get("severity")),  # type: ignore[arg-type]
                status=_alert_event_status(  # type: ignore[arg-type]
                    acknowledged=bool(e.get("acknowledged")),
                    verdict=e.get("triage_verdict"),
                ),
                agentId=str(payload.get("agent_id") or ""),
                firedAt=_iso(e.get("created_at")),
                relatedIssueId=str(payload["issue_id"]) if payload.get("issue_id") else None,
                relatedTraceId=str(payload["trace_id"]) if payload.get("trace_id") else None,
            )
        )
    return out


# ── GET /cost/drivers ─────────────────────────────────────────────


@router.get("/cost/drivers", response_model=list[CostDriverCard])
async def list_portal_cost_drivers(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(25, ge=1, le=100),
    _user: dict = Depends(get_current_user),
) -> list[CostDriverCard]:
    """Cost drivers derived from optimization / insights when easy."""
    insights: list[Any] = []
    try:
        from eden.insights.insights_service import InsightsService

        svc = InsightsService()
        raw = svc.get_insights(org_id, limit=limit)
        insights = list(raw or [])
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal cost drivers: insights unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Cost drivers temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[CostDriverCard] = []
    for item in insights:
        data = item.to_dict() if hasattr(item, "to_dict") else dict(item)
        detector = str(data.get("detector") or "")
        summary = str(data.get("summary") or "")
        # Prefer cost / performance / regression flavored insights.
        blob = f"{detector} {summary}".lower()
        if not any(
            k in blob for k in ("cost", "token", "latency", "waste", "regress", "model", "tool")
        ):
            continue
        conf = float(data.get("confidence") or 0)
        meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        est = meta.get("est_save_usd") or meta.get("estimated_savings_usd") or 0
        try:
            est_f = float(est)
        except (TypeError, ValueError):
            est_f = 0.0
        agent_id = str(meta.get("agent_id") or "")
        out.append(
            CostDriverCard(
                id=str(data.get("insight_id") or data.get("id") or ""),
                title=summary[:120] or detector or "Cost opportunity",
                summary=summary,
                kind=_cost_driver_kind(detector, summary),  # type: ignore[arg-type]
                agentId=agent_id,
                estSaveUsd=round(est_f, 4),
                confidence="high" if conf >= 0.8 else "med",
                traceIds=[str(t) for t in (data.get("affected_trace_ids") or [])][:20],
                primaryAction="open_traces",
            )
        )
        if len(out) >= limit:
            break
    return out


# ── GET /workspace ────────────────────────────────────────────────


@router.get("/workspace", response_model=WorkspaceCard)
async def get_portal_workspace(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> WorkspaceCard:
    """Assemble workspace projection from org row + settings merge.

    Uses ``WorkspacePrefs`` keys (timezone, density, retention_days,
    pii_redaction, notify fields). No ``region`` field.
    """
    defaults = WorkspacePrefs()
    client = await _pg()
    if client is None:
        return WorkspaceCard(id=org_id)

    try:
        row = await client.fetchrow(
            """
            SELECT id, name, slug, settings, is_personal, created_at
            FROM organizations
            WHERE id = $1
            """,
            org_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal workspace: org query failed: %s", redact_all(str(exc)))
        # Older schemas may lack is_personal.
        try:
            row = await client.fetchrow(
                """
                SELECT id, name, slug, settings, created_at
                FROM organizations
                WHERE id = $1
                """,
                org_id,
            )
        except Exception as exc2:  # noqa: BLE001
            logger.debug("portal workspace: fallback failed: %s", exc2)
            return WorkspaceCard(id=org_id)

    if row is None:
        return WorkspaceCard(id=org_id)

    settings = _as_dict(row.get("settings"))
    density_raw = settings.get("density")
    retention_raw = settings.get("retention_days")
    notify_ch = settings.get("default_notify_channel") or settings.get("notify_channel")
    prefs = WorkspacePrefs(
        timezone=str(settings.get("timezone") or defaults.timezone),
        density=(density_raw if density_raw in ("comfortable", "compact") else defaults.density),
        retention_days=(
            retention_raw  # type: ignore[arg-type]
            if retention_raw in (7, 30, 90, 365)
            else defaults.retention_days
        ),
        pii_redaction=bool(
            settings["pii_redaction"] if "pii_redaction" in settings else defaults.pii_redaction
        ),
        default_notify_channel=(
            _normalize_notify_channel(notify_ch)  # type: ignore[arg-type]
        ),
        default_notify_destination=str(
            settings.get("default_notify_destination")
            or settings.get("notify_destination")
            or defaults.default_notify_destination
        ),
    )
    plan = str(settings.get("plan_label") or settings.get("plan") or "")
    is_personal = bool(row.get("is_personal")) if "is_personal" in row.keys() else False

    return WorkspaceCard(
        id=str(row["id"]),
        name=str(row.get("name") or ""),
        slug=str(row.get("slug") or ""),
        planLabel=plan,
        isPersonal=is_personal,
        timezone=prefs.timezone,
        createdAt=_iso(row.get("created_at")),
        density=prefs.density,
        retentionDays=prefs.retention_days,
        piiRedaction=prefs.pii_redaction,
        defaultNotifyChannel=prefs.default_notify_channel,
        defaultNotifyDestination=prefs.default_notify_destination,
    )


# ── helpers for settings / improve / guardrails ───────────────────


def _map_improve_status(raw: str | None) -> str:
    s = (raw or "draft").lower()
    if s in ("draft", "pending_review"):
        return "needs_you"
    if s in ("approved", "in_progress"):
        return "in_progress"
    if s in ("pr_opened", "verify", "verifying"):
        return "verify"
    if s in ("merged", "done", "completed"):
        return "done"
    if s in ("rejected", "snoozed", "superseded", "blocked"):
        return "blocked"
    return "needs_you"


def _map_improve_kind(raw: str | None) -> str:
    s = (raw or "config").lower()
    if "prompt" in s:
        return "prompt_update"
    if "tool" in s or "policy" in s:
        return "tool_policy"
    if s in ("prompt_update", "tool_policy", "config"):
        return s
    return "config"


def _map_member_role(raw: str | None) -> str:
    s = (raw or "member").lower()
    if s in ("owner", "admin", "member", "viewer"):
        return s
    if s in ("org_owner", "organisation_owner"):
        return "owner"
    if s in ("org_admin", "administrator"):
        return "admin"
    if s in ("read", "readonly", "guest"):
        return "viewer"
    return "member"


def _map_dataset_source(raw: str | None) -> str:
    s = (raw or "manual").lower()
    if s in ("traces", "issues", "manual", "import"):
        return s
    if "trace" in s:
        return "traces"
    if "issue" in s:
        return "issues"
    if "import" in s:
        return "import"
    return "manual"


def _map_experiment_status(raw: str | None) -> str:
    s = (raw or "completed").lower()
    if s in ("completed", "complete", "done", "succeeded", "success"):
        return "completed"
    if s in ("running", "in_progress", "pending", "queued", "active"):
        return "running"
    if s in ("failed", "error", "cancelled", "canceled"):
        return "failed"
    return "completed"


def _map_guardrail_status(raw: str | None) -> str:
    s = (raw or "active").lower()
    if s in ("active", "enabled", "on"):
        return "active"
    if s in ("shadow", "dry_run", "dry-run", "monitor"):
        return "shadow"
    if s in ("disabled", "inactive", "off"):
        return "disabled"
    return "active"


def _map_guardrail_action(raw: str | None) -> str:
    s = (raw or "flag").lower()
    if s in ("block", "deny", "escalate"):
        return "block"
    if s in ("redact",):
        return "redact"
    # allow / warn / flag → flag
    return "flag"


def _map_guardrail_kind(raw: str | None) -> str:
    s = (raw or "custom").lower()
    if "pii" in s:
        return "pii"
    if "toxic" in s or "content" in s:
        return "toxicity"
    if "tool" in s or "allowlist" in s:
        return "tool_allowlist"
    if "rate" in s:
        return "rate_limit"
    if s in ("pii", "toxicity", "tool_allowlist", "rate_limit", "custom"):
        return s
    return "custom"


def _map_debugger_mode(raw: str | None) -> str:
    s = (raw or "inspect").lower()
    if s in ("replay", "rerun", "time-travel", "time_travel"):
        return "replay"
    if s in ("compare", "diff"):
        return "compare"
    return "inspect"


def _map_audit_pack_kind(event_type: str | None, subtype: str | None) -> str:
    blob = f"{event_type or ''} {subtype or ''}".lower()
    if "verify" in blob or "attest" in blob:
        return "verify"
    if "export" in blob or "pack" in blob:
        return "export"
    return "ledger"


# ── GET /keys ─────────────────────────────────────────────────────


@router.get("/keys", response_model=list[ApiKeyCard])
async def list_portal_keys(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(100, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[ApiKeyCard]:
    """API key cards from ``org_api_keys`` (revoked_at → status)."""
    client = await _pg()
    if client is None:
        # "You have no API keys" and "we could not read your API keys"
        # must not be the same screen. This is the same defect class as
        # GET /orgs returning [] mid-provisioning: the customer sees an
        # empty list and mints a duplicate key they did not need.
        raise HTTPException(
            status_code=503,
            detail="Could not load API keys; please retry",
            headers={"Retry-After": "5"},
        )
    try:
        rows = await client.fetch(
            """
            SELECT id, name, key_prefix, scopes, created_by,
                   last_used_at, created_at, revoked_at, active
            FROM org_api_keys
            WHERE org_id = $1::uuid
            ORDER BY created_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal keys: query failed: %s", redact_all(str(exc)))
        # A genuinely empty result is still [] below — that is the
        # honest answer for an org with no keys yet.
        raise HTTPException(
            status_code=503,
            detail="Could not load API keys; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[ApiKeyCard] = []
    for r in rows:
        revoked = r.get("revoked_at") is not None
        active = r.get("active")
        status = "revoked" if revoked or active is False else "active"
        scopes = r.get("scopes") or []
        if isinstance(scopes, str):
            try:
                scopes = json.loads(scopes)
            except Exception:
                scopes = []
        if not isinstance(scopes, list):
            scopes = []
        out.append(
            ApiKeyCard(
                id=str(r["id"]),
                name=str(r.get("name") or ""),
                prefix=str(r.get("key_prefix") or ""),
                scopes=[str(s) for s in scopes],
                status=status,  # type: ignore[arg-type]
                createdAt=_iso(r.get("created_at")),
                lastUsed=_iso(r.get("last_used_at")) or None,
                createdBy=str(r["created_by"]) if r.get("created_by") else "",
            )
        )
    return out


# ── GET /members ──────────────────────────────────────────────────


@router.get("/members", response_model=list[MemberCard])
async def list_portal_members(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(200, ge=1, le=500),
    _user: dict = Depends(get_current_user),
) -> list[MemberCard]:
    """Members + pending invites (invited) as portal ``MemberCard``s."""
    client = await _pg()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Members temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    async def _fetch_members() -> list[dict]:
        try:
            return await client.fetch(
                """
                SELECT om.user_id, om.role, om.last_active_at,
                       u.email, u.name
                FROM org_members om
                JOIN users u ON u.id = om.user_id
                WHERE om.org_id = $1
                ORDER BY om.joined_at ASC
                LIMIT $2
                """,
                org_id,
                limit,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal members: query failed: %s", redact_all(str(exc)))
            raise HTTPException(
                status_code=503,
                detail="Members temporarily unavailable; please retry",
                headers={"Retry-After": "5"},
            ) from exc

    async def _fetch_invites() -> list[dict]:
        try:
            from eden.services.invitation_service import get_pending_invitations

            return await get_pending_invitations(org_id) or []
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal members: invites skipped: %s", redact_all(str(exc)))
            return []

    rows, invites = await asyncio.gather(_fetch_members(), _fetch_invites())

    out: list[MemberCard] = []
    for r in rows:
        out.append(
            MemberCard(
                id=str(r["user_id"]),
                name=str(r.get("name") or ""),
                email=str(r.get("email") or ""),
                role=_map_member_role(r.get("role")),  # type: ignore[arg-type]
                status="active",
                lastActive=_iso(r.get("last_active_at")),
            )
        )

    remaining = max(0, limit - len(out))
    for inv in invites[:remaining]:
        out.append(
            MemberCard(
                id=str(inv.get("id") or inv.get("email") or ""),
                name=str(inv.get("email") or ""),
                email=str(inv.get("email") or ""),
                role=_map_member_role(inv.get("role")),  # type: ignore[arg-type]
                status="invited",
                lastActive=_iso(inv.get("created_at")),
            )
        )

    return out


# ── GET /audit/events + /audit/packs ──────────────────────────────


@router.get("/audit/events", response_model=list[AuditEventCard])
async def list_portal_audit_events(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[AuditEventCard]:
    """Audit events from ``org_audit_log`` when available."""
    client = await _pg()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Audit events temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )
    try:
        rows = await client.fetch(
            """
            SELECT oal.id, oal.user_id, oal.action,
                   oal.target_type, oal.target_id, oal.metadata,
                   oal.created_at,
                   u.email AS user_email, u.name AS user_name
            FROM org_audit_log oal
            LEFT JOIN users u ON u.id = oal.user_id
            WHERE oal.org_id = $1
            ORDER BY oal.created_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal audit events: query failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Audit events temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[AuditEventCard] = []
    for r in rows:
        actor = (
            str(r.get("user_name") or "")
            or str(r.get("user_email") or "")
            or str(r.get("user_id") or "")
        )
        target_type = r.get("target_type") or ""
        target_id = r.get("target_id") or ""
        target = f"{target_type}:{target_id}".strip(":") if (target_type or target_id) else ""
        meta = r.get("metadata")
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        detail = None
        href = None
        if isinstance(meta, dict):
            detail = str(meta.get("detail") or meta.get("summary") or "") or None
            href = str(meta["href"]) if meta.get("href") else None
        out.append(
            AuditEventCard(
                id=str(r["id"]),
                at=_iso(r.get("created_at")),
                actor=actor,
                action=str(r.get("action") or ""),
                target=target,
                detail=detail,
                href=href,
            )
        )
    return out


@router.get("/audit/packs", response_model=list[AuditPackCard])
async def list_portal_audit_packs(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[AuditPackCard]:
    """Compliance / ledger packs when available."""
    try:
        from eden.governance.compliance_pack import AgentAuditLedgerWriter

        events = await AgentAuditLedgerWriter().query(org_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal audit packs: ledger unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Audit packs temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[AuditPackCard] = []
    for e in events or []:
        et = str(e.get("event_type") or "")
        subtype = str(e.get("event_subtype") or "")
        # Prefer compliance / verify / export flavoured rows.
        kind = _map_audit_pack_kind(et, subtype)
        if et and et not in ("compliance", "audit", "ledger") and kind == "ledger":
            # Still include general ledger rows as kind=ledger.
            pass
        payload = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        rows_n = 0
        try:
            rows_n = int(payload.get("rows") or payload.get("event_count") or 1)
        except (TypeError, ValueError):
            rows_n = 1
        verified = bool(payload.get("verified", kind == "ledger"))
        out.append(
            AuditPackCard(
                id=str(e.get("id") or ""),
                at=_iso(e.get("created_at")),
                agentId=str(e.get("agent_id") or ""),
                kind=kind,  # type: ignore[arg-type]
                actor=str(e.get("actor_id") or e.get("actor_type") or ""),
                entryHash=str(e.get("entry_hash") or ""),
                verified=verified,
                rows=rows_n,
            )
        )
    return out


# ── GET /evals/* ──────────────────────────────────────────────────


@router.get("/evals/datasets", response_model=list[DatasetCard])
async def list_portal_datasets(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[DatasetCard]:
    """Eval dataset cards from DatasetHub when available."""
    try:
        from eden.datasets.hub import DatasetHub

        records = await DatasetHub().list_datasets(org_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal datasets: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Datasets temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[DatasetCard] = []
    for rec in records or []:
        data = rec.to_dict() if hasattr(rec, "to_dict") else dict(rec)
        out.append(
            DatasetCard(
                id=str(data.get("id") or ""),
                name=str(data.get("name") or ""),
                description=str(data.get("description") or ""),
                agentId=None,
                source=_map_dataset_source(data.get("source_type")),  # type: ignore[arg-type]
                version=str(data.get("version") or "1"),
                updatedAt=_iso(data.get("updated_at") or data.get("created_at")),
                caseIds=[],
            )
        )
    return out


@router.get("/evals/playgrounds", response_model=list[PlaygroundCard])
async def list_portal_playgrounds(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[PlaygroundCard]:
    """Eval playground cards when available."""
    try:
        from eden.playground.service import PlaygroundService

        records = await PlaygroundService().list(org_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal playgrounds: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Playgrounds temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[PlaygroundCard] = []
    for rec in records or []:
        data = rec.to_dict() if hasattr(rec, "to_dict") else dict(rec)
        cfg = data.get("config") if isinstance(data.get("config"), dict) else {}
        variants = cfg.get("variants") if isinstance(cfg.get("variants"), list) else []
        out.append(
            PlaygroundCard(
                id=str(data.get("id") or ""),
                name=str(data.get("name") or ""),
                agentId=str(cfg["agent_id"]) if cfg.get("agent_id") else None,
                datasetId=str(cfg["dataset_id"]) if cfg.get("dataset_id") else None,
                prompt=str(cfg.get("prompt") or ""),
                model=str(cfg.get("model") or ""),
                dirty=bool(cfg.get("dirty", False)),
                variants=[v for v in variants if isinstance(v, dict)],
                lastRunId=str(cfg["last_run_id"]) if cfg.get("last_run_id") else None,
            )
        )
    return out


@router.get("/evals/experiments", response_model=list[ExperimentSummary])
async def list_portal_experiments(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[ExperimentSummary]:
    """Offline eval experiment summaries when available."""
    try:
        from eden.experiments.offline_runner import OfflineExperimentRunner

        rows = await OfflineExperimentRunner().list_experiments(org_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal experiments: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Experiments temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[ExperimentSummary] = []
    for r in rows or []:
        data = dict(r)
        out.append(
            ExperimentSummary(
                id=str(data.get("id") or ""),
                name=str(data.get("name") or ""),
                datasetId=str(data.get("dataset_id") or ""),
                playgroundId=None,
                status=_map_experiment_status(data.get("status")),  # type: ignore[arg-type]
                createdAt=_iso(data.get("created_at")),
                avgScores={},
                latencyMs=None,
                costUsd=None,
                errorRate=None,
                suggestedBaselineId=None,
            )
        )
    return out


# ── GET /improve/plans ────────────────────────────────────────────


@router.get("/improve/plans", response_model=list[ImprovePlanCard])
async def list_portal_improve_plans(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[ImprovePlanCard]:
    """Improve plans with statuses mapped to portal ImproveStatus."""
    try:
        from eden.improvement import plans_repo

        plans = await plans_repo.list_plans(org_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal improve plans: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Improve plans temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[ImprovePlanCard] = []
    for p in plans or []:
        evidence = p.get("evidence") if isinstance(p.get("evidence"), dict) else {}
        triage = p.get("triage_snapshot") if isinstance(p.get("triage_snapshot"), dict) else {}
        issue_ids = evidence.get("issue_ids") or triage.get("issue_ids") or []
        case_ids = evidence.get("case_ids") or triage.get("case_ids") or []
        if not isinstance(issue_ids, list):
            issue_ids = []
        if not isinstance(case_ids, list):
            case_ids = []
        out.append(
            ImprovePlanCard(
                id=str(p.get("id") or ""),
                title=str(p.get("title") or ""),
                status=_map_improve_status(p.get("status")),  # type: ignore[arg-type]
                kind=_map_improve_kind(p.get("plan_kind")),
                agentId=str(p["agent_id"]) if p.get("agent_id") else None,
                issueIds=[str(x) for x in issue_ids],
                caseIds=[str(x) for x in case_ids],
                baselineId=(str(evidence["baseline_id"]) if evidence.get("baseline_id") else None),
                compareId=(str(evidence["compare_id"]) if evidence.get("compare_id") else None),
            )
        )
    return out


# ── GET /compare/experiments ──────────────────────────────────────


@router.get("/compare/experiments", response_model=list[AbExperimentCard])
async def list_portal_ab_experiments(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> list[AbExperimentCard]:
    """A/B / intelligence experiments when available."""
    tests: list[Any] = []
    try:
        from eden.api.routes import llmops as llmops_routes

        registry = getattr(llmops_routes, "_prompt_registry", None)
        if registry is not None:
            ab = getattr(registry, "_ab_tests", None) or {}
            tests = list(ab.values())
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal ab-tests: registry unavailable: %s", redact_all(str(exc)))

    if not tests:
        try:
            from eden.api.routes import llmops as llmops_routes

            tracker = getattr(llmops_routes, "_experiment_tracker", None)
            if tracker is not None and hasattr(tracker, "list_experiments"):
                for exp in tracker.list_experiments() or []:
                    data = exp.to_dict() if hasattr(exp, "to_dict") else dict(exp)
                    tests.append(data)
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal ab-tests: tracker unavailable: %s", redact_all(str(exc)))

    out: list[AbExperimentCard] = []
    for t in tests:
        data = t.to_dict() if hasattr(t, "to_dict") else (t if isinstance(t, dict) else {})
        if not data:
            continue
        status = str(data.get("status") or "active")
        if status in ("running",):
            status = "active"
        if status in ("completed",) and data.get("winner_id"):
            status = "winner_detected"
        arms: list[dict[str, Any]] = []
        if data.get("variant_a_id") or data.get("variant_b_id"):
            split = float(data.get("traffic_split") or 0.5)
            arms = [
                {
                    "key": "control",
                    "label": "Control",
                    "versionKey": str(data.get("variant_a_id") or ""),
                    "weight": round(1.0 - split, 4),
                },
                {
                    "key": "treatment",
                    "label": "Treatment",
                    "versionKey": str(data.get("variant_b_id") or ""),
                    "weight": round(split, 4),
                },
            ]
        elif isinstance(data.get("arms"), list):
            arms = [a for a in data["arms"] if isinstance(a, dict)]
        rec = "need_more_data"
        if data.get("winner_id") or status == "winner_detected":
            rec = "ship"
        elif status in ("stopped",):
            rec = "dont_ship"
        out.append(
            AbExperimentCard(
                id=str(data.get("test_id") or data.get("experiment_id") or data.get("id") or ""),
                name=str(
                    data.get("prompt_name") or data.get("experiment_name") or data.get("name") or ""
                ),
                status=status,
                agentId=str(data["agent_id"]) if data.get("agent_id") else None,
                recommendation=rec,
                arms=arms,
                sampleIds=[str(s) for s in (data.get("sample_ids") or [])],
            )
        )
    return out


# ── GET /guardrails/policies ──────────────────────────────────────


@router.get("/guardrails/policies", response_model=list[GuardrailPolicyCard])
async def list_portal_guardrail_policies(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> list[GuardrailPolicyCard]:
    """Guardrail policy cards (all statuses when queryable)."""
    client = await _pg()

    async def _fetch_policy_rows() -> list[dict[str, Any]] | None:
        """Returns policy rows, or ``None`` if no source was available."""
        rows: list[dict[str, Any]] = []
        if client is not None:
            try:
                raw = await client.fetch(
                    """
                    SELECT id, org_id, name, type, spec_json, action,
                           status, created_at
                    FROM guardrail_policies
                    WHERE org_id = $1
                    ORDER BY created_at DESC
                    LIMIT 200
                    """,
                    org_id,
                )
                for r in raw:
                    d = dict(r)
                    spec = d.get("spec_json")
                    if isinstance(spec, str):
                        try:
                            spec = json.loads(spec)
                        except Exception:
                            spec = {}
                    d["spec"] = spec if isinstance(spec, dict) else {}
                    rows.append(d)
            except Exception as exc:  # noqa: BLE001
                logger.warning("portal guardrails: direct query failed: %s", redact_all(str(exc)))

        if rows:
            return rows

        try:
            from eden.guardrails.policy import GuardrailPolicy

            envelope = await GuardrailPolicy().list(org_id)
            data = envelope.get("data") if isinstance(envelope, dict) else None
            policies = (data or {}).get("policies") if isinstance(data, dict) else []
            return [p for p in (policies or []) if isinstance(p, dict)]
        except Exception as exc:  # noqa: BLE001
            logger.warning("portal guardrails: service unavailable: %s", redact_all(str(exc)))
            return None

    async def _fetch_match_counts() -> dict[str, int]:
        match_counts: dict[str, int] = {}
        if client is not None:
            try:
                mrows = await client.fetch(
                    """
                    SELECT policy_id::text AS policy_id, COUNT(*)::int AS hits
                    FROM intervention_log
                    WHERE org_id = $1
                      AND created_at > NOW() - INTERVAL '24 hours'
                    GROUP BY policy_id
                    """,
                    org_id,
                )
                for m in mrows:
                    if m.get("policy_id"):
                        match_counts[str(m["policy_id"])] = int(m["hits"] or 0)
            except Exception as exc:  # noqa: BLE001
                logger.warning("portal guardrails: match counts skipped: %s", redact_all(str(exc)))
        return match_counts

    # These two queries are independent of each other (match counts only
    # need ``org_id``, not the fetched policy rows), so run them concurrently.
    rows, match_counts = await asyncio.gather(_fetch_policy_rows(), _fetch_match_counts())
    if rows is None:
        raise HTTPException(
            status_code=503,
            detail="Guardrail policies temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    out: list[GuardrailPolicyCard] = []
    for r in rows:
        pid = str(r.get("id") or "")
        spec = r.get("spec") if isinstance(r.get("spec"), dict) else {}
        agent_id = spec.get("agent_id") or spec.get("agentId")
        severity = str(spec.get("severity") or "medium")
        out.append(
            GuardrailPolicyCard(
                id=pid,
                name=str(r.get("name") or ""),
                kind=_map_guardrail_kind(r.get("type")),
                status=_map_guardrail_status(r.get("status")),  # type: ignore[arg-type]
                agentId=str(agent_id) if agent_id else None,
                severity=severity,
                matchCount24h=int(match_counts.get(pid, 0)),
                action=_map_guardrail_action(r.get("action")),  # type: ignore[arg-type]
            )
        )
    return out


# ── GET /debugger/sessions ────────────────────────────────────────


@router.get("/debugger/sessions", response_model=list[DebuggerSessionCard])
async def list_portal_debugger_sessions(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[DebuggerSessionCard]:
    """Debugger session cards when DebugSessionService is available."""
    try:
        from eden.debugger.session import DebugSessionService

        sessions = await DebugSessionService().list_sessions(org_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal debugger sessions: unavailable: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Debugger sessions temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    out: list[DebuggerSessionCard] = []
    for s in sessions or []:
        data = s.to_dict() if hasattr(s, "to_dict") else dict(s)
        runs = data.get("runs") if isinstance(data.get("runs"), list) else []
        compare_id = None
        mode = "inspect"
        if runs:
            last = runs[-1] if isinstance(runs[-1], dict) else {}
            compare_id = last.get("result_trace_id")
            mode = _map_debugger_mode(last.get("rerun_mode"))
            if compare_id:
                mode = "compare"
        notes = str(data.get("notes") or "")
        agent_id = ""
        # Optional agent hint stashed in notes as ``agent:<id>``.
        if notes.startswith("agent:"):
            agent_id = notes.split(":", 1)[1].split()[0].strip()
        out.append(
            DebuggerSessionCard(
                id=str(data.get("id") or ""),
                title=str(data.get("title") or ""),
                agentId=agent_id,
                sourceTraceId=(
                    str(data["source_trace_id"]) if data.get("source_trace_id") else None
                ),
                compareTraceId=str(compare_id) if compare_id else None,
                modeHint=mode,  # type: ignore[arg-type]
                notes=notes,
                updatedAt=_iso(data.get("updated_at") or data.get("created_at")),
            )
        )
    return out


# ── GET /assistant/threads ────────────────────────────────────────


@router.get("/assistant/threads", response_model=list[AssistantThreadCard])
async def list_portal_assistant_threads(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> list[AssistantThreadCard]:
    """Assistant threads from ai-insights / conversations when available."""
    client = await _pg()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Assistant threads temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        )

    user_id = user.get("user_id") if isinstance(user, dict) else None
    rows: list[Any] = []
    try:
        if user_id:
            rows = await client.fetch(
                """
                SELECT id, title, updated_at, created_at
                FROM ai_conversations
                WHERE org_id = $1 AND user_id = $2
                  AND archived_at IS NULL
                ORDER BY updated_at DESC
                LIMIT $3
                """,
                org_id,
                user_id,
                limit,
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, title, updated_at, created_at
                FROM ai_conversations
                WHERE org_id = $1
                  AND archived_at IS NULL
                ORDER BY updated_at DESC
                LIMIT $2
                """,
                org_id,
                limit,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("portal assistant threads: query failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Assistant threads temporarily unavailable; please retry",
            headers={"Retry-After": "5"},
        ) from exc

    ids = [str(r["id"]) for r in rows]
    counts: dict[str, int] = {}
    if ids:
        try:
            crows = await client.fetch(
                """
                SELECT conversation_id::text AS cid, COUNT(*)::int AS cnt
                FROM ai_conversation_messages
                WHERE conversation_id = ANY($1::text[])
                GROUP BY conversation_id
                """,
                ids,
            )
            counts = {str(c["cid"]): int(c["cnt"] or 0) for c in crows}
        except Exception:
            try:
                crows = await client.fetch(
                    """
                    SELECT conversation_id::text AS cid, COUNT(*)::int AS cnt
                    FROM ai_messages
                    WHERE conversation_id::text = ANY($1::text[])
                    GROUP BY conversation_id
                    """,
                    ids,
                )
                counts = {str(c["cid"]): int(c["cnt"] or 0) for c in crows}
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "portal assistant threads: message counts failed: %s", redact_all(str(exc))
                )

    out: list[AssistantThreadCard] = []
    for r in rows:
        sid = str(r["id"])
        out.append(
            AssistantThreadCard(
                id=sid,
                title=str(r.get("title") or ""),
                updatedAt=_iso(r.get("updated_at") or r.get("created_at")),
                pins=[],
                messageCount=counts.get(sid, 0),
            )
        )
    return out
