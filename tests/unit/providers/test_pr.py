"""Unit tests for :class:`eden.providers.pr`.

The :class:`LocalPRProvider` runs against a real temp git
repo (skip when git isn't available). The
:class:`GitHubPRProvider` placeholder raises
:class:`NotImplementedError` for every method.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.fixture
def temp_git_repo():
    """Create a temp git repo with 1 commit."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(["git", "init", "-q"], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@eden.local"],
            cwd=tmpdir, check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Eden Test"],
            cwd=tmpdir, check=True,
        )
        (Path(tmpdir) / "foo.py").write_text("x = 1\n")
        subprocess.run(["git", "add", "foo.py"], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "add foo"],
            cwd=tmpdir, check=True,
        )
        yield tmpdir


@pytest.fixture
def provider(temp_git_repo):
    from eden.providers.pr import LocalPRProvider
    return LocalPRProvider(repo_path=temp_git_repo)


import tempfile  # noqa: E402  (placed after fixtures intentionally)


class TestLocalPRProvider:
    @pytest.mark.asyncio
    async def test_create_pr_records_to_disk(self, provider, temp_git_repo):
        from eden.providers.pr import PRCreateRequest
        from eden.providers.repo import FileEntry
        pr = await provider.create_pr(PRCreateRequest(
            title="[Eden Agent] Test PR",
            body="Test body",
            branch="eden/test-pr",
            base="main",
            files=[FileEntry(
                path="bar.py", size=11, content="y = 2\n",
            )],
        ))
        # PR metadata
        assert pr.number == 1
        assert pr.title == "[Eden Agent] Test PR"
        assert pr.branch == "eden/test-pr"
        assert pr.state == "open"
        # PR record was written to .eden/prs/1.json
        record_path = os.path.join(
            temp_git_repo, ".eden", "prs", "1.json",
        )
        assert os.path.isfile(record_path)
        with open(record_path, encoding="utf-8") as fh:
            data = json.load(fh)
        assert data["title"] == "[Eden Agent] Test PR"
        assert data["branch"] == "eden/test-pr"

    @pytest.mark.asyncio
    async def test_pr_counter_increments(self, provider):
        from eden.providers.pr import PRCreateRequest
        from eden.providers.repo import FileEntry
        a = await provider.create_pr(PRCreateRequest(
            title="A", body="", branch="eden/a", base="main",
            files=[FileEntry(path="a.py", size=1, content="a")],
        ))
        b = await provider.create_pr(PRCreateRequest(
            title="B", body="", branch="eden/b", base="main",
            files=[FileEntry(path="b.py", size=1, content="b")],
        ))
        assert a.number == 1
        assert b.number == 2

    @pytest.mark.asyncio
    async def test_commit_files_creates_branch(self, provider):
        from eden.providers.repo import FileEntry
        commit = await provider.commit_files(
            branch="eden/test-branch",
            files=[FileEntry(path="c.py", size=1, content="c")],
            message="add c",
        )
        assert commit.sha  # A real SHA was produced.
        assert commit.message == "add c"

    @pytest.mark.asyncio
    async def test_create_branch_then_checkout(self, provider):
        # Idempotent: a no-op when the branch doesn't exist
        # yet creates it; a no-op when it already exists is
        # a benign git error that the provider swallows.
        await provider.create_branch("eden/branch-a")
        # Calling again doesn't raise.
        await provider.create_branch("eden/branch-a")

    @pytest.mark.asyncio
    async def test_revert_close_pr_strategy(self, provider):
        # First create a PR.
        from eden.providers.pr import PRCreateRequest, PRRevertRequest
        from eden.providers.repo import FileEntry
        original = await provider.create_pr(PRCreateRequest(
            title="Original", body="body",
            branch="eden/orig", base="main",
            files=[FileEntry(path="o.py", size=1, content="o")],
        ))
        # Revert with close_pr strategy.
        result = await provider.revert(PRRevertRequest(
            pr_number=original.number,
            strategy="close_pr",
        ))
        assert result.state == "closed"

    @pytest.mark.asyncio
    async def test_revert_revert_pr_strategy(self, provider):
        from eden.providers.pr import (
            PRCreateRequest,
            PRRevertRequest,
        )
        from eden.providers.repo import FileEntry
        original = await provider.create_pr(PRCreateRequest(
            title="To revert", body="body",
            branch="eden/rev", base="main",
            files=[FileEntry(path="r.py", size=1, content="r")],
        ))
        result = await provider.revert(PRRevertRequest(
            pr_number=original.number,
            strategy="revert_pr",
            merge_sha="deadbeef",
        ))
        # The revert PR is a new PR.
        assert result.number == original.number + 1
        assert "Revert" in result.title

    @pytest.mark.asyncio
    async def test_revert_missing_pr(self, provider):
        from eden.providers.pr import PRRevertRequest
        result = await provider.revert(PRRevertRequest(
            pr_number=999, strategy="close_pr",
        ))
        assert result.state == "missing"

    @pytest.mark.asyncio
    async def test_comment_appends_to_record(self, provider):
        from eden.providers.pr import PRCreateRequest
        from eden.providers.repo import FileEntry
        pr = await provider.create_pr(PRCreateRequest(
            title="C", body="", branch="eden/c", base="main",
            files=[FileEntry(path="c.py", size=1, content="c")],
        ))
        await provider.comment(pr.number, "first comment")
        # Read the record and assert the comment is there.
        record_path = os.path.join(
            provider.repo_path, ".eden", "prs",
            f"{pr.number}.json",
        )
        with open(record_path, encoding="utf-8") as fh:
            data = json.load(fh)
        assert len(data["comments"]) == 1
        assert data["comments"][0]["body"] == "first comment"

    def test_provider_name(self, provider):
        assert provider.name == "local"


