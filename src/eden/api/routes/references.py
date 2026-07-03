"""Organization-scoped code reference routes for Eden.

Allows users to upload code examples as references for Eden to learn from.
References are org-scoped and include purpose labels.
"""

import hashlib
import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status

from eden.api.deps import (
    get_current_user,
    require_org_member,
    require_org_permission_dep,
)
from eden.api.routes.billing import check_limit
from eden.storage.postgres import get_postgres_client

import os  # Audit 2026-06-22 B1.22 — for filename sanitization

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/references", tags=["code-references"])


async def generate_embedding(text: str) -> list[float]:
    """Generate embedding for code reference.

    Uses a simple deterministic embedding based on text content.
    In production, this would call an actual embedding model.
    """
    # Simple bag-of-words embedding
    words = text.lower().split()
    vector = [0.0] * 1536
    for i, word in enumerate(words[:1536]):
        # Simple hash-based weighting
        vector[i % 1536] += hash(word) % 100 / 100.0

    # Normalize
    magnitude = sum(v * v for v in vector) ** 0.5
    vector = [v / magnitude for v in vector] if magnitude > 0 else [0.0] * 1536

    return vector


def compute_content_hash(content: str) -> str:
    """Compute SHA256 hash of content for deduplication."""
    return hashlib.sha256(content.encode()).hexdigest()


def detect_language(filename: str, content: str) -> str:
    """Detect programming language from filename or content."""
    ext_map = {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".jsx": "javascript",
        ".go": "go",
        ".rs": "rust",
        ".java": "java",
        ".rb": "ruby",
        ".php": "php",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".cs": "csharp",
        ".swift": "swift",
        ".kt": "kotlin",
        ".scala": "scala",
        ".r": "r",
        ".R": "r",
        ".sql": "sql",
        ".sh": "shell",
        ".bash": "shell",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".json": "json",
        ".xml": "xml",
        ".html": "html",
        ".css": "css",
        ".md": "markdown",
    }

    for ext, lang in ext_map.items():
        if filename.endswith(ext):
            return lang

    # Try content-based detection
    if "def " in content and ":" in content:
        return "python"
    if "function" in content or "const " in content:
        return "javascript"
    if "func " in content and "package" in content:
        return "go"

    return "text"


class CodeReferenceResponse:
    """Response schema for code reference."""
    def __init__(self, id: str, name: str, description: str | None, purpose: str,
                 filename: str, language: str, uploaded_by: str, created_at: str):
        self.id = id
        self.name = name
        self.description = description
        self.purpose = purpose
        self.filename = filename
        self.language = language
        self.uploaded_by = uploaded_by
        self.created_at = created_at


@router.post("", response_model=dict)
async def upload_reference(
    org_id: str,
    name: str = Form(..., max_length=200),
    # Audit 2026-06-22 B1.22 — cap purpose length to prevent 5MB form fields.
    purpose: str = Form(..., max_length=64),
    description: str | None = Form(None, max_length=2_000),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
        _check_references_upload: dict = Depends(require_org_permission_dep('references:upload')),
):
    """Upload a code reference to the organization's library.

    - name: Display name for the reference
    - purpose: What this is a reference for (e.g., "Auth patterns", "API conventions")
    - description: Optional description
    - file: The code file to upload
    """

    # Check reference limit before uploading
    if await check_limit(org_id, "references"):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Reference limit reached. Upgrade your plan to add more references.",
        )

    client = await get_postgres_client()
    user_id = user["user_id"]

    # Audit 2026-06-22 B1.22 — sanitize filename to prevent path-traversal.
    safe_filename = os.path.basename(file.filename or "upload.txt")
    if ".." in safe_filename or safe_filename.startswith("."):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid filename",
        )

    # Read file content
    content = await file.read()
    try:
        text_content = content.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be UTF-8 encoded text",
        ) from None
    # Validate size (max 500KB)
    if len(content) > 500 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be under 500KB",
        )

    # Generate embedding
    embedding = await generate_embedding(text_content)

    # Detect language
    language = detect_language(file.filename, text_content)

    # Compute hash for deduplication
    content_hash = compute_content_hash(text_content)

    # Insert reference
    ref_id = str(uuid4())
    query = """
        INSERT INTO code_references (
            id, org_id, uploaded_by, name, description, purpose,
            filename, language, content, content_hash, embedding, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}')
        RETURNING id
    """
    row = await client.fetchrow(
        query,
        ref_id,
        org_id,
        user_id,
        name,
        description,
        purpose,
        file.filename,
        language,
        text_content,
        content_hash,
        embedding,
    )

    return {
        "id": str(row["id"]),
        "name": name,
        "purpose": purpose,
        "filename": file.filename,
        "language": language,
        "message": "Reference uploaded successfully",
    }


