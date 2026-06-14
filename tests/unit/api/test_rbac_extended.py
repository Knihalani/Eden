"""Phase 7.3d — verify the new permissions are wired into the
PERMISSION_MAP and the convenience guards exist.

These tests are pure-Python: no DB, no API. They lock in the
permission matrix described in the Phase 7.3d plan.
"""

from __future__ import annotations


def test_pii_edit_granted_to_owner_and_admin():
    from eden.api.deps import has_permission
    assert has_permission("owner", "pii:edit")
    assert has_permission("admin", "pii:edit")
    # Members and viewers cannot edit PII policy.
    assert not has_permission("member", "pii:edit")
    assert not has_permission("viewer", "pii:edit")


def test_judges_run_granted_to_owner_admin_member():
    from eden.api.deps import has_permission
    assert has_permission("owner", "judges:run")
    assert has_permission("admin", "judges:run")
    assert has_permission("member", "judges:run")
    # Viewers cannot trigger judge runs.
    assert not has_permission("viewer", "judges:run")


def test_gdpr_execute_owner_only():
    from eden.api.deps import has_permission
    assert has_permission("owner", "gdpr:execute")
    assert not has_permission("admin", "gdpr:execute")
    assert not has_permission("member", "gdpr:execute")
    assert not has_permission("viewer", "gdpr:execute")


def test_retention_override_owner_only():
    from eden.api.deps import has_permission
    assert has_permission("owner", "retention:override")
    assert not has_permission("admin", "retention:override")
    assert not has_permission("member", "retention:override")
    assert not has_permission("viewer", "retention:override")


def test_convenience_guards_are_callable():
    """The four named guards (pii:edit, judges:run, gdpr:execute,
    retention:override) must be importable as ``require_*`` from
    ``eden.api.deps`` so route signatures read cleanly."""
    from eden.api import deps

    assert callable(deps.require_pii_policy_edit)
    assert callable(deps.require_judges_run)
    assert callable(deps.require_gdpr_execute)
    assert callable(deps.require_retention_override)


def test_existing_permissions_preserved():
    """Adding the new permissions must not break the old ones —
    regression guard for the §6.3 base matrix."""
    from eden.api.deps import has_permission
    # Owner keeps all org-level controls
    for p in (
        "settings:edit",
        "members:invite",
        "members:remove",
        "billing:view",
        "billing:edit",
        "audit:view",
        "jobs:read",
        "jobs:write",
        "org:transfer",
    ):
        assert has_permission("owner", p), p
    # Member retains read jobs + write jobs (no admin things)
    assert has_permission("member", "jobs:write")
    assert not has_permission("member", "settings:edit")
    # Viewer is the most restricted role
    assert has_permission("viewer", "jobs:read")
    assert not has_permission("viewer", "jobs:write")
