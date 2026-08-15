"""Integration tests for ``/orgs/{org_id}/cost-overrides``.

Mirrors the ``test_pii_policy`` pattern: in-memory Postgres fake
via ``app.dependency_overrides``. Each test runs against the
actual FastAPI app + actual CostResolver so the wiring is
exercised end-to-end.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from eden.api.app import app

# ─────────────────────────────────────────────────────────────────────
# In-memory Postgres fake for ``org_cost_overrides``
# ─────────────────────────────────────────────────────────────────────


class FakeOverrideStore:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        # SELECT all for an org, newest first (mirrors the
        # ``ORDER BY effective_from DESC`` in the real query).
        org_id = args[0]
        rows = [r for r in self.rows if r["org_id"] == org_id]
        rows.sort(key=lambda r: r["effective_from"], reverse=True)
        return rows

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        # Resolve path - most-recent-effective
        org_id, provider, model_id = args
        now = datetime.now(UTC)
        candidates = [
            r for r in self.rows
            if r["org_id"] == org_id
            and r["provider"] in (provider, "*")
            and r["model_id"] == model_id
            and r["effective_from"] <= now
            and (r["effective_until"] is None or r["effective_until"] > now)
        ]
        # Order: exact provider match first, then effective_from DESC.
        candidates.sort(key=lambda r: (r["provider"] != provider, -r["effective_from"].timestamp()))
        # Mirror the SELECT column list in the real resolver
        # (cost_per_1k_cache_read / write may be None for older
        # rows pre-dating migration 082).
        if candidates:
            row = candidates[0]
            return {
                "cost_per_1k_input": row["cost_per_1k_input"],
                "cost_per_1k_output": row["cost_per_1k_output"],
                "cost_per_1k_cache_read": row.get("cost_per_1k_cache_read"),
                "cost_per_1k_cache_write": row.get("cost_per_1k_cache_write"),
                "currency": row["currency"],
                "source": row["source"],
                "effective_from": row["effective_from"],
                "notes": row["notes"],
            }
        return None

    def insert_returning(self, args: list[Any]) -> dict[str, Any]:
        # The route passes (override_id, org_id, provider, model_id,
        # cost_in, cost_out, cost_cache_read, cost_cache_write,
        # currency, source, eff_from, eff_until, notes, created_by).
        # We mirror the column order from the real INSERT.
        cols = [
            "override_id", "org_id", "provider", "model_id",
            "cost_per_1k_input", "cost_per_1k_output",
            "cost_per_1k_cache_read", "cost_per_1k_cache_write",
            "currency", "source", "effective_from", "effective_until",
            "notes", "created_by", "created_at", "updated_at",
        ]
        row = dict(zip(cols, args, strict=False))
        if row["effective_from"] is None:
            # Increment by 1ms per insert so DESC ordering is
            # deterministic in the LIST test.
            row["effective_from"] = datetime.now(UTC) + timedelta(
                milliseconds=len(self.rows),
            )
        if row["effective_until"] is not None and row["effective_until"] <= row["effective_from"]:
            raise ValueError("effective_until must be after effective_from")
        row["created_at"] = datetime.now(UTC)
        row["updated_at"] = datetime.now(UTC)
        self.rows.append(row)
        # Return only the columns the route's RETURNING clause asks for.
        return {
            "override_id": row["override_id"],
            "org_id": row["org_id"],
            "provider": row["provider"],
            "model_id": row["model_id"],
            "cost_per_1k_input": row["cost_per_1k_input"],
            "cost_per_1k_output": row["cost_per_1k_output"],
            "cost_per_1k_cache_read": row.get("cost_per_1k_cache_read"),
            "cost_per_1k_cache_write": row.get("cost_per_1k_cache_write"),
            "currency": row["currency"],
            "source": row["source"],
            "effective_from": row["effective_from"],
            "effective_until": row["effective_until"],
            "notes": row["notes"],
        }

    async def execute_update(self, args: list[Any]) -> str:
        override_id, org_id = args[0], args[1]
        now = datetime.now(UTC)
        for r in self.rows:
            if r["override_id"] == override_id and r["org_id"] == org_id and r["effective_until"] is None:
                r["effective_until"] = now
                r["updated_at"] = now
                return "UPDATE 1"
        return "UPDATE 0"


class FakePostgresClient:
    """Minimal asyncpg-shaped fake covering only the SQL the
    cost-overrides route emits.
    """
    def __init__(self, store: FakeOverrideStore) -> None:
        self.store = store
        self.fetch = store.fetch
        self.fetchrow = self._fetchrow_dispatch
        self.execute = self._execute_dispatch

    async def _fetchrow_dispatch(self, query: str, *args: Any):
        if "INSERT INTO org_cost_overrides" in query and "RETURNING" in query:
            # The INSERT path: store the row and return it.
            return self.store.insert_returning(list(args))
        return await self.store.fetchrow(query, *args)

    async def _execute_dispatch(self, query: str, *args: Any) -> str:
        if "UPDATE org_cost_overrides" in query and "effective_until = NOW()" in query:
            return await self.store.execute_update(list(args))
        return "OK"


@pytest.fixture
def store():
    return FakeOverrideStore()


@pytest.fixture
def fake_pg(store, monkeypatch):
    """Replace ``get_postgres_client`` in every module that imported it.

    ``cost_overrides.py`` captured ``get_postgres_client`` at import
    time, so monkeypatching only ``eden.storage.postgres`` leaves
    the route with the original reference. We patch the bound name
    in the route module too.
    """
    import eden.api.routes.cost_overrides as co_mod
    import eden.storage.postgres as pg

    async def fake_get_client():
        return FakePostgresClient(store)

    monkeypatch.setattr(pg, "get_postgres_client", fake_get_client)
    monkeypatch.setattr(co_mod, "get_postgres_client", fake_get_client)
    return store


@pytest.fixture
def fake_user(monkeypatch):
    """Stub the auth dep tree via ``app.dependency_overrides``.

    Bypasses both ``_resolve_token_payload`` (the upstream dep
    that decodes the JWT) and ``get_current_user`` (which then
    queries Postgres for the user record). Without both, the
    route would 401 on token resolution or DB lookup.
    """
    import eden.api.deps as deps_module

    async def fake_token_payload():
        return {"sub": "00000000-0000-0000-0000-000000000001", "email": "admin@test", "role": "admin"}

    async def fake_current_user():
        return {"user_id": "00000000-0000-0000-0000-000000000001", "email": "admin@test", "role": "admin"}

    app.dependency_overrides[deps_module._resolve_token_payload] = fake_token_payload
    app.dependency_overrides[deps_module.get_current_user] = fake_current_user
    yield
    app.dependency_overrides.pop(deps_module._resolve_token_payload, None)
    app.dependency_overrides.pop(deps_module.get_current_user, None)


@pytest.fixture
def client(fake_pg, fake_user):
    # default_deny middleware requires an auth credential in the
    # scope; send a fake Bearer token so the request reaches the
    # route handler. ``get_current_user`` is then overridden via
    # ``app.dependency_overrides`` to bypass token validation.
    return TestClient(app, headers={"Authorization": "Bearer test"})


# ─────────────────────────────────────────────────────────────────────
# CRUD
# ─────────────────────────────────────────────────────────────────────


def test_create_override(client, store):
    org_id = str(uuid.uuid4())
    body = {
        "provider": "openai",
        "model_id": "gpt-4o",
        "cost_per_1k_input": "0.001",
        "cost_per_1k_output": "0.002",
        "source": "contract",
        "notes": "acme-volume-deal",
    }
    r = client.post(f"/orgs/{org_id}/cost-overrides", json=body)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["provider"] == "openai"
    assert data["model_id"] == "gpt-4o"
    assert Decimal(data["cost_per_1k_input"]) == Decimal("0.001")
    assert Decimal(data["cost_per_1k_output"]) == Decimal("0.002")
    assert data["source"] == "contract"
    assert data["notes"] == "acme-volume-deal"
    assert len(store.rows) == 1


def test_list_overrides(client, store):
    org_id = str(uuid.uuid4())
    for i in range(3):
        body = {
            "provider": "openai",
            "model_id": f"gpt-4o-{i}",
            "cost_per_1k_input": "0.001",
            "cost_per_1k_output": "0.002",
        }
        r = client.post(f"/orgs/{org_id}/cost-overrides", json=body)
        assert r.status_code == 201
    r = client.get(f"/orgs/{org_id}/cost-overrides")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 3
    # Newest first.
    assert data[0]["model_id"] == "gpt-4o-2"


def test_expire_override(client, store):
    org_id = str(uuid.uuid4())
    body = {
        "provider": "openai",
        "model_id": "gpt-4o",
        "cost_per_1k_input": "0.001",
        "cost_per_1k_output": "0.002",
    }
    r = client.post(f"/orgs/{org_id}/cost-overrides", json=body)
    override_id = r.json()["override_id"]

    r = client.delete(f"/orgs/{org_id}/cost-overrides/{override_id}")
    assert r.status_code == 204

    # The row is still in the store but its effective_until is set.
    assert store.rows[0]["effective_until"] is not None


def test_expire_unknown_override_returns_404(client):
    org_id = str(uuid.uuid4())
    fake_id = str(uuid.uuid4())
    r = client.delete(f"/orgs/{org_id}/cost-overrides/{fake_id}")
    assert r.status_code == 404


def test_create_override_validates_cost_non_negative(client):
    org_id = str(uuid.uuid4())
    body = {
        "provider": "openai",
        "model_id": "gpt-4o",
        "cost_per_1k_input": "-0.001",  # negative
        "cost_per_1k_output": "0.002",
    }
    r = client.post(f"/orgs/{org_id}/cost-overrides", json=body)
    assert r.status_code == 422


def test_create_override_validates_effective_range(client):
    org_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    body = {
        "provider": "openai",
        "model_id": "gpt-4o",
        "cost_per_1k_input": "0.001",
        "cost_per_1k_output": "0.002",
        "effective_from": now.isoformat(),
        "effective_until": (now - timedelta(days=1)).isoformat(),
    }
    r = client.post(f"/orgs/{org_id}/cost-overrides", json=body)
    assert r.status_code == 422


# ─────────────────────────────────────────────────────────────────────
# Resolve (dry-run)
# ─────────────────────────────────────────────────────────────────────


def test_resolve_returns_override_rate(client, store):
    org_id = str(uuid.uuid4())
    body = {
        "provider": "openai",
        "model_id": "gpt-4o",
        "cost_per_1k_input": "0.001",
        "cost_per_1k_output": "0.002",
        "source": "contract",
    }
    client.post(f"/orgs/{org_id}/cost-overrides", json=body)

    r = client.post(
        f"/orgs/{org_id}/cost-overrides/resolve",
        json={"provider": "openai", "model_id": "gpt-4o", "input_tokens": 1000, "output_tokens": 1000},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["source"] == "override"
    assert Decimal(data["cost_usd"]) == Decimal("0.003")


def test_resolve_falls_through_to_catalog_when_no_override(client):
    org_id = str(uuid.uuid4())
    # No override row created.
    r = client.post(
        f"/orgs/{org_id}/cost-overrides/resolve",
        json={"provider": "openai", "model_id": "gpt-4o", "input_tokens": 1000, "output_tokens": 1000},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["source"] in ("static", "openrouter")  # whichever the catalog returns
    # The static seed for gpt-4o is 0.0025/0.010.
    assert Decimal(data["cost_usd"]) > Decimal("0")
