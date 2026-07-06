"""Protocol + dataclasses for the repo-graph layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class AffectedArea:
    """One ranked hit from ``find_affected_areas``.

    Attributes:
        path: Repo-relative path (e.g. ``src/eden/foo.py``).
        symbol: The symbol name (function / class) most
            likely involved. Empty when the path-level
            match is enough.
        confidence: A 0-1 confidence score for the hit.
        reason: A short human-readable reason (e.g.
            ``"stack_trace_match"``).
    """

    path: str
    symbol: str = ""
    confidence: float = 0.0
    reason: str = ""


@dataclass
class GraphQueryResult:
    """The structured payload from :meth:`RepoGraphClient.query`.

    Attributes:
        answer: A free-form natural-language answer to
            the query (best-effort).
        snippets: A list of ``(path, line_range, excerpt)``
            tuples with the supporting evidence.
        files: A list of relevant file paths.
        raw: The raw provider payload (kept for debugging).
    """

    answer: str = ""
    snippets: list[tuple[str, str, str]] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


class RepoGraphClient(Protocol):
    """The contract every repo-graph backend implements.

    Methods are all ``async`` and best-effort: a network
    error or missing credentials must return ``None`` /
    empty results, never raise.
    """

    name: str

    async def status(
        self, repo_full_name: str, branch: str = "main",
    ) -> dict[str, Any] | None:
        """Return ``{indexed: bool, latest_sha: str, last_indexed_at: str}``.

        ``None`` on backend failure.
        """
        ...

    async def request_index(
        self,
        repo_full_name: str,
        branch: str = "main",
        *,
        background: bool = True,
    ) -> bool:
        """Kick off indexing. Returns ``True`` if accepted.

        ``background=True`` returns immediately after
        the indexing job is enqueued (the recommended
        default). ``background=False`` waits for the
        index to be queryable before returning (only
        for tests / debug).
        """
        ...

    async def query(
        self, repo_full_name: str, question: str,
        branch: str = "main",
    ) -> GraphQueryResult | None:
        """Query the indexed graph with a natural-language question.

        Returns ``None`` on backend failure or when the
        repo isn't indexed yet.
        """
        ...

    async def find_affected_areas(
        self,
        repo_full_name: str,
        *,
        error_signature: str = "",
        trace_ids: tuple[str, ...] = (),
        file_path_hint: str = "",
        branch: str = "main",
    ) -> list[AffectedArea]:
        """Find files / symbols likely affected by the incident.

        Returns an empty list on backend failure. Order
        is by ``confidence`` descending.
        """
        ...
