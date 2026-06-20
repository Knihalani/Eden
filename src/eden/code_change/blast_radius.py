"""BlastRadiusAnalyzer — compute a 0-1 blast-radius score + affected ids.

Two signals combined (40% static + 60% dynamic, per v1.6 cat spec):

1. **Static** — how many call sites / functions does the patched
   code touch? Walks the diff for changed function definitions
   + the file count. Optional T1 model classifies the bucket.

2. **Dynamic** — how many distinct traces in the last 30 days
   executed this code path? Reads from ``telemetry_events``
   (org-scoped) where ``attributes->>'code_path'`` matches any
   patched file.

Blocks PR creation if ``blast_radius_score > max_blast_radius_score``.
The 40/60 weighting matches the Cat 2 RCA confidence adjustment.
"""

from __future__ import annotations

import logging
import math
import re
from typing import Any

from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


STATIC_WEIGHT = 0.4
DYNAMIC_WEIGHT = 0.6

_STATIC_BUCKETS = (
    (0.05, "leaf"),
    (0.25, "small_utility"),
    (0.40, "shared_utility"),
    (0.65, "service"),
    (0.85, "middleware"),
    (0.95, "critical_path"),
)

_DEF_RE = re.compile(
    r"^\+\s*(?:def|class|async\s+def|function)\s+([A-Za-z_][\w]*)",
    re.MULTILINE,
)
_FILE_HEADER_RE = re.compile(r"^\+\+\+\s+\S+", re.MULTILINE)


def _extract_files_from_diff(diff: str) -> list[str]:
    files: list[str] = []
    for header in _FILE_HEADER_RE.findall(diff or ""):
        path = header.split(None, 1)[-1].lstrip("b/")
        if path and path != "/dev/null":
            files.append(path)
    return files


def _extract_changed_definitions(diff: str) -> list[str]:
    return list(set(_DEF_RE.findall(diff or "")))


async def _read_telemetry_trace_count(
    org_id: str, code_paths: list[str], window_days: int = 30,
) -> int:
    if not code_paths:
        return 0
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return 0
        like_clauses = [
            f"attributes->>'code_path' LIKE ${i + 2}"
            for i in range(len(code_paths))
        ]
        where_sql = " OR ".join(like_clauses)
        sql = (
            "SELECT COUNT(DISTINCT trace_id)::int FROM telemetry_events "
            f"WHERE org_id = $1 AND created_at > NOW() - "
            f"({window_days} || ' days')::interval AND ({where_sql})"
        )
        params: tuple[Any, ...] = (org_id,) + tuple(
            f"%{path}%" for path in code_paths
        )
        async with client.acquire() as conn:
            value = await conn.fetchval(sql, *params)
        return int(value or 0)
    except Exception as exc:
        logger.debug("blast_radius: telemetry count failed: %s", exc)
        return 0


async def _classify_static_with_llm(
    router: ModelRouter | None,
    files: list[str],
    definitions: list[str],
) -> float:
    if not files and not definitions:
        return 0.05
    if router is None:
        n_files = len(files)
        n_defs = len(definitions)
        score = min(0.95, 0.05 + 0.1 * n_files + 0.05 * n_defs)
        return _snap_to_bucket(score)

    task = PipelineTask(
        agent="classify",
        description=(
            f"Classify static blast-radius for {n_files} files + "
            f"{n_defs} definitions"
        ),
        slot="fast",
        output_type="format",
        expected_min_length=5,
    )
    try:
        response = await router.aroute(
            task,
            (
                "You are a code-impact classifier. Return ONLY a "
                "single float 0.05-0.95 for the blast-radius bucket:\n"
                "  0.05 = leaf, 0.25 = small utility, 0.40 = shared utility, "
                "0.65 = service, 0.85 = middleware, 0.95 = critical path\n\n"
                f"Files: {files[:10]}\n"
                f"Definitions: {definitions[:10]}"
            ),
            max_tokens=8,
        )
        raw = response.content.strip().split()[0]
        score = float(raw)
        return _snap_to_bucket(max(0.05, min(0.95, score)))
    except Exception as exc:
        logger.debug("blast_radius: LLM classify failed: %s", exc)
        n_files = len(files)
        n_defs = len(definitions)
        return _snap_to_bucket(min(0.95, 0.05 + 0.1 * n_files + 0.05 * n_defs))


def _snap_to_bucket(score: float) -> float:
    return min(_STATIC_BUCKETS, key=lambda b: abs(b[0] - score))[0]


def _dynamic_score(trace_count: int) -> float:
    if trace_count <= 0:
        return 0.05
    return max(0.05, min(0.95, 0.05 + 0.225 * math.log10(max(1, trace_count))))


class BlastRadiusAnalyzer:
    """Compute the 0-1 blast-radius score for a proposed patch."""

    name = "blast_radius_analyzer"

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    async def analyze(
        self,
        org_id: str,
        diff: str,
        repo_id: str,
        *,
        affected_trace_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        files = _extract_files_from_diff(diff)
        definitions = _extract_changed_definitions(diff)
        static_score = await _classify_static_with_llm(
            self._router, files, definitions,
        )
        if affected_trace_ids is None:
            trace_count = await _read_telemetry_trace_count(org_id, files)
            affected_trace_ids = []
        else:
            trace_count = len(affected_trace_ids)
        dynamic_score = _dynamic_score(trace_count)
        blast_radius_score = round(
            STATIC_WEIGHT * static_score + DYNAMIC_WEIGHT * dynamic_score,
            4,
        )
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "blast_radius_score": blast_radius_score,
                "static_score": static_score,
                "dynamic_score": dynamic_score,
                "static_weight": STATIC_WEIGHT,
                "dynamic_weight": DYNAMIC_WEIGHT,
                "files_affected": files,
                "definitions_changed": definitions,
                "affected_trace_count": trace_count,
                "affected_trace_ids": affected_trace_ids,
                "analysis_id": _new_id("blast"),
            },
        )
