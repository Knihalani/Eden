"""Pinning tests for Wave 2.1 — PromptLoader canary-aware resolution.

``a_load_prompt(tenant_id=...)`` must consult ``prompt_version_assignments``
and apply ``pick_canary_version`` (stable per-tenant roll) before falling
back to the active (control) prompt. These tests pin the wiring: the
assignment query is tenant+agent scoped and the chosen candidate's
template is loaded through the v2 shim.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.agents.base import PromptLoader


class _FakePg:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = list(rows)
        self.queries: list[str] = []

    async def fetch(self, sql: str, *args: Any) -> list[dict]:
        self.queries.append(sql)
        return [dict(r) for r in self.rows]


class _FakeClient:
    def __init__(self, prompt: dict | None) -> None:
        self.prompt = prompt
        self.loaded: list[tuple[str, int]] = []

    async def get_prompts_for_agent(self, agent: str, version: int) -> dict | None:
        self.loaded.append((agent, version))
        return dict(self.prompt) if self.prompt else None

    async def get_active_prompt(self, agent: str) -> dict | None:
        return dict(self.prompt) if self.prompt else None


class _CanaryLoader(PromptLoader):
    AGENT_NAME = "planner"

    def __init__(self) -> None:
        self._system_prompt: str | None = None
        self._prompt_version: int | None = None
        self._prompt_loaded = False


@pytest.fixture
def patched(monkeypatch) -> Any:
    """Return a helper that wires get_postgres_client to a fake."""

    def _set_pg(pg: _FakePg) -> None:
        async def _get_pg():
            return pg

        # base.py imports get_postgres_client inside the method.
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client", _get_pg
        )

    return _set_pg


def _fake_resolve(client: _FakeClient, force_none: bool = False):
    # Patched as an *instance* attribute, so no self binding — the
    # signature must match the call site (c, tenant_id).
    async def _resolve(c: Any, tenant_id: str) -> dict | None:
        if force_none:
            return None
        return await client.get_prompts_for_agent("planner", 2)

    return _resolve


async def test_tenant_assignment_wins_roll(monkeypatch, patched) -> None:
    """The real ``_resolve_with_canary`` queries assignments + applies roll."""
    pg = _FakePg(
        [
            {
                "version": 2,
                "traffic_pct": 100,
                "experiment_id": "exp-1",
            }
        ]
    )
    patched(pg)
    client = _FakeClient({"system_prompt": "CANDIDATE V2", "version": 2})
    loader = _CanaryLoader()

    chosen = await loader._resolve_with_canary(client, "org-1")
    assert chosen is not None
    assert chosen["version"] == 2
    assert client.loaded == [("planner", 2)]
    # The assignment query must be tenant+agent scoped with active status.
    sql = pg.queries[0]
    assert "tenant_id = $1 AND agent = $2" in sql
    assert "status = 'active'" in sql
    assert "expires_at" in sql


async def test_no_assignments_returns_none(patched) -> None:
    """Without assignments, ``_resolve_with_canary`` returns None."""
    pg = _FakePg([])
    patched(pg)
    client = _FakeClient({"system_prompt": "CONTROL", "version": 1})
    loader = _CanaryLoader()
    chosen = await loader._resolve_with_canary(client, "org-1")
    assert chosen is None


async def test_a_load_prompt_falls_back_to_active(monkeypatch, patched) -> None:
    """When canary resolution returns None, the active prompt loads."""
    pg = _FakePg([])
    patched(pg)
    client = _FakeClient({"system_prompt": "CONTROL", "version": 1})
    loader = _CanaryLoader()
    monkeypatch.setattr(
        loader, "_resolve_with_canary", _fake_resolve(client, force_none=True)
    )
    # a_load_prompt builds its own client via get_prompt_versions_client
    # — point that at the fake too.
    monkeypatch.setattr(
        "eden.agents.base.get_prompt_versions_client", lambda: client
    )
    await loader.a_load_prompt(tenant_id="org-1")
    assert loader._system_prompt == "CONTROL"
    assert loader._prompt_version == 1
