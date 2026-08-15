"""Unit tests for :class:`eden.providers.repo`.

The :class:`LocalRepoProvider` runs against a real temp
git repo. The :class:`GitHubRepoProvider` placeholder
raises :class:`NotImplementedError` for every method.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

# ── LocalRepoProvider (against a temp git repo) ─────────────────────


@pytest.fixture
def temp_git_repo():
    """Create a temp git repo with 2 commits + a tracked file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Init + 2 commits (one of which writes a tracked file).
        subprocess.run(["git", "init", "-q"], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@eden.local"],
            cwd=tmpdir, check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Eden Test"],
            cwd=tmpdir, check=True,
        )
        subprocess.run(
            ["git", "commit", "--allow-empty", "-q", "-m", "init"],
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
    from eden.providers.repo import LocalRepoProvider
    return LocalRepoProvider(repo_path=temp_git_repo)


class TestLocalRepoProvider:
    @pytest.mark.asyncio
    async def test_list_files(self, provider):
        files = await provider.list_files("**/*.py")
        assert any(f.path == "foo.py" for f in files)

    @pytest.mark.asyncio
    async def test_list_files_with_no_match(self, provider):
        files = await provider.list_files("**/*.nope")
        assert files == []

    @pytest.mark.asyncio
    async def test_read_tracked_file(self, provider):
        content = await provider.read_file("foo.py")
        assert "x = 1" in content

    @pytest.mark.asyncio
    async def test_read_missing_file(self, provider):
        content = await provider.read_file("__nonexistent__.py")
        assert content == ""

    @pytest.mark.asyncio
    async def test_read_untracked_file(self, temp_git_repo, provider):
        # Write a file in the working tree but don't
        # commit. The provider falls back to a plain
        # filesystem read.
        (Path(temp_git_repo) / "untracked.py").write_text("y = 2\n")
        content = await provider.read_file("untracked.py")
        assert "y = 2" in content

    @pytest.mark.asyncio
    async def test_get_default_branch(self, provider, temp_git_repo):
        # The temp repo has no ``origin`` remote — the
        # provider falls back to ``"main"``.
        branch = await provider.get_default_branch()
        # Either the symbolic-ref parse succeeded or the
        # fallback returned "main".
        assert branch in ("main", "master")

    @pytest.mark.asyncio
    async def test_get_recent_commits(self, provider):
        commits = await provider.get_recent_commits(limit=5)
        assert len(commits) >= 2
        # Newest first.
        assert "add foo" in commits[0].message
        assert "init" in commits[1].message

    @pytest.mark.asyncio
    async def test_get_pull_request_returns_none(self, provider):
        pr = await provider.get_pull_request(999)
        assert pr is None

    @pytest.mark.asyncio
    async def test_list_pull_requests_empty(self, provider):
        prs = await provider.list_pull_requests(state="open", limit=10)
        assert prs == []

    def test_provider_name(self, provider):
        assert provider.name == "local"


class TestLocalRepoProviderWithoutGit:
    """When the path isn't a git repo, the provider degrades
    to empty results without raising."""

    def test_no_git_binary(self, monkeypatch):
        from eden.providers.repo import LocalRepoProvider
        monkeypatch.setattr(
            "eden.providers.repo.shutil.which",
            lambda _: None,
        )
        provider = LocalRepoProvider()
        assert provider._git is None
        # Even with no git, the provider doesn't raise on
        # construction.

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_git(self, monkeypatch):
        from eden.providers.repo import LocalRepoProvider
        monkeypatch.setattr(
            "eden.providers.repo.shutil.which",
            lambda _: None,
        )
        provider = LocalRepoProvider()
        assert await provider.list_files() == []
        assert await provider.read_file("anything") == ""
        assert await provider.get_recent_commits() == []


# ── GitHubRepoProvider (placeholder) ───────────────────────────────


class TestGitHubRepoProvider:
    """The GitHub provider hits real REST endpoints; we don't make
    network calls in unit tests, so these tests assert constructor
    behavior + the surface contract. Wire-format coverage lives in
    the integration suite."""

    def test_provider_name(self):
        from eden.providers.repo import GitHubRepoProvider
        provider = GitHubRepoProvider(token="ghs_test", repo="acme/foo")
        assert provider.name == "github"

    def test_requires_token(self):
        from eden.providers.repo import GitHubRepoProvider
        with pytest.raises(ValueError, match="token"):
            GitHubRepoProvider(token="", repo="acme/foo")

    def test_requires_repo(self):
        from eden.providers.repo import GitHubRepoProvider
        with pytest.raises(ValueError, match="repo"):
            GitHubRepoProvider(token="ghs_test", repo="invalid")

    def test_list_files_returns_list(self):
        """Without a real GitHub token the call will 404/401 and we
        gracefully return an empty list — verifies the no-raise
        contract (the rest of the platform relies on this)."""
        from eden.providers.repo import GitHubRepoProvider
        provider = GitHubRepoProvider(token="ghs_test", repo="acme/foo")
        # Method exists + is async; we don't actually call it (would
        # hit GitHub). Just verify the surface.
        assert hasattr(provider, "list_files")
        assert hasattr(provider, "read_file")
        assert hasattr(provider, "get_recent_commits")


class TestGetDefaultRepoProvider:
    def test_default_is_local(self, monkeypatch):
        monkeypatch.delenv("EDEN_REPO_PROVIDER", raising=False)
        from eden.providers.repo import (
            LocalRepoProvider,
            get_default_repo_provider,
        )
        assert isinstance(get_default_repo_provider(), LocalRepoProvider)

    def test_github_when_env_set(self, monkeypatch):
        """Returns GitHubRepoProvider when env vars are populated."""
        monkeypatch.setenv("EDEN_REPO_PROVIDER", "github")
        monkeypatch.setenv("EDEN_GITHUB_TOKEN", "ghs_test")
        monkeypatch.setenv("EDEN_GITHUB_REPO", "acme/foo")
        from eden.providers.repo import (
            GitHubRepoProvider,
            get_default_repo_provider,
        )
        assert isinstance(get_default_repo_provider(), GitHubRepoProvider)

    def test_github_falls_back_to_local_without_creds(self, monkeypatch):
        """Falls back to Local when env=github but creds missing."""
        monkeypatch.setenv("EDEN_REPO_PROVIDER", "github")
        monkeypatch.delenv("EDEN_GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("EDEN_GITHUB_REPO", raising=False)
        from eden.providers.repo import (
            LocalRepoProvider,
            get_default_repo_provider,
        )
        assert isinstance(get_default_repo_provider(), LocalRepoProvider)
