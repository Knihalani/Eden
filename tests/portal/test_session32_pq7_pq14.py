"""Session 32 tests — Portal quality (PQ-7, PQ-9, PQ-10, PQ-11, PQ-14).

Five audit items from Part G "Portal polish" final pass:

* **PQ-7** — Replace bare ``Loader2`` spinners in the loading
  states of ``TracesTab`` (``observability/_components``) and the
  ``HubTile`` value slot in ``observability/page.tsx`` with the
  shared ``Skeleton`` / ``SkeletonTableRow`` components so the
  page doesn't visually "jump" when data arrives.
* **PQ-9** — The previously orphan "Add / Update payment method"
  button in ``billing/page.tsx`` is wired through a handler with
  a ``try/catch`` + ``toast.error`` so backend failures surface
  instead of silently doing nothing.
* **PQ-10/PQ-11** — ``lib/api.ts`` introduces an ``ApiError`` class
  carrying the HTTP ``status`` field so callers can branch on
  ``err instanceof ApiError && err.status === 401`` instead of
  regex-parsing the message string. Both throw sites (the
  generic ``fetchApi`` and the exportOrgData 2nd-fetch) use it.
* **PQ-14** — The seven pages that previously re-defined
  ``const API_BASE = NEXT_PUBLIC_API_URL || "http://localhost:8000"``
  now import the canonical ``API_BASE`` from ``@/lib/api``. The
  pre-fix local definitions silently bypassed the proxy in
  production (the cookie would never reach FastAPI).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests._portal_api_source import portal_api_source

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


def _read(rel: str) -> str:
    if rel in ("src/lib/api.ts", "src/lib/api"):
        raw = portal_api_source()
    else:
        raw = (_PORTAL_ROOT / rel).read_text()
    # Strip ``//`` line comments — the audit-fix comments mention
    # the literal patterns in prose.
    return "\n".join(
        line for line in raw.splitlines()
        if not line.lstrip().startswith("//")
    )


# ─── PQ-7 — Skeletons replace bare spinners ────────────────────


class TestTracesTabSkeletonRows:
    """``TracesTab`` renders 8 ``SkeletonTableRow`` placeholders
    when ``loading && traces.length === 0`` so the page doesn't
    visually jump when the real rows arrive.
    """

    def test_uses_skeleton_table_row(self) -> None:
        source = _read(
            "src/app/(portal)/observability/_components/TracesTab.tsx"
        )
        assert "SkeletonTableRow" in source, (
            "PQ-7 regression: TracesTab must render SkeletonTableRow "
            "placeholders during initial load"
        )

    def test_imports_from_skeleton_module(self) -> None:
        """The component imports ``SkeletonTableRow`` from the
        shared skeleton module, not from a fresh local definition."""
        source = _read(
            "src/app/(portal)/observability/_components/TracesTab.tsx"
        )
        assert (
            'import { SkeletonTableRow } from "@/components/ui/skeleton"'
            in source
        ), "PQ-7 regression: must import SkeletonTableRow from /components/ui/skeleton"

    def test_no_bare_loader2_spinner(self) -> None:
        """The bare ``<Loader2 ... animate-spin ... />`` in the
        initial-load branch is gone."""
        source = _read(
            "src/app/(portal)/observability/_components/TracesTab.tsx"
        )
        # Loader2 should not appear — the import was removed.
        assert "Loader2" not in source, (
            "PQ-7 regression: TracesTab still has Loader2 "
            "(should be replaced by SkeletonTableRow)"
        )


class TestObservabilityHubTileSkeleton:
    """``observability/page.tsx``'s ``HubTile`` uses a Skeleton bar
    instead of a tiny spinning Loader2 when the stat value is null
    (loading).
    """

    def test_uses_skeleton_class(self) -> None:
        source = _read(
            "src/app/(portal)/observability/page.tsx"
        )
        assert "Skeleton" in source, (
            "PQ-7 regression: observability page must import and "
            "use Skeleton (HubTile's value === null branch)"
        )

    def test_imports_skeleton(self) -> None:
        """The page imports ``Skeleton`` from the shared module."""
        source = _read(
            "src/app/(portal)/observability/page.tsx"
        )
        assert (
            'import { Skeleton } from "@/components/ui/skeleton"'
            in source
        ), "PQ-7 regression: must import Skeleton from /components/ui/skeleton"


# ─── PQ-9 — Orphan button gets a handler + toast ────────────────


class TestBillingPaymentMethodButton:
    """The orphan ``Add / Update payment method`` button is wired
    through a handler that toasts backend failures.
    """

    @pytest.fixture(autouse=True)
    def _require_billing_page(self) -> None:
        path = (
            _PORTAL_ROOT / "src/app/(portal)/billing/page.tsx"
        )
        if not path.is_file():
            pytest.skip("billing page removed; PQ-9 surface N/A")

    def test_button_has_on_click(self) -> None:
        """The button must have an ``onClick`` handler (pre-fix it
        was an orphan with no handler)."""
        source = _read(
            "src/app/(portal)/billing/page.tsx"
        )
        # Find the "Add payment method" or "Update" string and
        # confirm it's wrapped in a Button with an onClick.
        assert (
            "onClick={handleUpdatePaymentMethod}" in source
        ), (
            "PQ-9 regression: payment method button must have an "
            "onClick={handleUpdatePaymentMethod} handler"
        )

    def test_has_handler_function(self) -> None:
        """A handler named ``handleUpdatePaymentMethod`` exists
        and is an ``async`` function so failures can be caught."""
        source = _read(
            "src/app/(portal)/billing/page.tsx"
        )
        assert "const handleUpdatePaymentMethod = async" in source, (
            "PQ-9 regression: handleUpdatePaymentMethod must be "
            "declared as an async function"
        )

    def test_handler_has_toast(self) -> None:
        """The handler must include ``toast.error`` so any backend
        failure surfaces to the user instead of silently no-op'ing."""
        source = _read(
            "src/app/(portal)/billing/page.tsx"
        )
        # Locate the handler block and check for toast.error inside.
        start = source.index("const handleUpdatePaymentMethod")
        # End of function = matching closing brace; heuristic: grab
        # the next 50 lines.
        block = source[start : start + 2500]
        assert "toast.error(" in block, (
            "PQ-9 regression: handleUpdatePaymentMethod must call "
            "toast.error on failure (was silent no-op pre-fix)"
        )


