"""Tests for the Gate 4a PRCreator CODEOWNERS wiring.

Covers:

* ``resolve_codeowners_reviewers`` — reads CODEOWNERS via
  RepoConnector + returns the flat deduped owner list
* ``attach_codeowners_reviewers`` — merges CODEOWNERS
  into the request's reviewers (preserving order +
  de-duplicating)
* End-to-end: when ``req.files`` is populated, the
  provider receives the augmented reviewers list
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.code_change.pr_creator import PRCreator
from eden.providers.pr import PRCreateRequest
from eden.providers.repo import FileEntry, PullRequestInfo

# ── attach_codeowners_reviewers (pure function) ────────────────


def test_attach_no_codeowners_returns_unchanged() -> None:
    """With no CODEOWNERS, the request is returned unchanged."""
    req = PRCreateRequest(
        title="t", body="b", branch="br", base="main",
        reviewers=["@alice"],
    )
    creator = PRCreator()
    new_req = creator.attach_codeowners_reviewers(req, [])
    assert new_req.reviewers == ["@alice"]


def test_attach_merges_codeowners_after_existing() -> None:
    """CODEOWNERS are appended after the existing reviewers."""
    req = PRCreateRequest(
        title="t", body="b", branch="br", base="main",
        reviewers=["@alice"],
    )
    creator = PRCreator()
    new_req = creator.attach_codeowners_reviewers(
        req, ["@bob", "@carol"],
    )
    assert new_req.reviewers == ["@alice", "@bob", "@carol"]


def test_attach_dedupes_overlap() -> None:
    """An owner already in reviewers is not duplicated."""
    req = PRCreateRequest(
        title="t", body="b", branch="br", base="main",
        reviewers=["@alice", "@bob"],
    )
    creator = PRCreator()
    new_req = creator.attach_codeowners_reviewers(
        req, ["@bob", "@carol", "@alice"],
    )
    assert new_req.reviewers == ["@alice", "@bob", "@carol"]


def test_attach_empty_reviewers_receives_only_codeowners() -> None:
    """When the request has no reviewers, the result is just CODEOWNERS."""
    req = PRCreateRequest(
        title="t", body="b", branch="br", base="main",
    )
    creator = PRCreator()
    new_req = creator.attach_codeowners_reviewers(
        req, ["@bob"],
    )
    assert new_req.reviewers == ["@bob"]


def test_attach_preserves_other_fields() -> None:
    """Other fields (title, body, files, etc.) are unchanged."""
    req = PRCreateRequest(
        title="original", body="original body", branch="br",
        base="main", labels=["bug"], draft=True,
        files=[FileEntry(path="src/x.py", size=0, content="x")],
        commit_message="cm",
        reviewers=["@alice"],
    )
    creator = PRCreator()
    new_req = creator.attach_codeowners_reviewers(req, ["@bob"])
    assert new_req.title == "original"
    assert new_req.body == "original body"
    assert new_req.labels == ["bug"]
    assert new_req.draft is True
    assert new_req.files == req.files
    assert new_req.commit_message == "cm"


# ── resolve_codeowners_reviewers (with mocked connector) ──────


@pytest.mark.asyncio
async def test_resolve_codeowners_flattens_and_dedupes() -> None:
    """The resolver reads CODEOWNERS via the connector + flattens."""
    creator = PRCreator()
    fake_resp = {
        "status": "ok",
        "data": {
            "owners": {
                "src/foo.py": ["@alice", "@bob"],
                "src/bar.py": ["@bob", "@carol"],
            },
        },
    }
    with patch(
        "eden.code_change.repo_connector.RepoConnector",
    ) as MockConnector:
        connector = MockConnector.return_value
        connector.owners_for_files = AsyncMock(return_value=fake_resp)
        result = await creator.resolve_codeowners_reviewers(
            "test-org",
            ["src/foo.py", "src/bar.py"],
        )
    assert set(result) == {"@alice", "@bob", "@carol"}
    # Bob appears once despite being on both files.
    assert result.count("@bob") == 1
    connector.owners_for_files.assert_awaited_once_with(
        "test-org", ["src/foo.py", "src/bar.py"],
    )


@pytest.mark.asyncio
async def test_resolve_codeowners_returns_empty_on_connector_failure() -> None:
    """A connector failure is caught + returns empty list."""
    creator = PRCreator()
    with patch(
        "eden.code_change.repo_connector.RepoConnector",
    ) as MockConnector:
        connector = MockConnector.return_value
        connector.owners_for_files = AsyncMock(
            side_effect=RuntimeError("connector down"),
        )
        result = await creator.resolve_codeowners_reviewers(
            "test-org", ["src/foo.py"],
        )
    assert result == []


@pytest.mark.asyncio
async def test_resolve_codeowners_returns_empty_for_empty_input() -> None:
    """Empty file_paths → empty result."""
    creator = PRCreator()
    result = await creator.resolve_codeowners_reviewers("test-org", [])
    assert result == []


# ── End-to-end (req with files → provider receives augmented) ──


@pytest.mark.asyncio
async def test_create_with_files_attaches_codeowners() -> None:
    """When ``req.files`` is populated, the provider receives
    the augmented reviewers list (CODEOWNERS merged in)."""
    import datetime as _dt
    fake_info = PullRequestInfo(
        number=1, title="t", body="b", branch="br", base="main",
        url="file://./prs/1.json", state="open",
        created_at=_dt.datetime.now(_dt.UTC),
    )

    captured: dict = {}

    async def capture(req: PRCreateRequest) -> PullRequestInfo:
        captured["req"] = req
        return fake_info

    creator = PRCreator(provider=_StubProvider(capture))
    with patch(
        "eden.code_change.repo_connector.RepoConnector",
    ) as MockConnector:
        connector = MockConnector.return_value
        connector.owners_for_files = AsyncMock(return_value={
            "status": "ok",
            "data": {"owners": {"src/foo.py": ["@alice"]}},
        })
        result = await creator.create(
            org_id="test-org",
            patch_id="patch_1",
            policy={"code_change_enabled": True, "auto_pr_enabled": True},
            req=PRCreateRequest(
                title="[Eden Agent] Fix",
                body="body",
                branch="eden/auto-fix",
                base="main",
                files=[FileEntry(path="src/foo.py", size=0, content="x")],
                reviewers=["@bob"],
            ),
        )

    assert result["status"] == "ok"
    assert captured["req"].reviewers == ["@bob", "@alice"]


@pytest.mark.asyncio
async def test_create_without_files_does_not_attach() -> None:
    """When ``req.files`` is empty, no CODEOWNERS lookup happens."""
    import datetime as _dt
    fake_info = PullRequestInfo(
        number=1, title="t", body="b", branch="br", base="main",
        url="file://./prs/1.json", state="open",
        created_at=_dt.datetime.now(_dt.UTC),
    )

    captured: dict = {}

    async def capture(req: PRCreateRequest) -> PullRequestInfo:
        captured["req"] = req
        return fake_info

    creator = PRCreator(provider=_StubProvider(capture))
    with patch(
        "eden.code_change.repo_connector.RepoConnector",
    ) as MockConnector:
        connector = MockConnector.return_value
        connector.owners_for_files = AsyncMock(return_value={
            "status": "ok",
            "data": {"owners": {"src/foo.py": ["@alice"]}},
        })
        result = await creator.create(
            org_id="test-org",
            patch_id="patch_1",
            policy={},
            req=PRCreateRequest(
                title="t", body="b", branch="br", base="main",
                # no files
                reviewers=["@bob"],
            ),
        )

    assert result["status"] == "ok"
    # CODEOWNERS lookup was NOT called.
    connector.owners_for_files.assert_not_called()
    assert captured["req"].reviewers == ["@bob"]


# ── Helpers ────────────────────────────────────────────────────


class _StubProvider:
    """Minimal PRProvider stub that records the request."""

    name = "stub"

    def __init__(self, capture_callable):
        self._capture = capture_callable

    async def create_pr(self, req):
        return await self._capture(req)

    async def create_branch(self, branch, from_sha=None):
        pass

    async def commit_files(self, branch, files, message):
        from datetime import UTC, datetime

        from eden.providers.repo import CommitInfo
        return CommitInfo(
            sha="abc", message=message, author="",
            timestamp=datetime.now(UTC),
        )

    async def revert(self, req):
        return PullRequestInfo(
            number=0, title="", body="", branch="", base="",
            url="", state="failed", created_at=datetime.now(UTC),
        )

    async def comment(self, pr_number, body):
        pass
