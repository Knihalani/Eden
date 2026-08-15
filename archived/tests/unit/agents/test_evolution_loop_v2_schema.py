"""Pinning test for Wave 2.4b — ``_enroll_pending_canaries`` v2 schema.

Migration 055 dropped the legacy ``prompt_versions`` columns the loop
previously read (``agent``, ``quality_metrics``). The query must now
join ``prompts`` for the agent name and read quality metrics from the
v2 ``params`` jsonb.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.agents.evolution.loop import _enroll_pending_canaries


class _FakePg:
    def __init__(self) -> None:
        self.queries: list[str] = []
        self.calls: list[tuple[str, tuple]] = []

    async def fetch(self, sql: str, *args: Any) -> list[dict]:
        self.queries.append(sql)
        self.calls.append((sql, args))
        return []


@pytest.fixture
def fake_pg(monkeypatch) -> _FakePg:
    pg = _FakePg()

    async def _get():
        return pg

    # ``loop.py`` imports get_postgres_client inside the function.
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        _get,
    )
    return pg


async def test_pending_canaries_query_targets_v2_schema(fake_pg: _FakePg) -> None:
    """The pending-canary query reads v2 columns only."""
    result = await _enroll_pending_canaries()
    assert result == 0
    assert len(fake_pg.queries) == 1
    sql = fake_pg.queries[0]
    # Agent name must come from the prompts join (legacy ``agent``
    # column is gone).
    assert "JOIN prompts p ON p.id = pv.prompt_id" in sql
    assert "p.name AS agent" in sql
    # Quality metrics must come from the v2 params jsonb.
    assert "params->'quality_metrics'" in sql
    assert "pv.params" in sql
    # The scan must be scoped to the sentinel system org so tenant
    # prompts (IssuePromptEvolver variants) are not picked up.
    assert "pv.org_id = $1" in sql
    from eden.kb.prompt_versions.client import SYSTEM_ORG_ID

    assert SYSTEM_ORG_ID in fake_pg.calls[0][1]
    # Legacy columns must NOT appear.
    assert "quality_metrics->>" not in sql
    assert "FROM prompt_versions pv" in sql
    assert "WHERE agent =" not in sql
