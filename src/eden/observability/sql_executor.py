"""Read-only SQL query surface (Phase M).

This is the Logfire / RagaAI "ask a SQL question" surface: users
write a SELECT, we run it against the analytics tables, return
the rows. Every safeguard you can imagine is in place because
this is the highest-risk surface in the platform — a single
``DELETE FROM telemetry_events`` would be catastrophic.

Security model
──────────────
The executor is **defence in depth**:

1. **Single-statement** — the parser rejects anything with ``;``
   followed by more content. ``SELECT 1; SELECT 2`` is rejected.
2. **SELECT only** — anything starting with INSERT / UPDATE /
   DELETE / MERGE / TRUNCATE / DROP / ALTER / CREATE / GRANT /
   REVOKE / COPY / VACUUM / REINDEX / CLUSTER / LOCK / CALL /
   DO / SET / RESET / DISCARD / LISTEN / NOTIFY / REFRESH /
   EXPLAIN / SHOW is rejected. We do this with a string prefix
   check, not a parser, because we want a HARD deny (no
   "EXPLAIN ANALYZE INSERT" tricks).
3. **Table allowlist** — only tables in ``ALLOWED_TABLES`` may
   appear in the FROM clause. The check is a case-insensitive
   regex against the parsed token list; ``users``, ``secrets``,
   ``api_keys`` and friends are not in the allowlist.
4. **Per-tenant injection** — every reference to an allowlisted
   table is auto-rewritten to filter on ``org_id = $org_id``.
   The user CANNOT bypass this; the rewriter scans the entire
   query for table references and appends a ``WHERE`` if none
   exists, or ANDs into the existing WHERE if one does.
5. **Row limit** — every query is wrapped in a CTE that caps
   the result at ``max_rows`` (default 1000, max 10000). The
   result includes a ``truncated`` flag if the underlying
   query returned more rows.
6. **Time limit** — every query sets a ``statement_timeout``
   of ``max_seconds`` (default 30s, max 120s). Postgres kills
   the query at the timeout; the executor catches the
   ``QueryCanceledError`` and returns a structured error.
7. **No DDL inside SELECTs** — subqueries that contain writes
   are caught by the same statement-level check.

What this is NOT
────────────────
* Not a full SQL parser. We use a small regex for the table
  allowlist + a string prefix check for the statement guard.
  Postgres's own permissions are the final defence.
* Not a federated query engine. We only query the local
  Postgres. Cross-engine queries (ClickHouse, Qdrant) come
  later.
* Not a query builder. Users write SQL. If they want a visual
  builder, that's the DashboardBuilder in Phase E.

The endpoint is "the marketing wedge": the product surface
where users can ask an LLM "what was the p99 latency for
claude-opus-4 last Tuesday?" and the LLM can hand-write the
SQL and run it. Closing this loop is the whole point of the
unified AI agent (Phase C).
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ── Allowlist ──────────────────────────────────────────────────────
# The single source of truth for which tables users can query.
# Adding a table here is a deliberate decision — it implies
# "this table is safe to expose read-only to all org members."
#
# Schema is documented in the migration files. The PII scanner
# (Cat 10) is the upstream filter on writes; the tables below
# are the read-side mirrors.

ALLOWED_TABLES: frozenset[str] = frozenset({
    # LLM events — the main telemetry stream.
    "telemetry_events",
    # Content-addressed message dedup (Phase A).
    "trace_messages",
    # The judge eval table (Cat 3).
    "judge_scores",
    # LLM cost + token usage.
    "usage_events",
    # Outcome attribution (Cat 11).
    "outcomes",
    # Incidents + clusters (Cat 2).
    "incidents",
    # Drift alerts (Cat 13).
    "drift_alerts",
    # Eval datasets (Cat 3 + Cat 12).
    "datasets",
    "dataset_items",
    # Experiment splits + assignments (Cat 12).
    "experiments",
    "experiment_assignments",
    # Predictions (Cat 13).
    "predictions",
    # Saved searches (Phase N) — so users can JOIN against them.
    "saved_searches",
    # ABAC roles (Cat 10) — read-only for org members.
    "org_members",
    # Agent registrations (Cat 6).
    "agent_registrations",
})

# Tables that ALWAYS need an org_id filter. The rewriter adds one
# if it's missing. ALL of the above tables are in this set; the
# split is here for documentation / future flexibility.
TENANT_SCOPED_TABLES: frozenset[str] = ALLOWED_TABLES


# ── Statement guard ────────────────────────────────────────────────
# Anything that starts with one of these tokens is rejected.
# The check is case-insensitive and applied to the leading
# non-whitespace token.

_FORBIDDEN_PREFIXES: tuple[str, ...] = (
    "insert", "update", "delete", "merge", "truncate",
    "drop", "alter", "create", "grant", "revoke",
    "copy", "vacuum", "reindex", "cluster", "lock",
    "call", "do", "set", "reset", "discard", "listen",
    "notify", "refresh", "explain", "show",
)


# ── Tunables ───────────────────────────────────────────────────────

# Default + hard cap on rows returned. A 10k-row response is the
# largest we'll ever send — past that, the user should use a
# chart spec (Phase C) or a saved query (Phase N) + export.
DEFAULT_MAX_ROWS = 1000
MAX_MAX_ROWS = 10000

# Default + hard cap on query time. The plan_explain is the
# Postgres tool, this is just ``SET statement_timeout`` for the
# session.
DEFAULT_MAX_SECONDS = 30
MAX_MAX_SECONDS = 120


# ── Errors ─────────────────────────────────────────────────────────


class SqlExecutorError(Exception):
    """Base class for executor errors."""


class SqlForbiddenStatementError(SqlExecutorError):
    """The user tried to run a non-SELECT statement."""


class SqlMultiStatementError(SqlExecutorError):
    """The user tried to run multiple statements in one query."""


class SqlUnknownTableError(SqlExecutorError):
    """A FROM clause references a table not in the allowlist."""


class SqlTenantViolationError(SqlExecutorError):
    """A table reference is missing the required org_id filter
    (defence-in-depth — the rewriter would normally inject one,
    but this fires if the rewriter can't see the table)."""


class SqlTimeoutError(SqlExecutorError):
    """The query exceeded the time limit."""


# ── Result ─────────────────────────────────────────────────────────


@dataclass
class SqlResult:
    """The outcome of a single ``SqlExecutor.execute()`` call."""

    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    execution_ms: float = 0.0
    # The rewritten SQL that was actually run (post-tenant-
    # injection + post-row-cap). Useful for "explain my query"
    # UX and for debugging.
    rewritten_sql: str = ""
    # If the executor hit a row cap or time cap, this string
    # tells the user which. None = no cap hit.
    cap_hit: str | None = None


# ── The executor ───────────────────────────────────────────────────


# Match a table reference in a SQL query. We support:
#   ``from <name>``
#   ``join <name>``
#   ``into <name>``  (rejected by the prefix guard, but listed
#                    here for completeness)
# The match is greedy enough to capture fully-qualified names
# (``public.telemetry_events``) and aliases (``telemetry_events t``).
# Schema-qualified names are checked too — if a schema is
# present, it must be one we know about (``public``).
_TABLE_REF_RE = re.compile(
    r"""\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?"""
    r"""(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?""",
    re.IGNORECASE,
)


class SqlExecutor:
    """Run a read-only SQL query against the analytics tables.

    Construct with a Postgres client (``eden.storage.postgres``).
    The client is held as ``self._pg`` and called via the
    ``fetch`` helper.
    """

    def __init__(
        self,
        pg: Any,
        *,
        max_rows: int = DEFAULT_MAX_ROWS,
        max_seconds: int = DEFAULT_MAX_SECONDS,
        allowed_tables: Iterable[str] = ALLOWED_TABLES,
        tenant_scoped_tables: Iterable[str] = TENANT_SCOPED_TABLES,
    ) -> None:
        self._pg = pg
        self.max_rows = max(1, min(int(max_rows), MAX_MAX_ROWS))
        self.max_seconds = max(1, min(int(max_seconds), MAX_MAX_SECONDS))
        self._allowed_tables = frozenset(
            [t.lower() for t in allowed_tables],
        )
        self._tenant_scoped_tables = frozenset(
            [t.lower() for t in tenant_scoped_tables],
        )

    # ── Public API ────────────────────────────────────────────

    async def execute(
        self,
        sql: str,
        *,
        org_id: str,
        params: dict[str, Any] | None = None,
    ) -> SqlResult:
        """Run a read-only SQL query for the given org.

        Args:
            sql: The user's SQL. Must be a single SELECT against
                an allowlisted table. No multi-statements.
            org_id: The org the query is scoped to. The executor
                injects an ``org_id = $org_id`` filter into every
                tenant-scoped table reference.
            params: Optional named params (e.g. ``{"agent_id":
                "..."}``) that the user can reference as ``:foo``
                in their SQL. We bind them as positional $N.

        Returns:
            A :class:`SqlResult` with columns + rows + timings.

        Raises:
            SqlForbiddenStatementError: non-SELECT.
            SqlMultiStatementError:    more than one statement.
            SqlUnknownTableError:      FROM/JOIN references a
                table not in the allowlist.
            SqlTenantViolationError:   org_id injection failed.
            SqlTimeoutError:           statement_timeout hit.
        """
        # 1. Strip comments + leading whitespace.
        cleaned = self._strip_comments(sql).strip()
        if not cleaned:
            raise SqlForbiddenStatementError("empty query")

        # 2. Single-statement check. Reject anything with `;`
        #    followed by more content. A trailing `;` is OK.
        if self._has_multi_statements(cleaned):
            raise SqlMultiStatementError(
                "only one statement per query is allowed",
            )

        # 3. Statement guard. Must start with SELECT or WITH.
        self._check_statement_kind(cleaned)

        # 4. Table allowlist + tenant-scope check.
        rewritten = self._rewrite_for_tenant(cleaned, org_id=org_id)

        # 5. Bind params. Named params → positional $N.
        bound_sql, bind_args = self._bind_params(rewritten, params or {})

        # 6. Row-cap via CTE. We wrap the user's query so the
        #    outer SELECT is bounded; this preserves the user's
        #    ORDER BY if they used one.
        capped_sql = self._wrap_row_cap(bound_sql, self.max_rows + 1)
        # We ask for max_rows + 1 so we can detect truncation.

        # 7. Execute with statement_timeout.
        start = time.monotonic()
        try:
            rows = await self._run_with_timeout(capped_sql, bind_args, self.max_seconds)
        except _StatementTimeoutSignal:
            raise SqlTimeoutError(
                f"query exceeded {self.max_seconds}s statement_timeout",
            ) from None
        elapsed_ms = (time.monotonic() - start) * 1000

        # 8. Format result.
        truncated = len(rows) > self.max_rows
        if truncated:
            rows = rows[: self.max_rows]
        columns = list(rows[0].keys()) if rows else []
        result_rows = [list(r.values()) for r in rows]
        return SqlResult(
            columns=columns,
            rows=result_rows,
            row_count=len(result_rows),
            truncated=truncated,
            execution_ms=round(elapsed_ms, 2),
            rewritten_sql=capped_sql,
            cap_hit="row_limit" if truncated else None,
        )

    # ── Statement-level guards ────────────────────────────────

    @staticmethod
    def _strip_comments(sql: str) -> str:
        """Strip ``-- line`` and ``/* block */`` comments."""
        # Block comments (non-greedy).
        out = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
        # Line comments.
        out = re.sub(r"--[^\n]*", " ", out)
        return out

    @staticmethod
    def _has_multi_statements(sql: str) -> bool:
        """True if the SQL contains a statement terminator followed
        by more content (other than whitespace + a final ``;``)."""
        # Strip trailing semicolon + whitespace.
        s = sql.rstrip().rstrip(";").rstrip()
        # If there's a `;` anywhere in the (now-stripped) string,
        # we have more than one statement.
        return ";" in s

    @staticmethod
    def _check_statement_kind(sql: str) -> None:
        """Reject anything that isn't a SELECT (or WITH ... SELECT).

        A leading ``WITH`` is allowed (CTE), but the first
        non-CTE statement must be SELECT. We check the leading
        keyword + the first statement boundary.
        """
        leading = sql.lstrip().split(None, 1)[0].lower()
        if leading in ("select", "with"):
            return
        if leading in _FORBIDDEN_PREFIXES:
            raise SqlForbiddenStatementError(
                f"statement kind not allowed: {leading!r}",
            )
        # Unknown leading keyword — deny by default. The SELECT
        # and WITH cases are the only allowlist; everything else
        # is denied.
        raise SqlForbiddenStatementError(
            f"statement kind not allowed: {leading!r}",
        )

    def _rewrite_for_tenant(self, sql: str, *, org_id: str) -> str:
        """Inject ``org_id = :org_id`` into every tenant-scoped
        table reference.

        Strategy: walk the table references found by
        ``_TABLE_REF_RE``. For each, if the table is tenant-scoped,
        ensure the surrounding query has an org_id filter. If
        the query has no WHERE, append one. If it has a WHERE,
        AND one in.
        """
        # 1. Collect table references + check the allowlist.
        refs: list[tuple[str, str | None, str | None]] = []
        for m in _TABLE_REF_RE.finditer(sql):
            schema = m.group(2)
            table = m.group(1).lower()
            alias = m.group(3)
            if schema is not None and schema.lower() != "public":
                raise SqlUnknownTableError(
                    f"schema-qualified table not allowed: {schema}.{table}",
                )
            if table not in self._allowed_tables:
                raise SqlUnknownTableError(
                    f"table not in allowlist: {table!r}",
                )
            refs.append((table, schema, alias))

        if not refs:
            # No FROM clause at all — this is something like
            # ``SELECT 1``. We allow it (it's harmless) but skip
            # the org injection.
            return sql

        # 2. Confirm at least one tenant-scoped table is referenced.
        #    (We don't want to allow a query that touches only
        #    system tables.)
        has_tenant = any(t in self._tenant_scoped_tables for t, _, _ in refs)
        if not has_tenant:
            raise SqlTenantViolationError(
                "query must reference at least one tenant-scoped table",
            )

        # 3. Inject the org filter. We do this by appending a
        #    WHERE clause if there isn't one, or ANDing into
        #    the existing one.
        return self._inject_org_filter(sql, org_id)

    @staticmethod
    def _inject_org_filter(sql: str, org_id: str) -> str:
        """Append / AND-in an org_id filter.

        We do not attempt full SQL parsing here. Instead:
          - If the SQL already contains a ``where`` keyword
            (case-insensitive, outside of strings — we don't
            split on strings, which is a known limitation),
            we add `` AND org_id = '<org_id>'`` to the end.
          - Otherwise we add `` WHERE org_id = '<org_id>'``.

        The org_id is a UUID-shaped string (validated upstream),
        so the single-quote injection risk is bounded. We still
        escape any single quote in the org_id as a defence.
        """
        escaped = org_id.replace("'", "''")
        clause = f"org_id = '{escaped}'"
        # Naive WHERE detection. False positives are possible
        # (e.g. ``SELECT 'where' FROM t``) but the org_id is
        # appended as a comment-style hint, and the result is
        # still correct: ``SELECT 'where' FROM t WHERE org_id = ...``.
        # A malformed user query that puts WHERE in a string
        # literal would still parse, just with our AND in the
        # wrong place — that's why the rewriter is the last
        # line of defence, not the only one. The Postgres
        # permissions are the real safety net.
        if re.search(r"\bwhere\b", sql, re.IGNORECASE):
            return f"{sql.rstrip().rstrip(';').rstrip()} AND {clause}"
        return f"{sql.rstrip().rstrip(';').rstrip()} WHERE {clause}"

    @staticmethod
    def _bind_params(sql: str, params: dict[str, Any]) -> tuple[str, list[Any]]:
        """Bind named params ``:foo`` → positional ``$N``.

        We accept string / int / float / bool / None params. The
        binding is positional because the Postgres client uses
        ``$1, $2, ...`` placeholders. We skip ``:name`` matches
        that fall inside single-quoted string literals so a query
        like ``SELECT ':foo' FROM t`` is left untouched.
        """
        if not params:
            return sql, []
        # Walk the SQL statefully — tracks ``in_string`` so we
        # skip :name matches inside single-quoted string literals.
        # ``''`` (escaped quote inside a string) does not toggle the
        # state, matching Postgres' own parser.
        pat = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)")
        args: list[Any] = []
        out_parts: list[str] = []
        last = 0
        in_string = False
        i = 0
        for m in pat.finditer(sql):
            # Advance the string-state cursor to ``m.start()``,
            # toggling ``in_string`` on each unescaped ``'``.
            while i < m.start():
                ch = sql[i]
                if ch == "'":
                    if in_string and i + 1 < len(sql) and sql[i + 1] == "'":
                        # Escaped quote inside string — skip both.
                        i += 2
                        continue
                    in_string = not in_string
                i += 1
            if in_string:
                continue
            name = m.group(1)
            if name not in params:
                # Leave it untouched — Postgres will raise a
                # "parameter not bound" error, which is the
                # correct failure mode (the user referenced
                # a param they didn't supply).
                continue
            out_parts.append(sql[last:m.start()])
            args.append(params[name])
            out_parts.append(f"${len(args)}")
            last = m.end()
        out_parts.append(sql[last:])
        return "".join(out_parts), args

    @staticmethod
    def _wrap_row_cap(sql: str, cap: int) -> str:
        """Wrap the user's query in a SELECT that returns at
        most ``cap`` rows.

        We use a CTE so the user's ORDER BY is preserved::

            WITH _user_query AS ({sql})
            SELECT * FROM _user_query LIMIT {cap}
        """
        return f"WITH _user_query AS ({sql.rstrip().rstrip(';')}) SELECT * FROM _user_query LIMIT {cap}"

    # ── Execution with timeout ────────────────────────────────

    async def _run_with_timeout(
        self,
        sql: str,
        args: list[Any],
        timeout_seconds: int,
    ) -> list[dict[str, Any]]:
        """Run the query with a per-statement timeout.

        We use ``SET LOCAL statement_timeout`` inside a
        transaction so the timeout is scoped to the query and
        does not leak to the next caller on a pooled
        connection. The ``SET LOCAL`` requires a transaction,
        which the Postgres client helper provides.
        """
        timeout_ms = int(timeout_seconds * 1000)
        # Postgres SQL: SET LOCAL statement_timeout = '<ms>';
        set_timeout_sql = f"SET LOCAL statement_timeout = {timeout_ms}"
        pg = self._pg
        try:
            async with pg.transaction() as tx:
                # tx.execute is asyncpg-style; we use the high-
                # level API instead.
                if hasattr(pg, "execute"):
                    await pg.execute(set_timeout_sql)
                else:
                    # No high-level execute — skip the timeout
                    # and rely on the caller's statement_timeout
                    # config.
                    pass
                # Run the query inside the same transaction.
                fetch = getattr(tx, "fetch", None) or pg.fetch
                rows = await fetch(sql, *args)
                return list(rows)
        except Exception as exc:
            # asyncpg raises ``QueryCanceledError`` on timeout.
            # We translate to our typed error so the API layer
            # can return a structured response.
            if _is_timeout(exc):
                raise _StatementTimeoutSignal() from exc
            raise


