"""Greptile repo-graph implementation.

Talks to the Greptile API:
https://docs.greptile.com/quickstart

The endpoints we use:

* ``POST /v2/repositories`` — submit a repo for indexing
  (background=True by default). Returns the job id.
* ``GET /v2/repositories/{owner}/{repo}`` — fetch the
  indexed repo metadata, including ``latestIndexedSha``
  and ``status``.
* ``POST /v2/query`` — run a natural-language query
  against the indexed graph. Returns the answer +
  relevant snippets.

Auth: ``Authorization: Bearer <GREPTILE_API_KEY>``.

Failure modes: every method degrades to ``None`` / empty
results on a non-2xx response, an aiohttp timeout, or a
missing key. The discipline layer treats "no graph
context" as a lower evidence_count, not a hard failure.

Activation: requires ``GREPTILE_API_KEY``. When the key
is missing, the factory falls back to :class:`LocalRepoGraph`.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

from .protocol import AffectedArea, GraphQueryResult

# Module-level singleton httpx client (mirrors the F42 pattern in
# ``eden.providers.pr``). Each ``async with httpx.AsyncClient(...)`` opens
# a fresh client and discards keep-alive sockets at scope exit; the
# singleton keeps the TCP pool warm across calls.
_HTTPX: httpx.AsyncClient | None = None


def _shared_httpx(timeout: float) -> httpx.AsyncClient:
    global _HTTPX
    if _HTTPX is None:
        _HTTPX = httpx.AsyncClient(timeout=timeout)
    return _HTTPX

logger = logging.getLogger(__name__)


GREPTILE_BASE_URL = os.getenv(
    "GREPTILE_BASE_URL", "https://api.greptile.com",
)
GREPTILE_TIMEOUT_SECONDS = float(
    os.getenv("GREPTILE_TIMEOUT_SECONDS", "20"),
)


@dataclass
class IndexStatus:
    """The state of a Greptile-indexed repo.

    Attributes:
        indexed: ``True`` if the repo is queryable.
        latest_sha: The most recent commit indexed.
        last_indexed_at: ISO-8601 timestamp.
        status: Greptile's status string
            (``"submitted"``, ``"cloning"``, ``"indexed"``,
            ``"failed"``).
        raw: The raw provider payload.
    """

    indexed: bool = False
    latest_sha: str = ""
    last_indexed_at: str = ""
    status: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-GitHub-URL": "https://github.com",
    }


class GreptileRepoGraph:
    """The Greptile implementation of :class:`RepoGraphClient`."""

    name: str = "greptile"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = GREPTILE_BASE_URL,
        timeout: float = GREPTILE_TIMEOUT_SECONDS,
    ) -> None:
        if not api_key:
            raise ValueError(
                "GreptileRepoGraph requires a non-empty api_key"
            )
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    async def status(
        self, repo_full_name: str, branch: str = "main",
    ) -> dict[str, Any] | None:
        """Read the indexed repo status.

        Greptile's API returns
        ``{repository, status, latestIndexedSha, ...}``.
        We map it to the discipline surface shape.
        """
        try:
            async with _shared_httpx(self._timeout) as client:
                r = await client.get(
                    f"{self._base_url}/v2/repositories/{repo_full_name}",
                    headers=_headers(self._api_key),
                    params={"branch": branch},
                )
            if r.status_code != 200:
                logger.debug(
                    "GreptileRepoGraph.status %s: %s",
                    r.status_code,
                    r.text[:200],
                )
                return None
            payload = r.json()
            return {
                "indexed": payload.get("status") == "indexed",
                "latest_sha": payload.get("latestIndexedSha") or "",
                "last_indexed_at": (
                    payload.get("indexedAt") or ""
                ),
                "status": payload.get("status") or "",
                "raw": payload,
            }
        except Exception as exc:
            logger.debug("GreptileRepoGraph.status: %s", exc)
            return None

    async def request_index(
        self,
        repo_full_name: str,
        branch: str = "main",
        *,
        background: bool = True,
    ) -> bool:
        """Submit the repo for (re-)indexing.

        Greptile's ``POST /v2/repositories`` is async by
        design — the call returns a job id and the
        indexing happens in the background. ``background``
        is therefore always ``True`` in practice; the
        parameter exists to match the protocol.
        """
        try:
            async with _shared_httpx(self._timeout) as client:
                r = await client.post(
                    f"{self._base_url}/v2/repositories",
                    headers=_headers(self._api_key),
                    json={
                        "repository": repo_full_name,
                        "branch": branch,
                        "reload": False,
                        "background": bool(background),
                    },
                )
            # Greptile returns 202 Accepted for enqueued jobs.
            if r.status_code not in (200, 201, 202):
                logger.debug(
                    "GreptileRepoGraph.request_index %s: %s",
                    r.status_code,
                    r.text[:200],
                )
                return False
            return True
        except Exception as exc:
            logger.debug("GreptileRepoGraph.request_index: %s", exc)
            return False

    async def query(
        self, repo_full_name: str, question: str,
        branch: str = "main",
    ) -> GraphQueryResult | None:
        """Run a natural-language query against the indexed graph."""
        try:
            async with _shared_httpx(self._timeout) as client:
                r = await client.post(
                    f"{self._base_url}/v2/query",
                    headers=_headers(self._api_key),
                    json={
                        "messages": [
                            {"role": "user", "content": question},
                        ],
                        "repositories": [
                            {
                                "repository": repo_full_name,
                                "branch": branch,
                            },
                        ],
                    },
                )
            if r.status_code != 200:
                logger.debug(
                    "GreptileRepoGraph.query %s: %s",
                    r.status_code,
                    r.text[:200],
                )
                return None
            payload = r.json()
            answer = ""
            if isinstance(payload, dict):
                # Greptile returns ``{"message": "..."}`` or
                # ``{"sources": [...], "answer": "..."}``
                # depending on the endpoint version. We
                # accept either shape.
                answer = (
                    payload.get("answer")
                    or payload.get("message")
                    or ""
                )
                if isinstance(answer, dict):
                    answer = str(answer.get("content") or "")
            sources = payload.get("sources") if isinstance(payload, dict) else None
            snippets: list[tuple[str, str, str]] = []
            files: list[str] = []
            if isinstance(sources, list):
                for src in sources:
                    if not isinstance(src, dict):
                        continue
                    path = src.get("filepath") or src.get("path") or ""
                    if path:
                        files.append(path)
                    snippets.append((
                        path,
                        str(src.get("linestart") or "")
                        + "-"
                        + str(src.get("lineend") or ""),
                        str(src.get("summary") or src.get("snippet") or ""),
                    ))
            return GraphQueryResult(
                answer=str(answer or ""),
                snippets=snippets,
                files=files,
                raw=payload if isinstance(payload, dict) else {},
            )
        except Exception as exc:
            logger.debug("GreptileRepoGraph.query: %s", exc)
            return None

    async def find_affected_areas(
        self,
        repo_full_name: str,
        *,
        error_signature: str = "",
        trace_ids: tuple[str, ...] = (),
        file_path_hint: str = "",
        branch: str = "main",
    ) -> list[AffectedArea]:
        """Use the graph to identify likely-affected areas.

        Implementation: a single ``query`` call that
        frames the evidence as a natural-language question
        ("which files / symbols are most likely the cause
        of <error_signature>?"). The response's
        ``sources`` are converted to ranked
        :class:`AffectedArea` records.

        Degrades to ``[]`` on failure. The discipline
        layer treats an empty list as "no graph context
        for this candidate" — the gate still runs, just
        with a lower evidence_count.
        """
        parts: list[str] = []
        if error_signature:
            parts.append(f"error signature: {error_signature}")
        if trace_ids:
            ids = ", ".join(trace_ids[:5])
            parts.append(f"trace ids: {ids}")
        if file_path_hint:
            parts.append(f"file path hint: {file_path_hint}")
        if not parts:
            return []
        question = (
            "Which files and symbols in this repository are "
            "most likely the root cause or most-affected "
            "by the following incident? "
            + " | ".join(parts)
            + " Return a ranked list of (file_path, symbol, "
            "confidence, reason)."
        )
        result = await self.query(
            repo_full_name, question, branch=branch,
        )
        if result is None:
            return []
        out: list[AffectedArea] = []
        seen: set[str] = set()
        for path, _range, excerpt in result.snippets:
            if not path or path in seen:
                continue
            seen.add(path)
            # Pull a confidence proxy from the snippet
            # length — longer summaries tend to be
            # more specific to the question.
            conf = min(0.9, max(0.2, len(excerpt) / 400.0))
            out.append(AffectedArea(
                path=path,
                symbol="",
                confidence=round(conf, 3),
                reason="greptile_query_snippet",
            ))
        for path in result.files:
            if not path or path in seen:
                continue
            seen.add(path)
            out.append(AffectedArea(
                path=path,
                symbol="",
                confidence=0.3,
                reason="greptile_query_file_ref",
            ))
        out.sort(key=lambda a: a.confidence, reverse=True)
        return out
