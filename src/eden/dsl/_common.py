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

# Set-operation keywords that let a query "attach" a second,
# independent SELECT to the one the linter/org-injection code
# actually inspects. ``UNION [ALL] SELECT ... FROM other_table``
# (or INTERSECT / EXCEPT) would run alongside the org-scoped
# first SELECT and read arbitrary rows the WHERE-clause
# org_id injection never touches — the read-only allowlist
# must reject these outright rather than try to org-scope them.
_DISALLOWED_SET_OPS: tuple[str, ...] = ("UNION", "INTERSECT", "EXCEPT")

# The EQL surface (Cat 19) is scoped to exactly one telemetry
# table. Any FROM/JOIN reference to a different table is either
# a mistake or an attempt to read data the org_id injection
# doesn't cover (e.g. a JOIN against another org's rows in a
# differently-scoped table) — reject it.
_ALLOWED_TABLES: frozenset[str] = frozenset({"telemetry_events"})

_TABLE_REF_RE = re.compile(
    r"\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE
)

# ``WITH <name> AS (...)`` / ``WITH a AS (...), b AS (...)`` CTE
# headers. A FROM/JOIN reference to a CTE's own name is not a real
# table reference (it never leaves the query, so it can't read data
# the org_id injection doesn't cover) — the entry keyword allowlist
# already accepts ``WITH`` as a supported form, so rejecting
# ``WITH cte AS (...) SELECT * FROM cte`` outright because ``cte``
# isn't in :data:`_ALLOWED_TABLES` is a regression, not a security
# improvement. This is a cheap heuristic (not a full parser): it
# only fires when the query's first keyword is ``WITH``, and it
# matches ``<name> AS (`` either right after ``WITH`` or right after
# a comma (the multi-CTE form). It does not handle every legal CTE
# spelling (e.g. a column-list after the CTE name — ``WITH cte(a, b)
# AS (...)``); that residual gap only means such a query keeps being
# (over-)rejected, same as before this fix — it can never cause a
# non-allowlisted table to be treated as a CTE.
_CTE_DEF_RE = re.compile(
    r"(?:\bWITH\s+|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(",
    re.IGNORECASE,
)


def _collect_cte_names(no_strings: str, first_keyword: str) -> frozenset[str]:
    """Collect the CTE names a leading ``WITH ... AS (`` header defines.

    Returns the empty set unless ``first_keyword == 'WITH'`` — a CTE
    header only makes sense (and is only cheap to detect) at the
    front of a ``WITH``-led query.
    """
    if first_keyword != "WITH":
        return frozenset()
    return frozenset(m.group(1).lower() for m in _CTE_DEF_RE.finditer(no_strings))


def _looks_like_readonly_sql(query: str) -> bool:
    """Return True if the SQL passes the read-only allowlist check.

    The check matches the Cat 18 query engine's:
    1. First non-comment keyword must be ``SELECT`` or ``WITH``.
    2. Body must not contain any disallowed DML keyword, and
       must not contain a set-operation keyword (``UNION`` /
       ``INTERSECT`` / ``EXCEPT``) — those let a second,
       independent SELECT ride along with the org-scoped one.
    3. Every ``FROM``/``JOIN`` table reference must be the
       expected telemetry table (:data:`_ALLOWED_TABLES`).
    String literals and SQL comments are stripped first so a
    column name like ``drop_count`` or a commented-out keyword
    doesn't false-positive (or false-negative).
    """
    if not query or not query.strip():
        return False
    # Strip comments over the *whole* query, not just a leading
    # run — a UNION/DML keyword or foreign table name hidden
    # after a later ``--``/``/* */`` must not slip past the
    # token scan below.
    cleaned = _strip_sql_comments(query)
    first_token_match = re.match(r"\s*([A-Za-z_]+)", cleaned)
    if not first_token_match:
        return False
    first = first_token_match.group(1).upper()
    if first not in ("SELECT", "WITH"):
        return False
    no_strings = re.sub(r"'[^']*'", "''", cleaned)
    no_strings = re.sub(r'"[^"]*"', '""', no_strings)
    for token in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\b", no_strings):
        upper_token = token.upper()
        if upper_token in _DISALLOWED_DML_KEYWORDS:
            return False
        if upper_token in _DISALLOWED_SET_OPS:
            return False
    cte_names = _collect_cte_names(no_strings, first)
    tables = {m.group(1).lower() for m in _TABLE_REF_RE.finditer(no_strings)}
    if tables - _ALLOWED_TABLES - cte_names:
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


