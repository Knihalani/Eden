"""Pin the deliberate prompts_v2-over-prompts route precedence.

``prompts_v2.router`` is mounted before ``prompts.router`` in
``eden.api.app`` with the comment "prompts_v2 first: FastAPI first-match
wins. D.9 owns GET/POST '' and GET /{name}; Phase I keeps PATCH,
playground, rollback, etc." Both routers declare overlapping paths, so
whichever mounts first silently serves them. This test makes the
ownership split explicit so a router reorder shows up as a test failure
rather than a quiet behavior change.
"""

from __future__ import annotations

from fastapi.routing import APIRoute


def _serving_endpoint(path: str, method: str):
    """First-match-wins resolution, mirroring FastAPI's router."""
    from eden.api.app import app

    for r in app.routes:
        if isinstance(r, APIRoute) and r.path == path and method in (r.methods or ()):
            return r.endpoint
    return None


def test_prompts_list_create_get_served_by_v2() -> None:
    for path, method in (
        ("/orgs/{org_id}/prompts", "GET"),
        ("/orgs/{org_id}/prompts", "POST"),
        ("/orgs/{org_id}/prompts/{name}", "GET"),
    ):
        endpoint = _serving_endpoint(path, method)
        assert endpoint is not None, f"{method} {path} has no handler"
        assert endpoint.__module__ == "eden.api.routes.prompts_v2", (
            f"{method} {path} is served by {endpoint.__module__}, expected "
            "eden.api.routes.prompts_v2 (mount-order regression?)"
        )


def test_prompts_phase_i_surface_still_reachable() -> None:
    """The v1 router's unique routes (not shadowed by v2) must exist."""
    from eden.api.app import app

    paths = {
        (r.path, m)
        for r in app.routes
        if isinstance(r, APIRoute)
        for m in (r.methods or ())
        if r.path.startswith("/orgs/{org_id}/prompts")
    }
    # Phase I keeps operations v2 does not declare.
    assert any("playground" in p or "rollback" in p for p, _ in paths), (
        f"no playground/rollback route found under /prompts: {sorted(paths)}"
    )
