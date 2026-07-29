"""Session 32 tests — Portal quality (PQ-7, PQ-9, PQ-10, PQ-11, PQ-14).

Five audit items from Part G "Portal polish" final pass:

* **PQ-7** — Replace bare ``Loader2`` spinners in the traces hub's
  loading state with the *shared* loading placeholder so the page
  doesn't visually jump when the real rows arrive. Audit 2026-07-28:
  the ``observability/`` route group is gone — ``TracesTab.tsx`` and
  ``observability/page.tsx`` were deleted, ``/observability*`` now
  redirects to ``/traces`` (next.config.ts), and the shared
  ``components/ui/skeleton`` module was superseded by
  ``QueryLoadingPanel`` in ``@/components/shell/query-error-panel``.
  The guards were repointed onto those successors.
* **PQ-9** — The previously orphan "Add / Update payment method"
  button in ``billing/page.tsx`` is wired through a handler with
  a ``try/catch`` + ``toast.error`` so backend failures surface
  instead of silently doing nothing.
* **PQ-10/PQ-11** — ``lib/api.ts`` introduces an ``ApiError`` class
  carrying the HTTP ``status`` field so callers can branch on
  ``err instanceof ApiError && err.status === 401`` instead of
  regex-parsing the message string. Both throw sites (the
  generic ``fetchApi`` and the exportOrgData 2nd-fetch) use it.
* **PQ-14** — Pages that previously re-defined
  ``const API_BASE = NEXT_PUBLIC_API_URL || "http://localhost:8000"``
  now import the canonical ``API_BASE`` from ``@/lib/api``. The
  pre-fix local definitions silently bypassed the proxy in
  production (the cookie would never reach FastAPI).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import pytest

from tests._portal_api_source import portal_api_source

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


# Cached: the repo-wide PQ-14 sweep below reads every portal client
# source once per assertion, and the sources can't change mid-run.
@lru_cache(maxsize=None)
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


# The traces hub's client component. Successor to the deleted
# ``(portal)/observability/_components/TracesTab.tsx`` — the
# ``observability`` route group was removed and its tabs were folded
# into first-class routes, with the traces tab becoming ``/traces``.
_TRACES_CLIENT = "src/app/(portal)/traces/traces-client.tsx"

# Successor to the deleted ``@/components/ui/skeleton`` module: the
# portal's one shared loading placeholder.
_SHARED_LOADING_MODULE = "@/components/shell/query-error-panel"
_SHARED_LOADING_COMPONENT = "QueryLoadingPanel"


class TestTracesTabSkeletonRows:
    """The traces hub renders the *shared* loading placeholder while
    the trace/session queries are in flight, so the page doesn't
    visually jump when the real rows arrive.
    """

    def test_uses_skeleton_table_row(self) -> None:
        source = _read(_TRACES_CLIENT)
        assert _SHARED_LOADING_COMPONENT in source, (
            f"PQ-7 regression: {_TRACES_CLIENT} must render "
            f"<{_SHARED_LOADING_COMPONENT}> placeholders during "
            "initial load"
        )

    def test_imports_from_skeleton_module(self) -> None:
        """The component imports the placeholder from the shared
        module, not from a fresh local definition."""
        source = _read(_TRACES_CLIENT)
        assert f'from "{_SHARED_LOADING_MODULE}"' in source, (
            f"PQ-7 regression: must import {_SHARED_LOADING_COMPONENT} "
            f"from {_SHARED_LOADING_MODULE}"
        )

    def test_no_bare_loader2_spinner(self) -> None:
        """The bare ``<Loader2 ... animate-spin ... />`` in the
        initial-load branch is gone."""
        source = _read(_TRACES_CLIENT)
        # Loader2 should not appear — the import was removed.
        assert "Loader2" not in source, (
            "PQ-7 regression: traces hub still has Loader2 "
            f"(should be replaced by {_SHARED_LOADING_COMPONENT})"
        )


class TestObservabilityHubTileSkeleton:
    """``/observability`` landing is retired (redirect → ``/traces``).

    The HubTile ``value === null`` Skeleton branch no longer exists —
    the landing page file is gone and the redirect now lives in
    ``next.config.ts``. What survives of the invariant: the redirect
    must still be wired (so the retired hub can't 404), and the
    successor shell must load through the shared placeholder rather
    than a bare spinner.
    """

    def test_uses_skeleton_class(self) -> None:
        config = _read("next.config.ts")
        assert '"/observability"' in config and '"/traces"' in config, (
            "PQ-7 regression: the retired /observability landing must "
            "still redirect to /traces in next.config.ts"
        )
        traces = _read(_TRACES_CLIENT)
        assert _SHARED_LOADING_COMPONENT in traces, (
            "PQ-7 regression: traces hub (successor to the "
            "observability landing) must use the shared loading "
            "placeholder"
        )

    def test_imports_skeleton(self) -> None:
        """Landing redirect is N/A; the traces shell imports the
        shared placeholder from the shared module."""
        obs_path = _PORTAL_ROOT / "src/app/(portal)/observability/page.tsx"
        assert not obs_path.is_file(), (
            "The observability landing is back — restore the original "
            "HubTile Skeleton assertions instead of the redirect guard"
        )
        traces = _read(_TRACES_CLIENT)
        assert f'from "{_SHARED_LOADING_MODULE}"' in traces, (
            "PQ-7 regression: traces hub must import "
            f"{_SHARED_LOADING_COMPONENT} from {_SHARED_LOADING_MODULE}"
        )


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
#
# Audit 2026-07-28 — the ``optimization/`` and ``observability/``
# route groups were dissolved by the portal refactor, so the original
# list pointed at six deleted files. Each entry was repointed at the
# surface that inherited its API calls:
#
#   optimization/budget/page.tsx      → cost/page.tsx
#                                       (/optimization/budget →
#                                       /cost?tab=budget in
#                                       next.config.ts; the budget
#                                       reads now come from
#                                       @/lib/api/budget)
#   observability/cohorts/page.tsx    → traces/traces-client.tsx
#   observability/time-travel/page.tsx  (both redirect to /traces)
#   settings/_components/            → settings/page.tsx
#     webhooks-dlq-tab.tsx             (the per-tab components were
#                                       folded into one page; the DLQ
#                                       calls live in @/lib/api
#                                       resources)
#   components/budget-ticker.tsx     → no successor component; the
#   components/streaming-sparkline.tsx  live cost/stream widgets were
#                                       removed in 9a1452b4. Their
#                                       half of the invariant is held
#                                       by TestNoLocalApiBaseAnywhere
#                                       below, which sweeps every
#                                       portal page + component
#                                       instead of a hardcoded list.
_PQ14_FILES = [
    "src/app/(portal)/cost/page.tsx",
    "src/app/(portal)/settings/page.tsx",
    "src/app/(portal)/traces/traces-client.tsx",
    "src/app/(portal)/prompts/page.tsx",
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


def _client_sources() -> list[str]:
    """Every portal page / shared component source file.

    These all run in the browser, so none of them may define its own
    ``API_BASE`` or hardcode the dev FastAPI origin — the canonical
    base lives in ``src/lib/api/core.ts`` and resolves to the
    same-origin ``/api/proxy`` in production. Server-only code
    (``src/app/api/**`` route handlers, ``src/lib/**``) is excluded:
    those legitimately read ``API_INTERNAL_URL`` with a
    ``http://localhost:8000`` dev fallback.
    """
    roots = (
        _PORTAL_ROOT / "src/app/(portal)",
        _PORTAL_ROOT / "src/components",
    )
    out: list[str] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.tsx")) + sorted(root.rglob("*.ts")):
            name = path.name
            if ".test." in name or ".spec." in name:
                continue
            if "__tests__" in path.parts:
                continue
            out.append(str(path.relative_to(_PORTAL_ROOT)))
    return out


class TestNoLocalApiBaseAnywhere:
    """Repo-wide half of PQ-14.

    The original guard listed the handful of files that were caught
    re-defining ``API_BASE`` in the 2026 audit; several of those files
    have since been deleted. Sweeping every client source keeps the
    invariant enforced without a list that goes stale each refactor.
    """

    def test_sweep_is_not_empty(self) -> None:
        """Guard the guard — a bad glob must not silently pass."""
        files = _client_sources()
        assert len(files) > 20, (
            f"PQ-14 sweep found only {len(files)} client sources — "
            "the glob is broken, not the portal"
        )

    def test_no_client_file_redefines_api_base(self) -> None:
        offenders = [
            rel for rel in _client_sources() if "API_BASE =" in _read(rel)
        ]
        assert not offenders, (
            "PQ-14 regression: client sources re-defining API_BASE "
            f"(must import it from @/lib/api): {offenders}"
        )

    def test_no_client_file_hardcodes_localhost(self) -> None:
        offenders = [
            rel
            for rel in _client_sources()
            if '"http://localhost:8000"' in _read(rel)
        ]
        assert not offenders, (
            "PQ-14 regression: client sources hardcoding the "
            '"http://localhost:8000" fallback (silently bypasses the '
            f"proxy in production): {offenders}"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