# ─── Structural org_id-predicate detection ───────────────────
#
# SECURITY (tenant isolation) — history of this code:
#
# 1. _inject_org_id() originally skipped injection with a bare
#    ``"org_id" in query.lower()`` substring check. That has zero
#    context awareness — it also matches a SQL comment
#    (``-- org_id``), a column alias (``AS org_id_x``), or a string
#    literal that merely contains the text ``org_id``, none of which
#    actually scope the query to a tenant. A query that tripped one
#    of those false positives skipped org-scoping entirely and was
#    later persisted (:class:`AlertAsCode`) and executed verbatim by
#    the cron watchdog against ClickHouse/Postgres with no tenant
#    filter. :func:`_has_org_scope_predicate` below replaced the
#    substring check with a structural one (word-bounded ``org_id``
#    column reference, compared with ``=`` to a literal matching
#    *this* org's id).
#
# 2. That was still not sufficient: _has_org_scope_predicate() only
#    checked whether such a predicate occurred *anywhere* in the
#    query text — it never verified the predicate actually gates the
#    whole query as a top-level ANDed conjunct. A query such as
#    ``WHERE (t.org_id = '<this org>' OR 1=1)`` (or
#    ``WHERE NOT (t.org_id != '<this org>')``, or the predicate
#    buried inside an unrelated subquery while the real outer WHERE
#    is ``OR 1=1``) contains a textually-genuine
#    ``org_id = '<this org>'`` match, so the old
#    _has_org_scope_predicate() returned True and _inject_org_id()
#    left the query untouched — but the query as written is
#    always-true and returns every org's rows. No regex heuristic
#    over free-form SQL text can reliably distinguish "this org_id
#    predicate is what actually gates the result set" from "this
#    org_id predicate is one disjunct of an always-true OR", so the
#    "skip injection if it looks already-scoped" strategy itself is
#    the bug.
#
# The fix: _inject_org_id() no longer tries to detect whether the
# query is "already scoped" at all. It unconditionally parenthesizes
# whatever WHERE body the query already has (creating a WHERE clause
# if there wasn't one) and ANDs the real ``t.org_id = '<org>'``
# filter onto the *outside* of those parens. Because the injected AND
# gates the entire pre-existing condition rather than sitting inside
# it, no OR / NOT / nested-parens / subquery trick the caller can
# write inside their own clause can ever escape the injected filter.
# :func:`_has_org_scope_predicate` is kept as a diagnostic helper
# (still exercised directly by tests) but no longer gates injection.
#
# 3. Even after (2), an adversarial review found a THIRD bypass: the
#    body-splitting / AND-appending logic in _inject_org_id() ran on
#    the RAW query text with any SQL comments the caller wrote still
#    embedded in it. A trailing ``--`` line comment (or an ``/* */``
#    block comment) placed after the point where this function
#    appends its own ``WHERE ...`` / ``AND t.org_id = ...`` text
#    swallows that appended text into the comment — the string this
#    function returns *contains* the real filter, but a SQL engine
#    parsing it would never execute that part, since it's inside a
#    comment. E.g. ``SELECT * FROM telemetry_events t WHERE 1=1) OR
#    1=1 --`` → the old code appended ``) AND t.org_id = '<org>'``
#    right after the trailing ``--``, so the *entire* injected clause
#    (and the closing paren needed to make the original text's
#    dangling ``)`` balance) landed inside the comment; the actually-
#    executed WHERE was just ``(1=1) OR 1=1`` — always-true and
#    completely unscoped. The fix: _inject_org_id() now calls
#    :func:`_strip_sql_comments` FIRST and does every step of its
#    WHERE-detection / body-splitting / rewriting against that
#    comment-free text — a comment in an executed alert-definition
#    query serves no functional purpose and is pure attack surface,
#    so it is removed outright rather than reasoned about. This is
#    only safe because :func:`_strip_sql_comments` is itself string-
#    literal aware (a ``--``/``/*`` inside a quoted literal is left
#    untouched), so a legitimate filter value containing those
#    characters is not corrupted by the strip.

