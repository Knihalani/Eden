"""BUG-13 — resolve_agent_id + alias-aware list filters."""

from __future__ import annotations

from typing import Any

import pytest

from eden.issues.agent_identity import agent_id_filter_sql, resolve_agent_id
from eden.issues.repo import IssuesRepo


class _FakePg:
    def __init__(
        self,
        *,
        registered: set[str] | None = None,
        aliases: dict[str, str] | None = None,
    ) -> None:
        self.registered = registered or set()
        self.aliases = aliases or {}

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        org_id, key = args[0], args[1]
        assert org_id == "org_test"
        if "FROM agent_registrations" in sql:
            return {"agent_id": key} if key in self.registered else None
        if "FROM agent_identity_aliases" in sql:
            agent_id = self.aliases.get(key)
            return {"agent_id": agent_id} if agent_id else None
        return None


def _patch_pg(monkeypatch: pytest.MonkeyPatch, pg: _FakePg) -> None:
    async def _get_client() -> _FakePg:
        return pg

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_client
    )


@pytest.mark.asyncio
async def test_resolve_registered_agent_id_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_pg(monkeypatch, _FakePg(registered={"agent-canonical"}))
    assert await resolve_agent_id("org_test", "agent-canonical") == "agent-canonical"


@pytest.mark.asyncio
async def test_resolve_synthetic_label_to_canonical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_pg(
        monkeypatch,
        _FakePg(
            registered={"agent-canonical"},
            aliases={"pydantic-ai:OpenAIChatModel()": "agent-canonical"},
        ),
    )
    resolved = await resolve_agent_id(
        "org_test", "pydantic-ai:OpenAIChatModel()"
    )
    assert resolved == "agent-canonical"


@pytest.mark.asyncio
async def test_resolve_empty_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_pg(monkeypatch, _FakePg())
    assert await resolve_agent_id("org_test", None) is None
    assert await resolve_agent_id("org_test", "  ") is None


@pytest.mark.asyncio
async def test_resolve_unknown_passes_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_pg(monkeypatch, _FakePg())
    assert await resolve_agent_id("org_test", "fleet-label") == "fleet-label"


def test_agent_id_filter_sql_matches_aliases() -> None:
    sql = agent_id_filter_sql(org_param=1, agent_param=2)
    assert "agent_identity_aliases" in sql
    assert "agent_id = $2" in sql


@pytest.mark.asyncio
async def test_list_stumbles_agent_filter_includes_alias_sql(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = IssuesRepo()
    captured: dict[str, Any] = {}

    class _ListPg:
        async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
            captured["sql"] = " ".join(sql.split())
            captured["args"] = args
            return []

    async def _client() -> _ListPg:
        return _ListPg()

    monkeypatch.setattr(repo, "_client", _client)
    await repo.list_stumbles("org_test", agent_id="agent-canonical")
    assert "agent_identity_aliases" in captured["sql"]
    assert captured["args"][1] == "agent-canonical"
