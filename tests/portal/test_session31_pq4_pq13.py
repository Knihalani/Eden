"""Session 31 tests — Portal quality (PQ-4, PQ-8, PQ-13).

Three audit items from Part G "Portal polish":

* **PQ-4** — User-facing TypeScript install snippets must not use
  ``process.env.X!`` non-null assertions (unsafe copy-paste). The
  old ``onboarding/install/page.tsx`` is gone; marketing SDK snippets
  are the remaining surface.
* **PQ-8** — ``hooks/use-org.tsx`` picks the **current** Clerk
  org's membership from ``userMemberships.data`` via
  ``.find(...)``, not the ``[0]`` first membership (pre-fix
  multi-org users always saw the role of their alphabetically-
  first org).
* **PQ-13** — ``hooks/use-auth.tsx`` loads the Eden profile via
  shared ``useMeQuery`` / ``fetchMeQuery`` (React Query), not an
  id-only effect — org refresh is driven by invalidate/refetch.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


def _read(rel: str) -> str:
    raw = (_PORTAL_ROOT / rel).read_text()
    # Strip ``//`` line comments — the audit-fix comments mention
    # the literal patterns in prose.
    return "\n".join(
        line for line in raw.splitlines()
        if not line.lstrip().startswith("//")
    )


# ─── PQ-4 — Drop the ``!`` from the user-facing TS snippet ─────


class TestInstallPageTypeScriptSnippet:
    """User-facing TypeScript SDK snippets must not use ``!``
    non-null assertions on env vars.

    ``onboarding/install/page.tsx`` was removed; the remaining
    copy-paste surface is marketing ``SDK_SNIPPETS`` / equivalent.
    """

    _SNIPPET = "src/app/(marketing)/_components/marketing-data.ts"
    _LEGACY_INSTALL = "src/app/(portal)/onboarding/install/page.tsx"

    def _snippet_source(self) -> str:
        legacy = _PORTAL_ROOT / self._LEGACY_INSTALL
        if legacy.is_file():
            return _read(self._LEGACY_INSTALL)
        path = _PORTAL_ROOT / self._SNIPPET
        if not path.is_file():
            pytest.skip("install / marketing snippet surface N/A")
        return _read(self._SNIPPET)

    def test_no_bang_on_api_key(self) -> None:
        source = self._snippet_source()
        assert "EDEN_API_KEY!" not in source, (
            "PQ-4 regression: TypeScript snippet still uses "
            "`process.env.EDEN_API_KEY!` — drop the `!`"
        )

    def test_no_bang_on_org_id(self) -> None:
        source = self._snippet_source()
        # Install used EDEN_DEFAULT_ORG; marketing uses EDEN_ORG_ID.
        assert "EDEN_DEFAULT_ORG!" not in source, (
            "PQ-4 regression: snippet still uses "
            "`process.env.EDEN_DEFAULT_ORG!` — drop the `!`"
        )
        assert "EDEN_ORG_ID!" not in source, (
            "PQ-4 regression: snippet still uses "
            "`process.env.EDEN_ORG_ID!` — drop the `!`"
        )

    def test_uses_nullish_coalescing(self) -> None:
        """Env-var references use ``??`` (or bracket access) so the
        snippet type-checks without ``!`` and shows a placeholder
        when unset."""
        source = self._snippet_source()
        has_api_key_fallback = (
            "EDEN_API_KEY ?? " in source
            or 'os.environ["EDEN_API_KEY"]' in source
        )
        has_org_fallback = (
            "EDEN_DEFAULT_ORG ?? " in source
            or "EDEN_ORG_ID ?? " in source
            or 'os.environ["EDEN_ORG_ID"]' in source
        )
        assert has_api_key_fallback, (
            "PQ-4 regression: EDEN_API_KEY must use a safe fallback "
            "(?? or os.environ[...]), not `!`"
        )
        assert has_org_fallback, (
            "PQ-4 regression: org id env must use a safe fallback "
            "(?? or os.environ[...]), not `!`"
        )

    def test_base_url_pattern_intact(self) -> None:
        """Base URL either uses ``??`` or is omitted (SDK defaults)."""
        source = self._snippet_source()
        if "EDEN_BASE_URL" not in source:
            return  # marketing snippets omit base URL — OK
        assert "EDEN_BASE_URL!" not in source, (
            "PQ-4 regression: EDEN_BASE_URL must not use `!`"
        )
        assert "EDEN_BASE_URL ?? " in source or 'os.environ["EDEN_BASE_URL"]' in source, (
            "PQ-4 sanity: EDEN_BASE_URL must use a safe fallback"
        )


# ─── PQ-8 — use-org picks role from CURRENT membership ─────────


class TestUseOrgPicksCurrentOrgRole:
    """``hooks/use-org.tsx`` must filter ``userMemberships.data`` by
    the active Clerk org id, not always pick the first item.
    """

    def test_no_first_element_access(self) -> None:
        source = _read("src/hooks/use-org.tsx")
        assert "userMemberships.data?.[0]" not in source, (
            "PQ-8 regression: use-org must not pick [0] — always the "
            "wrong role for multi-org users"
        )

    def test_filters_by_active_org_id(self) -> None:
        """The fix uses ``.find(m => m.organization?.id === clerkOrg.id)``
        so each org's role is honored."""
        source = _read("src/hooks/use-org.tsx")
        assert "userMemberships.data?.find" in source, (
            "PQ-8 regression: use-org must filter userMemberships by "
            "the active Clerk org id"
        )
        assert "m.organization?.id === clerkOrg.id" in source, (
            "PQ-8 regression: use-org's find predicate must compare "
            "m.organization.id to clerkOrg.id"
        )

    def test_role_still_returned(self) -> None:
        """The fix preserves the ``.role ?? null`` shape so RBAC
        callers keep working."""
        source = _read("src/hooks/use-org.tsx")
        # The role lookup happens inside `.find(...)?.role ?? null`.
        assert "?.role ?? null" in source, (
            "PQ-8 regression: clerkOrgRole must fall back to null"
        )


