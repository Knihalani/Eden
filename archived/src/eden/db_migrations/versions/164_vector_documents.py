"""164 — pgvector vector_documents replaces Qdrant (N4).

Revision ID: 164_vector_documents
Revises: 163_loop_events_outbox_primary
Create Date: 2026-08-10

N4: Qdrant is removed from the stack; semantic vector search moves to
Postgres pgvector. A single generic table stores every collection's
points with free-form JSONB payloads (identical shape to Qdrant points)
so callers that built Qdrant points keep working unchanged:

    vector_documents(collection, point_id, org_id, embedding, payload)

* ``(collection, point_id)`` is the primary key (upserts are
  ``ON CONFLICT DO UPDATE``).
* ``embedding`` is ``vector(1536)`` (text-embedding-3-small dim, the
  dimension every Eden embed path produces).
* HNSW (``vector_cosine_ops``) gives ANN search without the training
  pass ivfflat requires; the index skips NULL embeddings.
* ``(collection, org_id)`` index serves tenant-scoped scans.

Raw SQL with ``IF NOT EXISTS`` so a half-migrated DB recovers with
``alembic upgrade head`` (same idempotency lesson as 077/133/135/163).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "164_vector_documents"
down_revision: str | Sequence[str] | None = "163_loop_events_outbox_primary"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS vector_documents (
            collection TEXT NOT NULL,
            point_id TEXT NOT NULL,
            org_id TEXT,
            embedding vector(1536),
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (collection, point_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_vector_documents_embedding_hnsw
        ON vector_documents USING hnsw (embedding vector_cosine_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_vector_documents_org
        ON vector_documents (collection, org_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS vector_documents")
