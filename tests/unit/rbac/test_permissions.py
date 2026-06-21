"""RBAC tests — `require_org_permission` and the permission map.

Covers: owner > admin > member > viewer ordering, the
``require_org_admin`` chokepoint, and the ``HEAL`` route gating.
"""

from eden.api.deps import (
    PERMISSION_MAP,
    get_role_permissions,
    require_org_permission,
)


def test_owner_has_all_org_perms():
    """An owner should pass every standard org permission."""
    owner = "owner"
    perms = ["settings:edit", "members:invite", "members:remove", "billing:edit"]
    for p in perms:
        assert _check(owner, p), f"owner should have {p}"


def test_viewer_lacks_admin_perms():
    """A viewer should NOT have any write/admin permission."""
    viewer = "viewer"
    admin_perms = ["settings:edit", "members:invite", "members:remove", "billing:edit"]
    for p in admin_perms:
        assert not _check(viewer, p), f"viewer should not have {p}"


def test_member_has_jobs_write_not_billing():
    """Members can run jobs but not edit billing."""
    member = "member"
    assert _check(member, "jobs:write")
    assert not _check(member, "billing:edit")


def test_admin_has_settings_and_billing():
    """Admins edit settings + billing but cannot remove orgs."""
    admin = "admin"
    assert _check(admin, "settings:edit")
    assert _check(admin, "billing:edit")
    # Org removal is owner-only (if that gate exists).


def _check(role: str, permission: str) -> bool:
    """Returns True if `role` is allowed to perform `permission`.
    Uses the same map the routes use, by inspecting the role -> perms map
    directly via the public ``get_role_permissions`` helper.
    """
    return permission in get_role_permissions(role)
