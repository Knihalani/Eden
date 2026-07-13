"""Unit tests for F22 issue fix chat."""

from __future__ import annotations

import pytest

from eden.code_change.issue_fix_chat import IssueFixChatService


class _FakeIssue:
    def __init__(self) -> None:
        self.id = "iss-1"
        self.title = "bash loop"
        self.kind = "loop"
        self.fingerprint = "fp-abc"
        self.agent_id = "checkout"
        self.triage_result = {
            "summary": "bash invoked too many times",
            "candidate_files": ["prompts/checkout.yaml"],
        }
        self.example_stumble_ids = []


class _FakeRepo:
    async def get_issue(self, org_id: str, issue_id: str):
        return _FakeIssue()

    async def list_stumbles(self, *args, **kwargs):
        return []


@pytest.mark.asyncio
async def test_stream_chat_proposes_patch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "eden.issues.repo.IssuesRepo",
        lambda: _FakeRepo(),
    )
    svc = IssueFixChatService()
    events = []
    async for ev in svc.stream_chat(
        "org-1",
        "iss-1",
        message="fix the loop",
        repo_full_name="acme/checkout",
    ):
        events.append(ev)
    kinds = [e["event"] for e in events]
    assert "patch_proposed" in kinds
    assert "done" in kinds
    session = await svc.get_session("org-1", "iss-1")
    assert session is not None
    assert session.proposed_patch is not None
    assert "checkout.yaml" in session.proposed_patch


@pytest.mark.asyncio
async def test_apply_requires_patch() -> None:
    svc = IssueFixChatService()
    result = await svc.apply_patch("org-1", "missing", confirm=True)
    assert result["ok"] is False