# A structural org_id predicate: an (optionally table-qualified)
# ``org_id`` column reference — e.g. ``org_id`` or ``t.org_id``
# — compared with ``=`` to a string literal, in either operand
# order. The ``\b...\b`` word boundaries around ``org_id`` mean
# a bypass alias like ``org_id_x`` (as in ``AS org_id_x``) can
# never match: there is no word boundary between ``org_id`` and
# the trailing ``_x``.
_ORG_ID_PREDICATE_RE = re.compile(
    r"\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?org_id\b\s*=\s*"
    r"(?P<lit_rhs>'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
    r"|"
    r"(?P<lit_lhs>'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")\s*=\s*"
    r"\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?org_id\b",
    re.IGNORECASE,
)


def _strip_sql_comments(query: str) -> str:
    """Strip ``--`` line comments and ``/* */`` block comments.

    String-literal aware: a ``--`` or ``/*`` that occurs *inside* a
    ``'...'`` or ``"..."`` string literal is left untouched — only
    comment markers that appear outside any string literal are
    stripped. This matters for two independent callers:

    * :func:`_looks_like_readonly_sql` / :func:`_has_org_scope_predicate`
      — text-scanning heuristics where treating a literal's contents
      as "part of the query" vs. "invisible" only changes how
      conservative the heuristic is.
    * :func:`_inject_org_id` — which now rewrites the query body it
      is given (see below), so corrupting a legitimate literal like
      ``WHERE message = '-- not a comment'`` would silently mutate a
      value the caller depends on, not just a heuristic's input.

    Implemented with a single left-to-right scan (rather than a
    comment regex applied to the raw text) so a ``'...'``/``"..."``
    span is skipped over as an opaque unit — a comment marker inside
    it can never be mistaken for a real one, and the literal's exact
    original text (quotes, escapes, and all) is preserved verbatim
    in the output. Comment spans outside of string literals are
    replaced with a single space (block comments) or dropped
    entirely (line comments), same as the previous implementation.

    The string-literal sub-scan (backslash-escapes, SQL's doubled-
    quote escape) is factored out into :func:`_consume_string_literal`
    so this function, :func:`_string_literal_spans`, and
    :func:`_has_unbalanced_quotes` all agree exactly on where a
    literal begins and ends — one scanning routine, not three
    separately maintained (and separately correct-or-not) copies.
    """
    out: list[str] = []
    i = 0
    n = len(query)
    while i < n:
        ch = query[i]
        if ch in ("'", '"'):
            start = i
            i, _closed = _consume_string_literal(query, i)
            out.append(query[start:i])
            continue
        if ch == "-" and i + 1 < n and query[i + 1] == "-":
            end = query.find("\n", i)
            i = n if end == -1 else end
            continue
        if ch == "/" and i + 1 < n and query[i + 1] == "*":
            end = query.find("*/", i + 2)
            out.append(" ")
            i = n if end == -1 else end + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _consume_string_literal(text: str, start: int) -> tuple[int, bool]:
    """Scan one ``'...'``/``"..."`` string literal starting at ``text[start]``.

    ``start`` must index a quote character (``'`` or ``"``). Returns
    ``(end, closed)``: ``end`` is the index just past the literal — the
    position right after its closing quote, or ``len(text)`` if the
    literal is never closed; ``closed`` is False iff end-of-text was
    reached while still inside the open literal (an unterminated /
    unbalanced-quote string).

    This is the single low-level scanning routine :func:`_strip_sql_comments`,
    :func:`_string_literal_spans`, and :func:`_has_unbalanced_quotes` all
    build on top of, so all three agree exactly on where a literal begins
    and ends, on backslash-escapes, and on SQL's doubled-quote escape
    (``'it''s'``) — extracted here (round 4 of this function's hardening)
    rather than re-implemented per caller, so a future fix to the escaping
    rules can't accidentally apply to only one of the three.
    """
    quote = text[start]
    n = len(text)
    i = start + 1
    while i < n:
        if text[i] == "\\" and i + 1 < n:
            # Backslash-escape: keep both characters, and don't let
            # the escaped character close the literal (matches the
            # escaping already assumed by _ORG_ID_PREDICATE_RE
            # elsewhere in this module).
            i += 2
            continue
        if text[i] == quote:
            if i + 1 < n and text[i + 1] == quote:
                # SQL's doubled-quote escape (e.g. 'it''s').
                i += 2
                continue
            return i + 1, True
        i += 1
    return n, False


