"""Repo provider — read-only access to a source-control repo.

This module defines the :class:`RepoProvider` protocol plus
two real implementations:

* :class:`LocalRepoProvider` — uses the local ``git`` CLI on a
  checkout. No remote; this is the dev / CI / on-prem path.
* :class:`GitHubRepoProvider` — talks to the GitHub REST API
  with a GitHub App installation token. Production path; the
  Cat 23 v1.7 ship plan extends it to GitLab + Bitbucket.

The provider is read-only by design. The write side lives
in :mod:`eden.providers.pr` (:class:`PRProvider`).
:func:`get_default_repo_provider` returns a
:class:`LocalRepoProvider` pointed at the directory in
``EDEN_LOCAL_REPO_PATH`` (default ``.``); the GitHub
provider is selected when ``EDEN_GITHUB_TOKEN`` +
``EDEN_GITHUB_REPO`` are both populated.

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

# Module-level singleton httpx client. ``async with httpx.AsyncClient(...)``
# opens a fresh client (separate connection pool) and discards keep-alive
# sockets at scope exit; a module-level singleton keeps the underlying TCP
# connections warm across calls — material win for repeated GitHub API hits.
_HTTPX: "httpx.AsyncClient | None" = None  # noqa: UP037, F821


def _shared_httpx() -> "httpx.AsyncClient":  # noqa: UP037, F821
    global _HTTPX
    if _HTTPX is None:
        import httpx

        _HTTPX = httpx.AsyncClient(timeout=30.0)
    return _HTTPX


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
        self,
        path_glob: str = "**/*",
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
        self,
        limit: int = 10,
    ) -> list[CommitInfo]:
        """The most recent ``limit`` commits, newest first."""
        ...

    async def get_pull_request(
        self,
        number: int,
    ) -> PullRequestInfo | None:
        """One PR by number, or ``None`` if it doesn't exist."""
        ...

    async def list_pull_requests(
        self,
        state: str = "open",
        limit: int = 50,
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
        self,
        path_glob: str = "**/*",
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
                proc.communicate(),
                timeout=10.0,
            )
        except Exception as exc:
            logger.debug("LocalRepoProvider.list_files: %s", exc)
            return []
        if proc.returncode != 0:
            return []
        # NUL-separated; decode + filter empty entries.
        paths = [p.decode("utf-8", errors="replace") for p in stdout_b.split(b"\x00") if p]
        # fnmatch filter — git's glob is forgiving but the
        # caller's glob is fnmatch-shaped, so re-filter.
        filtered = [p for p in paths if _fnmatch_relpath(p, path_glob)]
        return [FileEntry(path=p, size=0, sha="") for p in filtered]

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
                self._git,
                "show",
                f"HEAD:{path}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(),
                timeout=10.0,
            )
            if proc.returncode == 0:
                return stdout_b.decode("utf-8", errors="replace")
        except Exception as exc:
            logger.debug(
                "LocalRepoProvider.read_file git show failed: %s",
                exc,
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
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(),
                timeout=5.0,
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
                self._git,
                "remote",
                "show",
                "origin",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(),
                timeout=5.0,
            )
            if proc.returncode == 0:
                for line in stdout_b.decode("utf-8", errors="replace").splitlines():
                    if "HEAD branch:" in line:
                        return line.rsplit(":", 1)[-1].strip()
        except Exception:
            pass
        # Prefer symbolic-ref / remote show; empty means unresolved when
        # git is present but HEAD cannot be resolved. Callers that need a
        # hard default (LocalPRProvider) supply their own.
        return ""

    async def get_recent_commits(
        self,
        limit: int = 10,
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
                self._git,
                "log",
                f"-n{limit}",
                f"--format={fmt}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(),
                timeout=10.0,
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
        self,
        number: int,
    ) -> PullRequestInfo | None:
        """Read a PR from the local ``.eden/prs/<n>.json`` log.

        Returns ``None`` when the file doesn't exist. The
        file is written by :class:`LocalPRProvider.create_pr`
        (sibling module) so the inbox round-trips without
        any external API.
        """
        path = os.path.join(
            self.repo_path,
            ".eden",
            "prs",
            f"{int(number)}.json",
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
        self,
        state: str = "open",
        limit: int = 50,
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


# ── GitHubRepoProvider ──────────────────────────────────────────


class GitHubRepoProvider:
    """A :class:`RepoProvider` backed by the GitHub REST API.

    Constructed by the onboarding wizard with an installation token
    minted via :meth:`eden.integrations.github.GitHubOAuthClient.installation_token`.
    The token is short-lived (~1 h); the caller is responsible for
    refreshing it before expiry (the route layer caches by
    ``installation_id``).

    Note: ``read_file`` returns the file content as a UTF-8 string,
    decoding the base64 the Contents API returns. Files over the
    1 MiB REST limit return ``""`` — onboarding-wizard manifest files
    (requirements.txt, package.json, pyproject.toml) are always well
    under this cap, so we don't fall back to the blobs API.

    Read-only by design. The write side is :class:`GitHubPRProvider`
    in :mod:`eden.providers.pr`.
    """

    name: str = "github"

    def __init__(self, token: str, repo: str) -> None:
        """
        Args:
            token: An installation access token (``ghs_…``). Get one
                from ``GitHubOAuthClient.installation_token()``.
            repo: ``"owner/repo"`` (e.g. ``"acme/agent-runner"``).
        """
        self.token = token
        self.repo = repo
        if not token or not repo or "/" not in repo:
            raise ValueError(
                "GitHubRepoProvider requires a non-empty installation "
                "token and a 'owner/repo' string."
            )

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": f"token {self.token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def list_files(
        self,
        path_glob: str = "**/*",
    ) -> list[FileEntry]:
        """List files via the git-trees API (recursive).

        Returns up to 100,000 entries (GitHub's tree cap) filtered by
        ``path_glob``. For the onboarding flow we only need the
        manifest files, so the caller typically asks for
        ``"requirements.txt"`` / ``"pyproject.toml"`` / ``"package.json"``
        directly via :meth:`read_file` and skips this method.
        """
        client = _shared_httpx()
        default_branch = await self.get_default_branch()
        async with client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}/git/trees/{default_branch}",
                headers=self._headers,
                params={"recursive": "1"},
            )
            if r.status_code != 200:
                logger.debug("GitHubRepoProvider.list_files %s: %s", r.status_code, r.text[:200])
                return []
            tree = r.json().get("tree", [])
        files = [
            FileEntry(path=item["path"], size=int(item.get("size", 0)), sha=item.get("sha", ""))
            for item in tree
            if item.get("type") == "blob"
        ]
        return [f for f in files if _fnmatch_relpath(f.path, path_glob)]

    async def read_file(self, path: str) -> str:
        """Read a file via the Contents API. Returns ``""`` on miss."""
        import base64 as _base64

        client = _shared_httpx()
        async with client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}/contents/{path}",
                headers=self._headers,
            )
            if r.status_code == 404:
                return ""
            if r.status_code != 200:
                logger.debug("GitHubRepoProvider.read_file %s: %s", r.status_code, r.text[:200])
                return ""
            payload = r.json()
        # Contents API returns base64 for files. Submodules / dirs
        # return a list — we treat those as "miss" and return "".
        if isinstance(payload, list):
            return ""
        if payload.get("encoding") != "base64" or "content" not in payload:
            return ""
        try:
            return _base64.b64decode(payload["content"]).decode("utf-8", errors="replace")
        except Exception as exc:
            logger.debug("GitHubRepoProvider.read_file decode failed: %s", exc)
            return ""

    async def get_default_branch(self) -> str:
        """Read the default branch from the repo metadata.

        Returns an empty string when the API is unreachable so callers
        (``resolve_pr_base_branch``) fail closed instead of inventing
        ``main``.
        """
        client = _shared_httpx()
        async with client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}",
                headers=self._headers,
            )
            if r.status_code != 200:
                return ""
            return str(r.json().get("default_branch") or "").strip()

    async def get_recent_commits(
        self,
        limit: int = 10,
    ) -> list[CommitInfo]:
        """List recent commits on the default branch."""
        client = _shared_httpx()
        async with client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}/commits",
                headers=self._headers,
                params={"per_page": max(1, min(int(limit), 100))},
            )
            if r.status_code != 200:
                return []
            data = r.json()
        out: list[CommitInfo] = []
        for item in data:
            commit = item.get("commit", {})
            author_data = commit.get("author") or {}
            ts_raw = author_data.get("date") or ""
            try:
                ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            except Exception:
                ts = datetime.now(UTC)
            out.append(
                CommitInfo(
                    sha=item.get("sha", ""),
                    message=(commit.get("message") or "").splitlines()[0]
                    if commit.get("message")
                    else "",
                    author=f"{author_data.get('name', '')} <{author_data.get('email', '')}>",
                    timestamp=ts,
                )
            )
        return out

    async def get_pull_request(
        self,
        number: int,
    ) -> PullRequestInfo | None:
        """Fetch one PR by number."""
        client = _shared_httpx()
        async with client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}/pulls/{int(number)}",
                headers=self._headers,
            )
            if r.status_code == 404:
                return None
            if r.status_code != 200:
                return None
            return _pr_info_from_github(r.json())

    async def list_pull_requests(
        self,
        state: str = "open",
        limit: int = 50,
    ) -> list[PullRequestInfo]:
        """List PRs filtered by state ('open'|'closed'|'all')."""
        client = _shared_httpx()
        gh_state = (
            "all" if state == "all" else ("closed" if state in ("merged", "closed") else "open")
        )
        async with client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}/pulls",
                headers=self._headers,
                params={
                    "state": gh_state,
                    "per_page": max(1, min(int(limit), 100)),
                    "sort": "created",
                    "direction": "desc",
                },
            )
            if r.status_code != 200:
                return []
            data = r.json()
        out: list[PullRequestInfo] = []
        for item in data:
            info = _pr_info_from_github(item)
            # Local convention: "merged" is a derived state from
            # closed+merged_at; surface that to the caller.
            if state == "merged" and info.state != "merged":
                continue
            if state == "closed" and info.state == "merged":
                # Closed without merge — the convention is to include.
                pass
            out.append(info)
        return out[:limit]


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
    created_at_raw = (
        data.get("created_at")
        or datetime.now(
            UTC,
        ).isoformat()
    )
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


