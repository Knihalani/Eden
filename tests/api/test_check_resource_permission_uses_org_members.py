"""Audit F48 — check_resource_permission must use the ``org_members`` table.

Pre-fix the role-lookup SQL in
``eden.api.deps.check_resource_permission`` queried the
non-existent ``organization_members`` table. The Eden schema
has ``org_members`` (per migration 004_orgs.sql). The pre-fix
SQL would have raised ``relation 'organization_members' does
not exist`` on every call and bubbled up as a 500 from the
auth dependency.

This test pins the table name in the source file: the
correct table is ``org_members``, never
``organization_members``.
"""
from __future__ import annotations

from pathlib import Path


def _deps_source() -> str:
    return Path("src/eden/api/deps.py").read_text()


def test_check_resource_permission_uses_org_members():
    body = _deps_source()
    # The function definition we care about
    assert "async def check_resource_permission(" in body
    # Find the function body and look for the table reference
    fn_start = body.find("async def check_resource_permission(")
    next_fn = body.find("async def ", fn_start + 1)
    fn_body = body[fn_start:next_fn if next_fn != -1 else None]
    assert "FROM org_members" in fn_body, (
        "check_resource_permission must SELECT role FROM org_members"
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