# ─── PQ-13 — use-auth re-fetches on updatedAt change ───────────


class TestUseAuthRefetchesOnUpdatedAt:
    """``hooks/use-auth.tsx`` loads Eden profile via shared React
    Query (``useMeQuery`` / ``fetchMeQuery``), not an id-only effect.
    """

    def test_no_id_only_dep(self) -> None:
        """The original effect dep array ``[clerkUser?.id]`` is
        gone — pre-fix this left the org list stale after a user
        accepted an invite in another tab."""
        source = _read("src/hooks/use-auth.tsx")
        assert "}, [clerkUser?.id]);" not in source and (
            "}, [clerkUser?.id])" not in source
        ), (
            "PQ-13 regression: use-auth must not depend on id alone"
        )

    def test_depends_on_updated_at(self) -> None:
        """Profile load goes through ``useMeQuery`` + ``fetchMeQuery``
        (invalidate/refetch), replacing the old ``updatedAt`` effect.
        """
        source = _read("src/hooks/use-auth.tsx")
        assert "useMeQuery" in source, (
            "PQ-13 regression: AuthProvider must use useMeQuery"
        )
        assert "fetchMeQuery" in source, (
            "PQ-13 regression: refreshUser must call fetchMeQuery"
        )

    def test_updatedAt_not_snake_case(self) -> None:
        """Clerk's React SDK exposes camelCase ``updatedAt`` (not
        snake-case ``updated_at``). Do not introduce a silent
        snake_case dep if an effect is re-added later.
        """
        source = _read("src/hooks/use-auth.tsx")
        assert "clerkUser?.updated_at" not in source, (
            "PQ-13 regression: Clerk React SDK uses updatedAt, "
            "not updated_at (which would silently never fire)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
