"""Phase 3 partial — judges async 501 replaced with forced-sync coercion.

``POST /orgs/{org_id}/observability/judges/run`` used to 501 when the
caller asked for ``sync=false`` (no async judge tailer exists). That
looked like a broken/unfinished endpoint to API consumers. The fix
runs the judges inline regardless of the requested mode and marks the
response with an ``X-Judges-Sync-Coerced`` header so callers can tell
the async request was coerced to sync — instead of leaving a 501.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from starlette.testclient import TestClient


def _build_app():
    from eden.api.deps import get_current_user, require_path_org_access
    from eden.api.routes import judges as judges_routes

    app = FastAPI()
    app.include_router(judges_routes.router)

    app.dependency_overrides[get_current_user] = lambda: {
        "user_id": "u-1",
        "email": "x@y.z",
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org-A"
    return app, judges_routes


def _no_events_postgres_client() -> AsyncMock:
    """A fake Postgres client whose trace has no telemetry_events, so
    ``run_judges`` short-circuits to an empty (but 200) response."""
    client = MagicMock()
    client.fetch = AsyncMock(return_value=[])
    return client


def test_async_request_no_longer_501s() -> None:
    """``sync=false`` must not 501 — it must run inline and succeed."""
    app, judges_routes = _build_app()

    with patch.object(
        judges_routes, "get_judge_registry",
        return_value=MagicMock(all=lambda: []),
    ), patch.object(
        judges_routes, "require_judges_run",
        AsyncMock(return_value={"org_id": "org-A"}),
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_no_events_postgres_client()),
    ):
        client = TestClient(app)
        resp = client.post(
            "/orgs/org-A/observability/judges/run",
            json={"trace_id": "tr-1", "sync": False},
        )

    assert resp.status_code == 200, (
        f"async judges run must not 501: {resp.status_code} {resp.text}"
    )
    body = resp.json()
    # Ran inline — never actually queued.
    assert body["queued"] is False
    assert body["job_id"] is None


def test_async_request_sets_coercion_header() -> None:
    """A ``sync=false`` request is flagged via the coercion header."""
    app, judges_routes = _build_app()

    with patch.object(
        judges_routes, "get_judge_registry",
        return_value=MagicMock(all=lambda: []),
    ), patch.object(
        judges_routes, "require_judges_run",
        AsyncMock(return_value={"org_id": "org-A"}),
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_no_events_postgres_client()),
    ):
        client = TestClient(app)
        resp = client.post(
            "/orgs/org-A/observability/judges/run",
            json={"trace_id": "tr-1", "sync": False},
        )

    assert resp.headers.get("x-judges-sync-coerced") == "true"


def test_sync_request_has_no_coercion_header() -> None:
    """A normal ``sync=true`` (or omitted) request is untouched."""
    app, judges_routes = _build_app()

    with patch.object(
        judges_routes, "get_judge_registry",
        return_value=MagicMock(all=lambda: []),
    ), patch.object(
        judges_routes, "require_judges_run",
        AsyncMock(return_value={"org_id": "org-A"}),
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_no_events_postgres_client()),
    ):
        client = TestClient(app)
        resp = client.post(
            "/orgs/org-A/observability/judges/run",
            json={"trace_id": "tr-1"},
        )

    assert resp.status_code == 200
    assert "x-judges-sync-coerced" not in resp.headers
