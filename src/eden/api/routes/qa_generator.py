"""Phase J — synthetic Q/A generation API routes.

Three routes:

  * ``POST /orgs/{org}/synthetic/generate`` — run a generation
  * ``GET  /orgs/{org}/synthetic/runs``    — list past runs
  * ``GET  /orgs/{org}/synthetic/runs/{id}`` — fetch a run

The :class:`QAGenerator` does the real work; this module is
the FastAPI wiring. Persistent storage of runs is intentionally
minimal — the runtime metadata goes to ``synthetic_qa_runs``
(via the existing ``datasets`` table from Cat 3) and the
generated triples are returned in the response for the user
to stream into Phase D's labeling queue or a Cat 3 dataset.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.data_platform.qa_generator import (
    ALL_QA_TYPES,
    MAX_CONTEXT_CHARS,
    QA_TYPE_ABSTRACTIVE,
    QA_TYPE_EXTRACTIVE,
    QA_TYPE_MULTI_HOP,
    QAGenerator,
    SyntheticQA,
)


logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/synthetic",
    tags=["synthetic"],
)


# ── Schemas ───────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1, max_length=200_000,
        description="Source text. May be plain text, markdown, or a single CSV cell.",
    )
    source_format: str = Field(
        default="text",
        pattern="^(text|markdown|csv)$",
        description="Hint for chunking + provenance.",
    )
    locale: str = Field(
        default="en",
        description="Locale of the FakerVault swaps (en/es/ar/ja/fr/de/zh).",
    )
    qa_type: str = Field(
        default=QA_TYPE_EXTRACTIVE,
        description="extractive | abstractive | multi_hop",
    )
    qa_per_chunk: int = Field(
        default=3, ge=1, le=20,
        description="How many triples per chunk (extractive only).",
    )
    chunk_size: int = Field(
        default=800, ge=100, le=10_000,
        description="Characters per chunk window.",
    )
    chunk_overlap: int = Field(
        default=100, ge=0, le=1_000,
        description="Overlap between adjacent windows.",
    )
    tags: list[str] = Field(default_factory=list)


class QAResponse(BaseModel):
    """One synthetic Q/A triple."""
    id: str
    question: str
    answer: str
    context: str
    source_chunk_id: str
    qa_type: str
    locale: str
    tags: list[str]
    difficulty: int
    source_chunks: list[str]
    metadata: dict[str, Any]
    created_at: str


class GenerateResponse(BaseModel):
    run_id: str
    qa_type: str
    locale: str
    triple_count: int
    triples: list[QAResponse]


# ── Helpers ───────────────────────────────────────────────────────


def _get_user():
    from eden.api.routes.auth import get_current_user
    return get_current_user


def _qa_to_response(qa: SyntheticQA) -> QAResponse:
    return QAResponse(**qa.to_dict())


# ── Routes ────────────────────────────────────────────────────────


@router.post(
    "/generate",
    response_model=GenerateResponse,
    summary="Generate synthetic Q/A triples from text",
)
async def generate_qa(
    body: GenerateRequest,
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(_get_user()),
) -> GenerateResponse:
    """Run the generator and return the batch of triples.

    The triples are returned inline (no DB persistence in
    this PR). The next PR wires the optional ``promote``
    endpoint that pushes a batch to a Cat 3 dataset.
    """
    if body.qa_type not in ALL_QA_TYPES:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unknown_qa_type",
                "kind": "unknown_qa_type",
                "detail": f"qa_type must be one of {sorted(ALL_QA_TYPES)}",
            },
        )
    if body.chunk_overlap >= body.chunk_size:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "chunk_overlap_too_large",
                "kind": "chunk_overlap_too_large",
                "detail": f"chunk_overlap ({body.chunk_overlap}) must be < chunk_size ({body.chunk_size})",
            },
        )

    generator = QAGenerator(
        chunk_size=body.chunk_size,
        chunk_overlap=body.chunk_overlap,
        qa_per_chunk=body.qa_per_chunk,
    )
    triples = generator.generate(
        body.text,
        source_format=body.source_format,
        locale=body.locale,
        qa_type=body.qa_type,
        tags=body.tags,
    )
    return GenerateResponse(
        run_id=str(uuid.uuid4()),
        qa_type=body.qa_type,
        locale=body.locale,
        triple_count=len(triples),
        triples=[_qa_to_response(t) for t in triples],
    )


# Stub routes for the list / fetch endpoints. The persistence
# layer is the next PR; for now we return a 501 with a clear
# message. The generator itself is fully functional via
# ``POST /generate``.

@router.get(
    "/runs",
    summary="List past Q/A generation runs (Phase J.5 follow-up)",
)
async def list_runs(
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> dict[str, Any]:
    raise HTTPException(
        status_code=501,
        detail={
            "error": "not_implemented",
            "detail": "synthetic Q/A run persistence ships in Phase J.5 (sibling of Cat 3 dataset promotion)",
        },
    )


@router.get(
    "/runs/{run_id}",
    summary="Fetch a Q/A generation run (Phase J.5 follow-up)",
)
async def get_run(
    org_id: str = Path(...),
    run_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> dict[str, Any]:
    raise HTTPException(
        status_code=501,
        detail={
            "error": "not_implemented",
            "detail": "synthetic Q/A run persistence ships in Phase J.5",
        },
    )
