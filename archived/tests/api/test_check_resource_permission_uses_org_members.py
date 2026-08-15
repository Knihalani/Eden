"""Audit F48 / W3-C — check_resource_permission table contracts.

Pre-fix the role-lookup SQL in
``eden.api.deps.check_resource_permission`` queried the
non-existent ``organization_members`` table. The Eden schema
has ``org_members`` (per migration 004_orgs.sql).

W3-C: the resource-scoped branch previously queried
``custom_role_assignments`` (never migrated). The correct join is
``role_assignments`` + ``role_definitions`` + ``role_permissions``
(migration 020).
"""
from __future__ import annotations

from pathlib import Path


def _deps_source() -> str:
    return Path("src/eden/api/deps.py").read_text()


def _check_resource_permission_body() -> str:
    body = _deps_source()
    assert "async def check_resource_permission(" in body
    fn_start = body.find("async def check_resource_permission(")
    next_fn = body.find("async def ", fn_start + 1)
    return body[fn_start : next_fn if next_fn != -1 else None]


def test_check_resource_permission_uses_org_members():
    fn_body = _check_resource_permission_body()
    assert "FROM org_members" in fn_body, (
        "check_resource_permission must SELECT role FROM org_members"
    )


def test_check_resource_permission_uses_role_assignments_join():
    fn_body = _check_resource_permission_body()
    assert "FROM role_assignments" in fn_body, (
        "resource-scoped check must query role_assignments"
    )
    assert "JOIN role_definitions" in fn_body
    assert "JOIN role_permissions" in fn_body
    assert "custom_role_assignments" not in fn_body, (
        "custom_role_assignments is not a real table — use role_assignments"
    )


def test_no_organization_members_references_in_deps():
    """Defence in depth: no SQL fragment in deps.py may
    reference the non-existent ``organization_members``
    table. The correct table is ``org_members``."""
    body = _deps_source()
    assert "organization_members" not in body, (
        "deps.py contains a reference to the non-existent "
        "``organization_members`` table. The correct table is "
        "``org_members`` (see migrations/004_orgs.sql)."
    )


def test_no_custom_role_assignments_references_in_deps():
    body = _deps_source()
    assert "custom_role_assignments" not in body, (
        "deps.py must not query the non-existent "
        "``custom_role_assignments`` table (use role_assignments)."
    )
