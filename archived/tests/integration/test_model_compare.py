"""Integration tests for /orgs/{org_id}/models/{compare,recommend,project}.

Mirrors the ``test_cost_overrides`` pattern: in-memory Postgres
fake via ``app.dependency_overrides``, real FastAPI app, real
CostResolver.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from eden.api.app import app

# ─────────────────────────────────────────────────────────────────────
# In-memory Postgres fake for usage_events
# ─────────────────────────────────────────────────────────────────────


class FakeUsageStore:
    """Minimal fake backing the ``usage_events`` SELECT that the
    comparator runs when projecting cost.

    Tests push rows via :meth:`add` and the comparator's SELECT
    sums them by ``org_id`` + ``model`` + window.
    """

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def add(
        self,
        *,
        org_id: str,
        model: str,
        requests: int,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        cost_usd: float = 0.0,
        created_at: datetime | None = None,
    ) -> None:
        self.rows.append({
            "org_id": org_id,
            "model": model,
            "metadata": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
            },
            "cost_usd": cost_usd,
            "event_type": "llm_call",
            "created_at": created_at or datetime.now(UTC),
        })

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        org_id, model, since = args
        matched = [
            r for r in self.rows
            if r["org_id"] == org_id
            and r["model"] == model
            and r["event_type"] == "llm_call"
            and r["created_at"] >= since
        ]
        if not matched:
            return None
        requests = len(matched)
        return {
            "requests": requests,
            "total_input_tokens": sum(int(r["metadata"]["input_tokens"]) for r in matched),
            "total_output_tokens": sum(int(r["metadata"]["output_tokens"]) for r in matched),
            "total_cache_read_tokens": sum(int(r["metadata"]["cache_read_tokens"]) for r in matched),
            "total_cache_write_tokens": sum(int(r["metadata"]["cache_write_tokens"]) for r in matched),
            "total_cost_usd": sum(float(r["cost_usd"]) for r in matched),
        }


@pytest.fixture
def store(monkeypatch):
    fake = FakeUsageStore()
    # Patch both the cost_resolver's DB lookup and the
    # comparator's usage_events lookup to share the same fake.
    import eden.storage.postgres as pg

    async def fake_get_client():
        # Return an object that also exposes fetchrow (used by
        # the resolver for org_cost_overrides - returns None
        # because we don't care about overrides in these tests).
        class _Both:
            def __init__(self, store: FakeUsageStore) -> None:
                self.store = store

            async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
                return await self.store.fetchrow(query, *args)

            async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
                return []

        return _Both(fake)

    # The cost_resolver imports ``get_postgres_client`` lazily at
    # call time so patching the source module is enough.
    monkeypatch.setattr(pg, "get_postgres_client", fake_get_client)
    return fake


@pytest.fixture
def fake_user(monkeypatch):
    """Bypass auth dep tree."""
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
def client(store, fake_user):
    return TestClient(app, headers={"Authorization": "Bearer test"})


# ─────────────────────────────────────────────────────────────────────
# /compare
# ─────────────────────────────────────────────────────────────────────


def test_compare_two_models(client):
    org_id = str(uuid.uuid4())
    r = client.post(
        f"/orgs/{org_id}/models/compare",
        json={
            "current": {"provider": "openai", "model_id": "gpt-4o"},
            "candidate": {"provider": "openai", "model_id": "gpt-4o-mini"},
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["current"]["model_id"] == "gpt-4o"
    assert data["candidate"]["model_id"] == "gpt-4o-mini"
    assert data["delta_cost_per_1k_input"] < 0
    assert data["delta_cost_per_1k_output"] < 0
    assert data["cost_ratio"] < 1.0
    # Cache rates should be surfaced for both sides.
    assert data["current"]["cost_per_1k_cache_read"] == pytest.approx(0.00125)
    assert data["candidate"]["cost_per_1k_cache_read"] == pytest.approx(0.000075)


def test_compare_self_hosted_yields_inf_ratio(client):
    org_id = str(uuid.uuid4())
    r = client.post(
        f"/orgs/{org_id}/models/compare",
        json={
            "current": {"provider": "ollama", "model_id": "llama3.1:8b"},
            "candidate": {"provider": "openai", "model_id": "gpt-4o"},
        },
    )
    assert r.status_code == 200
    # We return 1e9 instead of math.inf because math.inf is
    # not valid JSON.
    assert r.json()["cost_ratio"] == pytest.approx(1e9)


# ─────────────────────────────────────────────────────────────────────
# /recommend
# ─────────────────────────────────────────────────────────────────────


def test_recommend_pick_mode_picks_best(client):
    org_id = str(uuid.uuid4())
    r = client.post(
        f"/orgs/{org_id}/models/recommend",
        json={
            "mode": "pick",
            "candidates": [
                {"provider": "openai", "model_id": "gpt-4o"},
                {"provider": "openai", "model_id": "gpt-4o-mini"},
                {"provider": "anthropic", "model_id": "claude-sonnet-4-6"},
            ],
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["recommended_model_id"] in (
        "gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6",
    )
    assert data["score"] > 0
    assert data["monthly_savings_usd"] is None
    assert data["current_model_id"] is None
    assert len(data["runners_up"]) >= 0


def test_recommend_switch_mode_requires_current(client):
    org_id = str(uuid.uuid4())
    r = client.post(
        f"/orgs/{org_id}/models/recommend",
        json={
            "mode": "switch",
            "candidates": [{"provider": "openai", "model_id": "gpt-4o-mini"}],
        },
    )
    assert r.status_code == 422
    assert "current" in r.text.lower()


def test_recommend_switch_with_real_usage_history(client, store):
    """Switch recommendation uses actual usage_events from the org."""
    org_id = str(uuid.uuid4())
    # Push 30 days of gpt-4o traffic into the fake store.
    for _ in range(30):
        store.add(
            org_id=org_id,
            model="gpt-4o",
            requests=100,
            input_tokens=200_000,
            output_tokens=50_000,
            cache_read_tokens=40_000,
            cost_usd=10.0,
        )
    r = client.post(
        f"/orgs/{org_id}/models/recommend",
        json={
            "mode": "switch",
            "current": {"provider": "openai", "model_id": "gpt-4o"},
            "candidates": [
                {"provider": "openai", "model_id": "gpt-4o"},
                {"provider": "openai", "model_id": "gpt-4o-mini"},
                {"provider": "anthropic", "model_id": "claude-sonnet-4-6"},
            ],
            "window_days": 30,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["current_model_id"] == "gpt-4o"
    assert data["monthly_savings_usd"] is not None
    # The recommendation can be either gpt-4o (stay) or a
    # cheaper model; assert it's one of the valid candidates.
    assert data["recommended_model_id"] in ("gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6")


def test_recommend_switch_empty_history(client):
    """No usage_events -> empty_history=true + zero savings baseline."""
    org_id = str(uuid.uuid4())
    r = client.post(
        f"/orgs/{org_id}/models/recommend",
        json={
            "mode": "switch",
            "current": {"provider": "openai", "model_id": "gpt-4o"},
            "candidates": [{"provider": "openai", "model_id": "gpt-4o"}],
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["current_model_id"] == "gpt-4o"
    # No traffic -> the comparator falls back to defaults, so
    # savings vs the only candidate (itself) is zero.
    assert data["monthly_savings_usd"] == pytest.approx(0.0, abs=1e-6)
    assert data["empty_history"] is True


# ─────────────────────────────────────────────────────────────────────
# /project
# ─────────────────────────────────────────────────────────────────────


def test_project_cost_basic(client, store):
    org_id = str(uuid.uuid4())
    # Each add() call represents one usage_events row. We add 10
    # rows representing 100 total requests with shared per-row
    # token counts (the comparator averages them).
    for _ in range(10):
        store.add(
            org_id=org_id,
            model="gpt-4o",
            requests=1,  # 1 row per add
            input_tokens=20_000,
            output_tokens=5_000,
            cache_read_tokens=4_000,
            cost_usd=0.20,
        )
    r = client.post(
        f"/orgs/{org_id}/models/project",
        json={
            "current": {"provider": "openai", "model_id": "gpt-4o"},
            "candidate": {"provider": "openai", "model_id": "gpt-4o-mini"},
            "scale_factor": 1.0,
            "window_days": 30,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["current_model_id"] == "gpt-4o"
    assert data["candidate_model_id"] == "gpt-4o-mini"
    # Switching to a cheaper model must yield positive savings.
    assert data["savings_usd"] > 0
    assert data["savings_pct"] > 0
    # 10 rows -> 10 requests in the window
    assert data["requests_in_window"] == 10


def test_project_cost_scale_factor(client, store):
    """scale_factor=2 doubles the projected cost."""
    org_id = str(uuid.uuid4())
    for _ in range(5):
        store.add(
            org_id=org_id,
            model="gpt-4o",
            requests=1,
            input_tokens=10_000,
            output_tokens=2_500,
            cache_read_tokens=2_000,
            cost_usd=0.10,
        )
    body = {
        "current": {"provider": "openai", "model_id": "gpt-4o"},
        "candidate": {"provider": "openai", "model_id": "gpt-4o-mini"},
        "window_days": 30,
    }
    r1 = client.post(f"/orgs/{org_id}/models/project", json={**body, "scale_factor": 1.0})
    r2 = client.post(f"/orgs/{org_id}/models/project", json={**body, "scale_factor": 2.0})
    assert r1.status_code == 200 and r2.status_code == 200
    d1, d2 = r1.json(), r2.json()
    assert d2["projected_total_usd"] == pytest.approx(d1["projected_total_usd"] * 2.0, rel=0.01)
    assert d2["requests_in_window"] == d1["requests_in_window"] * 2


def test_project_cost_rejects_bad_scale(client):
    org_id = str(uuid.uuid4())
    r = client.post(
        f"/orgs/{org_id}/models/project",
        json={
            "current": {"provider": "openai", "model_id": "gpt-4o"},
            "candidate": {"provider": "openai", "model_id": "gpt-4o-mini"},
            "scale_factor": 1000.0,  # exceeds 100.0 cap
        },
    )
    assert r.status_code == 422