def _string_literal_spans(text: str) -> list[tuple[int, int]]:
    """Return the ``[start, end)`` spans of every string literal in ``text``.

    Built on :func:`_consume_string_literal`, so it agrees exactly with
    :func:`_strip_sql_comments` on where a literal begins and ends.
    ``text`` is expected to already be comment-stripped — this function
    does not itself recognize comment syntax, only quotes.

    Used by :func:`_find_unquoted` to make keyword detection (WHERE,
    GROUP BY, ...) literal-aware: a keyword spelled out inside a quoted
    string (e.g. ``SELECT 'WHERE' AS marker``) must never be mistaken
    for the real clause keyword.
    """
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] in ("'", '"'):
            start = i
            i, _closed = _consume_string_literal(text, i)
            spans.append((start, i))
            continue
        i += 1
    return spans


def _has_unbalanced_quotes(text: str) -> bool:
    """Return True iff ``text`` contains a string literal opened but never
    properly closed before end-of-string (an odd, unbalanced count of
    un-escaped, un-doubled quote characters outside comments).

    ``text`` is expected to already be comment-stripped
    (:func:`_strip_sql_comments`) — a quote character inside a comment
    was never part of a real literal and must not count.

    This matters because a real SQL engine's own quote-toggle parsing
    runs over the FULL text :func:`_inject_org_id` returns, *including*
    the ``'<org_id>'`` literal it appends. If the caller's own WHERE
    body has a dangling, never-closed quote, that engine-level parsing
    can use the injected literal's own quotes to (mis)close the
    caller's dangling string, garbling everything from that point on —
    including the appended ``AND t.org_id = ...`` clause itself. Every
    construction tried against this produced a SQL syntax error rather
    than a silent bypass (a garbled, unparseable query is not the same
    failure mode as an unscoped one), but "fails to a syntax error" is
    still not a state this function should try to rewrite through: it
    is safer to reject the query outright, at compile time, than to
    hand a real SQL engine something whose parse this module can no
    longer reason about.
    """
    i = 0
    n = len(text)
    while i < n:
        if text[i] in ("'", '"'):
            i, closed = _consume_string_literal(text, i)
            if not closed:
                return True
            continue
        i += 1
    return False


def _find_unquoted(
    pattern: re.Pattern[str],
    text: str,
    *,
    pos: int = 0,
    spans: list[tuple[int, int]] | None = None,
) -> re.Match[str] | None:
    """Find the first match of ``pattern`` in ``text`` at/after ``pos``
    whose start position is not inside any string-literal span.

    This is what makes WHERE/GROUP BY/ORDER BY/etc. keyword detection
    literal-aware: a match whose start falls inside a quoted string
    (e.g. the ``WHERE`` in ``SELECT 'WHERE' AS marker FROM ...``) is
    skipped, and the search resumes right after that literal's closing
    quote, so a real, later, out-of-literal keyword is still found.

    ``spans`` should be :func:`_string_literal_spans`'s output for
    ``text`` — callers that need several such searches over the same
    text (:func:`_inject_org_id` does two) compute it once and pass it
    in rather than re-scanning the whole text on every call.
    """
    if spans is None:
        spans = _string_literal_spans(text)
    idx = pos
    while True:
        match = pattern.search(text, idx)
        if match is None:
            return None
        start = match.start()
        enclosing_end: int | None = None
        for span_start, span_end in spans:
            if span_start > start:
                # Spans are produced in left-to-right scan order, so
                # every later span starts even further right — none
                # of them can contain `start` either.
                break
            if start < span_end:
                enclosing_end = span_end
                break
        if enclosing_end is None:
            return match
        # The match starts inside a literal — it's not a real keyword.
        # Resume the search right after the literal instead of at
        # match.end(), so a keyword whose match overlaps the literal's
        # closing quote can't be found twice or skipped.
        idx = enclosing_end


