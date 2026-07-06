"""LocalRepoGraph — the no-credentials fallback.

When ``GREPTILE_API_KEY`` is unset (dev / CI / on-prem),
this implementation answers the same queries using the
existing :class:`eden.providers.repo.LocalRepoProvider`
+ the existing :class:`eden.code_change.rca_linker`
heuristics. It's deliberately less capable than the
Greptile path (no cross-file reference graph, no symbol
queries), but it keeps the discipline layer functional
end-to-end without a hosted dependency.

The shape is identical to the Greptile client so the
discipline layer doesn't care which one it's talking to.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

from .protocol import AffectedArea, GraphQueryResult

logger = logging.getLogger(__name__)


_PY_STACK_RE = re.compile(
    r'File\s+"([^"]+)",\s*line\s+\d+,\s*in\s+(\w+)',
)


@dataclass
class LocalIndexStatus:
    indexed: bool = True
    latest_sha: str = ""
    last_indexed_at: str = ""
    status: str = "local"
    raw: dict[str, Any] = field(default_factory=dict)


def _safe_repo_provider() -> Any | None:
    """Return a :class:`LocalRepoProvider` for the cwd, or ``None``."""
    try:
        from eden.providers.repo import LocalRepoProvider
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("LocalRepoGraph: provider import failed: %s", exc)
        return None
    try:
        return LocalRepoProvider(
            repo_path=os.getenv(
                "EDEN_LOCAL_REPO_PATH",
                os.getcwd(),
            ),
        )
    except Exception as exc:
        logger.debug("LocalRepoGraph: provider init failed: %s", exc)
        return None


def _git_head_sha() -> str:
    """Best-effort: read the current HEAD SHA via git."""
    import shutil
    import subprocess
    git = shutil.which("git")
    if git is None:
        return ""
    try:
        out = subprocess.check_output(
            [git, "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return out.decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


class LocalRepoGraph:
    """The fallback :class:`RepoGraphClient` implementation."""

    name: str = "local"

    def __init__(self, repo_path: str | None = None) -> None:
        self._provider = _safe_repo_provider()

    async def status(
        self, repo_full_name: str, branch: str = "main",
    ) -> dict[str, Any] | None:
        return {
            "indexed": True,
            "latest_sha": _git_head_sha(),
            "last_indexed_at": "",
            "status": "local",
            "raw": {"provider": "local"},
        }

    async def request_index(
        self,
        repo_full_name: str,
        branch: str = "main",
        *,
        background: bool = True,
    ) -> bool:
        # The local graph is always "indexed" because it
        # reads from the working tree on every call. A
        # request_index is a no-op that returns True so
        # callers can wire it identically to Greptile.
        return True

    async def query(
        self, repo_full_name: str, question: str,
        branch: str = "main",
    ) -> GraphQueryResult | None:
        """Best-effort: extract file path mentions from the question.

        The local fallback can't run a semantic graph
        query. It returns a result that lists the file
        paths mentioned in the question (the caller's
        evidence usually carries them as ``src/eden/foo.py``
        literals). For more elaborate queries the answer
        is empty and the discipline layer will count it
        as low evidence.
        """
        if self._provider is None:
            return GraphQueryResult(answer="", files=[], snippets=[])
        # Find path-shaped tokens in the question.
        path_re = re.compile(r"[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx|go|java|rs)")
        files = sorted(set(path_re.findall(question or "")))
        return GraphQueryResult(
            answer="",
            snippets=[(p, "", "") for p in files],
            files=files,
            raw={"provider": "local"},
        )

    async def find_affected_areas(
        self,
        repo_full_name: str,
        *,
        error_signature: str = "",
        trace_ids: tuple[str, ...] = (),
        file_path_hint: str = "",
        branch: str = "main",
    ) -> list[AffectedArea]:
        """Use stack-trace + path-hint extraction.

        Three signals:

        1. If ``file_path_hint`` is provided, it's the
           strongest signal — confidence 0.9.
        2. If ``error_signature`` looks like a Python
           traceback, parse it for ``File "..."`` lines
           and use each as an affected area.
        3. Otherwise: empty list.
        """
        out: list[AffectedArea] = []
        if file_path_hint:
            out.append(AffectedArea(
                path=file_path_hint,
                symbol="",
                confidence=0.9,
                reason="file_path_hint",
            ))
        if error_signature:
            for match in _PY_STACK_RE.finditer(error_signature):
                path = match.group(1)
                symbol = match.group(2)
                if not path:
                    continue
                # Dedup: don't double-list a path that
                # already came in via file_path_hint.
                if any(a.path == path for a in out):
                    continue
                out.append(AffectedArea(
                    path=path,
                    symbol=symbol,
                    confidence=0.7,
                    reason="stack_trace_match",
                ))
        out.sort(key=lambda a: a.confidence, reverse=True)
        return out
