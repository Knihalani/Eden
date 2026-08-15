"""Tenant-scoped tables must not silently lose their RLS policy.

``usage_events`` — the billing table — had RLS enabled, forced, and a
``tenant_isolation_usage_events`` policy from migration 002. Migration 042
dropped all three, because a Timescale hypertable conversion cannot proceed with
them in place, under a comment about "schema quirks that block the conversion".
The conversion worked. Nobody put the isolation back, and Eden's cost and quota
table went without a row-level tenant boundary from that migration onward.

Nothing failed, because dropping RLS never fails — it only widens what a query
can see. That is the whole reason this test exists: the loss of a tenant
boundary has to be caught by something that reads the migration chain, since it
will not show up as a broken test or an error in a log.

These tests read the DDL statically (no live database), so they run in the
default mocked-Postgres suite.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_VERSIONS = _REPO / "src" / "eden" / "db_migrations" / "versions"


def _all_migration_text() -> str:
    return "\n".join(
        p.read_text(encoding="utf-8") for p in sorted(_VERSIONS.glob("*.py"))
    )


def _final_state(table: str) -> dict[str, bool]:
    """Replay the chain in revision order and report the final RLS state.

    Crude but sufficient: statements are applied in filename order, which is
    the revision order for this repo's ``NNN_slug`` convention.
    """
    enabled = False
    has_policy = False
    for path in sorted(_VERSIONS.glob("*.py")):
        text = path.read_text(encoding="utf-8")
        # Only consider the upgrade() body — a downgrade() that disables RLS is
        # correct and must not count against the final state.
        upgrade = text.split("def upgrade")[-1].split("def downgrade")[0]
        for stmt in re.split(r";|\"\"\"|'''", upgrade):
            low = " ".join(stmt.split()).lower()
            if table not in low:
                continue
            if "disable row level security" in low:
                enabled = False
            elif "enable row level security" in low:
                enabled = True
            if re.search(rf"drop policy .*on {re.escape(table)}\b", low):
                has_policy = False
            elif re.search(rf"create policy .*on {re.escape(table)}\b", low):
                has_policy = True
    return {"enabled": enabled, "has_policy": has_policy}


class TestUsageEventsIsolation:
    """The specific regression: RLS dropped for a hypertable conversion."""

    def test_rls_is_enabled_at_the_end_of_the_chain(self) -> None:
        state = _final_state("usage_events")
        assert state["enabled"], (
            "usage_events ends the migration chain with RLS disabled. "
            "Migration 042 disabled it for the Timescale conversion; it must "
            "be re-enabled afterwards (see migration 123)."
        )

    def test_a_tenant_policy_exists_at_the_end_of_the_chain(self) -> None:
        state = _final_state("usage_events")
        assert state["has_policy"], (
            "usage_events has no tenant_isolation policy at the end of the "
            "chain — migration 042 dropped it and nothing recreated it."
        )

    def test_the_restore_migration_is_present(self) -> None:
        assert (_VERSIONS / "123_usage_events_rls_restore.py").exists()


class TestPolicyShape:
    """A policy that cannot constrain writes is not tenant isolation."""

    def test_every_policy_is_for_all_or_declares_with_check(self) -> None:
        """``FOR ALL`` reuses USING as the check; anything else must be explicit.

        Postgres: "For policies that can have both USING and WITH CHECK
        expressions (ALL and UPDATE), if no WITH CHECK expression is defined,
        then the USING expression will be used both to determine which rows are
        visible and which new rows will be allowed to be added."

        So a ``FOR ALL ... USING (...)`` policy constrains writes already. A
        ``FOR UPDATE`` or ``FOR INSERT`` policy does not, and needs the clause
        spelled out.
        """
        text = _all_migration_text()
        offenders: list[str] = []
        for match in re.finditer(
            r"CREATE POLICY\s+([\w{}]+)\s+ON\s+([\w{}]+)([\s\S]{0,700})", text
        ):
            name, table, body = match.group(1), match.group(2), match.group(3)
            head = body.split(";")[0]
            # ``FOR`` is optional and defaults to ALL, so a policy with no FOR
            # clause is a FOR ALL policy and reuses USING as its check.
            explicit_for = re.search(
                r"\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b", head, re.I
            )
            command = (explicit_for.group(1).upper() if explicit_for else "ALL")
            if command in {"ALL", "SELECT", "DELETE"}:
                # ALL reuses USING; SELECT and DELETE cannot take WITH CHECK.
                continue
            if not re.search(r"WITH\s+CHECK", head, re.I):
                offenders.append(f"{name} on {table} (FOR {command})")
        assert not offenders, (
            "these policies restrict reads but not writes — a FOR UPDATE or "
            f"FOR INSERT policy needs an explicit WITH CHECK: {offenders}"
        )

    def test_policies_reference_the_org_guc(self) -> None:
        """A policy that does not read the GUC is not scoping by tenant."""
        text = _all_migration_text()
        bodies = re.findall(r"CREATE POLICY\s+tenant_isolation_\w+([\s\S]{0,600})", text)
        assert bodies, "no tenant_isolation policies found at all"
        for body in bodies:
            head = body.split(";")[0]
            assert "app.current_org_id" in head, (
                f"tenant policy does not read app.current_org_id: {head[:200]!r}"
            )


class TestRestoredPolicyMatchesTheOneItReplaces:
    """A restore migration must not quietly tighten what it restores.

    Migration 002 wrote ``tenant_isolation_usage_events`` with an
    ``OR current_setting('app.current_org_id', true) IS NULL`` branch. A
    ``FOR ALL`` policy reuses ``USING`` as its INSERT/UPDATE check, so dropping
    that branch does not merely narrow reads — it makes every write from a
    connection with no GUC fail RLS. ``bronze_sink._flush`` is exactly such a
    writer (background timer, plain pool checkout, one batch spanning many orgs),
    and it swallows the failure after three retries. The first draft of 123 did
    drop the branch, which would have silently destroyed all usage metering.
    """

    def _policy_body(self, revision: str) -> str:
        text = (_VERSIONS / revision).read_text(encoding="utf-8")
        upgrade = text.split("def upgrade")[-1].split("def downgrade")[0]
        return " ".join(upgrade.split())

    def test_restore_keeps_the_unset_guc_branch(self) -> None:
        body = self._policy_body("123_usage_events_rls_restore.py")
        assert "IS NULL" in body, (
            "migration 123 dropped migration 002's "
            "`OR current_setting('app.current_org_id', true) IS NULL` branch. "
            "Because FOR ALL reuses USING as the write check, every "
            "bronze_sink insert would fail RLS and be silently dropped."
        )
        assert body.count("current_setting('app.current_org_id', true) IS NULL") >= 1

    def test_original_policy_had_that_branch(self) -> None:
        """Guards the premise — if 002 changes, this test's reasoning changes."""
        body = self._policy_body("002_phase_4_2_data_layer.py")
        assert "tenant_isolation_usage_events" in body
        assert "current_setting('app.current_org_id', true) IS NULL" in body

    def test_restore_does_not_add_force(self) -> None:
        """FORCE subjects the owner too, and returns zero rows on an unpinned
        read rather than raising. It belongs with the connection pinning."""
        body = self._policy_body("123_usage_events_rls_restore.py")
        assert "FORCE ROW LEVEL SECURITY" not in body.upper().replace(
            "NO FORCE ROW LEVEL SECURITY", ""
        )


class TestNoSilentDisable:
    @pytest.mark.parametrize("table", ["usage_events"])
    def test_disable_is_always_followed_by_a_restore(self, table: str) -> None:
        """Disabling RLS mid-chain is fine; ending the chain disabled is not."""
        assert _final_state(table)["enabled"], (
            f"{table} is left with RLS disabled by the migration chain"
        )
