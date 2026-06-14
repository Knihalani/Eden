"""Repo provider — read-only access to a source-control repo.

This module defines the :class:`RepoProvider` protocol plus
a :class:`LocalRepoProvider` implementation (uses the local
``git`` CLI on a checkout) and a :class:`GitHubRepoProvider`
(placeholder that raises :class:`NotImplementedError` — the
real impl is gated on the GitHub App auth flow per the
Cat 23 v1.6 ship plan).

The provider is read-only by design. The write side lives
in :mod:`eden.providers.pr` (:class:`PRProvider`).
:func:`get_default_repo_provider` returns a
:class:`LocalRepoProvider` pointed at the directory in
``EDEN_LOCAL_REPO_PATH`` (default ``.``).

Example
-------
::

    from eden.providers.repo import LocalRepoProvider

    provider = LocalRepoProvider(repo_path="/path/to/repo")
    files = await provider.list_files(path_glob="src/**/*.py")
    for f in files:
        content = await provider.read_file(f.path)
        print(f.path, len(content))
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
import os
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

logger = logging.getLogger(__name__)


# ── Data classes ─────────────────────────────────────────────────


@dataclass
class FileEntry:
    """A single file in a repo (read-only metadata + content).

    Attributes:
        path: Repo-relative path using forward slashes
            (e.g. ``"src/eden/providers/repo.py"``).
        size: Size in bytes.
        sha: The git blob SHA. ``""`` when the file is
            not tracked (untracked or in a non-git
            directory — :class:`LocalRepoProvider` returns
            the SHA only for tracked files).
        content: The file content. Populated by
            :meth:`RepoProvider.read_file`; ``""`` when
            the entry is the result of a list call.
    """

    path: str
    size: int
    sha: str = ""
    content: str = ""


@dataclass
class CommitInfo:
    """A single commit in a repo.

    Attributes:
        sha: Full commit SHA (40 hex chars for git).
        message: The commit subject (first line).
        author: ``"Name <email>"`` form.
        timestamp: Commit timestamp (UTC).
    """

    sha: str
    message: str
    author: str
    timestamp: datetime


@dataclass
class PullRequestInfo:
    """A single pull request.

    Attributes:
        number: PR number (per provider — local uses a
            monotonic counter, GitHub uses the API id).
        title: PR title.
        body: PR body / description.
        branch: The head branch (where the changes are).
        base: The base branch (where the changes merge
            into).
        url: The web URL.
        state: One of ``"open"``, ``"merged"``, ``"closed"``.
        created_at: PR creation timestamp (UTC).
    """

    number: int
    title: str
    body: str
    branch: str
    base: str
    url: str
    state: str
    created_at: datetime


# ── Protocol ────────────────────────────────────────────────────


class RepoProvider(Protocol):
    """The read-only repo contract.

    Implementations: :class:`LocalRepoProvider`,
    :class:`GitHubRepoProvider`.
    """

    name: str

    async def list_files(
        self, path_glob: str = "**/*",
    ) -> list[FileEntry]:
        """List files matching ``path_glob``.

        ``path_glob`` is a Unix glob (``"**/*.py"``,
        ``"src/**/*.ts"``). Implementations may translate to
        provider-native glob syntax. An empty list means
        "no files matched" — never raises on a non-match.
        """
        ...

    async def read_file(self, path: str) -> str:
        """Read a single file's content. Empty string on
        a missing file. ``path`` is repo-relative."""
        ...

    async def get_default_branch(self) -> str:
        """The default branch name (e.g. ``"main"``)."""
        ...

    async def get_recent_commits(
        self, limit: int = 10,
    ) -> list[CommitInfo]:
        """The most recent ``limit`` commits, newest first."""
        ...

    async def get_pull_request(
        self, number: int,
    ) -> PullRequestInfo | None:
        """One PR by number, or ``None`` if it doesn't exist."""
        ...

    async def list_pull_requests(
        self, state: str = "open", limit: int = 50,
    ) -> list[PullRequestInfo]:
        """PRs in the given state, newest first."""
        ...


# ── LocalRepoProvider ────────────────────────────────────────────


