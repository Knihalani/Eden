"""Pinning tests for the Wave 2.4 ``PromptVersionsClient`` v2 shim.

Migration 055 dropped the legacy agent-keyed ``prompt_versions`` table
(``agent``/``system_prompt``/``active``/...). Every method of the client
previously targeted those dropped columns and would raise
``UndefinedColumnError`` at runtime. These tests pin the *new* SQL to
the live v2 schema (``prompts.name`` + ``prompt_versions.template`` /
``params``) and pin the preserved legacy row shape.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from eden.kb.prompt_versions.client import (
    SYSTEM_ORG_ID,
    PromptVersionsClient,
)


class _CapturingPg:
    """Fake postgres that records every call, returns configured rows.

    Mirrors the real client's API surface (fetchrow / fetch / fetchval /
    execute / transaction) while capturing the raw SQL so tests can pin
    column names against the live schema.
    """

    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows = list(rows or [])
        self.calls: list[tuple[str, tuple]] = []
        self.executed: list[str] = []

    # Every fetch is answered with the preconfigured row(s). The shim's
    # queries are shape-pinned by asserting on ``calls`` SQL, not by
    # simulating a real database. An INSERT ... RETURNING answers with a
    # fresh id so the race-safe ``_ensure_prompt`` path completes.
    async def fetchrow(self, sql: str, *args) -> dict | None:
        self.calls.append((sql, args))
        if "RETURNING id" in sql:
            return {"id": "22222222-2222-2222-2222-222222222222"}
        return dict(self.rows[0]) if self.rows else None

    async def fetch(self, sql: str, *args) -> list[dict]:
        self.calls.append((sql, args))
        return [dict(r) for r in self.rows]

    async def fetchval(self, sql: str, *args):
        self.calls.append((sql, args))
        return self.rows[0].get("max_version", 0) if self.rows else 0

    async def execute(self, sql: str, *args) -> None:
        self.calls.append((sql, args))
        self.executed.append(sql)

    def transaction(self):
        return _NoopTxn(self)


class _NoopTxn:
    def __init__(self, pg: _CapturingPg) -> None:
        self._pg = pg

    async def __aenter__(self) -> _NoopTxn:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


@pytest.fixture
def pg(monkeypatch) -> _CapturingPg:
    fake = _CapturingPg()

    async def _get():
        return fake

    monkeypatch.setattr(
        "eden.kb.prompt_versions.client.get_postgres_client",
        _get,
    )
    return fake


def _v2_version_row(**over: Any) -> dict:
    params = over.pop("params", {})
    return {
        # ``id`` doubles as the prompts.id the shim resolves for reads.
        "id": "11111111-1111-1111-1111-111111111111",
        "version": 2,
        "template": "You are the Planner.",
        "params": json.dumps(params),
        "created_at": "2026-08-11T00:00:00+00:00",
        "name": "planner",
        "org_id": SYSTEM_ORG_ID,
        **over,
    }


async def test_insert_version_targets_v2_columns(pg: _CapturingPg) -> None:
    """insert_version must write ``prompts`` + ``prompt_versions`` v2 cols."""
    client = PromptVersionsClient()
    ok = await client.insert_version(
        agent="planner",
        system_prompt="You are the Planner.",
        version=3,
        quality_metrics={"ab_test_active": True},
        active=False,
    )
    assert ok is True
    # The v2 ``prompt_versions`` insert must reference template/hash/params
    # (the columns that actually exist post-055), never the dropped
    # ``system_prompt`` / ``quality_metrics`` legacy columns.
    inserts = [sql for sql in pg.executed if "INSERT INTO prompt_versions" in sql]
    assert len(inserts) == 1
    assert "template" in inserts[0]
    assert "template_hash" in inserts[0]
    assert "params::jsonb" in inserts[0] or "params" in inserts[0]
    assert "system_prompt" not in inserts[0]
    assert "quality_metrics" not in inserts[0]
    assert "ON CONFLICT (prompt_id, version)" in inserts[0]
    # System-org sentinel is bound as the org_id arg — keeps global
    # agent prompts out of tenant lists.
    assert any(
        SYSTEM_ORG_ID in (args or ()) for _, args in pg.calls
    )


async def test_insert_version_ensures_prompts_row(pg: _CapturingPg) -> None:
    """The shim upserts the agent-named ``prompts`` row (org-scoped)."""
    client = PromptVersionsClient()
    await client.insert_version(
        agent="critic",
        system_prompt="You are the Critic.",
        version=1,
        active=True,
    )
    # _ensure_prompt runs the SELECT first; when no row is returned it
    # INSERTs into ``prompts`` with (org_id, name) conflict target and
    # RETURNING id (race-safe — no phantom UUID on concurrent insert).
    # The RETURNING insert goes through fetchrow, so inspect ``calls``.
    prompt_sql = [
        sql for sql, _ in pg.calls if sql.strip().startswith("INSERT INTO prompts")
    ]
    assert len(prompt_sql) == 1
    assert "org_id" in prompt_sql[0]
    assert "name" in prompt_sql[0]
    assert "ON CONFLICT (org_id, name)" in prompt_sql[0]
    assert "RETURNING id" in prompt_sql[0]
    # And the version insert references the resolved prompt id.
    assert any("prompt_id" in sql for sql in pg.executed)


async def test_get_active_prompt_reads_v2_and_preserves_legacy_shape(
    pg: _CapturingPg,
) -> None:
    """get_active_prompt joins via prompt_id and returns the legacy dict."""
    pg.rows = [
        _v2_version_row(
            params={
                "legacy": True,
                "active": True,
                "few_shot_examples": [{"x": 1}],
                "quality_metrics": {"ab_test_round": 2},
                "promoted_at": "2026-08-10T00:00:00+00:00",
            }
        )
    ]
    client = PromptVersionsClient()
    prompt = await client.get_active_prompt("planner")
    assert prompt is not None
    # Legacy row shape preserved for PromptLoader / judge evolver.
    assert prompt["system_prompt"] == "You are the Planner."
    assert prompt["version"] == 2
    assert prompt["active"] is True
    assert prompt["quality_metrics"] == {"ab_test_round": 2}
    assert prompt["few_shot_examples"] == [{"x": 1}]
    assert prompt["promoted_at"] == "2026-08-10T00:00:00+00:00"
    assert prompt["agent"] == "planner"
    # The active lookup (2nd call — first is the prompt-id resolve)
    # must filter on the v2 params jsonb flag, not a legacy ``active``
    # column.
    active_sql = pg.calls[1][0]
    assert "params->>'active' = 'true'" in active_sql
    assert "active = TRUE" not in active_sql
    assert "system_prompt" not in active_sql


async def test_get_active_prompt_falls_back_to_latest_when_none_flagged(
    pg: _CapturingPg,
) -> None:
    """No version flagged active → latest wins (bootstrap seed case).

    The legacy client returned ``None`` when nothing was ``active=TRUE``;
    the shim falls back to the latest version so a single un-flagged
    seed row is still resolvable as the control prompt (the judge
    evolver's bootstrap path depends on ``get_active_prompt`` returning
    something after the first seed).
    """
    pg.rows = [
        _v2_version_row(params={"active": False, "quality_metrics": {}})
    ]
    client = PromptVersionsClient()
    prompt = await client.get_active_prompt("planner")
    assert prompt is not None
    assert prompt["version"] == 2
    # First SQL call = prompt-id resolve; second = active lookup; the
    # fallback path re-queries latest when the active lookup is empty.
    # With the fake always returning the same row, the fallback returns
    # the row too — pin that the method *does* fall back rather than
    # returning None.
    assert len(pg.calls) >= 2


async def test_get_latest_version_uses_prompt_id(pg: _CapturingPg) -> None:
    """get_latest_version aggregates over v2 prompt_id (agent via prompts)."""
    pg.rows = [{"id": "p-1", "max_version": 4}]
    client = PromptVersionsClient()
    assert await client.get_latest_version("planner") == 4
    # 2nd call — the first is the prompt-id resolve SELECT.
    sql = pg.calls[1][0]
    assert "MAX(version)" in sql
    assert "prompt_id" in sql
    assert "WHERE agent = $1" not in sql


async def test_activate_deactivate_flag_params_jsonb(pg: _CapturingPg) -> None:
    """activate/deactivate write the v2 params jsonb, not an active column."""
    pg.rows = [{"id": "p-1"}]
    client = PromptVersionsClient()
    await client.activate_prompt("planner", 2)
    assert any("jsonb_set(params, '{active}'" in sql for sql in pg.executed)
    assert any("prompt_id = $1" in sql for sql in pg.executed)
    assert not any("active = TRUE" in sql for sql in pg.executed)
    await client.deactivate_prompt("planner", 2)
    assert any("jsonb_set(params, '{active}', 'false'::jsonb)" in sql for sql in pg.executed)


async def test_update_quality_metrics_merges_into_params(pg: _CapturingPg) -> None:
    """Quality metrics merge into v2 ``params`` jsonb (no legacy column)."""
    pg.rows = [{"id": "p-1"}]
    client = PromptVersionsClient()
    ok = await client.update_quality_metrics(
        "planner", 2, {"canary_status": "active", "org_id": "org-1"}
    )
    assert ok is True
    assert any("params->'quality_metrics'" in sql for sql in pg.executed)
    assert not any("SET quality_metrics" in sql for sql in pg.executed)


async def test_ab_candidates_read_params_flag(pg: _CapturingPg) -> None:
    """get_candidates_for_ab_test filters on v2 params jsonb keys."""
    pg.rows = [{"id": "p-1"}]
    client = PromptVersionsClient()
    await client.get_candidates_for_ab_test("planner", limit=5)
    # 2nd call — the first is the prompt-id resolve SELECT.
    sql = pg.calls[1][0]
    assert "ab_test_active" in sql
    assert "params" in sql
    assert "quality_metrics" in sql
