"""Cat 19 — EQLLinter.

Raises the 4 Braintrust-parity lint warnings:

* **NO_FILTERS** — no WHERE clause → full-table scan.
* **ANY_SPAN_OVERUSE** — more than 2 ``any.`` references.
* **MISSING_ORG** — no ``org_id`` filter.
* **SHAPE_MISMATCH** — references a field not in the
  requested shape's first-class field set.

The linter is the head of the alert-editor preview path: the
UI calls ``lint`` on every keystroke and surfaces the
warnings inline, so the customer sees "this query will
full-table scan" *before* they hit save. The strict-mode
behaviour is also surfaced via the same route — the front-end
can toggle strict mode and the linter returns the blocked
envelope on error.

The 4 rules are persisted to ``eql_lint_warnings`` on every
call (even when no warnings fire — a future v1.4 feature
will use the "no warnings" rows to compute "this customer
writes queries that pass the linter" rollups).
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _insert_lint_warnings,
    _lint_query,
    _not_implemented_envelope,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


class EQLLinter:
    """Lint an EQL query against the 4 Braintrust-parity rules."""

    async def lint(
        self,
        org_id: str,
        *,
        query: str,
        shape: str | None = None,
        lint_mode: str = "default",
    ) -> dict[str, Any]:
        """Run the linter and return the warnings.

        Args:
            org_id: The tenant id (used for the audit log
                persistence path — the linter itself is
                org-agnostic).
            query: The EQL query.
            shape: Optional shape hint (``traces|spans|summary``).
                When provided, the SHAPE_MISMATCH rule fires
                on references to fields outside the shape's
                first-class set.
            lint_mode: One of ``default|strict``. The linter
                itself returns the same warnings either way;
                the strict mode is enforced at the call site
                (the parser + relational-field resolver block
                on error-severity warnings in strict mode).

        Returns:
            The Cat 19 live envelope with the ``warnings``
            list and the ``lint_mode``. The lint warnings
            are also persisted to ``eql_lint_warnings`` so
            the UI can render the audit log.
        """
        if not query or not query.strip():
            return _not_implemented_envelope(
                "EQLLinter",
                "query is required and must be non-empty",
            )
        if lint_mode not in ("default", "strict"):
            return _not_implemented_envelope(
                "EQLLinter",
                f"invalid lint_mode: {lint_mode!r} "
                "(expected one of: default, strict)",
            )
        if shape is not None and shape not in ("traces", "spans", "summary"):
            return _not_implemented_envelope(
                "EQLLinter",
                f"invalid shape: {shape!r} "
                "(expected one of: traces, spans, summary, or None)",
            )

        warnings = _lint_query(query, shape=shape)
        # Persist the warnings to the audit log. The helper
        # is a no-op when the list is empty.
        await _insert_lint_warnings(
            org_id=org_id,
            query=query,
            warnings=warnings,
            lint_mode=lint_mode,
        )
        return _ok_envelope(
            "EQLLinter",
            {
                "warnings": warnings,
                "lint_mode": lint_mode,
                "shape": shape,
                "n_warnings": len(warnings),
                "n_errors": sum(1 for w in warnings if w["severity"] == "error"),
            },
        )


__all__ = ["EQLLinter"]
