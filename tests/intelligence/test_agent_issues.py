"""F28/F29 — stumble writer + issue promoter (Wave 1).

Uses an in-memory Postgres fake that understands exactly the queries the
issues layer runs, so the dedup / promotion / regression logic is
exercised for real (not mocked away).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.issues.models import StumbleCreate


class _FakePG:
    """Minimal asyncpg-like fake for agent_stumbles / agent_issues."""

    def __init__(self) -> None:
        self.stumbles: dict[tuple, dict[str, Any]] = {}
        self.issues: dict[tuple, dict[str, Any]] = {}

    # ── connection acquisition / txn (used by IssuePromoter) ────────
    def acquire(self) -> Any:
        pg = self

        class _Ctx:
            async def __aenter__(self) -> Any:
                return pg

            async def __aexit__(self, *a: Any) -> bool:
                return False

        return _Ctx()

    def transaction(self) -> Any:
        class _T:
            async def __aenter__(self) -> None:
                return None

            async def __aexit__(self, *a: Any) -> bool:
                return False

        return _T()

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        s = " ".join(sql.split())
        if "INSERT INTO agent_stumbles" in s:
            (sid, org, trace, session, user, agent, span, kind, fp,
             title, detail, sev, by) = args
            key = (org, trace, kind, fp)
            if key in self.stumbles:
                self.stumbles[key]["detail"] = detail
                return {"id": self.stumbles[key]["id"], "inserted": False}
            row = {
                "id": sid, "org_id": org, "trace_id": trace,
                "session_id": session, "user_id": user, "agent_id": agent,
                "span_id": span, "kind": kind, "fingerprint": fp,
                "title": title, "detail": detail, "severity": sev,
                "detected_by": by, "detected_at": datetime.now(UTC),
            }
            self.stumbles[key] = row
            return {"id": sid, "inserted": True}
        if "FROM agent_issues" in s and "FOR UPDATE" in s:
            org, fp = args
            return self.issues.get((org, fp))
        if "FROM agent_issues" in s and "AND id =" in s:
            org, iid = args
            for r in self.issues.values():
                if r["id"] == str(iid) and r["org_id"] == org:
                    return r
            return None
        if "FROM agent_issues" in s and "fingerprint = $2" in s:
            org, fp = args
            return self.issues.get((org, fp))
        return None

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        s = " ".join(sql.split())
        if "FROM agent_issues" in s:
            org = args[0]
            return [r for r in self.issues.values() if r["org_id"] == org]
        if "FROM agent_stumbles" in s:
            org = args[0]
            return [r for r in self.stumbles.values() if r["org_id"] == org]
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        s = " ".join(sql.split())
        if "INSERT INTO agent_issues" in s:
            (iid, org, fp, kind, title, sev, agent, ucount, affected,
             stumble_id) = args
            now = datetime.now(UTC)
            self.issues[(org, fp)] = {
                "id": iid, "org_id": org, "fingerprint": fp, "kind": kind,
                "title": title, "status": "open", "severity": sev,
                "agent_id": agent, "stumble_count": 1, "user_count": ucount,
                "repetition_count": 1,
                "affected_user_ids": list(affected),
                "example_stumble_ids": [stumble_id],
                "triage_result": None, "first_seen": now, "last_seen": now,
            }
            return "INSERT 0 1"
        if "UPDATE agent_issues" in s and "stumble_count = stumble_count + 1" in s:
            (org, iid, status, rep, sev, ucount, affected, examples) = args
            for r in self.issues.values():
                if r["id"] == iid:
                    r["stumble_count"] += 1
                    r["status"] = status
                    r["repetition_count"] = rep
                    r["severity"] = sev
                    r["user_count"] = ucount
                    r["affected_user_ids"] = list(affected)
                    r["example_stumble_ids"] = list(examples)
                    return "UPDATE 1"
            return "UPDATE 0"
        if "UPDATE agent_issues" in s and "SET status = $3" in s:
            org, iid, status = args
            for r in self.issues.values():
                if r["id"] == iid and r["org_id"] == org:
                    r["status"] = status
                    return "UPDATE 1"
            return "UPDATE 0"
        if "SET triage_result" in s:
            org, iid, tr = args
            for r in self.issues.values():
                if r["id"] == iid and r["org_id"] == org:
                    r["triage_result"] = tr
                    return "UPDATE 1"
            return "UPDATE 0"
        return "OK"


def _sc(trace_id: str, *, user_id: str = "u1", tool: str = "search") -> StumbleCreate:
    return StumbleCreate(
        org_id="org_test",
        trace_id=trace_id,
        kind="tool_error",
        title="search tool timed out",
        detail={"tool_name": tool, "error": "Timeout after 30s"},
        detected_by="auto_scanner",
        agent_id="agent-a",
        user_id=user_id,
    )


@pytest.mark.asyncio
async def test_create_persists_and_promotes() -> None:
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a1")
        res = await StumbleWriter().create(_sc("trace-1"))

    assert res["stumble_id"] is not None
    assert res["inserted"] is True
    issue = res["issue"]
    assert issue is not None
    assert issue.was_created is True
    assert issue.stumble_count == 1
    # on_issue_created fired for a brand-new issue.
    hook.on_issue_created.assert_awaited_once()


@pytest.mark.asyncio
async def test_second_matching_stumble_increments_not_duplicates() -> None:
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a1")
        writer = StumbleWriter()
        await writer.create(_sc("trace-1", user_id="u1"))
        r2 = await writer.create(_sc("trace-2", user_id="u2"))

    # One issue only.
    assert len(pg.issues) == 1
    assert r2["issue"].stumble_count == 2
    assert r2["issue"].was_created is False
    assert r2["issue"].user_count == 2  # two distinct users
    # Hook fired only for the first (create), not the plain increment.
    assert hook.on_issue_created.await_count == 1


@pytest.mark.asyncio
async def test_same_trace_is_deduped_at_stumble_level() -> None:
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
        writer = StumbleWriter()
        await writer.create(_sc("trace-1"))
        r2 = await writer.create(_sc("trace-1"))  # identical trace

    assert r2["inserted"] is False  # deduped
    assert len(pg.stumbles) == 1


@pytest.mark.asyncio
async def test_resolve_then_new_stumble_regresses() -> None:
    from eden.issues.repo import IssuesRepo
    from eden.issues.stumble_writer import StumbleWriter

    pg = _FakePG()
    with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
        "eden.llmops.promotion_hooks.get_issue_hook"
    ) as hook_factory:
        hook = hook_factory.return_value
        hook.on_issue_created = AsyncMock(return_value="a")
        writer = StumbleWriter()
        r1 = await writer.create(_sc("trace-1"))
        issue_id = r1["issue"].id
        # Resolve it.
        await IssuesRepo().set_status("org_test", issue_id, "resolved")
        # New matching stumble → regression.
        r3 = await writer.create(_sc("trace-9"))

    assert r3["issue"].status == "regressed"
    assert r3["issue"].was_regressed is True
    assert r3["issue"].repetition_count == 2
    # Hook fired for the initial create AND the regression.
    assert hook.on_issue_created.await_count == 2


# ── Route smoke tests ───────────────────────────────────────────────


def _client(pg: _FakePG) -> TestClient:
    from eden.api.deps import get_current_user

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "u1",
        "org_id": "org_test",
    }
    import eden.api.routes.agent_issues as mod

    async def _flag_on() -> None:
        return None

    for r in mod.router.routes:
        if not hasattr(r, "dependant"):
            continue
        for d in r.dependant.dependencies:
            if d.call.__name__ == "_dependency":
                app.dependency_overrides[d.call] = _flag_on
    app.include_router(mod.router)
    return TestClient(app)


def test_list_and_get_issue_routes() -> None:
    pg = _FakePG()

    async def _seed() -> str:
        from eden.issues.stumble_writer import StumbleWriter

        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_issue_hook"
        ) as hook_factory:
            hook_factory.return_value.on_issue_created = AsyncMock(return_value="a")
            res = await StumbleWriter().create(_sc("trace-1"))
        return res["issue"].id

    import asyncio

    issue_id = asyncio.run(_seed())

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
        client = _client(pg)
        r = client.get("/orgs/org_test/agent-issues")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["data"]["count"] == 1

        r2 = client.get(f"/orgs/org_test/agent-issues/{issue_id}")
        assert r2.status_code == 200
        assert r2.json()["data"]["issue"]["id"] == issue_id

        r3 = client.post(
            f"/orgs/org_test/agent-issues/{issue_id}/resolve",
            json={"status": "resolved"},
        )
        assert r3.status_code == 200
        assert r3.json()["data"]["status"] == "resolved"
