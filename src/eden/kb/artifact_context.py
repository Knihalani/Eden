"""Team-uploaded agent artifact context (FEAT-148).

Rows live in ``agent_artifact_context`` (migration 157). Book/Ledger
synthesis reads them; ``BookGatewayFilter`` stays unchanged — context
flows in upstream via regenerated Book/Ledger content.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

_CONTENT_PREVIEW_LEN = 280
_ALLOWED_EXTENSIONS = (".txt", ".md", ".markdown")


def is_allowed_context_filename(filename: str) -> bool:
    lower = (filename or "").lower()
    return any(lower.endswith(ext) for ext in _ALLOWED_EXTENSIONS)


def infer_context_content_type(filename: str) -> str:
    lower = (filename or "").lower()
    if lower.endswith(".md") or lower.endswith(".markdown"):
        return "text/markdown"
    return "text/plain"


def serialize_context_row(row: dict[str, Any]) -> dict[str, Any]:
    """API-safe row for portal list (preview, no full body)."""
    content = (row.get("content") or "").strip()
    preview = content[:_CONTENT_PREVIEW_LEN]
    created_at = row.get("created_at")
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()
    return {
        "id": str(row.get("id") or ""),
        "org_id": str(row.get("org_id") or ""),
        "agent_id": row.get("agent_id"),
        "filename": row.get("filename"),
        "content_type": row.get("content_type"),
        "content_preview": preview,
        "preview_truncated": len(content) > len(preview),
        "size_bytes": len(content.encode("utf-8")),
        "created_by": row.get("created_by"),
        "created_at": created_at,
    }


async def insert_agent_context(
    org_id: str,
    agent_id: str,
    *,
    filename: str,
    content: str,
    content_type: str,
    created_by: str,
) -> dict[str, Any] | None:
    """Persist one team-uploaded context document."""
    try:
        from uuid import uuid4

        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return None
        row_id = uuid4()
        await client.execute(
            """
            INSERT INTO agent_artifact_context (
                id, org_id, agent_id, filename, content_type, content, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            row_id,
            org_id,
            agent_id,
            filename,
            content_type,
            content,
            created_by,
        )
        rows = await list_agent_context(org_id, agent_id, limit=1)
        for row in rows:
            if str(row.get("id")) == str(row_id):
                return row
        return {
            "id": row_id,
            "org_id": org_id,
            "agent_id": agent_id,
            "filename": filename,
            "content_type": content_type,
            "content": content,
            "created_by": created_by,
        }
    except Exception as exc:
        logger.debug("insert_agent_context failed: %s", exc)
        return None


async def list_agent_context(
    org_id: str,
    agent_id: str,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Return recent team-uploaded context rows for an agent."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT id, org_id, agent_id, filename, content_type, content,
                   created_by, created_at
            FROM agent_artifact_context
            WHERE org_id = $1 AND agent_id = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            org_id,
            agent_id,
            limit,
        )
        return [dict(r) for r in rows or []]
    except Exception as exc:
        logger.debug("list_agent_context failed: %s", exc)
        return []


def format_book_section(rows: list[dict[str, Any]], *, max_chars: int = 4000) -> str:
    """Markdown section for ``BookGenerator._synthesize``."""
    if not rows:
        return "## Team context\n_No team-uploaded context yet._"
    lines: list[str] = []
    remaining = max_chars
    for row in rows:
        name = row.get("filename") or "context"
        body = (row.get("content") or "").strip()
        if not body:
            continue
        chunk = f"### {name}\n{body}"
        if len(chunk) > remaining:
            chunk = chunk[: max(0, remaining - 1)] + "…"
            lines.append(chunk)
            break
        lines.append(chunk)
        remaining -= len(chunk) + 2
        if remaining <= 0:
            break
    if not lines:
        return "## Team context\n_No team-uploaded context yet._"
    return "## Team context\n" + "\n\n".join(lines)


def format_ledger_appendix(
    rows: list[dict[str, Any]],
    *,
    max_chars: int = 1200,
) -> tuple[str, list[str]]:
    """Return (appendix text, citation ids) for Ledger upserts."""
    if not rows:
        return "", []
    citations: list[str] = []
    parts: list[str] = []
    remaining = max_chars
    for row in rows:
        cid = str(row.get("id") or "")
        if cid:
            citations.append(f"context:{cid}")
        name = row.get("filename") or "context"
        body = (row.get("content") or "").strip()
        if not body:
            continue
        snippet = body[: min(400, remaining)]
        if len(body) > len(snippet):
            snippet += "…"
        part = f"Team context ({name}): {snippet}"
        if len(part) > remaining:
            break
        parts.append(part)
        remaining -= len(part) + 1
        if remaining <= 0:
            break
    if not parts:
        return "", citations
    return "\n".join(parts), citations