class LocalRepoProvider:
    """A :class:`RepoProvider` backed by the local ``git`` CLI.

    The provider runs ``git ls-files``, ``git show``,
    ``git log``, etc. against a local checkout. **Read-only
    by design** — the provider never modifies the working
    tree. The write side lives in :class:`PRProvider`.

    The provider is best-effort: a missing ``git`` binary
    or a non-git directory returns empty results instead
    of raising. This matches the rest of the Eden stack
    (every fetcher degrades to "no data" on failure).
    """

    name: str = "local"

    def __init__(self, repo_path: str | None = None) -> None:
        self.repo_path = os.path.abspath(repo_path or os.getcwd())
        self._git = shutil.which("git")
        if self._git is None:
            logger.warning(
                "LocalRepoProvider: 'git' binary not found; "
                "all reads will return empty results. Install "
                "git or set EDEN_LOCAL_REPO_PATH to a git repo."
            )

    async def list_files(
        self, path_glob: str = "**/*",
    ) -> list[FileEntry]:
        """List files matching ``path_glob`` via ``git ls-files``.

        ``git ls-files`` is recursive by default — bare
        ``*.py`` already matches ``a/b.py`` — but it does
        NOT understand fnmatch-style ``**/`` patterns. We
        strip the leading ``**/`` to a bare ``:(top)`` so
        the root level matches.

        We then ``fnmatch.filter`` the results so the
        caller's glob (e.g. ``**/*.py``) only matches
        paths that satisfy both git's and fnmatch's view
        of the pattern.
        """
        if not self._git:
            return []
        # Translate fnmatch-style ``**/`` to git's
        # ``:(top)`` pathspec (recursive by default for
        # the trailing pattern). For ``**/*`` / ``**`` we
        # pass an empty arg to get every tracked file.
        if path_glob in ("**/*", "**"):
            git_glob_arg: str | None = None
        elif path_glob.startswith("**/"):
            git_glob_arg = ":(top)" + path_glob[3:]
        else:
            git_glob_arg = path_glob
        try:
            cmd = [self._git, "ls-files", "-z"]
            if git_glob_arg is not None:
                cmd.extend(["--", git_glob_arg])
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(), timeout=10.0,
            )
        except Exception as exc:
            logger.debug("LocalRepoProvider.list_files: %s", exc)
            return []
        if proc.returncode != 0:
            return []
        # NUL-separated; decode + filter empty entries.
        paths = [
            p.decode("utf-8", errors="replace")
            for p in stdout_b.split(b"\x00")
            if p
        ]
        # fnmatch filter — git's glob is forgiving but the
        # caller's glob is fnmatch-shaped, so re-filter.
        filtered = [
            p for p in paths
            if _fnmatch_relpath(p, path_glob)
        ]
        return [
            FileEntry(path=p, size=0, sha="")
            for p in filtered
        ]

    async def read_file(self, path: str) -> str:
        """Read ``path`` via ``git show HEAD:<path>``.

        Falls back to a plain filesystem read when the file
        is not tracked by git (e.g. a freshly created file
        in a working copy). Returns ``""`` on any failure.
        """
        if not self._git:
            return ""
        try:
            proc = await asyncio.create_subprocess_exec(
                self._git, "show", f"HEAD:{path}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(), timeout=10.0,
            )
            if proc.returncode == 0:
                return stdout_b.decode("utf-8", errors="replace")
        except Exception as exc:
            logger.debug(
                "LocalRepoProvider.read_file git show failed: %s", exc,
            )
        # Fallback: filesystem read for untracked files.
        try:
            full = os.path.join(self.repo_path, path)
            with open(full, "rb") as fh:
                return fh.read().decode("utf-8", errors="replace")
        except Exception:
            return ""

    async def get_default_branch(self) -> str:
        """The default branch via ``git symbolic-ref``."""
        if not self._git:
            return "main"
        try:
            proc = await asyncio.create_subprocess_exec(
                self._git,
                "symbolic-ref", "refs/remotes/origin/HEAD",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(), timeout=5.0,
            )
            if proc.returncode == 0 and stdout_b:
                # Output is ``refs/remotes/origin/<branch>``.
                return stdout_b.decode("utf-8").strip().rsplit("/", 1)[-1]
        except Exception:
            pass
        # Fallback: try ``git remote show origin`` and parse
        # the "HEAD branch:" line.
        try:
            proc = await asyncio.create_subprocess_exec(
                self._git, "remote", "show", "origin",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(), timeout=5.0,
            )
            if proc.returncode == 0:
                for line in stdout_b.decode("utf-8", errors="replace").splitlines():
                    if "HEAD branch:" in line:
                        return line.rsplit(":", 1)[-1].strip()
        except Exception:
            pass
        return "main"

    async def get_recent_commits(
        self, limit: int = 10,
    ) -> list[CommitInfo]:
        """The most recent ``limit`` commits via ``git log``.

        Format: ``%H%n%s%n%an <%ae>%n%aI%n--END--``. We
        parse the markers; any malformed lines are skipped
        so the function is resilient to weird git output.
        """
        if not self._git or limit <= 0:
            return []
        sep = "--END--"
        fmt = f"%H%n%s%n%an <%ae>%n%aI%n{sep}"
        try:
            proc = await asyncio.create_subprocess_exec(
                self._git, "log", f"-n{limit}", f"--format={fmt}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(), timeout=10.0,
            )
        except Exception as exc:
            logger.debug("LocalRepoProvider.get_recent_commits: %s", exc)
            return []
        if proc.returncode != 0:
            return []
        out: list[CommitInfo] = []
        text = stdout_b.decode("utf-8", errors="replace")
        for block in text.split(sep):
            block = block.strip()
            if not block:
                continue
            lines = block.splitlines()
            if len(lines) < 4:
                continue
            try:
                ts = datetime.fromisoformat(lines[3].strip()).astimezone(
                    UTC,
                )
            except Exception:
                ts = datetime.now(UTC)
            out.append(
                CommitInfo(
                    sha=lines[0].strip(),
                    message=lines[1].strip(),
                    author=lines[2].strip(),
                    timestamp=ts,
                )
            )
        return out

    async def get_pull_request(
        self, number: int,
    ) -> PullRequestInfo | None:
        """Read a PR from the local ``.eden/prs/<n>.json`` log.

        Returns ``None`` when the file doesn't exist. The
        file is written by :class:`LocalPRProvider.create_pr`
        (sibling module) so the inbox round-trips without
        any external API.
        """
        path = os.path.join(
            self.repo_path, ".eden", "prs", f"{int(number)}.json",
        )
        if not os.path.isfile(path):
            return None
        try:
            import json as _json
            with open(path, encoding="utf-8") as fh:
                data = _json.load(fh)
        except Exception:
            return None
        try:
            return _pr_info_from_dict(data)
        except Exception:
            return None

    async def list_pull_requests(
        self, state: str = "open", limit: int = 50,
    ) -> list[PullRequestInfo]:
        """List PRs in the local ``.eden/prs/*.json`` log.

        Sorted by ``created_at`` descending. Filtered by
        ``state`` (open / merged / closed). The log is the
        source of truth for the local dev flow; the
        GitLab/Bitbucket providers will replace it.
        """
        import json as _json
        prs_dir = os.path.join(self.repo_path, ".eden", "prs")
        if not os.path.isdir(prs_dir):
            return []
        out: list[PullRequestInfo] = []
        for name in os.listdir(prs_dir):
            if not name.endswith(".json"):
                continue
            full = os.path.join(prs_dir, name)
            try:
                with open(full, encoding="utf-8") as fh:
                    data = _json.load(fh)
                info = _pr_info_from_dict(data)
            except Exception:
                continue
            if state != "all" and info.state != state:
                continue
            out.append(info)
        out.sort(key=lambda p: p.created_at, reverse=True)
        return out[:limit]