class TestGitHubPRProvider:
    """The GitHub PR provider hits real REST endpoints; we don't make
    network calls in unit tests, so these tests assert constructor
    behavior + the surface contract."""

    def test_provider_name(self):
        from eden.providers.pr import GitHubPRProvider
        provider = GitHubPRProvider(token="ghs_test", repo="acme/foo")
        assert provider.name == "github"

    def test_requires_token(self):
        from eden.providers.pr import GitHubPRProvider
        with pytest.raises(ValueError, match="token"):
            GitHubPRProvider(token="", repo="acme/foo")

    def test_requires_repo(self):
        from eden.providers.pr import GitHubPRProvider
        with pytest.raises(ValueError, match="repo"):
            GitHubPRProvider(token="ghs_test", repo="invalid")

    def test_surface(self):
        """Verifies the contract methods exist; wire-format coverage
        lives in the integration suite."""
        from eden.providers.pr import GitHubPRProvider
        provider = GitHubPRProvider(token="ghs_test", repo="acme/foo")
        assert hasattr(provider, "create_branch")
        assert hasattr(provider, "commit_files")
        assert hasattr(provider, "create_pr")
        assert hasattr(provider, "revert")
        assert hasattr(provider, "comment")


class TestGetDefaultPRProvider:
    def test_default_is_local(self, monkeypatch):
        monkeypatch.delenv("EDEN_PR_PROVIDER", raising=False)
        from eden.providers.pr import (
            LocalPRProvider,
            get_default_pr_provider,
        )
        assert isinstance(get_default_pr_provider(), LocalPRProvider)

    def test_github_when_env_set(self, monkeypatch):
        """Returns GitHubPRProvider when env vars are populated."""
        monkeypatch.setenv("EDEN_PR_PROVIDER", "github")
        monkeypatch.setenv("EDEN_GITHUB_TOKEN", "ghs_test")
        monkeypatch.setenv("EDEN_GITHUB_REPO", "acme/foo")
        from eden.providers.pr import (
            GitHubPRProvider,
            get_default_pr_provider,
        )
        assert isinstance(get_default_pr_provider(), GitHubPRProvider)

    def test_github_falls_back_to_local_without_creds(self, monkeypatch):
        """Falls back to Local when env=github but creds missing."""
        monkeypatch.setenv("EDEN_PR_PROVIDER", "github")
        monkeypatch.delenv("EDEN_GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("EDEN_GITHUB_REPO", raising=False)
        from eden.providers.pr import (
            LocalPRProvider,
            get_default_pr_provider,
        )
        assert isinstance(get_default_pr_provider(), LocalPRProvider)