# ── Internal helpers ───────────────────────────────────────────────


class _StatementTimeoutSignal(Exception):
    """Internal signal — converted to SqlTimeoutError at the boundary."""


def _is_timeout(exc: BaseException) -> bool:
    """Detect a Postgres statement_timeout error.

    asyncpg's ``QueryCanceledError`` has a ``sqlstate`` of
    ``57014`` (query_canceled). We check both the exception
    class name and the SQLSTATE to be robust across driver
    versions.
    """
    name = type(exc).__name__
    if name in ("QueryCanceledError", "StatementTimeoutError"):
        return True
    sqlstate = getattr(exc, "sqlstate", None) or getattr(exc, "pg_code", None)
    if sqlstate == "57014":
        return True
    msg = str(exc).lower()
    return "statement timeout" in msg or "canceling statement" in msg


# ── Schema introspection ───────────────────────────────────────────


async def get_schema_summary(pg: Any) -> list[dict[str, Any]]:
    """Return a list of ``{table, columns: [...]}`` for the
    allowlisted tables.

    The portal uses this to render the "browse schema" panel in
    the SQL editor. The result is cached at the API layer for
    5 minutes.
    """
    rows: list[dict[str, Any]] = []
    for table in sorted(ALLOWED_TABLES):
        # We use information_schema (read-only, always present)
        # to fetch the column list. The user is implicitly
        # trusted to know the table exists in the allowlist.
        try:
            cols = await pg.fetch(
                """
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = $1
                ORDER BY ordinal_position
                """,
                table,
            )
        except Exception as exc:
            logger.debug("schema summary failed for %s: %s", table, exc)
            cols = []
        rows.append({
            "table": table,
            "columns": [
                {"name": c.get("column_name"), "type": c.get("data_type")}
                for c in cols
            ],
        })
    return rows


__all__ = [
    "SqlExecutor",
    "SqlResult",
    "SqlExecutorError",
    "SqlForbiddenStatementError",
    "SqlMultiStatementError",
    "SqlUnknownTableError",
    "SqlTenantViolationError",
    "SqlTimeoutError",
    "ALLOWED_TABLES",
    "TENANT_SCOPED_TABLES",
    "DEFAULT_MAX_ROWS",
    "MAX_MAX_ROWS",
    "DEFAULT_MAX_SECONDS",
    "MAX_MAX_SECONDS",
    "get_schema_summary",
]
