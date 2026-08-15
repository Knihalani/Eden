"""SSO live-schema round-trip + static lock against org_sso_providers.

Pins the 2026-08-02 fix: handlers query ``org_sso_settings`` /
``sso_configurations`` / ``org_scim_config``, never the non-existent
``org_sso_providers`` table.
"""

from __future__ import annotations

import ast
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ORG = "00000000-0000-0000-0000-000000000001"
USER = "00000000-0000-0000-0000-000000000099"


def _sso_source() -> str:
    return Path("src/eden/api/routes/sso.py").read_text(encoding="utf-8")


def test_sso_py_has_no_org_sso_providers_reference() -> None:
    """Static lock: sso.py must not mention the dead table name."""
    src = _sso_source()
    assert "org_sso_providers" not in src, (
        "sso.py still references org_sso_providers — that table does not "
        "exist live; use org_sso_settings / sso_configurations"
    )
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert "org_sso_providers" not in node.value


def test_sso_py_targets_live_tables() -> None:
    src = _sso_source()
    assert "org_sso_settings" in src
    assert "sso_configurations" in src
    assert "org_scim_config" in src


class _RecordingConn:
    """Connection stand-in that records SQL and returns canned rows."""

    def __init__(self, store: dict[str, Any]) -> None:
        self.store = store
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, *args: Any) -> str:
        self.queries.append((query, args))
        q = " ".join(query.split()).lower()
        if "insert into sso_configurations" in q:
            self.store["config_id"] = args[0]
            self.store["provider"] = args[1]
            self.store["client_id"] = args[2]
            self.store["client_secret"] = args[3]
            self.store["authorization_endpoint"] = args[4]
            return "INSERT 0 1"
        if "insert into org_sso_settings" in q:
            self.store["settings_id"] = args[0]
            self.store["org_id"] = args[1]
            self.store["sso_config_id"] = args[2]
            return "INSERT 0 1"
        if "insert into org_scim_config" in q:
            self.store["scim_token_hash"] = args[1] if len(args) > 1 else None
            self.store["scim_enabled"] = True
            return "INSERT 0 1"
        if "update org_scim_config" in q:
            if "scim_token_hash = null" in q or "scim_token_hash = $1" in q and args and args[0] is None:
                self.store["scim_token_hash"] = None
                self.store["scim_enabled"] = False
            else:
                self.store["scim_token_hash"] = args[0]
                self.store["scim_enabled"] = True
            return "UPDATE 1"
        if "update org_sso_settings" in q and "enabled = true" in q:
            self.store["enabled"] = True
            return "UPDATE 1"
        return "UPDATE 1"

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        self.queries.append((query, args))
        q = " ".join(query.split()).lower()
        if "insert into org_sso_settings" in q:
            self.store["settings_id"] = args[0]
            self.store["org_id"] = args[1]
            self.store["sso_config_id"] = args[2]
            self.store["enabled"] = False
            self.store["enforce_sso"] = False
            self.store["created_at"] = datetime.now(UTC)
            return {"id": args[0]}
        if "from org_sso_settings" in q and "join sso_configurations" in q:
            if not self.store.get("settings_id"):
                return None
            return {
                "sso_config_id": self.store["sso_config_id"],
                "client_id": self.store.get("client_id", ""),
                "client_secret": self.store.get("client_secret", ""),
                "authorization_endpoint": self.store.get("authorization_endpoint"),
                "token_endpoint": self.store.get("token_endpoint"),
                "userinfo_endpoint": self.store.get("userinfo_endpoint"),
                "id": self.store["settings_id"],
                "provider_type": self.store.get("provider"),
                "name": self.store.get("provider"),
            }
        if "from org_sso_settings" in q and "where id" in q:
            if self.store.get("settings_id") == args[0]:
                return {"id": args[0]}
            return None
        if "from org_scim_config" in q:
            if self.store.get("scim_token_hash") is not None or self.store.get("scim_row"):
                return {"id": str(uuid4())}
            return None
        return None

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.queries.append((query, args))
        q = " ".join(query.split()).lower()
        if "from org_sso_settings" in q and self.store.get("settings_id"):
            return [
                {
                    "id": self.store["settings_id"],
                    "org_id": self.store["org_id"],
                    "provider_type": self.store.get("provider", "oidc"),
                    "name": self.store.get("provider", "oidc"),
                    "enabled": self.store.get("enabled", False),
                    "enforce_sso": self.store.get("enforce_sso", False),
                    "scim_enabled": bool(self.store.get("scim_enabled", False)),
                    "created_at": self.store.get(
                        "created_at", datetime.now(UTC)
                    ),
                }
            ]
        return []


class _FakePg:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.conn = _RecordingConn(self.store)
        self.all_queries: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def transaction(self):
        yield self.conn

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        rows = await self.conn.fetch(query, *args)
        self.all_queries.extend(self.conn.queries[-1:])
        return rows

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        row = await self.conn.fetchrow(query, *args)
        self.all_queries.extend(self.conn.queries[-1:])
        return row

    async def execute(self, query: str, *args: Any) -> str:
        result = await self.conn.execute(query, *args)
        self.all_queries.extend(self.conn.queries[-1:])
        return result


def _build_app(pg: _FakePg) -> FastAPI:
    from eden.api.routes import sso as sso_routes

    app = FastAPI()
    app.include_router(sso_routes.router)
    app.dependency_overrides[sso_routes.get_current_user] = lambda: {
        "user_id": USER,
        "email": "admin@example.com",
    }
    app.dependency_overrides[sso_routes._try_resolve_token_payload] = lambda: {
        "sub": USER,
    }
    return app


@pytest.mark.asyncio
async def test_sso_provider_create_list_round_trip_uses_live_tables() -> None:
    """Full create → list cycle; every SQL names live tables only."""
    from eden.api.routes import sso as sso_routes

    pg = _FakePg()
    app = _build_app(pg)

    with (
        patch.object(sso_routes, "require_org_admin", AsyncMock(return_value=None)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
    ):
        client = TestClient(app)
        create = client.post(
            "/sso/providers",
            params={"org_id": ORG},
            json={
                "provider_type": "oidc",
                "name": "Acme Okta",
                "client_id": "cid-1",
                "client_secret": "sec-1",
                "sso_url": "https://idp.example.com/oauth2/authorize",
            },
        )
        assert create.status_code == 200, create.text
        body = create.json()
        assert "id" in body
        provider_id = body["id"]
        assert provider_id == pg.store["settings_id"]

        listed = client.get("/sso/providers", params={"org_id": ORG})
        assert listed.status_code == 200, listed.text
        rows = listed.json()
        assert len(rows) == 1
        assert rows[0]["id"] == provider_id
        assert rows[0]["org_id"] == ORG
        assert rows[0]["provider_type"] == "oidc"
        # name has no live column — derived from provider slug
        assert rows[0]["name"] == "oidc"
        assert rows[0]["default_for_domain"] is None

    sql_blob = "\n".join(q for q, _ in pg.conn.queries)
    assert "org_sso_providers" not in sql_blob
    assert "sso_configurations" in sql_blob
    assert "org_sso_settings" in sql_blob
