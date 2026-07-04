"""Integration tests for the per-org AI Gateway model registry (A2).

Covers the CRUD surface at ``/orgs/{org_id}/gateway/models`` plus
the gateway-side ``/resolve`` endpoint that A1 calls. The
Postgres client is replaced with an in-memory fake via
``app.dependency_overrides`` (the same pattern as
``test_ingestion.py``).

Encryption is exercised end-to-end: writes go through Fernet,
reads decrypt, and the masked prefix is asserted in responses.
The plaintext key is only ever visible on the ``/resolve`` route.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from eden.api.deps import OrgMember

# ── In-memory store + Postgres fake ─────────────────────────────


class FakeRow:
    def __init__(self, data: dict[str, Any]) -> None:
        self._d = data

    def __getitem__(self, k: str) -> Any:
        return self._d[k]

    def get(self, k: str, default: Any = None) -> Any:
        return self._d.get(k, default)

    def keys(self):  # for ``dict(row)``
        return self._d.keys()

    def values(self):
        return self._d.values()

    def items(self):
        return self._d.items()

    def __iter__(self):
        return iter(self._d)


class GatewayModelStore:
    """In-memory replacement for the ``org_gateway_models`` table.

    Mirrors the SQL of the real store: UNIQUE(org_id, name),
    routing_priority ordering, and the same column shape. Used
    by the Postgres fake below to validate the route's read /
    write logic without standing up a real database.
    """

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.audit: list[dict[str, Any]] = []

    # Insert
    async def execute_insert(self, args: list[Any]) -> str:
        cols = [
            "model_id", "org_id", "name", "provider", "upstream_model",
            "upstream_api_key_encrypted", "upstream_key_prefix",
            "endpoint", "enabled", "routing_priority", "metadata",
            "created_by", "created_at", "updated_at",
        ]
        row = dict(zip(cols, args, strict=False))
        # UNIQUE(org_id, name)
        for r in self.rows:
            if r["org_id"] == row["org_id"] and r["name"] == row["name"]:
                # asyncpg surfaces UniqueViolationError; the route
                # catches it generically. We return a sentinel.
                raise ValueError("duplicate key value violates unique constraint")
        self.rows.append(row)
        return "INSERT 0 1"

    # Update
    async def execute_update(
        self, sql: str, params: list[Any]
    ) -> str:
        org_id = params[0]
        model_id = params[1]
        row = next(
            (r for r in self.rows if r["org_id"] == org_id and str(r["model_id"]) == str(model_id)),
            None,
        )
        if not row:
            return "UPDATE 0"
        # Crude parser: extract "col = $N" from the SET clause
        # then map back to the positional args. The $N indices
        # refer to the FULL params list, not the SET-only list.
        import re
        set_clause = sql.split("SET", 1)[1].split("WHERE", 1)[0]
        matches = re.findall(r"([\w_]+)\s*=\s*\$(\d+)", set_clause)
        for col, idx_str in matches:
            idx = int(idx_str)
            if idx - 1 < len(params):
                row[col] = params[idx - 1]
        return "UPDATE 1"

    # Delete
    async def execute_delete(self, org_id: str, model_id: str) -> str:
        before = len(self.rows)
        self.rows = [
            r for r in self.rows
            if not (r["org_id"] == org_id and str(r["model_id"]) == str(model_id))
        ]
        deleted = before - len(self.rows)
        return f"DELETE {deleted}"


def _make_pg(store: GatewayModelStore) -> MagicMock:
    """A MagicMock Postgres client that talks to the in-memory store."""
    client = MagicMock()

    async def _fetch(sql: str, *args):
        if "org_gateway_models" not in sql:
            return []
        rows = [
            r for r in store.rows
            if r["org_id"] == (args[0] if args else None)
        ]
        # Very crude filter parsing for the simple WHERE clauses
        # the route uses.
        if "AND name = $2" in sql:
            rows = [r for r in rows if r["name"] == args[1]]
        if "AND model_id = $2" in sql:
            rows = [r for r in rows if str(r["model_id"]) == str(args[1])]
        if "AND enabled = TRUE" in sql:
            rows = [r for r in rows if r["enabled"]]
        if "ORDER BY routing_priority ASC" in sql:
            rows = sorted(rows, key=lambda r: r["routing_priority"])
        if "LIMIT 1" in sql:
            rows = rows[:1]
        return [FakeRow(r) for r in rows]

    async def _fetchrow(sql: str, *args):
        rows = await _fetch(sql, *args)
        return rows[0] if rows else None

    async def _execute(sql: str, *args):
        sql_norm = " ".join(sql.split())
        if sql_norm.startswith("INSERT INTO org_gateway_models"):
            return await store.execute_insert(list(args))
        if sql_norm.startswith("UPDATE org_gateway_models"):
            return await store.execute_update(sql, list(args))
        if sql_norm.startswith("DELETE FROM org_gateway_models"):
            return await store.execute_delete(args[0], args[1])
        if sql_norm.startswith(
            "INSERT INTO org_audit_log"
        ):
            store.audit.append({"sql": sql, "args": list(args)})
            return "INSERT 0 1"
        return "OK"

    client.fetch = AsyncMock(side_effect=_fetch)
    client.fetchrow = AsyncMock(side_effect=_fetchrow)
    client.execute = AsyncMock(side_effect=_execute)
    return client


def _admin_member(org_id: str = "org-abc", user_id: str = "user-1") -> OrgMember:
    return OrgMember(
        user_id=user_id,
        org_id=org_id,
        role="owner",
        email="owner@example.com",
        name="Owner",
    )


def _member_role(org_id: str = "org-abc", user_id: str = "user-2") -> OrgMember:
    return OrgMember(
        user_id=user_id,
        org_id=org_id,
        role="member",
        email="member@example.com",
        name="Member",
    )


# ── Fixtures ─────────────────────────────────────────────────────


@pytest.fixture
def gateway_store() -> GatewayModelStore:
    return GatewayModelStore()


@pytest.fixture
def api_client_with_gateway(gateway_store: GatewayModelStore) -> TestClient:
    """A TestClient with the gateway router's auth deps overridden."""
    from eden.api.app import app
    from eden.api.deps import get_current_org_member
    from eden.llmops import registry_store as rs
    from eden.storage.postgres import get_postgres_client

    pg = _make_pg(gateway_store)

    # Override the auth dep so tests don't need a real cookie.
    # Default: owner. Tests can call ``app.dependency_overrides[...]``
    # to swap in a different role.
    app.dependency_overrides[get_current_org_member] = lambda: _admin_member()

    # Patch the postgres client AND the registry store module so
    # the route (which imports the store) sees the same fake. We
    # also patch the modules that imported get_postgres_client at
    # top-of-file, since Python name resolution uses the original
    # reference unless we rewrite the imported name in each module.
    async def _pg():
        return pg
    app.dependency_overrides[get_postgres_client] = _pg
    import eden.api.deps as deps_module
    import eden.api.routes.gateway_models as gm_module
    import eden.llmops.registry_store as rs_module
    rs_original = rs_module.get_postgres_client
    gm_original = gm_module.get_postgres_client
    deps_original = deps_module.get_postgres_client
    rs_module.get_postgres_client = _pg
    gm_module.get_postgres_client = _pg
    deps_module.get_postgres_client = _pg
    try:
        client = TestClient(app)
        # Pre-set the auth cookie so default-deny middleware accepts
        # the request (overriding deps doesn't reach the middleware).
        client.cookies.set("authorization", "test-token-for-default-deny")
        yield client, pg, gateway_store
    finally:
        app.dependency_overrides.pop(get_current_org_member, None)
        app.dependency_overrides.pop(get_postgres_client, None)
        rs_module.get_postgres_client = rs_original
        gm_module.get_postgres_client = gm_original
        deps_module.get_postgres_client = deps_original