def _pr_info_from_github(item: dict) -> PullRequestInfo:
    """Parse a :class:`PullRequestInfo` from a GitHub REST PR payload.

    Maps the GitHub ``state`` field ('open'|'closed') + ``merged_at``
    to our 3-state model ('open'|'merged'|'closed').
    """
    gh_state = item.get("state", "open")
    merged_at = item.get("merged_at")
    state = "merged" if gh_state == "closed" and merged_at else gh_state
    created_at_raw = item.get("created_at") or ""
    try:
        created_at = datetime.fromisoformat(created_at_raw.replace("Z", "+00:00"))
    except Exception:
        created_at = datetime.now(UTC)
    head = item.get("head") or {}
    base = item.get("base") or {}
    return PullRequestInfo(
        number=int(item.get("number", 0)),
        title=str(item.get("title", "")),
        body=str(item.get("body") or ""),
        branch=str(head.get("ref", "")),
        base=str(base.get("ref", "")),
        url=str(item.get("html_url", "")),
        state=state,
        created_at=created_at,
    )


def get_default_repo_provider() -> RepoProvider:
    """The default :class:`RepoProvider` for the platform.

    Returns :class:`LocalRepoProvider` pointed at
    ``EDEN_LOCAL_REPO_PATH`` (default ``.``). When
    ``EDEN_REPO_PROVIDER=github`` is set AND both
    ``EDEN_GITHUB_TOKEN`` + ``EDEN_GITHUB_REPO`` are populated,
    returns a real :class:`GitHubRepoProvider`. Falls back to
    Local if those env vars are missing — the GitHub provider
    requires a non-empty token + repo.
    """
    provider_name = os.environ.get("EDEN_REPO_PROVIDER", "local")
    if provider_name == "github":
        token = os.environ.get("EDEN_GITHUB_TOKEN", "")
        repo = os.environ.get("EDEN_GITHUB_REPO", "")
        if token and repo:
            return GitHubRepoProvider(token=token, repo=repo)
        logger.warning(
            "EDEN_REPO_PROVIDER=github but EDEN_GITHUB_TOKEN/REPO not set; "
            "falling back to LocalRepoProvider.",
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