# ── GitHubRepoProvider (placeholder) ────────────────────────────


class GitHubRepoProvider:
    """A :class:`RepoProvider` backed by the GitHub REST API.

    PLACEHOLDER. The real impl requires:

    1. A GitHub App registration (the Eden Agent App) with
       ``contents:read`` + ``pull_requests:read`` + ``metadata:read``
       permissions.
    2. The App's private key + installation id per org.
    3. A JWT-signing helper (the existing
       ``eden.integrations.github_auth`` module is the
       starting point).

    The placeholder methods raise
    :class:`NotImplementedError` with a clear install
    instruction. The provider class exists so the
    ``get_default_repo_provider()`` factory can return it
    when ``EDEN_REPO_PROVIDER=github`` is set, and so the
    route bootstrap can route to it.
    """

    name: str = "github"

    def __init__(self, token: str = "", repo: str = "") -> None:
        self.token = token
        self.repo = repo

    async def list_files(
        self, path_glob: str = "**/*",
    ) -> list[FileEntry]:
        raise NotImplementedError(
            "GitHubRepoProvider: install the GitHub App and "
            "provide a token + repo to enable this method."
        )

    async def read_file(self, path: str) -> str:
        raise NotImplementedError(
            "GitHubRepoProvider: install the GitHub App and "
            "provide a token + repo to enable this method."
        )

    async def get_default_branch(self) -> str:
        raise NotImplementedError(
            "GitHubRepoProvider: install the GitHub App to "
            "enable this method."
        )

    async def get_recent_commits(
        self, limit: int = 10,
    ) -> list[CommitInfo]:
        raise NotImplementedError(
            "GitHubRepoProvider: install the GitHub App to "
            "enable this method."
        )

    async def get_pull_request(
        self, number: int,
    ) -> PullRequestInfo | None:
        raise NotImplementedError(
            "GitHubRepoProvider: install the GitHub App to "
            "enable this method."
        )

    async def list_pull_requests(
        self, state: str = "open", limit: int = 50,
    ) -> list[PullRequestInfo]:
        raise NotImplementedError(
            "GitHubRepoProvider: install the GitHub App to "
            "enable this method."
        )


