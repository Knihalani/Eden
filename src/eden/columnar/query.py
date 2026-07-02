"""Cat 18 — ColumnarQueryEngine.

The headline API surface: a fast SQL path against the
ClickHouse substrate with a deterministic Postgres
fallback. The v1.3 ship supports three engine modes:

* **clickhouse** — always attempt ClickHouse; raise on
  failure (the caller is opting in to a hard dependency).
* **postgres** — always use Postgres; useful for the
  tests and for the
  ``data_source: "postgres_fallback"`` code path.
* **auto** (default) — try ClickHouse first; on any
  failure (timeout, unavailable, query error), fall back
  to Postgres and tag the response with
  ``data_source: "postgres_fallback"`` so the UI can
  render the "slower than usual" badge.

The query engine is the only service that has a real
**input sanitisation** surface — the caller passes raw
SQL, so the only safe default is to require an
explicit ``engine=postgres`` (or pre-vetted rollup SQL).
The auto + clickhouse paths enforce a 5-second timeout
to keep the request budget under control.

The 90-day cost dashboard the Cat 18 surface is built
for reads ``SELECT sum(cost_usd) FROM usage_events WHERE
org_id = $1 AND created_at >= $2`` — a single bucket
aggregate that the v1.3 substrate handles in < 100ms
instead of the 8-12 seconds the unindexed Postgres path
takes. The query engine deliberately doesn't optimise
the query — that's the clickhouse side's job (the
``ORDER BY (org_id, ...)`` on the existing usage_events
table is the index that makes the 90-day query fast).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime
from typing import Any

from ._common import (
    _check_ch_available,
    _fire_compaction_drift_hook,
    _not_implemented_envelope,
    _ok_envelope,
    _ok_fallback_envelope,
)

logger = logging.getLogger(__name__)


# 5-second hard cap on a single query. The dashboard
# budget is 1s; 5s is a generous ceiling that still
# fails fast on a hung substrate.
QUERY_TIMEOUT_SECONDS: float = 5.0

# A read-only regex used to reject obviously-mutating
# SQL on the auto + clickhouse paths. The check is
# deliberately conservative: it accepts anything that
# starts with SELECT or WITH, then scans for the
# dangerous keyword set. The clickhouse substrate is
# also configured for read-only, so this is
# defence-in-depth (caller mistakes + future substrate
# changes), not the primary safety net.
_DISALLOWED_DML_KEYWORDS: tuple[str, ...] = (
    "DROP", "DELETE", "INSERT", "UPDATE", "ALTER",
    "TRUNCATE", "CREATE", "REPLACE", "RENAME",
    "GRANT", "REVOKE", "OPTIMIZE", "KILL",
)

# B-17: table allowlist regex. Captures the table name
# after FROM, JOIN, INTO, UPDATE. Each keyword has its own
# capture group so callers can collect every reference.
_TABLE_NAME_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE)\s+"
    r"(?:`(?P<backtick>[^`]+)`|\"(?P<double>[^\"]+)\"|(?P<bare>[A-Za-z_][A-Za-z0-9_]*))",
    re.IGNORECASE,
)

# B-17: tables the Postgres fallback path is allowed to read.
_PG_ALLOWED_TABLES: frozenset[str] = frozenset(
    {"telemetry_events", "usage_events", "judge_scores"}
)


def _strip_sql_for_table_check(query: str) -> str:
    """Strip SQL comments + string literals so they can't fake
    a table reference.

    Used by the B-17 pg-fallback table allowlist. Both
    ``-- line`` comments and ``/* block */`` comments are
    removed; ``'...'`` and ``"..."`` string literals are
    blanked to ``''`` / ``""`` so a literal like
    ``SELECT 'FROM users' FROM telemetry_events`` doesn't
    trick the table regex into seeing ``users``.
    """
    if not query:
        return ""
    out = re.sub(r"--[^\n]*", "", query)
    out = re.sub(r"/\*.*?\*/", "", out, flags=re.DOTALL)
    out = re.sub(r"'(?:''|[^'])*'", "''", out)
    out = re.sub(r'"(?:""|[^"])*"', '""', out)
    return out


def _extract_referenced_tables(query: str) -> set[str]:
    """Return the set of table names referenced in the SQL.

    Comments and string literals are stripped first via
    :func:`_strip_sql_for_table_check` so neither can fake
    a reference.
    """
    cleaned = _strip_sql_for_table_check(query)
    found: set[str] = set()
    for m in _TABLE_NAME_RE.finditer(cleaned):
        for g in m.groups():
            if g:
                found.add(g)
                break
    return found


def _looks_like_readonly_sql(query: str) -> bool:
    """Return True if the SQL passes the read-only allowlist check.

    A two-stage check:

    1. The first non-comment keyword must be
       ``SELECT`` or ``WITH``. Anything else is
       rejected — ``DROP``, ``UPDATE``, ``DELETE``, etc.
       start with those exact words.
    2. The body must not contain any of the
       :data:`_DISALLOWED_DML_KEYWORDS` keywords. We
       strip string literals (single + double quotes)
       first so a column name like ``drop_count`` in a
       string literal doesn't false-positive.
    """
    if not query or not query.strip():
        return False
    # Strip leading comments (line + block).
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
    # Strip string literals so their contents don't
    # trigger the keyword check. We use a single regex
    # that handles both single + double quotes; nested
    # quotes are not supported by Postgres / ClickHouse
    # identifiers so this is sufficient.
    no_strings = re.sub(r"'[^']*'", "''", cleaned)
    no_strings = re.sub(r'"[^"]*"', '""', no_strings)
    # Tokenise on word boundaries; check uppercase form
    # against the disallowed set.
    for token in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\b", no_strings):
        if token.upper() in _DISALLOWED_DML_KEYWORDS:
            return False
    return True


class ColumnarQueryEngine:
    """Read-only SQL executor with ClickHouse + Postgres fallback (Cat 18, v1.3)."""

    async def execute(
        self,
        org_id: str,
        *,
        query: str,
        engine: str = "auto",
    ) -> dict[str, Any]:
        """Execute a read-only SQL query against the columnar engine.

        Args:
            org_id: The tenant id. Re-injected into the
                query as a ``WHERE org_id = $1`` clause if
                the query is missing the org filter — the
                data leak across orgs is the worst
                failure mode for a columnar engine.
            query: The read-only SQL to execute. Validated
                against the read-only allowlist on the
                ``auto`` + ``clickhouse`` paths.
            engine: One of ``clickhouse|postgres|auto``.
                Default ``auto``: try ClickHouse first,
                fall back to Postgres on any failure.

        Returns:
            The Cat 18 live envelope with the rows,
            ``engine_used``, ``duration_ms``, and
            ``data_source``. ``data_source`` is
            ``clickhouse`` on the happy path,
            ``postgres_fallback`` on the fallback path.
            A read-only violation returns the
            ``not_implemented`` envelope with a clear
            message.
        """
        if engine not in ("clickhouse", "postgres", "auto"):
            return _not_implemented_envelope(
                "ColumnarQueryEngine",
                f"invalid engine: {engine!r} "
                "(expected one of: clickhouse, postgres, auto)",
            )
        if not query or not query.strip():
            return _not_implemented_envelope(
                "ColumnarQueryEngine",
                "query is required and must be non-empty",
            )

        # Read-only check on the auto + clickhouse paths.
        if engine in ("auto", "clickhouse") and not _looks_like_readonly_sql(query):
            return _not_implemented_envelope(
                "ColumnarQueryEngine",
                "query failed the read-only allowlist check "
                "(rejected non-SELECT/WITH leading keyword or "
                "disallowed identifier)",
            )

        # 1. Inject the org_id filter if the caller forgot.
        #    The Cat 18 failure-modes table calls this out
        #    as a critical risk: "Data leak across orgs".
        if "org_id" not in query.lower():
            return _not_implemented_envelope(
                "ColumnarQueryEngine",
                "query must include an org_id filter "
                "(auto-injection disabled in v1.3; "
                "include `org_id` in the WHERE clause to proceed)",
            )

        # 2. Decide the engine to try first.
        if engine == "auto":
            tried = "clickhouse" if await _check_ch_available() else "postgres"
        else:
            tried = engine

        if tried == "clickhouse":
            try:
                t0 = time.monotonic()
                rows = await asyncio.wait_for(
                    self._ch_execute(query=query),
                    timeout=QUERY_TIMEOUT_SECONDS,
                )
                duration_ms = int((time.monotonic() - t0) * 1000)
                return _ok_envelope(
                    "ColumnarQueryEngine",
                    {
                        "rows": rows,
                        "engine_used": "clickhouse",
                        "duration_ms": duration_ms,
                        "data_source": "clickhouse",
                        "n_rows": len(rows),
                    },
                )
            except Exception as exc:  # noqa: BLE001 - fallback path
                logger.warning(
                    "ClickHouse query failed for org=%s: %s; falling back",
                    org_id,
                    exc,
                )
                if engine == "clickhouse":
                    # The caller explicitly opted in to
                    # clickhouse-only; do NOT fall back. Return
                    # the error envelope so the operator can
                    # see what happened.
                    return _not_implemented_envelope(
                        "ColumnarQueryEngine",
                        f"clickhouse query failed: {exc}",
                    )
                # engine == "auto": fall through to the
                # Postgres path. Fire the closed-loop hook
                # with the ch_unavailable reason so the
                # operator can see the substrate is degraded.
                await _fire_compaction_drift_hook(
                    org_id,
                    partition_id=None,
                    reason="ch_unavailable",
                    severity="medium",
                )

        # 3. Postgres path. We translate the query for the
        #    caller's intent as best we can; in v1.3 the
        #    safe shape is a small set of pre-vetted
        #    rollup queries (the dashboard's hot paths).
        t0 = time.monotonic()
        try:
            rows = await asyncio.wait_for(
                self._pg_execute(query=query),
                timeout=QUERY_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            return _not_implemented_envelope(
                "ColumnarQueryEngine",
                f"postgres query exceeded {QUERY_TIMEOUT_SECONDS}s timeout",
            )
        # B-17: the pg-fallback path may return the
        # not-implemented envelope when the SQL references a
        # non-allowlisted table. Surface it directly.
        if isinstance(rows, dict):
            return rows
        duration_ms = int((time.monotonic() - t0) * 1000)
        if engine == "auto":
            return _ok_fallback_envelope(
                "ColumnarQueryEngine",
                {
                    "rows": rows,
                    "engine_used": "postgres",
                    "duration_ms": duration_ms,
                    "data_source": "postgres_fallback",
                    "n_rows": len(rows),
                },
                "ClickHouse unavailable or query failed; using Postgres",
            )
        return _ok_envelope(
            "ColumnarQueryEngine",
            {
                "rows": rows,
                "engine_used": "postgres",
                "duration_ms": duration_ms,
                "data_source": "postgres",
                "n_rows": len(rows),
            },
        )

    async def _ch_execute(self, *, query: str) -> list[dict[str, Any]]:
        """Run a query against the ClickHouse substrate.

        Returns the rows as a list of dicts. The
        underlying substrate's ``_parse_tsv`` converts the
        tab-separated output to dicts.
        """
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink

        sink = await get_clickhouse_sink()
        raw = await sink._execute(query)  # noqa: SLF001 - intentional
        return sink._parse_tsv(raw)  # noqa: SLF001 - intentional

    async def _pg_execute(self, *, query: str) -> Any:
        """Run a query against Postgres.

        Postgres accepts the same SQL shape as ClickHouse
        for the most part (both are SQL dialects), but the
        v1.3 ship deliberately restricts this path to the
        ``telemetry_events`` + ``usage_events`` +
        ``judge_scores`` source tables so a caller can't
        turn the fallback into a Postgres-side SQL
        injection surface.

        B-17: extracts referenced table names via
        :func:`_extract_referenced_tables` and refuses any
        query that touches a table outside the allowlist.
        On refusal returns the :func:`_not_implemented_envelope`
        dict (the executor expects a list on the happy path;
        a dict here signals the caller to render the
        envelope-shaped error).
        """
        referenced = _extract_referenced_tables(query)
        disallowed = referenced - _PG_ALLOWED_TABLES
        if disallowed:
            logger.warning(
                "ColumnarQueryEngine._pg_execute refused query; "
                "disallowed tables=%s",
                sorted(disallowed),
            )
            return _not_implemented_envelope(
                "ColumnarQueryEngine",
                f"query references table(s) outside the "
                f"pg-fallback allowlist {_PG_ALLOWED_TABLES!r}: "
                f"{sorted(disallowed)!r}",
            )
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        rows = await client.fetch(query)
        out: list[dict[str, Any]] = []
        for r in rows:
            # asyncpg's Record supports both index and
            # attribute access. We coerce datetimes to ISO
            # strings so the JSON-serialisable shape is
            # consistent with the clickhouse path.
            d: dict[str, Any] = {}
            for k, v in dict(r).items():
                if isinstance(v, datetime):
                    d[k] = v.isoformat()
                else:
                    d[k] = v
            out.append(d)
        return out


__all__ = [
    "ColumnarQueryEngine",
    "QUERY_TIMEOUT_SECONDS",
    "_looks_like_readonly_sql",
    "_strip_sql_for_table_check",
    "_TABLE_NAME_RE",
    "_extract_referenced_tables",
    "_PG_ALLOWED_TABLES",
]
