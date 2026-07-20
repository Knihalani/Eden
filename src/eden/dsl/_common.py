"""Shared helpers for Cat 19 — Trace Query DSL / EQL (v1.3).

The four services (:class:`EQLParser`, :class:`RelationalFieldResolver`,
:class:`EQLLinter`, :class:`AlertAsCode`) share four concerns:

* **Envelope shape** — every route returns the
  ``status / feature / live / data`` envelope from
  :mod:`eden.intelligence_envelope`. The Cat 19 routes use the
  live ``ok`` shape on the happy path; the read-only-violation
  and missing-org paths return the stable ``not_implemented``
  envelope.

* **SQL parse + render** — the v1.3 ship is **SQL only** (no
  BTQL pipe syntax, per the 2026-06-11 decision). We do not
  depend on ``sqlglot`` (not in the v0 dependency set); the
  helpers in this module implement a minimal, deterministic
  parser that handles the relational-field prefix expansion
  (root. / parent. / any.) and the 4 Braintrust-parity lint
  warnings.

* **Deterministic id builders** — the alert id, the warning
  id, and the cache key for the recorder are all content-
  derived so re-running the same operation on the same input
  produces the same id, making the services re-runnable.

* **Closed-loop wiring** — :func:`_fire_dsl_alert_lint_warning_hook`
  fires :func:`DSLHook.on_alert_lint_warning` when an alert is
  compiled with at least one lint warning. Stub no-op in v1.3
  (the hook is registered in :mod:`eden.llmops.promotion_hooks`
  as a no-op logger); a real implementation (v1.4) would
  surface the warning in the alert editor UI.

The v1.3 ship is intentionally minimal — there is no SQL
type-checking beyond the read-only allowlist and the
relational-field prefix expansion. A v2 implementation can
swap in ``sqlglot`` if/when the dependency is added.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ─── Envelope helpers ────────────────────────────────────────


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The Cat 19 happy-path envelope.

    Mirrors the rest of the intelligence surface — the
    ``live: True`` flag signals the front-end to render the
    live EQL editor rather than the "stub" badge.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "data": data,
    }


def _ok_with_warnings(
    feature: str,
    data: dict[str, Any],
    warnings: list[dict[str, Any]],
    *,
    blocked: bool = False,
) -> dict[str, Any]:
    """The Cat 19 envelope with lint warnings attached.

    ``warnings`` is the list of warning dicts the linter
    returned. ``blocked`` is True when ``lint_mode == 'strict'``
    AND at least one warning is ``severity='error'`` — the
    caller should treat this as a 400-class response.
    """
    data = dict(data)
    data["warnings"] = warnings
    out = {
        "status": "ok",
        "feature": feature,
        "live": True,
        "data": data,
    }
    if blocked:
        out["status"] = "not_implemented"
        out["live"] = False
        out["message"] = (
            f"lint_mode='strict' blocked the query: "
            f"{[w['code'] for w in warnings if w.get('severity') == 'error']}"
        )
    return out


def _not_implemented_envelope(
    feature: str, message: str
) -> dict[str, Any]:
    """The Cat 19 error envelope.

    Returned when the input is malformed (empty query, invalid
    shape, non-SELECT leading keyword, etc.). Keeps the same
    shape as the rest of the surface so the front-end renders
    a single uniform error card.
    """
    return {
        "status": "not_implemented",
        "feature": feature,
        "live": False,
        "data": None,
        "message": message,
    }


# ─── Relational field detection ───────────────────────────────


# A relational field is a dotted path of the form
#   <prefix>.<column>
# where <prefix> is one of {root, parent, any}. The .<column>
# part is the telemetry_events column to read from. Examples:
#   root.event_type        →  t.event_type = ? AND t.parent_span_id IS NULL
#   parent.agent_id        →  t.parent_span_id IS NOT NULL AND
#                             t.parent_span_id = (subquery for parent)
#   any.error              →  EXISTS (SELECT 1 FROM telemetry_events e
#                                  WHERE e.org_id = t.org_id
#                                    AND e.trace_id = t.trace_id
#                                    AND e.error IS NOT NULL)
#
# The parser is deliberately conservative — it only recognises
# the three prefixes the appendix calls out, and only in
# WHERE-clause predicates (not in the SELECT list or the
# ORDER BY clause, where the meaning is ambiguous).
_RELATIONAL_PREFIX_RE = re.compile(
    r"\b(root|parent|any)\.([A-Za-z_][A-Za-z0-9_]*)"
)

# ``any.<col>`` plus the immediate comparison so EXISTS closes
# before a following AND/OR (appending ``)`` at query end would
# swallow later clauses into the subquery).
_ANY_PRED_RE = re.compile(
    r"\bany\.([A-Za-z_][A-Za-z0-9_]*)"
    r"(?:"
    r"\s+(IS\s+NOT\s+NULL|IS\s+NULL)"
    r"|"
    r"\s*(=|!=|<>|<=|>=|<|>)\s*(?:'[^']*'|\"[^\"]*\"|\d+(?:\.\d+)?|TRUE|FALSE)"
    r"|"
    r"\s+IN\s*\([^)]*\)"
    r")?",
    re.IGNORECASE,
)


# The 4 Braintrust-parity lint rules. See the appendix for the
# full rationale; the v1.3 ship matches the appendix verbatim.
LINT_RULES: dict[str, dict[str, str]] = {
    "NO_FILTERS": {
        "severity": "error",
        "message": (
            "Query has no WHERE on created/_xact_id/root_span_id. "
            "Will full-table scan. Add a time range."
        ),
    },
    "ANY_SPAN_OVERUSE": {
        "severity": "warning",
        "message": (
            "ANY_SPAN() is used more than 2 times. Prefer root. or "
            "parent. for the common case; ANY_SPAN can be 10-100x "
            "slower on large traces."
        ),
    },
    "MISSING_ORG": {
        "severity": "error",
        "message": (
            "Query omits org_id. Auto-injecting (or returning 400 "
            "in strict mode)."
        ),
    },
    "SHAPE_MISMATCH": {
        "severity": "warning",
        "message": (
            "Query references a field that doesn't exist in the "
            "requested shape (traces|spans|summary)."
        ),
    },
}


# The 3 EQL shapes (Braintrust parity). Each shape has the
# set of legal "first-class" fields — a query that references
# a field outside the set gets the SHAPE_MISMATCH warning.
SHAPE_FIELDS: dict[str, frozenset[str]] = {
    "traces": frozenset(
        {
            "trace_id", "org_id", "agent_id", "agent_version",
            "environment_id", "source_format", "event_type",
            "timestamp", "duration_ms", "outcome",
        }
    ),
    "spans": frozenset(
        {
            "span_id", "parent_span_id", "trace_id", "org_id",
            "agent_id", "event_type", "timestamp", "duration_ms",
            "name", "outcome", "level",
        }
    ),
    "summary": frozenset(
        {
            "trace_id", "org_id", "agent_id", "timestamp",
            "n_spans", "n_errors", "total_duration_ms",
            "total_cost_usd",
        }
    ),
}


# Read-only allowlist — same shape as the Cat 18 query engine's
# but slightly more permissive (we allow ANY/WITH only when
# the body has no DML keywords; we don't enforce the
# disallowed-identifier set because the linter and the
# relational-field resolver are the only callers of this
# path and they both validate input upstream).
_DISALLOWED_DML_KEYWORDS: tuple[str, ...] = (
    "DROP", "DELETE", "INSERT", "UPDATE", "ALTER",
    "TRUNCATE", "CREATE", "REPLACE", "RENAME",
    "GRANT", "REVOKE", "OPTIMIZE", "KILL",
)


def _looks_like_readonly_sql(query: str) -> bool:
    """Return True if the SQL passes the read-only allowlist check.

    The check matches the Cat 18 query engine's:
    1. First non-comment keyword must be ``SELECT`` or ``WITH``.
    2. Body must not contain any disallowed DML keyword.
    String literals are stripped first so a column name like
    ``drop_count`` doesn't false-positive.
    """
    if not query or not query.strip():
        return False
    cleaned = re.sub(
        r"^\s*(?:--[^\n]*\n|/\*.*?\*/\s*)*",
        "",
        query,
        flags=re.DOTALL,
    )
    first_token_match = re.match(r"\s*([A-Za-z_]+)", cleaned)
    if not first_token_match:
        return False
    first = first_token_match.group(1).upper()
    if first not in ("SELECT", "WITH"):
        return False
    no_strings = re.sub(r"'[^']*'", "''", cleaned)
    no_strings = re.sub(r'"[^"]*"', '""', no_strings)
    for token in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\b", no_strings):
        if token.upper() in _DISALLOWED_DML_KEYWORDS:
            return False
    return True


# ─── Relational field expansion ──────────────────────────────


def _expand_relational_field(
    prefix: str, column: str
) -> str:
    """Expand a relational field reference into ClickHouse SQL.

    Returns a string that the relational-field resolver
    substitutes into the WHERE clause. The resolver injects
    ``t`` as the outer table alias (the resolver wraps the
    expansion in an EXISTS / correlated-subquery for the
    ``any`` prefix; for ``root`` and ``parent`` it inlines
    the predicate on the outer table).

    Examples:
        _expand_relational_field("root", "event_type")
            → 't.event_type'  (the resolver adds the
                                parent_span_id IS NULL guard)
        _expand_relational_field("parent", "agent_id")
            → 't.parent_span_id IS NOT NULL'
               (the resolver adds the correlated subquery)
        _expand_relational_field("any", "error")
            → handled separately by the resolver (EXISTS)
    """
    if prefix == "root":
        # The root span is the one with no parent — match
        # the existing telemetry_events.index pattern.
        return "t.event_type"  # placeholder; resolver adds the IS NULL guard
    if prefix == "parent":
        return "t.parent_span_id IS NOT NULL"
    if prefix == "any":
        # The "any" prefix is special — the resolver wraps
        # the column reference in an EXISTS subquery. We
        # return just the column name here.
        return column
    # Should never reach — defensive default.
    return f"t.{column}"


def _expand_query(
    query: str, org_id: str
) -> tuple[str, list[dict[str, Any]]]:
    """Expand the relational-field prefixes in the WHERE clause.

    Returns the expanded query and the list of lint warnings
    the expansion produced (the only warning the expansion
    itself surfaces is ANY_SPAN_OVERUSE — the others are
    detected by the linter).
    """
    warnings: list[dict[str, Any]] = []
    # 1. Find every relational field reference.
    matches = list(_RELATIONAL_PREFIX_RE.finditer(query))
    if not matches:
        # No relational fields → return the query unchanged
        # (after a minimal org_id-injection check; the linter
        # handles the missing-org case below).
        expanded = _inject_org_id(query, org_id)
        return expanded, warnings

    # 2. Count the "any" usages — the ANY_SPAN_OVERUSE rule
    #    fires when more than 2 are present.
    n_any = sum(1 for m in matches if m.group(1) == "any")
    if n_any > 2:
        warnings.append(
            _lint_warning(
                "ANY_SPAN_OVERUSE",
                "ANY_SPAN() is used " + str(n_any) + " times. "
                "Prefer root. for the common case; ANY_SPAN can "
                "be 10-100x slower on large traces",
            )
        )

    # 3. Expand ``any.<col> <op> <rhs>`` first so each EXISTS
    #    closes immediately after its predicate (AND/OR after
    #    the predicate must stay outside the subquery).
    def _sub_any(match: re.Match[str]) -> str:
        full = match.group(0)
        column = match.group(1)
        head = re.match(
            r"any\.([A-Za-z_][A-Za-z0-9_]*)", full, re.IGNORECASE
        )
        rest = full[head.end() :] if head else ""
        return (
            f"EXISTS (SELECT 1 FROM telemetry_events e "
            f"WHERE e.org_id = t.org_id "
            f"AND e.trace_id = t.trace_id "
            f"AND e.{column}{rest})"
        )

    expanded = _ANY_PRED_RE.sub(_sub_any, query)

    # 4. Expand root. / parent. (any. already rewritten above).
    def _sub(match: re.Match[str]) -> str:
        prefix = match.group(1)
        column = match.group(2)
        if prefix == "root":
            return f"t.{column}"
        if prefix == "parent":
            return (
                f"(SELECT p.{column} FROM telemetry_events p "
                f"WHERE p.org_id = t.org_id AND p.span_id = t.parent_span_id)"
            )
        return match.group(0)

    expanded = _RELATIONAL_PREFIX_RE.sub(_sub, expanded)

    # 5. Auto-inject the org_id if missing.
    expanded = _inject_org_id(expanded, org_id)
    return expanded, warnings


def _inject_org_id(query: str, org_id: str) -> str:
    """Auto-inject the org_id filter if the query is missing it.

    The v0 ship injects ``AND t.org_id = '<org_id>'`` at the
    end of the WHERE clause (creating one if needed). The
    MISSING_ORG lint warning is surfaced by the linter; the
    injection itself is silent.
    """
    if "org_id" in query.lower():
        return query
    safe = org_id.replace("'", "''")
    if re.search(r"\bWHERE\b", query, flags=re.IGNORECASE):
        return re.sub(
            r"(\bWHERE\b)",
            f"\\1 t.org_id = '{safe}' AND",
            query,
            count=1,
            flags=re.IGNORECASE,
        )
    # No WHERE — add one.
    if re.search(r"\bORDER\s+BY\b", query, flags=re.IGNORECASE):
        return re.sub(
            r"(\bORDER\s+BY\b)",
            f"WHERE t.org_id = '{safe}' \\1",
            query,
            count=1,
            flags=re.IGNORECASE,
        )
    if re.search(r"\bLIMIT\b", query, flags=re.IGNORECASE):
        return re.sub(
            r"(\bLIMIT\b)",
            f"WHERE t.org_id = '{safe}' \\1",
            query,
            count=1,
            flags=re.IGNORECASE,
        )
    return query + f" WHERE t.org_id = '{safe}'"


# ─── Linter ──────────────────────────────────────────────────


def _lint_warning(code: str, message: str) -> dict[str, str]:
    """Build a single lint warning dict.

    Pulls the severity from :data:`LINT_RULES` so the v0 ship
    has a single source of truth for the 4 Braintrust-parity
    warnings. Falls back to ``severity='warning'`` for any
    unknown code (defensive default).
    """
    rule = LINT_RULES.get(code, {"severity": "warning", "message": message})
    return {
        "code": code,
        "severity": rule["severity"],
        "message": rule.get("message", message),
    }


def _lint_query(
    query: str, *, shape: str | None = None
) -> list[dict[str, str]]:
    """Run the 4 lint rules against the query.

    The rules fire in this order:

    1. **NO_FILTERS** — no WHERE clause → full-table scan.
    2. **ANY_SPAN_OVERUSE** — more than 2 ``any.`` references.
    3. **MISSING_ORG** — no ``org_id`` filter.
    4. **SHAPE_MISMATCH** — references a field not in the
       requested shape's first-class field set.

    The function returns the list of warnings; the caller
    decides whether to block (in strict mode) or surface
    (in default mode).
    """
    warnings: list[dict[str, str]] = []
    upper = query.upper()

    # 1. NO_FILTERS
    if not re.search(r"\bWHERE\b", upper):
        warnings.append(_lint_warning("NO_FILTERS", LINT_RULES["NO_FILTERS"]["message"]))

    # 2. ANY_SPAN_OVERUSE
    n_any = upper.count("ANY.")
    if n_any > 2:
        warnings.append(
            _lint_warning(
                "ANY_SPAN_OVERUSE",
                LINT_RULES["ANY_SPAN_OVERUSE"]["message"],
            )
        )

    # 3. MISSING_ORG
    if "ORG_ID" not in upper:
        warnings.append(_lint_warning("MISSING_ORG", LINT_RULES["MISSING_ORG"]["message"]))

    # 4. SHAPE_MISMATCH
    if shape is not None and shape in SHAPE_FIELDS:
        legal = SHAPE_FIELDS[shape]
        # Find every identifier in the SELECT + WHERE clauses.
        # (Cheap heuristic: strip strings, then tokenise.)
        no_strings = re.sub(r"'[^']*'", "''", query)
        identifiers = {
            m.group(0).lower()
            for m in re.finditer(r"\b[A-Za-z_][A-Za-z0-9_]*\b", no_strings)
        }
        # Don't flag the SQL keywords.
        sql_keywords = {
            "select", "from", "where", "and", "or", "not", "is", "null",
            "in", "as", "on", "join", "left", "right", "inner", "outer",
            "group", "by", "order", "limit", "offset", "having", "count",
            "sum", "avg", "min", "max", "exists", "case", "when", "then",
            "else", "end", "distinct", "all", "any", "root", "parent",
            "true", "false", "t", "p", "e",
        }
        identifiers -= sql_keywords
        # Strip the relational prefixes (root./parent./any.)
        # — the column they reference is what matters.
        bare = set()
        for ident in identifiers:
            if ident in ("root", "parent", "any"):
                continue
            bare.add(ident)
        unknown = bare - legal
        if unknown:
            warnings.append(
                _lint_warning(
                    "SHAPE_MISMATCH",
                    LINT_RULES["SHAPE_MISMATCH"]["message"]
                    + f" Unknown: {sorted(unknown)}",
                )
            )
    return warnings


# ─── Deterministic id builders ──────────────────────────────


def _alert_id_for(*, org_id: str, name: str) -> str:
    """Deterministic alert id for the (org, name) pair.

    Re-running the same compile on the same input produces the
    same id, which means the ``_delete_then_insert`` upsert
    pattern is safe. The id is ``eql_alert_<sha256[:16]>`` so
    it's debuggable in the URL (e.g. ``/intelligence/dsl/alerts/
    eql_alert_abc...``).
    """
    digest = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"eql_alert|{org_id}|{name}",
    )
    return f"eql_alert_{digest.hex[:16]}"


# ─── Persistence helpers ─────────────────────────────────────


async def _upsert_alert_rule(
    *,
    org_id: str,
    alert_id: str,
    name: str,
    eql_query: str,
    clickhouse_sql: str,
    shape: str,
    interval_seconds: int,
    severity: str,
) -> None:
    """Upsert an EQL alert rule row.

    Idempotent — repeated ``compile_alert`` calls on the
    same ``(org, name)`` update the row in place. The cron
    watchdog reads ``next_fire_at`` to know when to fire.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    now = datetime.now(UTC)
    next_fire = datetime.fromtimestamp(
        now.timestamp() + interval_seconds, tz=UTC
    )
    await client.execute(
        """
        INSERT INTO eql_alert_rules (
            id, org_id, alert_id, name, eql_query, clickhouse_sql,
            shape, interval_seconds, severity, next_fire_at,
            enabled, lifecycle_status
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'active'
        )
        ON CONFLICT (alert_id) DO UPDATE SET
            eql_query = EXCLUDED.eql_query,
            clickhouse_sql = EXCLUDED.clickhouse_sql,
            shape = EXCLUDED.shape,
            interval_seconds = EXCLUDED.interval_seconds,
            severity = EXCLUDED.severity,
            next_fire_at = EXCLUDED.next_fire_at,
            lifecycle_status = 'active'
        """,
        uuid.UUID(int=int(alert_id.replace("eql_alert_", "").ljust(16, "0")[:16], base=16) & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF),
        org_id,
        alert_id,
        name,
        eql_query,
        clickhouse_sql,
        shape,
        interval_seconds,
        severity,
        next_fire,
    )