# ─── PQ-10 / PQ-11 — typed ApiError class ───────────────────────


class TestApiErrorClass:
    """``lib/api.ts`` exposes an ``ApiError`` class so callers can
    branch on ``err instanceof ApiError && err.status`` rather than
    regex-parsing the message string.
    """

    def test_class_declared(self) -> None:
        source = _read("src/lib/api.ts")
        assert "class ApiError" in source, (
            "PQ-10 regression: lib/api.ts must declare ApiError"
        )

    def test_class_carries_status(self) -> None:
        """The class has a ``readonly status: number`` field."""
        source = _read("src/lib/api.ts")
        assert "readonly status: number" in source, (
            "PQ-11 regression: ApiError must carry `readonly status: number`"
        )

    def test_class_is_exported(self) -> None:
        """The class is ``export``ed so route handlers and pages
        can use it for type narrowing (``err instanceof ApiError``)."""
        source = _read("src/lib/api.ts")
        assert "export class ApiError" in source, (
            "PQ-10 regression: ApiError must be export-ed"
        )

    def test_fetchApi_throws_typed_error(self) -> None:
        """The generic ``fetchApi`` path throws an ``ApiError``
        (not a bare ``new Error``) so callers get the status."""
        source = _read("src/lib/api.ts")
        # Find the body where the non-OK branch lives — it must
        # contain a ``throw new ApiError(...)``.
        assert "throw new ApiError(" in source, (
            "PQ-10 regression: fetchApi's non-OK branch must throw "
            "new ApiError(status, detail)"
        )


# ─── PQ-14 — Single source of truth for API_BASE ────────────────


# Files that previously re-defined API_BASE; each must now import
# from @/lib/api.
_PQ14_FILES = [
    "src/app/(portal)/optimization/budget/page.tsx",
    "src/app/(portal)/settings/(tabs)/webhooks-dlq/page.tsx",
    "src/app/(portal)/observability/cohorts/page.tsx",
    "src/app/(portal)/observability/time-travel/page.tsx",
    "src/app/(portal)/prompts/page.tsx",
    "src/components/budget-ticker.tsx",
    "src/components/streaming-sparkline.tsx",
]


@pytest.mark.parametrize("rel_path", _PQ14_FILES)
class TestPagesImportCanonicalApiBase:
    """Each page that previously re-defined API_BASE now uses the
    canonical client (``API_BASE`` / ``fetchApi`` from ``@/lib/api``
    or ``@/lib/api/core``). Local ``API_BASE = …localhost:8000``
    redefinitions silently bypassed the proxy in production.
    """

    def test_imports_api_base(self, rel_path: str) -> None:
        source = _read(rel_path)
        uses_canonical = (
            'from "@/lib/api"' in source
            or 'from "@/lib/api/' in source
            or 'from "@/lib/api/core"' in source
        )
        assert uses_canonical, (
            f"PQ-14 regression: {rel_path} must import from @/lib/api "
            "(or @/lib/api/core) — was re-defining API_BASE locally"
        )

    def test_no_local_re_definition(self, rel_path: str) -> None:
        source = _read(rel_path)
        # Pre-fix: ``const API_BASE = process.env.NEXT_PUBLIC_API_URL ||
        # "http://localhost:8000"`` — reject any local re-definition
        # of the constant.
        assert "API_BASE =" not in source, (
            f"PQ-14 regression: {rel_path} still has a local "
            "API_BASE = … constant (must import from @/lib/api)"
        )

    def test_no_localhost_fallback(self, rel_path: str) -> None:
        source = _read(rel_path)
        assert '"http://localhost:8000"' not in source, (
            f"PQ-14 regression: {rel_path} still hardcodes "
            'the "http://localhost:8000" fallback (silently '
            "bypasses the proxy in production)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