# ── Tests ────────────────────────────────────────────────────────


class TestListGatewayModels:
    def test_list_empty(self, api_client_with_gateway):
        client, _, _ = api_client_with_gateway
        resp = client.get("/orgs/org-abc/gateway/models")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_returns_masked_keys(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        # Seed an existing row directly
        from eden.api.utils.encryption import encrypt_value
        store.rows.append(
            {
                "model_id": str(uuid.uuid4()),
                "org_id": "org-abc",
                "name": "gpt-4o-mini",
                "provider": "openai",
                "upstream_model": "gpt-4o-mini-2024-07-18",
                "upstream_api_key_encrypted": encrypt_value("sk-test-1234"),
                "upstream_key_prefix": "1234",
                "endpoint": None,
                "enabled": True,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.get("/orgs/org-abc/gateway/models")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["name"] == "gpt-4o-mini"
        assert data[0]["upstream_key_prefix"] == "1234"
        # Plaintext key must not leak
        assert "upstream_api_key" not in data[0]
        body = resp.text
        assert "sk-test-1234" not in body


class TestCreateGatewayModel:
    def test_create_openai(self, api_client_with_gateway):
        client, pg, store = api_client_with_gateway
        resp = client.post(
            "/orgs/org-abc/gateway/models",
            json={
                "name": "gpt-4o-mini",
                "provider": "openai",
                "upstream_model": "gpt-4o-mini-2024-07-18",
                "upstream_api_key": "sk-test-abcdef",
                "endpoint": "https://api.openai.com/v1",
                "routing_priority": 50,
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["name"] == "gpt-4o-mini"
        assert data["provider"] == "openai"
        assert data["upstream_key_prefix"] == "cdef"
        assert "upstream_api_key" not in data
        assert data["enabled"] is True
        assert data["routing_priority"] == 50
        # Verify the underlying row encrypted the key
        assert len(store.rows) == 1
        assert "sk-test-abcdef" not in store.rows[0]["upstream_api_key_encrypted"]
        # And that an audit row was emitted (action is the 3rd positional arg)
        assert any(
            len(a.get("args", [])) > 3 and a["args"][2] == "gateway_model.created"
            for a in store.audit
        )

    def test_create_unsupported_provider_422(self, api_client_with_gateway):
        client, _, _ = api_client_with_gateway
        resp = client.post(
            "/orgs/org-abc/gateway/models",
            json={
                "name": "x",
                "provider": "made-up-provider",
                "upstream_model": "x",
                "upstream_api_key": "k",
            },
        )
        assert resp.status_code == 422

    def test_create_duplicate_name_409(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        from eden.api.utils.encryption import encrypt_value
        store.rows.append(
            {
                "model_id": str(uuid.uuid4()),
                "org_id": "org-abc",
                "name": "dup",
                "provider": "openai",
                "upstream_model": "dup",
                "upstream_api_key_encrypted": encrypt_value("k"),
                "upstream_key_prefix": "k",
                "endpoint": None,
                "enabled": True,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.post(
            "/orgs/org-abc/gateway/models",
            json={
                "name": "dup",
                "provider": "openai",
                "upstream_model": "dup-2",
                "upstream_api_key": "sk-other",
            },
        )
        assert resp.status_code == 409
        assert "dup" in resp.json()["detail"]

    def test_member_role_cannot_create(self, api_client_with_gateway):
        from eden.api.app import app
        from eden.api.deps import get_current_org_member
        app.dependency_overrides[get_current_org_member] = lambda: _member_role()
        client, _, _ = api_client_with_gateway
        resp = client.post(
            "/orgs/org-abc/gateway/models",
            json={
                "name": "x",
                "provider": "openai",
                "upstream_model": "x",
                "upstream_api_key": "sk-x",
            },
        )
        assert resp.status_code == 403
        # Reset for subsequent tests
        app.dependency_overrides[get_current_org_member] = lambda: _admin_member()


class TestUpdateGatewayModel:
    def test_patch_endpoint(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        from eden.api.utils.encryption import encrypt_value
        mid = str(uuid.uuid4())
        store.rows.append(
            {
                "model_id": mid,
                "org_id": "org-abc",
                "name": "gpt-4o",
                "provider": "openai",
                "upstream_model": "gpt-4o-2024-08-06",
                "upstream_api_key_encrypted": encrypt_value("sk-old"),
                "upstream_key_prefix": "-old",
                "endpoint": None,
                "enabled": True,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.patch(
            f"/orgs/org-abc/gateway/models/{mid}",
            json={
                "endpoint": "https://api.openai.com/v1",
                "enabled": False,
                "routing_priority": 25,
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["endpoint"] == "https://api.openai.com/v1"
        assert data["enabled"] is False
        assert data["routing_priority"] == 25
        # key is still there
        assert data["upstream_key_prefix"] == "-old"

    def test_patch_rotates_key(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        from eden.api.utils.encryption import encrypt_value
        mid = str(uuid.uuid4())
        store.rows.append(
            {
                "model_id": mid,
                "org_id": "org-abc",
                "name": "gpt-4o",
                "provider": "openai",
                "upstream_model": "gpt-4o",
                "upstream_api_key_encrypted": encrypt_value("sk-old"),
                "upstream_key_prefix": "d-old",
                "endpoint": None,
                "enabled": True,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.patch(
            f"/orgs/org-abc/gateway/models/{mid}",
            json={"upstream_api_key": "sk-new-key-9999"},
        )
        assert resp.status_code == 200
        assert resp.json()["upstream_key_prefix"] == "9999"
        # Confirm underlying row was re-encrypted
        from eden.api.utils.encryption import decrypt_value
        row = store.rows[0]
        assert decrypt_value(row["upstream_api_key_encrypted"]) == "sk-new-key-9999"

    def test_patch_404(self, api_client_with_gateway):
        client, _, _ = api_client_with_gateway
        resp = client.patch(
            f"/orgs/org-abc/gateway/models/{uuid.uuid4()}",
            json={"enabled": False},
        )
        assert resp.status_code == 404


class TestDeleteGatewayModel:
    def test_delete(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        from eden.api.utils.encryption import encrypt_value
        mid = str(uuid.uuid4())
        store.rows.append(
            {
                "model_id": mid,
                "org_id": "org-abc",
                "name": "to-delete",
                "provider": "openai",
                "upstream_model": "x",
                "upstream_api_key_encrypted": encrypt_value("k"),
                "upstream_key_prefix": "k",
                "endpoint": None,
                "enabled": True,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.delete(f"/orgs/org-abc/gateway/models/{mid}")
        assert resp.status_code == 200
        assert store.rows == []  # gone

    def test_delete_404(self, api_client_with_gateway):
        client, _, _ = api_client_with_gateway
        resp = client.delete(f"/orgs/org-abc/gateway/models/{uuid.uuid4()}")
        assert resp.status_code == 404


class TestResolveGatewayModel:
    def test_resolve_returns_decrypted_key(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        from eden.api.utils.encryption import encrypt_value
        store.rows.append(
            {
                "model_id": str(uuid.uuid4()),
                "org_id": "org-abc",
                "name": "gpt-4o-mini",
                "provider": "openai",
                "upstream_model": "gpt-4o-mini-2024-07-18",
                "upstream_api_key_encrypted": encrypt_value("sk-plaintext"),
                "upstream_key_prefix": "text",
                "endpoint": "https://api.openai.com/v1",
                "enabled": True,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.post(
            "/orgs/org-abc/gateway/models/resolve",
            json={"name": "gpt-4o-mini"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["upstream_api_key"] == "sk-plaintext"
        assert data["provider"] == "openai"
        assert data["endpoint"] == "https://api.openai.com/v1"

    def test_resolve_unknown_name_404(self, api_client_with_gateway):
        client, _, _ = api_client_with_gateway
        resp = client.post(
            "/orgs/org-abc/gateway/models/resolve",
            json={"name": "never-registered"},
        )
        assert resp.status_code == 404
        assert "never-registered" in resp.json()["detail"]

    def test_resolve_skips_disabled(self, api_client_with_gateway):
        client, _, store = api_client_with_gateway
        from eden.api.utils.encryption import encrypt_value
        store.rows.append(
            {
                "model_id": str(uuid.uuid4()),
                "org_id": "org-abc",
                "name": "off",
                "provider": "openai",
                "upstream_model": "off",
                "upstream_api_key_encrypted": encrypt_value("k"),
                "upstream_key_prefix": "k",
                "endpoint": None,
                "enabled": False,
                "routing_priority": 100,
                "metadata": {},
                "created_by": "user-1",
                "created_at": "2024-01-01T00:00:00+00:00",
                "updated_at": "2024-01-01T00:00:00+00:00",
            }
        )
        resp = client.post(
            "/orgs/org-abc/gateway/models/resolve",
            json={"name": "off"},
        )
        assert resp.status_code == 404

    def test_resolve_member_role_forbidden(self, api_client_with_gateway):
        from eden.api.app import app
        from eden.api.deps import get_current_org_member
        app.dependency_overrides[get_current_org_member] = lambda: _member_role()
        client, _, _ = api_client_with_gateway
        resp = client.post(
            "/orgs/org-abc/gateway/models/resolve",
            json={"name": "x"},
        )
        assert resp.status_code == 403
        app.dependency_overrides[get_current_org_member] = lambda: _admin_member()


class TestEncryptionRoundTrip:
    def test_decrypts_to_original_plaintext(self, api_client_with_gateway):
        """A round trip: write a key, read it back via /resolve."""
        client, _, store = api_client_with_gateway
        resp = client.post(
            "/orgs/org-abc/gateway/models",
            json={
                "name": "k1",
                "provider": "openai",
                "upstream_model": "k1",
                "upstream_api_key": "sk-roundtrip-1234",
            },
        )
        assert resp.status_code == 201
        # Confirm stored ciphertext is not the plaintext
        assert "sk-roundtrip-1234" not in store.rows[0]["upstream_api_key_encrypted"]
        # Resolve and confirm decrypted plaintext matches
        resp = client.post(
            "/orgs/org-abc/gateway/models/resolve",
            json={"name": "k1"},
        )
        assert resp.json()["upstream_api_key"] == "sk-roundtrip-1234"
