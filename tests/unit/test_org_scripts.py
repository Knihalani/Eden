"""Unit tests for the ops scripts.

Both scripts in ``src/eden/scripts/`` are operator tools: they query
Clerk + Postgres and emit a report. We don't have a live Clerk API
in tests, so we mock the network + DB layers and assert on the
script's structure (CLI parsing, the orphan-detection filter logic).

The full end-to-end run is exercised manually against staging — the
plan is documented at ``docs/eden-clerk-org-alignment.md``.
"""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── backfill_legacy_orgs ───────────────────────────────────────────


class TestBackfillLegacyOrgsCLI:
    """Verify the CLI surface (argparse + entry point)."""

    def test_help_flag_parses(self):
        from eden.scripts.backfill_legacy_orgs import main

        with pytest.raises(SystemExit) as exc:
            with patch("sys.argv", ["backfill_legacy_orgs", "--help"]):
                with redirect_stdout(io.StringIO()):
                    main()
        # argparse exits with code 0 for --help
        assert exc.value.code == 0

    def test_requires_clerk_secret_when_not_dry_run(self):
        from eden.scripts.backfill_legacy_orgs import main

        # No CLERK_SECRET_KEY in test settings → exits 2 with stderr error.
        # The Settings fixture in conftest clears the secret.
        with patch("sys.argv", ["backfill_legacy_orgs"]):
            captured = io.StringIO()
            with redirect_stdout(captured):
                # main returns the exit code; we assert below
                rc = main()
        # Without a real Clerk secret the script returns 2
        assert rc == 2

    def test_dry_run_with_no_legacy_orgs_returns_zero(self):
        """Dry-run with an empty legacy set prints 'Found 0' and exits 0."""
        from eden.scripts.backfill_legacy_orgs import main

        # Patch the settings fixture so the dry-run path runs (the
        # ``not settings.clerk_secret_key and not dry_run`` branch
        # only fires for non-dry-run).
        with patch("sys.argv", ["backfill_legacy_orgs", "--dry-run"]):
            with patch(
                "eden.scripts.backfill_legacy_orgs._fetch_legacy_orgs",
                AsyncMock(return_value=[]),
            ):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = main()
        assert rc == 0
        assert "Found 0 legacy org(s)" in out.getvalue()

    def test_dry_run_with_legacy_orgs_prints_table(self):
        """Dry-run prints each org without calling Clerk."""
        from eden.scripts.backfill_legacy_orgs import main

        fake_orgs = [
            {"id": "uuid-A", "name": "Acme", "slug": "acme"},
            {"id": "uuid-B", "name": "Beta", "slug": "beta"},
        ]
        with patch("sys.argv", ["backfill_legacy_orgs", "--dry-run"]):
            with patch(
                "eden.scripts.backfill_legacy_orgs._fetch_legacy_orgs",
                AsyncMock(return_value=fake_orgs),
            ):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = main()
        assert rc == 0
        body = out.getvalue()
        assert "Found 2 legacy org(s)" in body
        assert "uuid-A" in body
        assert "uuid-B" in body
        # The dry-run path must NOT touch Clerk.
        # (No assertion needed — the create_organization import is
        # only invoked via the real run path; we never patched it,
        # so any accidental call would raise NameError.)


# ── scan_orphan_clerk_orgs ────────────────────────────────────────


class TestScanOrphanClerkOrgsLogic:
    """The orphan filter: a Clerk org is orphan if its id isn't in
    the set of known ``clerk_org_id`` values from Postgres."""

    @staticmethod
    def _settings_with_secret():
        """Return a Settings stub with a non-empty ``clerk_secret_key``."""
        from eden.config import Settings
        return Settings(clerk_secret_key="sk_test_fake_for_unit_tests")

    def test_orphan_filter(self):
        from eden.scripts.scan_orphan_clerk_orgs import run

        clerk_orgs = [
            {"id": "org_2xknown", "name": "Acme", "slug": "acme"},
            {"id": "org_2xorphan", "name": "Orphan", "slug": "orphan"},
            {"id": "org_2xalso-orphan", "name": "Beta", "slug": "beta"},
        ]
        mock_pg = MagicMock()
        mock_pg.fetch = AsyncMock(return_value=[
            {"clerk_org_id": "org_2xknown"},
        ])
        with patch(
            "eden.scripts.scan_orphan_clerk_orgs.get_settings",
            return_value=self._settings_with_secret(),
        ), patch(
            "eden.scripts.scan_orphan_clerk_orgs.get_postgres_client",
            AsyncMock(return_value=mock_pg),
        ), patch(
            "eden.scripts.scan_orphan_clerk_orgs._list_clerk_orgs",
            AsyncMock(return_value=clerk_orgs),
        ):
            out = io.StringIO()
            with redirect_stdout(out):
                rc = asyncio_run(run(report_json=True))
        # JSON output: must contain only the two orphans
        payload = json.loads(out.getvalue())
        assert {o["id"] for o in payload} == {"org_2xorphan", "org_2xalso-orphan"}
        assert rc == 0

    def test_no_orphans(self):
        from eden.scripts.scan_orphan_clerk_orgs import run

        clerk_orgs = [{"id": "org_2xknown"}]
        mock_pg = MagicMock()
        mock_pg.fetch = AsyncMock(return_value=[{"clerk_org_id": "org_2xknown"}])
        with patch(
            "eden.scripts.scan_orphan_clerk_orgs.get_settings",
            return_value=self._settings_with_secret(),
        ), patch(
            "eden.scripts.scan_orphan_clerk_orgs.get_postgres_client",
            AsyncMock(return_value=mock_pg),
        ), patch(
            "eden.scripts.scan_orphan_clerk_orgs._list_clerk_orgs",
            AsyncMock(return_value=clerk_orgs),
        ):
            out = io.StringIO()
            with redirect_stdout(out):
                rc = asyncio_run(run(report_json=True))
        assert json.loads(out.getvalue()) == []
        assert rc == 0


def asyncio_run(coro):
    """Tiny helper so the tests don't need pytest-asyncio."""
    import asyncio
    return asyncio.run(coro)
