"""NL → EQL alert compiler (F81).

Reuses :func:`compile_signal` keyword extraction and maps the
structured rule to a read-only EQL ``SELECT`` the DSL parser accepts.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from eden.dsl.parser import EQLParser
from eden.services.cat2_intel.signals import CompiledRule, compile_signal

logger = logging.getLogger(__name__)

# Bare column/attribute names interpolated into generated EQL (e.g. the
# ``key`` in ``any.<key> = '<value>'``) must match this allowlist. Filter
# keys come from client-supplied ``context.filters`` (see
# ``CompileRequest`` in routes.py) gated only by org membership, so a key
# that doesn't look like a plain identifier is treated as a malicious
# payload and rejected outright rather than silently stripped.
#
# NOTE: this is matched with ``re.fullmatch`` (see ``_validate_filter_key``),
# not ``.match()`` against a ``^...$`` pattern. Python's bare ``$`` matches
# at end-of-string *or* immediately before a single trailing newline even
# without ``re.MULTILINE`` (e.g. ``re.match(r"^[a-z]+$", "abc\n")``
# succeeds), so a key like ``"agent_id\n"`` would previously slip through
# validation unchanged and be interpolated verbatim into the generated EQL.
# ``re.fullmatch`` has no such trailing-newline carve-out.
_SAFE_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class UnsafeFilterKeyError(ValueError):
    """Raised when a filter/scope key is not a safe bare identifier."""


def _validate_filter_key(key: str) -> str:
    if not isinstance(key, str) or not _SAFE_IDENTIFIER_RE.fullmatch(key):
        raise UnsafeFilterKeyError(
            f"invalid filter key {key!r}: must match {_SAFE_IDENTIFIER_RE.pattern}"
        )
    return key


def _escape_literal(value: Any) -> str:
    """Escape a value for use inside a single-quoted EQL/SQL string literal.

    ClickHouse string literals honor **both** SQL-standard ``'`` -> ``''``
    quote doubling *and* C-style backslash escape sequences (``\\'``,
    ``\\\\``, ``\\n``, ...). Escaping only the quote character (the
    convention this codebase otherwise uses, see
    ``eden.columnar.aggregations._escape_org_id`` and ``eden.dsl._common``,
    and the misleading "SQL-standard string-literal escape (not backslash)"
    comment in ``eden.data_platform.clickhouse_sink``) is unsafe: a value
    ending in an odd number of backslashes (e.g. the two characters ``x``
    and ``\\``) produces the fragment ``'x\\'``. Under ClickHouse's
    backslash-escape parsing, that trailing ``\\'`` is read as an escaped
    literal quote character rather than the closing delimiter, so the
    string literal fails to terminate where the code intends and a later
    quote elsewhere in the query can close it -- allowing injection of
    everything in between.

    The fix is to escape backslashes *first* (each ``\\`` -> ``\\\\``) so
    every backslash is unambiguously paired, and only *then* double any
    quote characters. Doing backslash-doubling first does not disturb the
    existing ``'`` -> ``''`` behaviour for values that contain no
    backslashes (i.e. it is backward compatible with every other literal
    this codebase already escapes this way) while closing the
    backslash-parity gap.
    """
    return str(value).replace("\\", "\\\\").replace("'", "''")


_METRIC_COLUMN: dict[str, str] = {
    "error_rate": "countIf(any.error IS NOT NULL) / greatest(count(), 1)",
    "refusal_rate": "countIf(any.outcome = 'refusal') / greatest(count(), 1)",
    "latency_p99": "quantile(0.99)(any.duration_ms)",
    "cost_per_call": "avg(any.cost_usd)",
    "tool_call_rate": "countIf(any.event_type = 'tool.call')",
    "completion_tokens": "avg(any.completion_tokens)",
    "prompt_tokens": "avg(any.prompt_tokens)",
    "user_satisfaction": "avg(any.user_satisfaction)",
}


def _scope_filters(rule: CompiledRule, context: dict[str, Any] | None) -> list[str]:
    clauses: list[str] = []
    ctx_filters = (context or {}).get("filters") or {}
    if isinstance(ctx_filters, dict):
        for key, value in ctx_filters.items():
            if value:
                safe_key = _validate_filter_key(key)
                clauses.append(f"any.{safe_key} = '{_escape_literal(value)}'")
    for key, value in rule.scope.items():
        safe_key = _validate_filter_key(key)
        clauses.append(f"any.{safe_key} = '{_escape_literal(value)}'")
    if (context or {}).get("trace_id"):
        clauses.append(f"trace_id = '{_escape_literal(context['trace_id'])}'")
    return clauses


def rule_to_eql(rule: CompiledRule, context: dict[str, Any] | None = None) -> str:
    """Map a :class:`CompiledRule` to an EQL query string."""
    filters = _scope_filters(rule, context)
    where = " AND ".join(filters) if filters else "1=1"

    if rule.metric == "cost_per_call":
        return (
            f"SELECT count() FROM telemetry_events "
            f"WHERE {where} AND any.cost_usd {rule.op} {rule.threshold}"
        )
    if rule.metric == "latency_p99":
        return (
            f"SELECT count() FROM telemetry_events "
            f"WHERE {where} AND any.duration_ms {rule.op} {rule.threshold}"
        )
    if rule.metric in ("error_rate", "refusal_rate"):
        col = "any.error IS NOT NULL" if rule.metric == "error_rate" else "any.outcome = 'refusal'"
        return (
            f"SELECT countIf({col}) FROM telemetry_events WHERE {where} "
            f"HAVING countIf({col}) / greatest(count(), 1) {rule.op} {rule.threshold}"
        )
    expr = _METRIC_COLUMN.get(rule.metric, "count()")
    return f"SELECT {expr} FROM telemetry_events WHERE {where}"


def filters_to_nl(filters: dict[str, str]) -> str:
    """Build a plain-English alert seed from trace filter chips."""
    parts: list[str] = []
    if filters.get("outcome"):
        parts.append(f"outcome is {filters['outcome']}")
    if filters.get("realm"):
        parts.append(f"realm is {filters['realm']}")
    if filters.get("agent_id"):
        parts.append(f"agent_id is {filters['agent_id']}")
    if not parts:
        return "Alert me when error rate exceeds 5% in the last hour"
    joined = " and ".join(parts)
    return f"Alert me when traces match {joined} and error rate exceeds 5%"


class AlertCompiler:
    """Compile natural-language alert text to validated EQL."""

    async def compile(
        self,
        org_id: str,
        nl_text: str,
        *,
        context: dict[str, Any] | None = None,
        eql_override: str | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        text = (nl_text or "").strip()
        if len(text) < 3:
            return {
                "eql": "",
                "warnings": ["nl_text must be at least 3 characters"],
                "error": "nl_text too short",
            }

        rule = compile_signal(text)
        eql = (eql_override or "").strip() or rule_to_eql(rule, context)
        warnings: list[str] = []

        if rule.metric == "custom":
            warnings.append(
                "Could not map a known metric; using a broad count() query"
            )
            eql = (
                "SELECT count() AS metric_value FROM telemetry_events "
                "WHERE 1=1"
            )

        parser = EQLParser()
        parse_result = await parser.parse(
            org_id,
            query=eql,
            shape="traces",
            lint_mode="default",
        )
        if parse_result.get("status") != "ok":
            warnings.append(
                parse_result.get("message") or "EQL parse failed; review manually"
            )
        else:
            lint = parse_result.get("data", {}).get("warnings") or []
            for item in lint:
                if isinstance(item, dict):
                    warnings.append(str(item.get("message") or item.get("code")))
                else:
                    warnings.append(str(item))

        duration_s = time.perf_counter() - started
        logger.debug(
            "AlertCompiler.compile org=%s metric=%s duration=%.3fs",
            org_id,
            rule.metric,
            duration_s,
        )
        return {
            "eql": eql,
            "warnings": warnings,
            "rule": rule.to_dict(),
            "suggested_name": _suggest_name(text),
            "compile_seconds": round(duration_s, 3),
        }


def _suggest_name(nl_text: str) -> str:
    cleaned = re.sub(r"\s+", " ", nl_text.strip())
    if len(cleaned) <= 64:
        return cleaned
    return cleaned[:61] + "..."
