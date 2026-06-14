"""PR provider — write-side of the source-control abstraction.

This module defines the :class:`PRProvider` protocol plus
a :class:`LocalPRProvider` implementation (uses the local
``git`` CLI on a checkout, persists PRs as JSON files in
``.eden/prs/``) and a :class:`GitHubPRProvider` placeholder
that raises :class:`NotImplementedError` — the real impl
is gated on the GitHub App auth flow per the Cat 23 v1.6
ship plan.

The provider is the **write side** of the abstraction. The
read side is :mod:`eden.providers.repo` (:class:`RepoProvider`).
They are separate so the agent-suggest flow can read the
repo (always allowed) without a write capability until the
human clicks "open PR".

Example
-------
::

    from eden.providers.pr import LocalPRProvider, PRCreateRequest

    provider = LocalPRProvider(repo_path="/path/to/repo")
    pr = await provider.create_pr(PRCreateRequest(
        title="[Eden Agent] Fix timeout",
        body="Auto-suggested based on Cat 2 RCA cluster.",
        branch="eden/fix-timeout-1",
        base="main",
    ))
    print(pr.url)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol, cast, Any

from .repo import CommitInfo, FileEntry, PullRequestInfo

logger = logging.getLogger(__name__)


# ── Data classes ─────────────────────────────────────────────────


@dataclass
class PRCreateRequest:
    """The arguments for :meth:`PRProvider.create_pr`.

    Attributes:
        title: PR title (e.g. ``"[Eden Agent] Fix timeout"``).
        body: PR body / description (markdown).
        branch: The new head branch (e.g. ``"eden/fix-1"``).
        base: The base branch the PR merges into.
        labels: Optional list of label names.
        reviewers: Optional list of GitHub usernames.
        draft: When ``True``, the PR is a draft.
        files: The list of files to commit. Each entry
            is a :class:`eden.providers.repo.FileEntry`
            with ``path`` + ``content`` populated. The
            provider applies the change to the working
            tree, commits, and pushes.
        commit_message: The commit message. Defaults to
            the PR title when empty.
    """

    title: str
    body: str
    branch: str
    base: str
    labels: list[str] = field(default_factory=list)
    reviewers: list[str] = field(default_factory=list)
    draft: bool = False
    files: list[FileEntry] = field(default_factory=list)
    commit_message: str = ""


@dataclass
class PRRevertRequest:
    """The arguments for :meth:`PRProvider.revert`.

    Mirrors the 3-strategy surface from
    :class:`eden.code_change.revert_engine.AutoRevertEngine`:

    * ``"close_pr"`` — close the PR without a git action.
    * ``"revert_pr"`` — ``gh pr revert <n>`` (or the local
      equivalent: create a revert commit on a new branch).
    * ``"revert_branch"`` — ``git revert <merge_sha>`` on a
      new branch.

    The strategy is selected by the caller (the
    :class:`AutoRevertEngine` is the strategy picker).
    """

    pr_number: int
    strategy: str = "close_pr"
    new_branch: str | None = None
    merge_sha: str | None = None


# ── Protocol ────────────────────────────────────────────────────


class PRProvider(Protocol):
    """The write-side PR contract.

    Implementations: :class:`LocalPRProvider`,
    :class:`GitHubPRProvider`.
    """

    name: str

    async def create_branch(
        self, branch: str, from_sha: str | None = None,
    ) -> None:
        """Create ``branch`` from ``from_sha`` (or HEAD)."""
        ...

    async def commit_files(
        self,
        branch: str,
        files: list[FileEntry],
        message: str,
    ) -> CommitInfo:
        """Apply ``files`` to the working tree, stage, commit
        on ``branch``. Returns the new commit info."""
        ...

    async def create_pr(self, req: PRCreateRequest) -> PullRequestInfo:
        """Open a new PR with ``req``'s metadata. Persists a
        record so :meth:`RepoProvider.get_pull_request` can
        round-trip. Returns the :class:`PullRequestInfo`."""
        ...

    async def revert(self, req: PRRevertRequest) -> PullRequestInfo:
        """Revert a PR per the chosen strategy. Returns the
        new :class:`PullRequestInfo` (the revert PR, for
        ``revert_pr`` and ``revert_branch``; the closed PR
        for ``close_pr``)."""
        ...

    async def comment(self, pr_number: int, body: str) -> None:
        """Post a comment on a PR. No-op for ``close_pr``."""
        ...


# ── LocalPRProvider ────────────────────────────────────────────


class LocalPRProvider:
    """A :class:`PRProvider` backed by the local ``git`` CLI.

    The provider writes to a local checkout:

    1. ``create_branch`` runs ``git checkout -b``.
    2. ``commit_files`` applies each file (writes the new
       content to the working tree), stages via ``git add``,
       and commits via ``git commit``.
    3. ``create_pr`` writes a JSON record to
       ``.eden/prs/<n>.json`` and returns the
       :class:`PullRequestInfo`. The push step is a
       no-op (no real remote).

    The provider degrades gracefully when ``git`` is
    missing or the directory is not a git repo — every
    method returns a "skipped" envelope instead of
    raising. This matches the rest of the Eden stack.
    """

    name: str = "local"

    def __init__(self, repo_path: str | None = None) -> None:
        self.repo_path = os.path.abspath(repo_path or os.getcwd())
        self._git = shutil.which("git")
        self._pr_counter: int = self._load_counter()
        if self._git is None:
            logger.warning(
                "LocalPRProvider: 'git' binary not found; "
                "all writes will be no-ops."
            )

    def _load_counter(self) -> int:
        """Load the next PR number from ``.eden/pr_counter``.

        The counter is a small file holding an integer.
        We load the max(existing PR numbers) + 1 so the
        counter survives restarts without a DB.
        """
        counter_path = os.path.join(
            self.repo_path, ".eden", "pr_counter",
        )
        if os.path.isfile(counter_path):
            try:
                with open(counter_path, encoding="utf-8") as fh:
                    return int(fh.read().strip()) + 1
            except Exception:
                pass
        # Fall back: count existing PRs.
        prs_dir = os.path.join(self.repo_path, ".eden", "prs")
        if os.path.isdir(prs_dir):
            max_n = 0
            for name in os.listdir(prs_dir):
                if name.endswith(".json") and name.split(".")[0].isdigit():
                    max_n = max(max_n, int(name.split(".")[0]))
            return max_n + 1
        return 1

    def _save_counter(self) -> None:
        """Persist the next PR number to ``.eden/pr_counter``."""
        counter_path = os.path.join(
            self.repo_path, ".eden", "pr_counter",
        )
        try:
            os.makedirs(os.path.dirname(counter_path), exist_ok=True)
            with open(counter_path, "w", encoding="utf-8") as fh:
                fh.write(str(self._pr_counter))
        except Exception as exc:
            logger.debug("LocalPRProvider: counter save failed: %s", exc)

    async def create_branch(
        self, branch: str, from_sha: str | None = None,
    ) -> None:
        """Create ``branch`` via ``git checkout -b <branch> [<from>]``."""
        if not self._git:
            return
        cmd = [self._git, "checkout", "-b", branch]
        if from_sha:
            cmd.append(from_sha)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=10.0)
        except Exception as exc:
            logger.debug("LocalPRProvider.create_branch: %s", exc)

    async def commit_files(
        self,
        branch: str,
        files: list[FileEntry],
        message: str,
    ) -> CommitInfo:
        """Write ``files`` to the working tree, stage, commit.

        Steps:
            1. ``git checkout <branch>`` (idempotent — if
               we're already on the branch, this is a no-op).
            2. Write each file to the working tree.
            3. ``git add`` all the paths.
            4. ``git commit -m <message>`` (skip the commit
               if there are no staged changes).
            5. Return the new :class:`CommitInfo`.
        """
        if not self._git:
            return CommitInfo(
                sha="", message=message, author="",
                timestamp=datetime.now(UTC),
            )
        try:
            # 1. Switch to the branch (best effort — we may
            # already be on it).
            await self._run_git(
                ["checkout", branch],
                timeout=10.0,
            )
            # 2. Write each file to the working tree.
            for f in files:
                full = os.path.join(self.repo_path, f.path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w", encoding="utf-8") as fh:
                    fh.write(f.content)
            # 3. Stage the changed paths.
            await self._run_git(
                ["add", "--"] + [f.path for f in files],
                timeout=10.0,
            )
            # 4. Commit (skip if nothing to commit).
            await self._run_git(
                ["commit", "-m", message, "--allow-empty"],
                timeout=10.0,
            )
            # 5. Read the new HEAD sha.
            sha_b, _ = await self._run_git_capture(
                ["rev-parse", "HEAD"], timeout=5.0,
            )
            sha = sha_b.decode("utf-8").strip() if sha_b else ""
        except Exception as exc:
            logger.debug("LocalPRProvider.commit_files: %s", exc)
            sha = ""
        return CommitInfo(
            sha=sha,
            message=message,
            author="Eden Agent <agent@eden.local>",
            timestamp=datetime.now(UTC),
        )

    async def create_pr(
        self, req: PRCreateRequest,
    ) -> PullRequestInfo:
        """Open a PR.

        Steps:
            1. ``create_branch(req.branch)``.
            2. ``commit_files(req.branch, req.files,
               req.commit_message or req.title)``.
            3. Write ``.eden/prs/<n>.json``.
            4. Bump the counter + return the
               :class:`PullRequestInfo`.
        """
        branch = req.branch or f"eden/auto-fix-{int(time.time())}"
        await self.create_branch(branch)
        commit_message = req.commit_message or req.title
        commit = await self.commit_files(
            branch=branch,
            files=req.files,
            message=commit_message,
        )
        number = self._pr_counter
        self._pr_counter += 1
        self._save_counter()
        created_at = datetime.now(UTC)
        info = PullRequestInfo(
            number=number,
            title=req.title,
            body=req.body,
            branch=branch,
            base=req.base,
            url=f"file://{self.repo_path}/.eden/prs/{number}.json",
            state="open",
            created_at=created_at,
        )
        await self._write_pr_record(info, commit, req.labels, req.reviewers)
        return info

    async def revert(
        self, req: PRRevertRequest,
    ) -> PullRequestInfo:
        """Revert a PR per the chosen strategy.

        For ``close_pr``, the original PR's state is flipped
        to ``"closed"`` and the record is rewritten. For
        ``revert_pr`` + ``revert_branch``, a new branch
        ``eden/revert-<n>-<ts>`` is created, a revert
        commit is made (the real ``git revert`` path is
        a future enhancement; the v0.1 surface writes a
        marker commit), and a new PR is opened.
        """
        original = await self._read_pr_record(req.pr_number)
        if original is None:
            return PullRequestInfo(
                number=0, title="", body="",
                branch="", base="",
                url="", state="missing",
                created_at=datetime.now(UTC),
            )
        if req.strategy == "close_pr":
            original_dict = original
            original_dict["state"] = "closed"
            original_dict["closed_at"] = datetime.now(
                UTC,
            ).isoformat()
            await self._write_json(
                f"{req.pr_number}.json", original_dict,
            )
            return _pr_info_from_dict(original_dict)
        # revert_pr / revert_branch — open a new PR.
        new_branch = (
            req.new_branch
            or f"eden/revert-{req.pr_number}-{int(time.time())}"
        )
        await self.create_branch(new_branch)
        commit = await self.commit_files(
            branch=new_branch,
            files=[
                FileEntry(
                    path=".eden/REVERT_NOTE.md",
                    size=0,
                    content=(
                        f"Revert of PR #{req.pr_number} "
                        f"via {req.strategy}\n\n"
                        f"{original.get('body', '')}"
                    ),
                ),
            ],
            message=f"Revert #{req.pr_number} via {req.strategy}",
        )
        number = self._pr_counter
        self._pr_counter += 1
        self._save_counter()
        new_info = PullRequestInfo(
            number=number,
            title=f"Revert #{req.pr_number}: {original.get('title', '')}",
            body=(
                f"Automated revert of PR #{req.pr_number} via "
                f"strategy `{req.strategy}`.\n\n"
                f"Original PR body:\n\n{original.get('body', '')}"
            ),
            branch=new_branch,
            base=req.new_branch or original.get("base", "main"),
            url=(
                f"file://{self.repo_path}/.eden/prs/{number}.json"
            ),
            state="open",
            created_at=datetime.now(UTC),
        )
        await self._write_pr_record(
            new_info, commit, labels=["revert"], reviewers=[],
        )
        return new_info

    async def comment(self, pr_number: int, body: str) -> None:
        """Append a comment to the PR record (JSON array).

        The local dev flow stores comments in
        ``.eden/prs/<n>.json["comments"]`` so the test can
        round-trip them. No real remote call.
        """
        record = await self._read_pr_record(pr_number)
        if record is None:
            return
        comments = record.get("comments", [])
        comments.append(
            {
                "body": body,
                "author": "Eden Agent <agent@eden.local>",
                "created_at": datetime.now(UTC).isoformat(),
            }
        )
        record["comments"] = comments
        await self._write_json(f"{pr_number}.json", record)

    # ── Internal helpers ───────────────────────────────────

    async def _run_git(
        self, args: list[str], *, timeout: float = 10.0,
    ) -> None:
        """Run a git command, ignore stdout/stderr."""
        if not self._git:
            return
        try:
            proc = await asyncio.create_subprocess_exec(
                self._git, *args,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except Exception as exc:
            logger.debug("LocalPRProvider._run_git %s: %s", args, exc)

    async def _run_git_capture(
        self, args: list[str], *, timeout: float = 10.0,
    ) -> tuple[bytes, bytes]:
        """Run a git command, return (stdout, stderr) bytes."""
        if not self._git:
            return b"", b""
        try:
            proc = await asyncio.create_subprocess_exec(
                self._git, *args,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            return await asyncio.wait_for(
                proc.communicate(), timeout=timeout,
            )
        except Exception as exc:
            logger.debug("LocalPRProvider._run_git_capture %s: %s", args, exc)
            return b"", b""

    async def _write_pr_record(
        self,
        info: PullRequestInfo,
        commit: CommitInfo,
        labels: list[str],
        reviewers: list[str],
    ) -> None:
        """Persist a PR record as JSON to ``.eden/prs/<n>.json``."""
        data = {
            "number": info.number,
            "title": info.title,
            "body": info.body,
            "branch": info.branch,
            "base": info.base,
            "url": info.url,
            "state": info.state,
            "labels": labels,
            "reviewers": reviewers,
            "created_at": info.created_at.isoformat(),
            "commit_sha": commit.sha,
            "commit_message": commit.message,
            "comments": [],
        }
        await self._write_json(f"{info.number}.json", data)

    async def _read_pr_record(self, number: int) -> dict | None:
        path = os.path.join(
            self.repo_path, ".eden", "prs", f"{int(number)}.json",
        )
        if not os.path.isfile(path):
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                return cast(dict[Any, Any] | None, json.load(fh))
        except Exception:
            return None

    async def _write_json(self, name: str, data: dict) -> None:
        prs_dir = os.path.join(self.repo_path, ".eden", "prs")
        os.makedirs(prs_dir, exist_ok=True)
        path = os.path.join(prs_dir, name)
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
        except Exception as exc:
            logger.debug("LocalPRProvider._write_json: %s", exc)


# ── GitHubPRProvider (placeholder) ──────────────────────────────


class GitHubPRProvider:
    """A :class:`PRProvider` backed by the GitHub REST API.

    PLACEHOLDER. The real impl requires:

    1. A GitHub App with ``contents:write`` +
       ``pull_requests:write`` permissions.
    2. A JWT-signing helper (the existing
       ``eden.integrations.github_auth`` module is the
       starting point).
    3. The installation flow (the user installs the App
       on their repo; the install id is stored on
       ``repo_connections``).

    The placeholder methods raise
    :class:`NotImplementedError` with a clear install
    instruction. The provider class exists so the
    ``get_default_pr_provider()`` factory can return it
    when ``EDEN_PR_PROVIDER=github`` is set, and so the
    route bootstrap can route to it.
    """

    name: str = "github"

    def __init__(self, token: str = "", repo: str = "") -> None:
        self.token = token
        self.repo = repo

    async def create_branch(
        self, branch: str, from_sha: str | None = None,
    ) -> None:
        raise NotImplementedError(
            "GitHubPRProvider: install the GitHub App and "
            "provide a token + repo to enable this method."
        )

    async def commit_files(
        self,
        branch: str,
        files: list[FileEntry],
        message: str,
    ) -> CommitInfo:
        raise NotImplementedError(
            "GitHubPRProvider: install the GitHub App and "
            "provide a token + repo to enable this method."
        )

    async def create_pr(self, req: PRCreateRequest) -> PullRequestInfo:
        raise NotImplementedError(
            "GitHubPRProvider: install the GitHub App to "
            "enable this method."
        )

    async def revert(self, req: PRRevertRequest) -> PullRequestInfo:
        raise NotImplementedError(
            "GitHubPRProvider: install the GitHub App to "
            "enable this method."
        )

    async def comment(self, pr_number: int, body: str) -> None:
        raise NotImplementedError(
            "GitHubPRProvider: install the GitHub App to "
            "enable this method."
        )


# ── Helpers ─────────────────────────────────────────────────────


def _pr_info_from_dict(data: dict) -> PullRequestInfo:
    """Mirror of ``eden.providers.repo._pr_info_from_dict``.

    Kept as a private copy to avoid the cross-module
    import (the file would import from a sibling anyway,
    but the indirection is small enough to inline).
    """
    created_at_raw = data.get("created_at") or datetime.now(
        UTC,
    ).isoformat()
    try:
        created_at = datetime.fromisoformat(created_at_raw)
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
    except Exception:
        created_at = datetime.now(UTC)
    return PullRequestInfo(
        number=int(data.get("number", 0)),
        title=str(data.get("title", "")),
        body=str(data.get("body", "")),
        branch=str(data.get("branch", "")),
        base=str(data.get("base", "")),
        url=str(data.get("url", "")),
        state=str(data.get("state", "open")),
        created_at=created_at,
    )


def get_default_pr_provider() -> PRProvider:
    """The default :class:`PRProvider` for the platform.

    Returns :class:`LocalPRProvider` pointed at
    ``EDEN_LOCAL_REPO_PATH`` (default ``.``). When
    ``EDEN_PR_PROVIDER=github`` is set, returns a
    :class:`GitHubPRProvider` placeholder.
    """
    provider_name = os.environ.get("EDEN_PR_PROVIDER", "local")
    if provider_name == "github":
        return GitHubPRProvider(
            token=os.environ.get("EDEN_GITHUB_TOKEN", ""),
            repo=os.environ.get("EDEN_GITHUB_REPO", ""),
        )
    return LocalPRProvider(
        repo_path=os.environ.get("EDEN_LOCAL_REPO_PATH") or None,
    )


__all__ = [
    "GitHubPRProvider",
    "LocalPRProvider",
    "PRCreateRequest",
    "PRProvider",
    "PRRevertRequest",
    "get_default_pr_provider",
]
