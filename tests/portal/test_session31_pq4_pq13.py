"""Session 31 tests — Portal quality (PQ-4, PQ-8, PQ-13).

Three audit items from Part G "Portal polish":

* **PQ-4** — ``onboarding/install/page.tsx`` drops the
  TypeScript-style ``!`` non-null assertions from the
  user-facing TypeScript snippet (was: ``process.env.X!`` which
  told the user "this is non-null but actually IS undefined at
  runtime"). Snippets now use ``?? "<placeholder>"`` so the
  user can copy-paste them safely.
* **PQ-8** — ``hooks/use-org.tsx`` picks the **current** Clerk
  org's membership from ``userMemberships.data`` via
  ``.find(...)``, not the ``[0]`` first membership (pre-fix
  multi-org users always saw the role of their alphabetically-
  first org).
* **PQ-13** — ``hooks/use-auth.tsx`` re-fetches the Eden profile
  on ``clerkUser?.updatedAt`` change (not just ``id``), so
  accepting a new org invite refreshes the org list.
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
    """The TypeScript ``init({...})`` snippet shown to users must
    not tell them to write ``!`` non-null assertions on missing
    env vars — placeholders are safer to copy-paste.
    """

    def test_no_bang_on_api_key(self) -> None:
        source = _read(
            "src/app/(portal)/onboarding/install/page.tsx"
        )
        assert "EDEN_API_KEY!" not in source, (
            "PQ-4 regression: install snippet still uses "
            "`process.env.EDEN_API_KEY!` — drop the `!`"
        )

    def test_no_bang_on_org_id(self) -> None:
        source = _read(
            "src/app/(portal)/onboarding/install/page.tsx"
        )
        assert "EDEN_DEFAULT_ORG!" not in source, (
            "PQ-4 regression: install snippet still uses "
            "`process.env.EDEN_DEFAULT_ORG!` — drop the `!`"
        )

    def test_uses_nullish_coalescing(self) -> None:
        """Both env-var references now use ``??`` so the snippet
        type-checks without ``!`` and is human-readable with a
        visible placeholder when the env var is unset."""
        source = _read(
            "src/app/(portal)/onboarding/install/page.tsx"
        )
        assert "EDEN_API_KEY ?? " in source, (
            "PQ-4 regression: EDEN_API_KEY must use `??` fallback"
        )
        assert "EDEN_DEFAULT_ORG ?? " in source, (
            "PQ-4 regression: EDEN_DEFAULT_ORG must use `??` fallback"
        )

    def test_base_url_pattern_intact(self) -> None:
        """The existing ``baseUrl`?`` \"...\"`` pattern is the model
        for the fix — confirm it was preserved when the siblings
        were rewritten."""
        source = _read(
            "src/app/(portal)/onboarding/install/page.tsx"
        )
        assert "EDEN_BASE_URL ?? " in source, (
            "PQ-4 sanity: EDEN_BASE_URL must keep the ?? fallback"
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
    """``hooks/use-auth.tsx`` must depend on ``clerkUser?.updatedAt``
    so that accepting a new org invite triggers a re-fetch.
    """

    def test_no_id_only_dep(self) -> None:
        """The original effect dep array ``[clerkUser?.id]`` is
        gone — pre-fix this left the org list stale after a user
        accepted an invite in another tab."""
        source = _read("src/hooks/use-auth.tsx")
        # The fix changes the dep array to include updatedAt.
        # Acceptable forms:
        #   [clerkUser?.id, clerkUser?.updatedAt]
        # We assert id-alone is GONE.
        assert "}, [clerkUser?.id]);" not in source and (
            "}, [clerkUser?.id])" not in source
        ), (
            "PQ-13 regression: use-auth effect must depend on "
            "updatedAt in addition to id"
        )

    def test_depends_on_updated_at(self) -> None:
        """The effect's dep array includes ``clerkUser?.updatedAt``."""
        source = _read("src/hooks/use-auth.tsx")
        assert "clerkUser?.updatedAt" in source, (
            "PQ-13 regression: effect dep array must include "
            "clerkUser?.updatedAt"
        )

    def test_updatedAt_not_snake_case(self) -> None:
        """Clerk's React SDK exposes camelCase ``updatedAt`` (not
        snake-case ``updated_at`` — that's only on the raw JSON
        type). Using snake_case here would silently never
        trigger."""
        source = _read("src/hooks/use-auth.tsx")
        assert "clerkUser?.updated_at" not in source, (
            "PQ-13 regression: Clerk React SDK uses updatedAt, "
            "not updated_at (which would silently never fire)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