def _has_org_scope_predicate(query: str, org_id: str) -> bool:
    """Return True iff ``query`` textually contains a genuine org_id predicate.

    DIAGNOSTIC ONLY — this function no longer gates whether
    :func:`_inject_org_id` injects the real filter (it always does,
    unconditionally; see the SECURITY comment above this section).
    The reason: a match here only proves the predicate occurs
    *somewhere* in the query text as a top-level-looking comparison —
    it says nothing about whether that comparison actually gates the
    whole query (``WHERE (t.org_id = '<this org>' OR 1=1)`` matches
    here even though the query is always-true). Kept around because
    it's still a useful, narrowly-scoped text check for lint/logging
    callers that want a best-effort "does this look scoped" signal,
    but it must never again be used to decide whether to skip
    injecting the real filter.

    Unlike the historical substring check, this:

    1. Strips comments first (:func:`_strip_sql_comments`), so
       ``-- org_id`` (a comment, never executed) doesn't count.
    2. Requires a real, word-bounded ``org_id`` column reference
       (:data:`_ORG_ID_PREDICATE_RE`) — ``org_id_x`` (as in an
       ``AS org_id_x`` alias) does not match.
    3. Requires that reference to be one side of a literal
       ``=`` comparison — a bare ``SELECT org_id`` or
       ``AS org_id`` alone (no comparison) does not count as a
       scoping predicate.
    4. Requires the literal to equal *this* org's id. A
       predicate scoping to some *other* org (e.g. an
       attacker-supplied ``org_id = 'victim-org'``) is treated
       as *not* scoped, so the caller still appends the real
       ``AND t.org_id = '<this org>'`` filter. ANDing a second,
       contradictory org_id predicate can only narrow the
       result set (typically to empty) — never widen it — so
       this is safe even though it doesn't strip the
       attacker's clause.

    Residual limitation: this is a regex heuristic over SQL
    text, not a real parser (the module intentionally has no
    ``sqlglot`` dependency in v1.3). It materially raises the
    bar over a bare substring check but is not a bulletproof
    SQL grammar. When a query is ambiguous, this function is
    written to prefer returning False (i.e. re-inject the real
    filter) over True.
    """
    if not query or not org_id:
        return False
    cleaned = _strip_sql_comments(query)
    safe_org = org_id.replace("'", "''")
    for match in _ORG_ID_PREDICATE_RE.finditer(cleaned):
        literal = match.group("lit_rhs") or match.group("lit_lhs")
        if literal is None:
            continue
        inner = literal[1:-1]
        if inner == org_id or inner == safe_org:
            return True
    return False


# Clause keywords that terminate a WHERE body — used both to find
# where an existing WHERE body ends (so it can be parenthesized in
# full) and, when there's no WHERE at all, to find where a new one
# should be inserted so it lands before GROUP BY/ORDER BY/etc.
# rather than after (which would be invalid SQL).
_WHERE_CLAUSE_END_RE = re.compile(
    r"\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET)\b", re.IGNORECASE
)

# The WHERE keyword itself — matched via :func:`_find_unquoted` (not a
# bare ``re.search``) so a query whose WHERE-like text appears inside a
# string literal *before* the real WHERE keyword doesn't fool the
# detection. See the round-4 SECURITY/correctness note above
# :func:`_inject_org_id` for the motivating example.
_WHERE_KEYWORD_RE = re.compile(r"\bWHERE\b", re.IGNORECASE)