# ── Helpers ─────────────────────────────────────────────────────


def _fnmatch_relpath(path: str, pattern: str) -> bool:
    """Filter a path against a glob.

    ``fnmatch`` doesn't honour ``**`` natively, so we
    translate a leading ``**/`` to ``*`` for the directory
    walk. This is a best-effort match — git's own glob
    filter has already run, so the worst case is "we
    include too much" (no false negatives).
    """
    if not pattern or pattern == "**/*":
        return True
    # Always try the raw pattern first.
    if fnmatch.fnmatch(path, pattern):
        return True
    # ``**/foo`` → also match ``foo`` at the root.
    if pattern.startswith("**/"):
        rest = pattern[3:]
        if fnmatch.fnmatch(path, rest):
            return True
        # ``**/foo`` → also match any-path ending in
        # ``foo`` (e.g. ``a/b/foo``).
        if "/" in path:
            tail = path.rsplit("/", 1)[-1]
            if fnmatch.fnmatch(tail, rest):
                return True
    # Bare ``*.py`` → match any-path ending in ``.py``.
    return bool("/" not in pattern and fnmatch.fnmatch(path.rsplit("/", 1)[-1], pattern))


def _pr_info_from_dict(data: dict) -> PullRequestInfo:
    """Parse a :class:`PullRequestInfo` from a serialised dict.

    The dict is written by :class:`LocalPRProvider.create_pr`
    (sibling module). We defensively parse every field so
    a future change to the wire format doesn't break the
    read path.
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


def get_default_repo_provider() -> RepoProvider:
    """The default :class:`RepoProvider` for the platform.

    Returns :class:`LocalRepoProvider` pointed at
    ``EDEN_LOCAL_REPO_PATH`` (default ``.``). When
    ``EDEN_REPO_PROVIDER=github`` is set, returns a
    :class:`GitHubRepoProvider` placeholder (the real impl
    is gated on the GitHub App auth flow).
    """
    provider_name = os.environ.get("EDEN_REPO_PROVIDER", "local")
    if provider_name == "github":
        return GitHubRepoProvider(
            token=os.environ.get("EDEN_GITHUB_TOKEN", ""),
            repo=os.environ.get("EDEN_GITHUB_REPO", ""),
        )
    return LocalRepoProvider(
        repo_path=os.environ.get("EDEN_LOCAL_REPO_PATH") or None,
    )


__all__ = [
    "CommitInfo",
    "FileEntry",
    "GitHubRepoProvider",
    "LocalRepoProvider",
    "PullRequestInfo",
    "RepoProvider",
    "get_default_repo_provider",
]
