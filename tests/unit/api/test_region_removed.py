"""Assert product region-picker route module is gone."""

from __future__ import annotations

import importlib.util

from fastapi.routing import APIRoute


def test_region_route_module_find_spec_is_none() -> None:
    """``eden.api.routes.region`` must not be importable."""
    spec = importlib.util.find_spec("eden.api.routes.region")
    assert spec is None


def test_region_route_import_fails() -> None:
    try:
        import eden.api.routes.region as region_mod  # noqa: F401
    except ModuleNotFoundError:
        return
    raise AssertionError("eden.api.routes.region should not import")


def test_app_routes_have_no_org_region_suffix() -> None:
    """App route paths must not include ``/region`` as an org region picker suffix."""
    from eden.api.app import app

    region_suffix_paths: list[str] = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            path = getattr(route, "path", "") or ""
        else:
            path = route.path or ""
        # Org region picker was ``/orgs/{org_id}/region`` (exact suffix).
        if path.rstrip("/").endswith("/region"):
            region_suffix_paths.append(path)

    assert region_suffix_paths == [], (
        f"Unexpected /region org picker routes still mounted: {region_suffix_paths}"
    )