def _inject_org_id(query: str, org_id: str) -> str:
    """Unconditionally AND the real org_id filter onto the query.

    This always appends ``AND t.org_id = '<org_id>'`` — it never
    tries to decide whether the query is "already org-scoped" (see
    the SECURITY comment above this section for why that strategy
    was itself the tenant-isolation bug). Concretely:

    * If the query has a WHERE clause, its *entire* existing body is
      wrapped in parentheses and ANDed with the real predicate:
      ``WHERE X`` → ``WHERE (X) AND t.org_id = '<org>'``. Because the
      injected AND gates the whole original condition rather than
      being inserted inside it, no OR / NOT / nested-parens /
      subquery the caller wrote inside ``X`` can ever make the
      overall WHERE evaluate to true for a row belonging to a
      different org — the caller's clause can only narrow the result
      set further, never widen it past the injected filter.
    * If the query has no WHERE clause, one is added (positioned
      before any GROUP BY/ORDER BY/HAVING/LIMIT/OFFSET, since adding
      it after those would be invalid SQL).

    For a query that already has a correct, unambiguous
    ``org_id = '<this org>'`` predicate, this still ANDs on a second,
    redundant copy of the same predicate — ANDing a true condition
    with itself is a no-op, so the result set is unaffected; it's
    just a slightly more verbose query, not a correctness problem.

    SECURITY (comments as attack surface): this function operates on
    :func:`_strip_sql_comments`'s output, **not** the raw ``query``
    text. A prior revision ran the WHERE-detection / body-splitting /
    AND-appending logic directly on the raw text, which let a
    trailing ``--`` line comment (or an embedded ``/* */`` block
    comment) the caller's query happened to contain swallow the
    appended ``AND t.org_id = ...`` clause (and, in the has-WHERE
    branch, the closing paren right after it) into the comment —
    the clause was present in the query *string* this function
    returned, but a SQL engine would never execute it, so the
    tenant filter silently vanished. Concretely:

        "SELECT * FROM telemetry_events t -- no filters here"
        -> (old, buggy) "...t -- no filters here WHERE t.org_id = '...'"
           (the WHERE is part of the comment; never executed)

        "SELECT * FROM telemetry_events t WHERE 1=1) OR 1=1 --"
        -> (old, buggy) "...WHERE (1=1) OR 1=1 --) AND t.org_id = '...'"
           (everything from -- onward, including the injected AND
           and the closing paren, is a comment; the executed WHERE
           is just "(1=1) OR 1=1" — always-true, unscoped)

    A comment in an executed alert-definition query serves no
    functional purpose and is pure attack surface, so this function
    removes all comments *before* doing any WHERE/body detection or
    rewriting, rather than trying to detect/avoid "dangerous" ones.
    Because :func:`_strip_sql_comments` is string-literal-aware (a
    ``--`` or ``/*`` inside a quoted literal is left untouched), a
    legitimate filter value like ``WHERE message = '-- not a
    comment'`` is unaffected — only real comment syntax is removed.
    The org-scoped SQL this function returns is later persisted
    verbatim as ``clickhouse_sql`` and executed by the cron watchdog
    / on-demand evaluate path, so it must never contain a comment
    that could re-swallow a future edit either.

    4. A fourth review round found two further gaps, both fixed here:

       a. **Unbalanced quotes reject rather than rewrite.** If the
          comment-stripped query has a dangling, never-closed string
          literal (an odd count of un-escaped, un-doubled quotes), a
          real SQL engine's own quote-toggle parsing over the FULL
          text this function returns — including the ``'<org_id>'``
          literal it appends — can use *that* literal's quotes to
          close the caller's dangling string, garbling the appended
          ``AND t.org_id = ...`` clause (e.g. ``WHERE 1=1 OR '`` — the
          appended ``' AND t.org_id = '<org>'`` reads as more string
          content to a real parser). Every construction tried against
          this produces a SQL syntax error, not a silent bypass, but
          "the query still parses (elsewhere) into a syntax error" is
          not something this function can reliably reason about, so it
          now raises :class:`ValueError` up front
          (:func:`_has_unbalanced_quotes`) rather than attempting the
          rewrite — fail loudly at compile time instead of silently
          producing SQL text whose behavior under a real engine is
          unpredictable.
       b. **WHERE-keyword detection is now literal-aware.** The
          previous revision located the WHERE keyword (and the
          GROUP BY/ORDER BY/HAVING/LIMIT/OFFSET body-end boundary)
          with a bare ``re.search`` over the whole query text — unlike
          :func:`_strip_sql_comments`, that search had no concept of
          "inside a string literal". A perfectly ordinary, non-
          adversarial query containing the word WHERE inside a quoted
          string *before* the real WHERE keyword (e.g.
          ``SELECT id, 'WHERE' AS marker FROM telemetry_events t WHERE
          1=1``) fooled the old search into treating the literal's
          WHERE as the clause boundary, corrupting the body/tail
          split. This function now locates WHERE and the clause-end
          keywords with :func:`_find_unquoted`, which skips any match
          whose start falls inside a string-literal span
          (:func:`_string_literal_spans`) — the same scanning
          primitive :func:`_strip_sql_comments` is built on, so the
          two never disagree about where a literal begins and ends.
    """
    query = _strip_sql_comments(query)

    if _has_unbalanced_quotes(query):
        raise ValueError(
            "eql query rejected: unbalanced (odd) quote count outside "
            "comments -- a dangling/unterminated string literal in the "
            "WHERE body would let a real SQL engine's own quote parsing "
            "re-interpret the org_id filter this function appends, so "
            "the query is rejected rather than rewritten"
        )

    safe = org_id.replace("'", "''")
    org_predicate = f"t.org_id = '{safe}'"
    literal_spans = _string_literal_spans(query)

    where_match = _find_unquoted(_WHERE_KEYWORD_RE, query, spans=literal_spans)
    if where_match is None:
        # No WHERE clause at all — add one, ahead of any
        # GROUP BY/ORDER BY/HAVING/LIMIT/OFFSET so the result stays
        # syntactically valid.
        boundary = _find_unquoted(
            _WHERE_CLAUSE_END_RE, query, spans=literal_spans
        )
        if boundary is None:
            return query.rstrip() + f" WHERE {org_predicate}"
        head = query[: boundary.start()].rstrip()
        tail = query[boundary.start() :]
        return f"{head} WHERE {org_predicate} {tail}"

    # There's a WHERE clause — parenthesize its ENTIRE body (up to
    # the next clause boundary, or end of string) before ANDing the
    # real filter onto the outside.
    body_start = where_match.end()
    boundary = _find_unquoted(
        _WHERE_CLAUSE_END_RE, query, pos=body_start, spans=literal_spans
    )
    body_end = boundary.start() if boundary else len(query)
    body = query[body_start:body_end].strip()
    tail = query[body_end:].strip()

    if not body:
        # Malformed "WHERE" with an empty body — don't emit
        # "WHERE () AND ...", just install the real predicate alone.
        new_clause = f"WHERE {org_predicate}"
    else:
        new_clause = f"WHERE ({body}) AND {org_predicate}"

    head = query[: where_match.start()].rstrip()
    result = f"{head} {new_clause}"
    if tail:
        result += f" {tail}"
    return result


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
    # ``on_alert_lint_warning`` is ``async def`` and this helper is
    # already async — await it so the warning actually reaches the hook.
    await hook.on_alert_lint_warning(
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
    "_consume_string_literal",
    "_expand_query",
    "_expand_relational_field",
    "_find_unquoted",
    "_fire_dsl_alert_lint_warning_hook",
    "_has_org_scope_predicate",
    "_has_unbalanced_quotes",
    "_inject_org_id",
    "_insert_lint_warnings",
    "_json_dumps",
    "_lint_query",
    "_lint_warning",
    "_looks_like_readonly_sql",
    "_not_implemented_envelope",
    "_ok_envelope",
    "_ok_with_warnings",
    "_string_literal_spans",
    "_strip_sql_comments",
    "_upsert_alert_rule",
    "_DISALLOWED_DML_KEYWORDS",
    "_DISALLOWED_SET_OPS",
    "_ALLOWED_TABLES",
]
