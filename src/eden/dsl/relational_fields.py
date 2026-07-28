"""Cat 19 — RelationalFieldResolver.

Translates the ``root.`` / ``parent.`` / ``any.`` prefixes into
the underlying ClickHouse SQL (the Honeycomb relational-field
pattern, the "killer feature" of EQL per the appendix).

The resolver is a thin wrapper over :func:`_expand_query` that
returns the expanded query alongside the list of lint warnings
the expansion surfaced. The expansion itself is deterministic:
the same input → the same output, so the resolver is re-runnable.

The v1.3 ship supports the three prefixes the appendix calls
out:

* **``root.``** — the outer trace's root span (no parent). Maps
  to a predicate on the outer table with a ``parent_span_id IS
  NULL`` guard.
* **``parent.``** — the parent span of the current row. Maps
  to a correlated subquery on ``(org_id, span_id)``.
* **``any.``** — any span in the trace. Maps to an ``EXISTS``
  correlated subquery on ``(org_id, trace_id)``.

The resolver is the highest-call-frequency service in the
Cat 19 surface — the front-end will call it on every
keystroke in the IDE. The 1ms-or-less target is met by the
single-pass regex substitution the v1.3 ship uses.
"""

from __future__ import annotations

import logging
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


class RelationalFieldResolver:
    """Translate the relational-field prefixes into ClickHouse SQL."""

    async def resolve(
        self,
        org_id: str,
        *,
        query: str,
        lint_mode: str = "default",
    ) -> dict[str, Any]:
        """Expand the relational fields and return the rewritten query.

        Args:
            org_id: The tenant id. Auto-injected if missing.
            query: The EQL query. SQL only.
            lint_mode: One of ``default|strict``.

        Returns:
            The Cat 19 live envelope with ``expanded_query``
            and the ``warnings`` list. On a strict-mode block,
            the envelope is the ``not_implemented`` shape.
        """
        if not query or not query.strip():
            return _not_implemented_envelope(
                "RelationalFieldResolver",
                "query is required and must be non-empty",
            )
        if lint_mode not in ("default", "strict"):
            return _not_implemented_envelope(
                "RelationalFieldResolver",
                f"invalid lint_mode: {lint_mode!r} "
                "(expected one of: default, strict)",
            )
        if not _looks_like_readonly_sql(query):
            return _not_implemented_envelope(
                "RelationalFieldResolver",
                "query failed the read-only allowlist check",
            )

        t0 = time.monotonic()
        try:
            expanded, expansion_warnings = _expand_query(query, org_id)
        except ValueError as exc:
            # _inject_org_id rejects a query whose WHERE body has an
            # unbalanced (odd) quote count outside comments -- see the
            # SECURITY/correctness note above _inject_org_id. Same
            # convention as every other malformed-input case in this
            # method: a clear not_implemented envelope, not an
            # uncaught 500.
            return _not_implemented_envelope("RelationalFieldResolver", str(exc))
        # Also lint the original query (the resolver should
        # surface NO_FILTERS, MISSING_ORG, etc. — these are
        # customer's mistakes, not artifacts of the
        # expansion). The linter itself is the same helper
        # the EQLLinter uses.
        lint_warnings = _lint_query(query, shape=None)
        warnings = expansion_warnings + lint_warnings
        has_error = any(w["severity"] == "error" for w in warnings)
        blocked = lint_mode == "strict" and has_error
        duration_ms = int((time.monotonic() - t0) * 1000)
        return _ok_with_warnings(
            "RelationalFieldResolver",
            {
                "expanded_query": expanded,
                "duration_ms": duration_ms,
            },
            warnings,
            blocked=blocked,
        )


__all__ = ["RelationalFieldResolver"]
