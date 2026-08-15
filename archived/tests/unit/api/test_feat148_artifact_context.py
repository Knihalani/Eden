"""FEAT-148 — team-uploaded artifact context routes + synthesizer fold-in."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import learn as learn_routes
from eden.kb.artifact_context import format_book_section, format_ledger_appendix
from eden.kb.book.generator import BookGenerator
from eden.kb.ledger.generator import LedgerGenerator


def _app() -> FastAPI:
    app = FastAPI()

    async def _fake_user() -> dict:
        return {"user_id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(learn_routes.router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


class _FakePg:
    def __init__(self) -> None:
        self.inserted: list[tuple] = []
        self.fetch_rows: list[dict] = []

    async def execute(self, query: str, *args):
        self.inserted.append((query, args))
        return "OK"

    async def fetch(self, query: str, *args):
        return self.fetch_rows

    async def fetchrow(self, query: str, *args):
        if "MAX(version)" in query:
            return {"next_version": 1, "v": 1}
        if self.fetch_rows:
            return self.fetch_rows[0]
        return None


# ── Route tests ─────────────────────────────────────────────────────


def test_upload_context_persists_and_envelopes(client: TestClient) -> None:
    fake = _FakePg()
    with (
        patch.object(learn_routes, "artifacts_enabled", new=AsyncMock(return_value=True)),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake),
        ),
    ):
        resp = client.post(
            "/orgs/org_1/agents/agent-a/artifacts/context",
            files={"file": ("policy.md", b"# Refund policy\nAlways verify ID.", "text/markdown")},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["feature"] == "artifact_context"
    assert body["data"]["filename"] == "policy.md"
    assert body["data"]["content_type"] == "text/markdown"
    assert body["data"]["agent_id"] == "agent-a"
    assert len(fake.inserted) == 1
    args = fake.inserted[0][1]
    assert args[2] == "agent-a"
    assert args[3] == "policy.md"
    assert "Refund policy" in args[5]


def test_upload_rejects_non_text_extension(client: TestClient) -> None:
    with patch.object(learn_routes, "artifacts_enabled", new=AsyncMock(return_value=True)):
        resp = client.post(
            "/orgs/org_1/agents/agent-a/artifacts/context",
            files={"file": ("notes.pdf", b"%PDF-1.4", "application/pdf")},
        )
    assert resp.status_code == 400
    assert "txt" in resp.json()["detail"].lower() or ".md" in resp.json()["detail"]


def test_list_context_returns_items(client: TestClient) -> None:
    fake = _FakePg()
    fake.fetch_rows = [
        {
            "id": uuid4(),
            "org_id": "org_1",
            "agent_id": "agent-a",
            "filename": "policy.md",
            "content_type": "text/markdown",
            "content": "Always verify ID before refund.",
            "created_by": "user_1",
            "created_at": datetime(2026, 8, 6, tzinfo=UTC),
        }
    ]
    with (
        patch.object(learn_routes, "artifacts_enabled", new=AsyncMock(return_value=True)),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake),
        ),
    ):
        resp = client.get("/orgs/org_1/agents/agent-a/artifacts/context")
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["filename"] == "policy.md"
    assert "verify ID" in items[0]["content_preview"]


# ── Synthesizer fold-in ─────────────────────────────────────────────


def test_format_book_section_includes_filenames() -> None:
    section = format_book_section(
        [{"filename": "policy.md", "content": "Refunds need manager approval."}]
    )
    assert "## Team context" in section
    assert "policy.md" in section
    assert "Refunds need manager approval" in section


def test_format_ledger_appendix_adds_context_citations() -> None:
    cid = str(uuid4())
    text, cites = format_ledger_appendix(
        [{"id": cid, "filename": "policy.md", "content": "Verify ID."}]
    )
    assert "Team context" in text
    assert f"context:{cid}" in cites


@pytest.mark.asyncio
async def test_book_synthesize_reads_context(monkeypatch: pytest.MonkeyPatch) -> None:
    issues = [{"title": "timeout", "kind": "latency", "stumble_count": 3}]
    nudges: list = []
    ctx = [{"id": uuid4(), "filename": "team.md", "content": "Only ship on Tuesdays."}]

    client = MagicMock()
    client.fetch = AsyncMock(side_effect=[issues, nudges])

    async def _list(_org: str, _agent: str, *, limit: int = 20):
        return ctx

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    )
    monkeypatch.setattr(
        "eden.kb.artifact_context.list_agent_context",
        _list,
    )

    md = await BookGenerator()._synthesize("org_1", "agent-a")
    assert "## Team context" in md
    assert "Only ship on Tuesdays" in md
    assert "team.md" in md


@pytest.mark.asyncio
async def test_ledger_upsert_from_issue_appends_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cid = str(uuid4())
    captured: dict = {}

    async def _fake_upsert(*args, **kwargs):
        captured.update(kwargs)
        captured["args"] = args
        return "entry-1"

    async def _list(_org: str, _agent: str, *, limit: int = 20):
        return [{"id": cid, "filename": "policy.md", "content": "Always verify ID."}]

    gen = LedgerGenerator()
    monkeypatch.setattr(gen, "get_or_create_ledger", AsyncMock(return_value="ledger-1"))
    monkeypatch.setattr(gen, "_upsert_entry", _fake_upsert)
    monkeypatch.setattr("eden.kb.artifact_context.list_agent_context", _list)

    eid = await gen.upsert_from_issue(
        "org_1",
        "agent-a",
        {"id": "issue-1", "kind": "policy", "title": "Bad refund", "triage_result": {}},
    )
    assert eid == "entry-1"
    assert "Always verify ID" in captured["text"]
    assert f"context:{cid}" in captured["citations"]


@pytest.mark.asyncio
async def test_ledger_upsert_dnr_appends_context(monkeypatch: pytest.MonkeyPatch) -> None:
    cid = str(uuid4())
    captured: dict = {}

    async def _fake_upsert(*args, **kwargs):
        captured.update(kwargs)
        return "entry-2"

    async def _list(_org: str, _agent: str, *, limit: int = 20):
        return [{"id": cid, "filename": "dnr.md", "content": "Do not retry failed charges."}]

    gen = LedgerGenerator()
    monkeypatch.setattr(gen, "get_or_create_ledger", AsyncMock(return_value="ledger-1"))
    monkeypatch.setattr(gen, "_upsert_entry", _fake_upsert)
    monkeypatch.setattr("eden.kb.artifact_context.list_agent_context", _list)

    eid = await gen.upsert_do_not_repeat(
        "org_1", "agent-a", text="Demoted: high stumble", source_ids=["nudge-1"]
    )
    assert eid == "entry-2"
    assert "Do not retry failed charges" in captured["text"]
    assert f"context:{cid}" in captured["citations"]
    assert "nudge-1" in captured["citations"]
