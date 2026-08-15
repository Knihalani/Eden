"""Regression: hot list routes must bound SQL (no unbounded JOINs).

Cost-pass Jul 2026 — list_org_members and analytics member_activity
used to SELECT every row for large tenants on every settings/analytics
page load.
"""

from __future__ import annotations

import inspect

from eden.api.routes import analytics, orgs, rbac


def test_list_org_members_sql_has_limit():
    src = inspect.getsource(orgs.list_org_members)
    assert "LIMIT $2" in src
    assert "limit: int = Query" in src


def test_analytics_member_activity_sql_has_limit():
    src = inspect.getsource(analytics.get_org_analytics)
    assert "LIMIT 100" in src
    assert "Member activity" in src or "member_activity" in src


def test_list_roles_batches_permissions_not_n_plus_one():
    src = inspect.getsource(rbac.list_roles)
    assert "ANY($1::uuid[])" in src
    assert "for r in rows:\n        perms = await _fetch_permissions" not in src