async def _insert_lint_warnings(
    *,
    org_id: str,
    query: str,
    warnings: list[dict[str, Any]],
    lint_mode: str,
) -> None:
    """Persist the lint warnings to ``eql_lint_warnings``.

    Append-only — the table is an audit log. The query is
    truncated to 1k chars so an adversarial customer can't
    bloat the table with a 100kB query string.
    """
    if not warnings:
        return
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    truncated = query[:1024] if len(query) > 1024 else query
    for w in warnings:
        await client.execute(
            """
            INSERT INTO eql_lint_warnings (
                id, org_id, query, warning_code, severity, message,
                lint_mode
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7
            )
            """,
            uuid.uuid4(),
            org_id,
            truncated,
            w["code"],
            w["severity"],
            w["message"],
            lint_mode,
        )


# ─── Closed-loop hook firer ─────────────────────────────────


async def _fire_dsl_alert_lint_warning_hook(
    org_id: str,
    *,
    alert_id: str,
    warnings: list[dict[str, Any]],
) -> None:
    """Fire the closed-loop :class:`DSLHook` if available.

    Stub no-op in v1.3 — the hook is registered in
    :mod:`eden.llmops.promotion_hooks` as a no-op logger. A
    real implementation (v1.4) would surface the warnings
    in the alert editor UI.
    """
    try:
        from eden.llmops.promotion_hooks import get_dsl_hook
    except ImportError:
        logger.debug(
            "dsl_hook not registered; org=%s alert=%s warnings=%d "
            "(no-op)",
            org_id,
            alert_id,
            len(warnings),
        )
        return
    hook = get_dsl_hook()
    hook.on_alert_lint_warning(
        org_id,
        alert_id=alert_id,
        warning_codes=[w["code"] for w in warnings],
    )


# ─── JSON helpers ────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    """JSON-serialise ``obj`` to a string.

    Same shape as the rest of the intelligence surface — the
    standard ``json.dumps`` would fail on a ``datetime`` or
    ``UUID``; we use the default ``str`` cast so a row with
    a ``datetime`` field round-trips through Postgres TEXT.
    """
    return json.dumps(obj, default=str, sort_keys=True)


__all__ = [
    "LINT_RULES",
    "SHAPE_FIELDS",
    "_alert_id_for",
    "_expand_query",
    "_expand_relational_field",
    "_fire_dsl_alert_lint_warning_hook",
    "_inject_org_id",
    "_insert_lint_warnings",
    "_json_dumps",
    "_lint_query",
    "_lint_warning",
    "_looks_like_readonly_sql",
    "_not_implemented_envelope",
    "_ok_envelope",
    "_ok_with_warnings",
    "_upsert_alert_rule",
    "_DISALLOWED_DML_KEYWORDS",
]
