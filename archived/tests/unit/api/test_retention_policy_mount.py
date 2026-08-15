"""Wiring lock: the retention-policy router must stay mounted in the app.

The router (``eden.api.routes.retention_policy``) existed — and had
handler-level tests — since Phase 7.3b, but was never included in
``eden.api.app``: the include line naming it was left as a trailing
comment on the ``cost_overrides`` mount. The endpoints were unreachable
in production while every module-level test passed. Mounted 2026-08-02;
this test fails if the router is ever silently unmounted again.
"""

from __future__ import annotations

from fastapi.routing import APIRoute


def _retention_routes() -> list[APIRoute]:
    from eden.api.app import app

    return [
        r
        for r in app.routes
        if isinstance(r, APIRoute) and r.path == "/orgs/{org_id}/retention-policy"
    ]


def test_retention_policy_router_is_mounted_in_app() -> None:
    routes = _retention_routes()
    assert routes, (
        "retention_policy.router is not mounted in eden.api.app — "
        "the endpoints exist but are unreachable."
    )


def test_retention_policy_exposes_get_and_put() -> None:
    methods: set[str] = set()
    for r in _retention_routes():
        methods |= set(r.methods or ())
    assert {"GET", "PUT"} <= methods
