"""CodeRootCauseLinker — map a Cat 2 RCA to source files.

4-source correlation (the same pattern as Cat 5's
:class:`MemoryAttributor`):

1. **Stack-trace** — if the RCA carries a Python stack trace,
   regex-extract file paths and look them up in the repo.
2. **Request-path** — for HTTP errors, map the URL path to
   controller files via the diff / file naming convention.
3. **Telemetry attributes** — read ``code_path`` attributes
   from telemetry_events for the same trace_id and link.
4. **LLM inference** — T1 model maps the RCA's natural-language
   description to the most likely file/function.

Each source emits a candidate ``(file_path, confidence)`` pair.

Examples:
    >>> from eden.patches.rca_linker import _SOURCE_WEIGHTS
    >>> set(_SOURCE_WEIGHTS.keys()) == {
    ...     "stack_trace", "request_path", "telemetry", "llm_inference",
    ... }
    True
    >>> sum(_SOURCE_WEIGHTS.values())  # weights should normalise to 1.0
    0.9999...
    >>> _SOURCE_WEIGHTS["stack_trace"] > _SOURCE_WEIGHTS["llm_inference"]
    True
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from eden.optimization.model_router import ModelRouter, PipelineTask
from eden.patches._common import _delete_then_insert

from ._common import _ok_envelope

logger = logging.getLogger(__name__)


# Source weights per the v1.6 cat spec.
_SOURCE_WEIGHTS: dict[str, float] = {
    "stack_trace": 0.40,
    "request_path": 0.25,
    "telemetry": 0.20,
    "llm_inference": 0.15,
}

# Stack-trace extraction. Matches ``File "...", line N, in <fn>``
# (Python) and ``at <fn> (...:N:N)`` (Node) — the two most common
# stack-trace formats.
_PY_STACK_RE = re.compile(
    r'File\s+"([^"]+)",\s*line\s+\d+,\s*in\s+(\w+)',
)
_NODE_STACK_RE = re.compile(
    r"at\s+(\S+)\s+\(([^:]+):\d+:\d+\)",
)


def _content_derived_id(*parts: str) -> str:
    """Deterministic ``crcl_<sha256[:16]>`` per ``(org, rca_id, file_path)``."""
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return f"crcl_{h}"


_LANGUAGE_BY_EXT: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mjs": "javascript",
    ".cjs": "javascript",
}


def _detect_language(file_path: str) -> str:
    """Return the parser language key for ``file_path``.

    Falls back to ``"python"`` because that's the only
    language the stdlib parser handles today; JS/TS
    return their key but the parser currently no-ops
    with a debug log.
    """
    import os

    _, ext = os.path.splitext(file_path)
    return _LANGUAGE_BY_EXT.get(ext.lower(), "python")


def _stack_trace_files(stack_trace: str | None) -> list[tuple[str, float]]:
    """Source 1: extract file paths from a stack trace.

    The regex captures (file_path, function_name). We use
    only the file path here; the function name is read
    separately by :func:`_stack_trace_function` so the
    helper stays a single-purpose file-path extractor.
    """
    if not stack_trace:
        return []
    out: list[tuple[str, float]] = []
    for file_path, _fn in _PY_STACK_RE.findall(stack_trace):
        if file_path and not file_path.startswith("<"):
            out.append((file_path, 1.0))
    for _fn, file_path in _NODE_STACK_RE.findall(stack_trace):
        if file_path and not file_path.startswith("node:"):
            out.append((file_path, 1.0))
    return out


def _stack_trace_function(stack_trace: str | None) -> str:
    """Return the innermost function name in ``stack_trace``.

    Used by the linker to look up the line range via
    :mod:`eden.patches.code_parser`. Returns ``""``
    when the trace is empty or unparseable.

    "Innermost" = the LAST frame in the trace (the deepest
    call site) — that's where the bug usually lives.
    """
    if not stack_trace:
        return ""
    py_frames = _PY_STACK_RE.findall(stack_trace)
    if py_frames:
        return py_frames[-1][1]
    node_frames = _NODE_STACK_RE.findall(stack_trace)
    if node_frames:
        return node_frames[-1][0]
    return ""


def _request_path_files(
    request_path: str | None, candidate_files: list[str],
) -> list[tuple[str, float]]:
    """Source 2: match the URL path against candidate files.

    E.g. ``/api/users/123`` matches a ``users`` controller if
    the candidate set contains ``src/api/users.py``. Confidence
    is 0.8 for an exact match, 0.4 for a substring match.
    """
    if not request_path or not candidate_files:
        return []
    out: list[tuple[str, float]] = []
    segments = [s for s in request_path.split("/") if s]
    for seg in segments:
        seg_lower = seg.lower()
        for cand in candidate_files:
            cand_lower = cand.lower()
            base = cand_lower.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            if base == seg_lower:
                out.append((cand, 0.8))
            elif seg_lower in base or base in seg_lower:
                out.append((cand, 0.4))
    return out


async def _telemetry_files(
    org_id: str, trace_id: str | None, code_paths: list[str],
) -> list[tuple[str, float]]:
    """Source 3: read telemetry_events for the same trace_id."""
    if not trace_id:
        return []
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return []
        async with client.acquire() as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT attributes->>'code_path' AS code_path "
                "FROM telemetry_events WHERE org_id = $1 AND trace_id = $2 "
                "AND attributes ? 'code_path' LIMIT 20",
                org_id, trace_id,
            )
        return [(r["code_path"], 0.7) for r in rows if r.get("code_path")]
    except Exception as exc:
        logger.debug("rca_linker: telemetry read failed: %s", exc)
        return []


async def _llm_infer_files(
    router: ModelRouter | None,
    rca_description: str,
    candidate_files: list[str],
) -> list[tuple[str, float]]:
    """Source 4: ask T1 which file is the most likely root cause."""
    if not router or not rca_description:
        return []
    if not candidate_files:
        return []
    task = PipelineTask(
        agent="classify",
        description="Map an RCA description to the most likely source file",
        slot="fast",
        output_type="format",
        expected_min_length=3,
    )
    try:
        response = await router.aroute(
            task,
            (
                "Given this RCA description, return ONLY the path of the "
                "single most likely source file from the list below. "
                "If none are plausible, return 'none'.\n\n"
                f"RCA: {rca_description[:1000]}\n\n"
                f"Candidates:\n" + "\n".join(
                    f"- {p}" for p in candidate_files[:50]
                )
            ),
            max_tokens=200,
        )
        path = response.content.strip().split("\n")[0].strip().strip("\"'`")
        if path and path != "none" and path in candidate_files:
            return [(path, 0.5)]
    except Exception as exc:
        logger.debug("rca_linker: LLM inference failed: %s", exc)
    return []


def _combine_sources(
    sources: list[list[tuple[str, float]]],
) -> list[tuple[str, float]]:
    """Combine candidates from all sources using the weights."""
    combined: dict[str, float] = {}
    for source_idx, candidates in enumerate(sources):
        weight = list(_SOURCE_WEIGHTS.values())[source_idx]
        for path, conf in candidates:
            combined[path] = combined.get(path, 0.0) + weight * conf
    # Normalise to 0..1 (rough max possible).
    max_w = sum(_SOURCE_WEIGHTS.values())
    return [
        (path, round(score / max_w, 4))
        for path, score in sorted(
            combined.items(), key=lambda kv: kv[1], reverse=True,
        )
    ]


class CodeRootCauseLinker:
    """Map a Cat 2 RCA to source files / functions."""

    name = "code_root_cause_linker"

    def __init__(
        self,
        router: ModelRouter | None = None,
        repo_connector: Any | None = None,
    ) -> None:
        self._router = router
        # Optional :class:`RepoConnector` (or anything with a
        # ``read_file`` method) used by Gate 2 to read the
        # candidate file for line-range extraction. When
        # ``None``, the linker skips line-range extraction
        # and persists an empty ``line_range`` — the same
        # behaviour as the pre-Gate-2 ship.
        self._repo_connector = repo_connector

    async def _extract_line_range(
        self, file_path: str, function_name: str,
    ) -> str:
        """Read ``file_path`` and return the ``start-end`` string.

        Best-effort: returns ``""`` on any failure (no
        connector, file unreadable, function not found,
        language not yet supported). The caller treats
        empty as "no data" and persists an empty column.
        """
        from .code_parser import extract_function_range

        if self._repo_connector is None:
            return ""
        try:
            content = await self._repo_connector.read_file(file_path)
        except Exception as exc:
            logger.debug(
                "rca_linker._extract_line_range: read failed: %s", exc,
            )
            return ""
        if not content:
            return ""
        # Ponytail: the parser auto-detects Python via
        # ``language='python'``. JS/TS would need the
        # file extension hint; for now we default to
        # Python and rely on the parser's graceful miss.
        language = _detect_language(file_path)
        try:
            start, end = extract_function_range(
                content, language, function_name,
            )
        except Exception as exc:
            logger.debug(
                "rca_linker._extract_line_range: parse failed: %s", exc,
            )
            return ""
        if start == 0 and end == 0:
            return ""
        return f"{start}-{end}"

    async def link(
        self,
        org_id: str,
        rca_id: str,
        repo_id: str,
        *,
        rca_description: str = "",
        stack_trace: str | None = None,
        request_path: str | None = None,
        trace_id: str | None = None,
        candidate_files: list[str] | None = None,
    ) -> dict[str, Any]:
        """Run the 4-source attribution + persist the top result.

        ``candidate_files`` is the search universe — typically
        ``provider.list_files()`` output. When omitted, the LLM
        source is skipped (the other 3 still run if their inputs
        are present).
        """
        candidate_files = candidate_files or []

        s1 = _stack_trace_files(stack_trace)
        s2 = _request_path_files(request_path, candidate_files)
        s3 = await _telemetry_files(org_id, trace_id, candidate_files)
        s4 = await _llm_infer_files(
            self._router, rca_description, candidate_files,
        )

        combined = _combine_sources([s1, s2, s3, s4])
        if not combined:
            return _ok_envelope(
                self.name,
                {
                    "rca_id": rca_id,
                    "repo_id": repo_id,
                    "links": [],
                    "primary_link_id": None,
                    "sources_used": [
                        k for k, v in [
                            ("stack_trace", s1),
                            ("request_path", s2),
                            ("telemetry", s3),
                            ("llm_inference", s4),
                        ] if v
                    ],
                },
            )

        # Persist the top candidate as the primary link.
        top_path, top_conf = combined[0]
        link_id = _content_derived_id(org_id, rca_id, top_path)
        # Gate 2: extract the function name from the stack
        # trace and look up the line range via
        # :mod:`eden.patches.code_parser`. The read is
        # best-effort — if the file is unavailable or the
        # parser can't find the function, we leave both
        # columns empty (the same behaviour as the
        # pre-Gate-2 ship).
        function_name = _stack_trace_function(stack_trace)
        line_range_str = ""
        if function_name and self._repo_connector is not None:
            line_range_str = await self._extract_line_range(
                top_path, function_name,
            )
        try:
            await _delete_then_insert(
                org_id,
                "id",
                link_id,
                "code_root_cause_links",
                [
                    "id",
                    "rca_id",
                    "file_path",
                    "line_range",
                    "function_name",
                    "call_graph_path",
                    "confidence",
                    "signal_sources",
                ],
                [
                    link_id,
                    rca_id,
                    top_path,
                    line_range_str,
                    function_name,
                    json.dumps([
                        {"source": k, "path": p, "confidence": c}
                        for k, paths, _ in [
                            ("stack_trace", s1, _SOURCE_WEIGHTS["stack_trace"]),
                            ("request_path", s2, _SOURCE_WEIGHTS["request_path"]),
                            ("telemetry", s3, _SOURCE_WEIGHTS["telemetry"]),
                            ("llm_inference", s4, _SOURCE_WEIGHTS["llm_inference"]),
                        ]
                        for p, c in paths
                    ]),
                    top_conf,
                    json.dumps({
                        "stack_trace": bool(s1),
                        "request_path": bool(s2),
                        "telemetry": bool(s3),
                        "llm_inference": bool(s4),
                    }),
                ],
            )
        except Exception as exc:
            logger.debug("rca_linker: persist failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "rca_id": rca_id,
                "repo_id": repo_id,
                "links": [
                    {"path": p, "confidence": c}
                    for p, c in combined[:5]
                ],
                "primary_link_id": link_id,
                "primary_path": top_path,
                "primary_confidence": top_conf,
                "sources_used": [
                    k for k, v in [
                        ("stack_trace", s1),
                        ("request_path", s2),
                        ("telemetry", s3),
                        ("llm_inference", s4),
                    ] if v
                ],
            },
        )
