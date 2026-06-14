"""Cat 19 — EQLParser.

The headline service: parse an EQL query and return the
compiled ClickHouse SQL + the shape + the list of relational
fields used. The v1.3 ship is **SQL only** (no BTQL pipe
syntax, per the 2026-06-11 decision).

The parser is intentionally minimal — it validates that the
query is a SELECT (or WITH), runs the relational-field
expansion to translate ``root.`` / ``parent.`` / ``any.``
prefixes into ClickHouse SQL, and returns the shape (default
``traces``). The full SQL AST work is deferred to v2 (the
appendix Open Question lists ``sqlglot`` as the v2 dependency).

The parser is also the path the v0 IDE autocomplete will
build on — the ``relational_fields_used`` field tells the
front-end which prefixes to suggest.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from ._common import (
    _expand_query,
    _lint_query,
    _looks_like_readonly_sql,
    _not_implemented_envelope,
    _ok_with_warnings,
)

logger = logging.getLogger(__name__)


# EQL shapes (Braintrust parity). The v1.3 ship accepts the
# 3 shapes the appendix calls out; any other value returns
# the ``not_implemented`` envelope.
_VALID_SHAPES: frozenset[str] = frozenset({"traces", "spans", "summary"})


class EQLParser:
    """Parse an EQL query and return the compiled ClickHouse SQL."""

    async def parse(
        self,
        org_id: str,
        *,
        query: str,
        shape: str = "traces",
        lint_mode: str = "default",
    ) -> dict[str, Any]:
        """Parse the EQL query and return the compiled form.

        Args:
            org_id: The tenant id. Auto-injected into the
                query if missing (the ``MISSING_ORG`` lint
                warning is surfaced either way).
            query: The EQL query. SQL only — no BTQL pipe
                syntax (the parser rejects the leading
                ``select:`` / ``filter:`` token pattern).
            shape: One of ``traces|spans|summary``. Default
                ``traces``. Controls the SHAPE_MISMATCH lint
                warning and the field set the alert-as-code
                compiler renders.
            lint_mode: One of ``default|strict``. ``default``
                returns the warnings in the response;
                ``strict`` blocks the query when at least
                one warning is ``severity='error'``.

        Returns:
            The Cat 19 live envelope with ``clickhouse_sql``,
            ``shape``, ``relational_fields_used``, and the
            ``warnings`` list. On a strict-mode block, the
            envelope is the ``not_implemented`` shape with
            a clear message.
        """
        if shape not in _VALID_SHAPES:
            return _not_implemented_envelope(
                "EQLParser",
                f"invalid shape: {shape!r} "
                "(expected one of: traces, spans, summary)",
            )
        if lint_mode not in ("default", "strict"):
            return _not_implemented_envelope(
                "EQLParser",
                f"invalid lint_mode: {lint_mode!r} "
                "(expected one of: default, strict)",
            )
        if not query or not query.strip():
            return _not_implemented_envelope(
                "EQLParser",
                "query is required and must be non-empty",
            )

        # BTQL pipe syntax — rejected explicitly. The user
        # decision (2026-06-11) is "SQL only, no pipe parser";
        # the v0 ship returns a clear 400-class envelope when
        # the leading token looks like a BTQL directive.
        stripped = query.lstrip()
        if re.match(
            r"^(select|filter|dimensions|where|group|order|having|"
            r"compute|sort|limit):",
            stripped,
            flags=re.IGNORECASE,
        ):
            return _not_implemented_envelope(
                "EQLParser",
                "BTQL pipe syntax is not supported in v1.3 "
                "(SQL-only decision, 2026-06-11). Use a "
                "standard SELECT statement.",
            )

        # Read-only check.
        if not _looks_like_readonly_sql(query):
            return _not_implemented_envelope(
                "EQLParser",
                "query failed the read-only allowlist check "
                "(rejected non-SELECT/WITH leading keyword or "
                "disallowed identifier)",
            )

        t0 = time.monotonic()
        # 1. Expand the relational fields.
        clickhouse_sql, expansion_warnings = _expand_query(query, org_id)

        # 2. Run the linter on the ORIGINAL query. The linter
        #    is meant to surface the customer's mistakes
        #    (NO_FILTERS, ANY_SPAN_OVERUSE, MISSING_ORG,
        #    SHAPE_MISMATCH) — linting the *expanded* query
        #    would hide the MISSING_ORG case (the expansion
        #    auto-injects the org_id filter).
        lint_warnings = _lint_query(query, shape=shape)

        all_warnings = expansion_warnings + lint_warnings

        # 3. Block in strict mode if any warning is error.
        has_error = any(w["severity"] == "error" for w in all_warnings)
        blocked = lint_mode == "strict" and has_error

        # 4. Compute relational fields used (for the IDE
        #    autocomplete hint in the response).
        relational_fields_used = sorted(
            {m.group(1) for m in re.finditer(r"\b(root|parent|any)\.", query)}
        )

        duration_ms = int((time.monotonic() - t0) * 1000)
        data = {
            "clickhouse_sql": clickhouse_sql,
            "shape": shape,
            "relational_fields_used": relational_fields_used,
            "duration_ms": duration_ms,
        }
        return _ok_with_warnings(
            "EQLParser",
            data,
            all_warnings,
            blocked=blocked,
        )


__all__ = ["EQLParser", "_VALID_SHAPES"]
