"""Provider abstractions — sandbox, repo, PR.

This package ships the general-purpose provider interfaces
that the rest of Eden (Cat 12 Simulator, Cat 23
TestPlanRunner, the new agent-suggest flow) can target.
Three families:

* :class:`eden.providers.sandbox.SandboxProvider` — execute
  a single command in a sandbox. ``Local`` + ``Null``
  implementations ship; Docker / Firecracker are
  follow-ups.
* :class:`eden.providers.repo.RepoProvider` — read-only
  access to a source-control repo. ``Local`` (git CLI)
  ships; ``GitHub`` is a placeholder.
* :class:`eden.providers.pr.PRProvider` — write-side of
  the source-control abstraction. ``Local`` (git CLI +
  ``.eden/prs/*.json`` log) ships; ``GitHub`` is a
  placeholder.

The package uses **lazy re-exports** so that
``from eden.providers import LocalSandboxProvider`` does
not eagerly import the sibling submodules.

See ``docs/eden-observability-gap-roadmap.md`` § Cat 23
for the source-control design + the GitHub App auth
flow that unlocks the real providers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "CommitInfo",
    "FileEntry",
    "GitHubPRProvider",
    "GitHubRepoProvider",
    "IsolatedSandboxProvider",
    "LocalPRProvider",
    "LocalRepoProvider",
    "LocalSandboxProvider",
    "NullSandboxProvider",
    "PRCreateRequest",
    "PRProvider",
    "PRRevertRequest",
    "PullRequestInfo",
    "RepoProvider",
    "SandboxProvider",
    "SandboxResult",
    "SandboxSpec",
    "get_default_pr_provider",
    "get_default_repo_provider",
    "get_default_sandbox_provider",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .pr import (
        GitHubPRProvider,
        LocalPRProvider,
        PRCreateRequest,
        PRProvider,
        PRRevertRequest,
        get_default_pr_provider,
    )
    from .repo import (
        CommitInfo,
        FileEntry,
        GitHubRepoProvider,
        LocalRepoProvider,
        PullRequestInfo,
        RepoProvider,
        get_default_repo_provider,
    )
    from .sandbox import (
        LocalSandboxProvider,
        NullSandboxProvider,
        SandboxProvider,
        SandboxResult,
        SandboxSpec,
        get_default_sandbox_provider,
    )
    from .sandbox_isolated import IsolatedSandboxProvider


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "GitHubPRProvider": (".pr", "GitHubPRProvider"),
    "LocalPRProvider": (".pr", "LocalPRProvider"),
    "PRCreateRequest": (".pr", "PRCreateRequest"),
    "PRProvider": (".pr", "PRProvider"),
    "PRRevertRequest": (".pr", "PRRevertRequest"),
    "get_default_pr_provider": (".pr", "get_default_pr_provider"),
    "CommitInfo": (".repo", "CommitInfo"),
    "FileEntry": (".repo", "FileEntry"),
    "GitHubRepoProvider": (".repo", "GitHubRepoProvider"),
    "LocalRepoProvider": (".repo", "LocalRepoProvider"),
    "PullRequestInfo": (".repo", "PullRequestInfo"),
    "RepoProvider": (".repo", "RepoProvider"),
    "get_default_repo_provider": (".repo", "get_default_repo_provider"),
    "IsolatedSandboxProvider": (
        ".sandbox_isolated", "IsolatedSandboxProvider",
    ),
    "LocalSandboxProvider": (".sandbox", "LocalSandboxProvider"),
    "NullSandboxProvider": (".sandbox", "NullSandboxProvider"),
    "SandboxProvider": (".sandbox", "SandboxProvider"),
    "SandboxResult": (".sandbox", "SandboxResult"),
    "SandboxSpec": (".sandbox", "SandboxSpec"),
    "get_default_sandbox_provider": (
        ".sandbox", "get_default_sandbox_provider",
    ),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access."""
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module
        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