@router.get("", response_model=list[dict])
async def list_references(
    org_id: str,
    purpose: str | None = None,
    language: str | None = None,
    user: dict | None = None,
):
    """List code references in the organization.

    Filters:
    - purpose: Filter by reference purpose
    - language: Filter by programming language
    """
    await require_org_member(org_id)

    client = await get_postgres_client()

    conditions = ["org_id = $1"]
    params = [org_id]
    param_idx = 2

    if purpose:
        conditions.append(f"purpose = ${param_idx}")
        params.append(purpose)
        param_idx += 1

    if language:
        conditions.append(f"language = ${param_idx}")
        params.append(language)
        param_idx += 1

    where_clause = " AND ".join(conditions)

    query = f"""
        SELECT id, name, description, purpose, filename, language,
               uploaded_by, created_at
        FROM code_references
        WHERE {where_clause}
        ORDER BY created_at DESC
    """
    rows = await client.fetch(query, *params)

    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "description": r["description"],
            "purpose": r["purpose"],
            "filename": r["filename"],
            "language": r["language"],
            "uploaded_by": str(r["uploaded_by"]),
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


@router.get("/{ref_id}", response_model=dict)
async def get_reference(org_id: str, ref_id: str, user: dict | None = None):
    """Get a single code reference with content."""
    await require_org_member(org_id)

    client = await get_postgres_client()

    query = """
        SELECT id, name, description, purpose, filename, language,
               content, uploaded_by, created_at
        FROM code_references
        WHERE id = $1 AND org_id = $2
    """
    row = await client.fetchrow(query, ref_id, org_id)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reference not found",
        )

    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "purpose": row["purpose"],
        "filename": row["filename"],
        "language": row["language"],
        "content": row["content"],
        "uploaded_by": str(row["uploaded_by"]),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


@router.delete("/{ref_id}", response_model=dict)
async def delete_reference(org_id: str, ref_id: str, user: dict = Depends(get_current_user),
        _check_references_delete: dict = Depends(require_org_permission_dep('references:delete')),
):
    """Delete a code reference (requires references:delete permission or be the uploader)."""
    # Audit 2026-06-22 B1.10 — drop dead try/except, add user dep.
    client = await get_postgres_client()

    # Verify ownership BEFORE delete; the permission dep already passed.
    ref = await client.fetchrow(
        "SELECT uploaded_by, org_id FROM code_references WHERE id = $1",
        ref_id,
    )
    if not ref or str(ref.get("org_id")) != org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reference not found",
        )
    if str(ref["uploaded_by"]) != user["user_id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the uploader or org admin can delete this reference",
        )

    # Audit 2026-06-22 B1.10 — org_id filter on DELETE prevents cross-org writes.
    await client.execute(
        "DELETE FROM code_references WHERE id = $1 AND org_id = $2",
        ref_id, org_id,
    )

    return {"message": "Reference deleted"}


@router.get("/search/by-text", response_model=list[dict])
async def search_references(
    org_id: str,
    # Audit 2026-06-22 B1.14 — cap query length to prevent 1MB embedding requests.
    q: str = Query(..., max_length=2_000),
    user: dict = Depends(get_current_user),
):
    """Search code references by text similarity.

    Uses embedding-based semantic search.
    """
    await require_org_member(org_id)

    client = await get_postgres_client()

    # Generate embedding for query
    query_embedding = await generate_embedding(q)

    # Search using vector similarity
    query = """
        SELECT id, name, description, purpose, filename, language,
               1 - (embedding <=> $1) as similarity
        FROM code_references
        WHERE org_id = $2 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1
        LIMIT 10
    """
    rows = await client.fetch(query, query_embedding, org_id)

    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "description": r["description"],
            "purpose": r["purpose"],
            "filename": r["filename"],
            "language": r["language"],
            "similarity": round(r["similarity"], 3),
        }
        for r in rows
    ]


@router.get("/purposes", response_model=list[str])
async def list_purposes(org_id: str, user: dict | None = None):
    """List all unique purpose labels in the organization."""
    await require_org_member(org_id)

    client = await get_postgres_client()

    query = """
        SELECT DISTINCT purpose FROM code_references
        WHERE org_id = $1
        ORDER BY purpose
    """
    rows = await client.fetch(query, org_id)

    return [r["purpose"] for r in rows]
