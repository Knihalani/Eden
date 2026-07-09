"""Audit F47 — region routes must use ``organizations.id``, not ``organizations.org_id``.

Pre-fix the GET and PUT region routes queried/updated
``organizations`` with a ``WHERE org_id = $1`` predicate. The
``organizations`` table has no ``org_id`` column — its
primary key is ``id`` (UUID). The pre-fix SQL was an
unknown-column error and would have raised a 500 from
asyncpg on every call.

This test pins the SQL contract: both queries MUST filter
on ``id = $1`` (and the second MUST bind ``$2`` to ``id``,
not ``org_id``). The SQL source is the source of truth —
refactors that pull the predicate out of the route handler
or that change the table layout must update this test.
"""
from __future__ import annotations

from pathlib import Path


def _route_source() -> str:
    return Path("src/eden/api/routes/region.py").read_text()


def test_get_region_filters_by_id_column():
    body = _route_source()
    assert "SELECT region FROM organizations WHERE id = $1" in body, (
        "get_region must filter the organizations row by "
        "id = $1. Pre-fix the route used org_id = $1, but the "
        "organizations table has no org_id column — the SQL "
        "raised an unknown-column error on every call."
    )


def test_put_region_updates_by_id_column():
    body = _route_source()
    assert "UPDATE organizations SET region = $1 WHERE id = $2" in body, (
        "put_region must update the organizations row by "
        "id = $2. Pre-fix the route used org_id = $2, which "
        "matched no rows so the region's UPDATE was a no-op "
        "and a 200 was returned even when nothing changed."
    )


def test_no_legacy_org_id_predicate_on_organizations():
    """Defence in depth: catch any future regression that
    re-introduces ``WHERE org_id`` against the organizations
    table. The correct tenant-scope column is ``id``."""
    body = _route_source()
    # Allow the words "org_id" in comments / docstrings, but
    # ban them inside SQL fragments.
    assert "FROM organizations WHERE org_id" not in body
    assert "organizations SET region = $1 WHERE org_id" not in body
