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
The final list is the union weighted by source reliability
(stack-trace > request-path > telemetry > LLM).

Persists to ``code_root_cause_links`` with a content-derived
``crcl_<sha256[:16]>`` id so re-runs with the same
``(org, rca_id, file_path)`` are idempotent.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from eden.code_change._common import _delete_then_insert, _select_one
from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import _new_id, _ok_envelope

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
    r'File\s+"([^"]+)",\s*line\s+\d+,\s*in\s+\w+',
)
_NODE_STACK_RE = re.compile(
    r"at\s+\S+\s+\(([^:]+):\d+:\d+\)",
)


def _content_derived_id(*parts: str) -> str:
    """Deterministic ``crcl_<sha256[:16]>`` per ``(org, rca_id, file_path)``."""
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return f"crcl_{h}"


def _stack_trace_files(stack_trace: str | None) -> list[tuple[str, float]]:
    """Source 1: extract file paths from a stack trace."""
    if not stack_trace:
        return []
    out: list[tuple[str, float]] = []
    for match in _PY_STACK_RE.findall(stack_trace):
        if match and not match.startswith("<"):
            out.append((match, 1.0))
    for match in _NODE_STACK_RE.findall(stack_trace):
        if match and not match.startswith("node:"):
            out.append((match, 1.0))
    return out


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

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

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
                    "",  # line_range — extracted by tree-sitter (Gate 2)
                    "",  # function_name
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
