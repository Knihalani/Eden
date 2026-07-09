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



class TestGitHubCommitFilesPerformance:
    """F42 regression tests for the GitHub commit_files path.

    The pre-fix code did N sequential ``await client.post(...)`` calls
    for N file blobs (a true N+1) and opened a fresh
    ``httpx.AsyncClient`` per method call instead of using the
    module-level ``_shared_httpx`` singleton. Both were fixed:

    * Blob POSTs are now ``asyncio.gather``-ed — N files in one
      round-trip's worth of latency.
    * The shared client is wired up in every GitHub method (was
      defined but never used).
    """

    @pytest.fixture
    def fake_httpx(self):
        """Replace ``_shared_httpx`` with a mock client that records
        the sequence of calls."""
        from unittest.mock import AsyncMock, MagicMock
        from eden.providers import pr as pr_mod

        class _Response:
            def __init__(self, status_code=201, payload=None):
                self.status_code = status_code
                self._payload = payload or {}
                self.text = ""

            def json(self):
                return self._payload

        # Reset the module-level singleton so the test gets a clean one.
        pr_mod._HTTPX = None
        client = MagicMock()
        # Default 201 + sha payload for any POST/GET/PATCH.
        client.post = AsyncMock(return_value=_Response(
            201, payload={"sha": "abc123"},
        ))
        client.get = AsyncMock(return_value=_Response(
            200, payload={
                "object": {"sha": "parent_sha"},
                "tree": {"sha": "base_tree_sha"},
                "default_branch": "main",
            },
        ))
        client.patch = AsyncMock(return_value=_Response(200, payload={}))
        pr_mod._shared_httpx = lambda: client
        yield client
        pr_mod._HTTPX = None
        # Restore the real helper.
        import httpx
        pr_mod._shared_httpx = (
            lambda: pr_mod._HTTPX
            if pr_mod._HTTPX is not None
            else pr_mod._HTTPX  # noqa: E501
        )
        # Simplest: just restore by reimport
        pr_mod._shared_httpx = lambda: _real_shared(pr_mod)

    @pytest.mark.asyncio
    async def test_blob_posts_are_fired_concurrently(self, fake_httpx):
        """All N blob POSTs are scheduled before the first one resolves.

        We verify by counting how many ``client.post`` calls were
        in-flight at the moment ``asyncio.gather`` awaited them. The
        pre-fix code awaited each POST sequentially, so the count
        would be 1 at a time. With ``asyncio.gather`` all N are
        scheduled together.
        """
        from unittest.mock import AsyncMock
        from eden.providers.pr import GitHubPRProvider
        from eden.providers.repo import FileEntry

        # Track peak in-flight count by inspecting when each call
        # was awaited. With asyncio.gather, all N tasks are scheduled
        # in the same event-loop iteration.
        in_flight = 0
        peak_in_flight = 0

        async def _tracking_post(*args, **kwargs):
            nonlocal in_flight, peak_in_flight
            in_flight += 1
            peak_in_flight = max(peak_in_flight, in_flight)
            # Yield to the event loop to allow other tasks to start.
            import asyncio
            await asyncio.sleep(0)
            in_flight -= 1
            from unittest.mock import MagicMock
            r = MagicMock()
            r.status_code = 201
            r.json.return_value = {"sha": f"blob-{peak_in_flight}"}
            r.text = ""
            return r

        # Branch ref GET (step 1) + parent commit GET (step 2)
        # need to return real-ish data so the flow proceeds to
        # the blob POSTs.
        from unittest.mock import MagicMock

        def _get_side_effect(*args, **kwargs):
            r = MagicMock()
            r.status_code = 200
            url = args[0] if args else kwargs.get("url", "")
            if "git/ref/heads/" in url:
                r.json.return_value = {"object": {"sha": "parent_sha"}}
            elif "git/commits/" in url:
                r.json.return_value = {"tree": {"sha": "base_tree_sha"}}
            elif "/repos/" in url and "pulls/" not in url:
                r.json.return_value = {"default_branch": "main"}
            else:
                r.json.return_value = {}
            return r

        fake_httpx.post = AsyncMock(side_effect=_tracking_post)
        fake_httpx.get = AsyncMock(side_effect=_get_side_effect)
        fake_httpx.patch = AsyncMock(return_value=MagicMock(
            status_code=200, json=lambda: {}, text="",
        ))

        provider = GitHubPRProvider(token="ghs_test", repo="acme/foo")
        files = [
            FileEntry(path=f"file_{i}.py", size=10, content="x = 1\n")
            for i in range(5)
        ]
        commit = await provider.commit_files(
            branch="main", files=files, message="test",
        )

        # The peak in-flight count for the blob POSTs should be > 1
        # (they ran concurrently). Pre-fix sequential code would
        # show peak_in_flight == 1.
        assert peak_in_flight > 1, (
            f"Expected concurrent blob POSTs, got peak_in_flight="
            f"{peak_in_flight}. The for-loop in commit_files is "
            f"awaiting each blob POST sequentially."
        )
        # All 5 blobs were created.
        # The other POSTs are: 1 trees + 1 commits = 2 non-blob POSTs.
        # Total POSTs = 5 blobs + 1 tree + 1 commit = 7.
        post_urls = [
            c.args[0] for c in fake_httpx.post.await_args_list
        ]
        blob_posts = [u for u in post_urls if "git/blobs" in u]
        assert len(blob_posts) == 5
        assert commit.sha == "blob-5"  # last blob's sha returned

    @pytest.mark.asyncio
    async def test_uses_shared_httpx_client(self, fake_httpx, monkeypatch):
        """commit_files uses the module-level _shared_httpx, not a
        freshly-opened httpx.AsyncClient.

        The pre-fix code did ``async with httpx.AsyncClient(...)``
        in every method, which defeats HTTP/1.1 keep-alive. The
        fix routes everything through the ``_shared_httpx``
        singleton (the comment at the helper definition makes
        the intent clear).
        """
        from eden.providers import pr as pr_mod
        from eden.providers.pr import GitHubPRProvider
        from eden.providers.repo import FileEntry
        from unittest.mock import AsyncMock, MagicMock

        # Record that the shared helper was the only client source.
        # If the code opened a fresh httpx.AsyncClient, that would
        # also create new connection pools. We assert by checking
        # that no fresh client was constructed.
        constructed: list[str] = []
        orig_init = pr_mod.httpx.AsyncClient.__init__

        def _tracking_init(self, *a, **kw):
            constructed.append(self.__class__.__name__)
            return orig_init(self, *a, **kw)

        monkeypatch.setattr(
            pr_mod.httpx.AsyncClient, "__init__", _tracking_init,
        )

        # Stub the GETs to return real-ish payloads.
        def _get_side_effect(*args, **kwargs):
            r = MagicMock()
            r.status_code = 200
            url = args[0] if args else kwargs.get("url", "")
            if "git/ref/heads/" in url:
                r.json.return_value = {"object": {"sha": "parent_sha"}}
            elif "git/commits/" in url:
                r.json.return_value = {"tree": {"sha": "base_tree_sha"}}
            else:
                r.json.return_value = {}
            return r

        fake_httpx.get = AsyncMock(side_effect=_get_side_effect)
        fake_httpx.post = AsyncMock(return_value=MagicMock(
            status_code=201, json=lambda: {"sha": "x"}, text="",
        ))
        fake_httpx.patch = AsyncMock(return_value=MagicMock(
            status_code=200, json=lambda: {}, text="",
        ))

        provider = GitHubPRProvider(token="ghs_test", repo="acme/foo")
        await provider.commit_files(
            branch="main",
            files=[FileEntry(path="a.py", size=10, content="x = 1\n")],
            message="test",
        )
        # No new httpx.AsyncClient instances should have been
        # created during commit_files — the shared client is
        # used.
        assert constructed == [], (
            f"Expected zero httpx.AsyncClient constructions during "
            f"commit_files; got {constructed}. The code is still "
            f"opening a fresh client per call."
        )


def _real_shared(pr_mod):
    """The real ``_shared_httpx`` (re-bound for test cleanup)."""
    if pr_mod._HTTPX is None:
        pr_mod._HTTPX = pr_mod.httpx.AsyncClient(timeout=30.0)
    return pr_mod._HTTPX

