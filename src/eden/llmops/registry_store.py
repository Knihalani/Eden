"""Storage layer for per-org upstream model registry entries.

Used by the AI Gateway (A1) to resolve a logical model name
("gpt-4o-mini") into a concrete upstream call (provider, base URL,
decrypted API key, target model id). The gateway in A1 falls back
to its static list when the per-org table is empty for a given
logical name.

Encryption is mandatory: every write goes through
``eden.api.utils.encryption.encrypt_value``; reads decrypt on
demand and the plaintext key only ever leaves this module in the
``UpstreamModelConfig.upstream_api_key`` field that the gateway
holds in memory. The HTTP layer never sees the plaintext.

This module is intentionally pure-Postgres + Fernet — no FastAPI
imports — so it is also reachable from the gateway hot path,
background workers, and the static-fallback code path in A1.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from eden.api.utils.encryption import decrypt_value, encrypt_value
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


# Whitelist of provider identifiers. The gateway in A1 maps each
# of these to a concrete adapter (OpenAI Chat Completions wire,
# Anthropic Messages wire, AWS Bedrock, OpenRouter, or a generic
# OpenAI-compatible local endpoint).
SUPPORTED_PROVIDERS = frozenset(
    {"openai", "anthropic", "bedrock", "openrouter", "local"}
)


@dataclass
class UpstreamModelConfig:
    """One row of the ``org_gateway_models`` table, decrypted.

    ``upstream_api_key`` is the decrypted plaintext — only ever
    constructed inside this module or the A1 gateway caller.
    """

    model_id: str
    org_id: str
    name: str
    provider: str
    upstream_model: str
    upstream_api_key: str
    upstream_key_prefix: str
    endpoint: Optional[str]
    enabled: bool
    routing_priority: int
    metadata: dict[str, Any]
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    def to_public_dict(self) -> dict[str, Any]:
        """Public shape: no plaintext key, only the last-4 prefix."""
        return {
            "model_id": self.model_id,
            "org_id": self.org_id,
            "name": self.name,
            "provider": self.provider,
            "upstream_model": self.upstream_model,
            "upstream_key_prefix": self.upstream_key_prefix,
            "endpoint": self.endpoint,
            "enabled": self.enabled,
            "routing_priority": self.routing_priority,
            "metadata": self.metadata,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat()
            if isinstance(self.created_at, datetime)
            else self.created_at,
            "updated_at": self.updated_at.isoformat()
            if isinstance(self.updated_at, datetime)
            else self.updated_at,
        }


def _mask_prefix(plaintext: str) -> str:
    """Return a short, non-reversible prefix for UI display."""
    if not plaintext:
        return ""
    return plaintext[-4:]


def _validate_provider(provider: str) -> str:
    """Normalise and validate the provider identifier."""
    provider = (provider or "").strip().lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(
            f"Unsupported provider '{provider}'. "
            f"Supported: {sorted(SUPPORTED_PROVIDERS)}"
        )
    return provider


def _row_to_config(row: dict[str, Any]) -> UpstreamModelConfig:
    """Convert a raw Postgres row into a typed, decrypted config."""
    ciphertext = row.get("upstream_api_key_encrypted") or ""
    plaintext = decrypt_value(ciphertext) if ciphertext else ""
    created_at = row.get("created_at")
    updated_at = row.get("updated_at")
    if isinstance(created_at, datetime) and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    if isinstance(updated_at, datetime) and updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    return UpstreamModelConfig(
        model_id=str(row["model_id"]),
        org_id=str(row["org_id"]),
        name=row["name"],
        provider=row["provider"],
        upstream_model=row["upstream_model"],
        upstream_api_key=plaintext,
        upstream_key_prefix=row.get("upstream_key_prefix") or "",
        endpoint=row.get("endpoint"),
        enabled=bool(row.get("enabled", True)),
        routing_priority=int(row.get("routing_priority") or 100),
        metadata=row.get("metadata") or {},
        created_by=row.get("created_by"),
        created_at=created_at,
        updated_at=updated_at,
    )


async def list_models(
    org_id: str,
    *,
    enabled_only: bool = False,
) -> list[UpstreamModelConfig]:
    """Return all model rows for an org, ordered by routing priority.

    When ``enabled_only`` is true, disabled rows are filtered out
    — the gateway uses this in its hot path.
    """
    client = await get_postgres_client()
    if client is None:
        return []
    sql = """
        SELECT model_id, org_id, name, provider, upstream_model,
               upstream_api_key_encrypted, upstream_key_prefix,
               endpoint, enabled, routing_priority, metadata,
               created_by, created_at, updated_at
        FROM org_gateway_models
        WHERE org_id = $1
    """
    if enabled_only:
        sql += " AND enabled = TRUE"
    sql += " ORDER BY routing_priority ASC, name ASC"
    rows = await client.fetch(sql, org_id)
    return [_row_to_config(dict(r)) for r in rows]


async def get_model(
    org_id: str,
    name: str,
    *,
    enabled_only: bool = True,
) -> Optional[UpstreamModelConfig]:
    """Return the highest-priority enabled row for ``org_id`` + ``name``."""
    client = await get_postgres_client()
    if client is None:
        return None
    sql = """
        SELECT model_id, org_id, name, provider, upstream_model,
               upstream_api_key_encrypted, upstream_key_prefix,
               endpoint, enabled, routing_priority, metadata,
               created_by, created_at, updated_at
        FROM org_gateway_models
        WHERE org_id = $1 AND name = $2
    """
    if enabled_only:
        sql += " AND enabled = TRUE"
    sql += " ORDER BY routing_priority ASC LIMIT 1"
    row = await client.fetchrow(sql, org_id, name)
    if not row:
        return None
    return _row_to_config(dict(row))


async def get_model_by_id(
    org_id: str, model_id: str
) -> Optional[UpstreamModelConfig]:
    """Return a single row by id, scoped to the org."""
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        uuid.UUID(model_id)
    except (TypeError, ValueError):
        return None
    row = await client.fetchrow(
        """
        SELECT model_id, org_id, name, provider, upstream_model,
               upstream_api_key_encrypted, upstream_key_prefix,
               endpoint, enabled, routing_priority, metadata,
               created_by, created_at, updated_at
        FROM org_gateway_models
        WHERE org_id = $1 AND model_id = $2
        """,
        org_id,
        model_id,
    )
    if not row:
        return None
    return _row_to_config(dict(row))


async def create_model(
    org_id: str,
    *,
    name: str,
    provider: str,
    upstream_model: str,
    upstream_api_key: str,
    endpoint: Optional[str] = None,
    enabled: bool = True,
    routing_priority: int = 100,
    metadata: Optional[dict[str, Any]] = None,
    created_by: Optional[str] = None,
) -> UpstreamModelConfig:
    """Insert a new registry row. Encrypts the API key at rest."""
    provider = _validate_provider(provider)
    if not name or not name.strip():
        raise ValueError("name is required")
    if not upstream_model or not upstream_model.strip():
        raise ValueError("upstream_model is required")

    ciphertext = encrypt_value(upstream_api_key or "")
    key_prefix = _mask_prefix(upstream_api_key or "")
    model_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO org_gateway_models (
            model_id, org_id, name, provider, upstream_model,
            upstream_api_key_encrypted, upstream_key_prefix,
            endpoint, enabled, routing_priority, metadata,
            created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        """,
        model_id,
        org_id,
        name.strip(),
        provider,
        upstream_model.strip(),
        ciphertext,
        key_prefix,
        (endpoint or None),
        bool(enabled),
        int(routing_priority),
        dict(metadata or {}),
        created_by,
        now,
        now,
    )
    return UpstreamModelConfig(
        model_id=model_id,
        org_id=org_id,
        name=name.strip(),
        provider=provider,
        upstream_model=upstream_model.strip(),
        upstream_api_key=upstream_api_key or "",
        upstream_key_prefix=key_prefix,
        endpoint=endpoint,
        enabled=bool(enabled),
        routing_priority=int(routing_priority),
        metadata=dict(metadata or {}),
        created_by=created_by,
        created_at=now,
        updated_at=now,
    )


async def update_model(
    org_id: str,
    model_id: str,
    *,
    upstream_model: Optional[str] = None,
    upstream_api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    enabled: Optional[bool] = None,
    routing_priority: Optional[int] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> Optional[UpstreamModelConfig]:
    """Patch one row. ``None`` fields are left unchanged.

    Passing ``upstream_api_key=""`` clears the key (used by the
    portal "rotate to empty" flow, if any). Pass any non-empty
    value to rotate.
    """
    try:
        uuid.UUID(model_id)
    except (TypeError, ValueError):
        return None

    sets: list[str] = []
    args: list[Any] = []
    idx = 3  # $1 = org_id, $2 = model_id — SET clauses start at $3

    if upstream_model is not None:
        if not upstream_model.strip():
            raise ValueError("upstream_model cannot be empty")
        sets.append(f"upstream_model = ${idx}")
        args.append(upstream_model.strip())
        idx += 1
    if upstream_api_key is not None:
        sets.append(f"upstream_api_key_encrypted = ${idx}")
        args.append(encrypt_value(upstream_api_key))
        idx += 1
        sets.append(f"upstream_key_prefix = ${idx}")
        args.append(_mask_prefix(upstream_api_key))
        idx += 1
    if endpoint is not None:
        sets.append(f"endpoint = ${idx}")
        args.append(endpoint or None)
        idx += 1
    if enabled is not None:
        sets.append(f"enabled = ${idx}")
        args.append(bool(enabled))
        idx += 1
    if routing_priority is not None:
        sets.append(f"routing_priority = ${idx}")
        args.append(int(routing_priority))
        idx += 1
    if metadata is not None:
        sets.append(f"metadata = ${idx}::jsonb")
        args.append(dict(metadata))
        idx += 1

    if not sets:
        return await get_model_by_id(org_id, model_id)

    sets.append("updated_at = NOW()")
    sql = (
        "UPDATE org_gateway_models SET "
        + ", ".join(sets)
        + " WHERE org_id = $1 AND model_id = $2"
    )
    client = await get_postgres_client()
    await client.execute(sql, org_id, model_id, *args)
    return await get_model_by_id(org_id, model_id)


async def delete_model(org_id: str, model_id: str) -> bool:
    """Delete a row. Returns True if a row was actually removed."""
    try:
        uuid.UUID(model_id)
    except (TypeError, ValueError):
        return False
    client = await get_postgres_client()
    result = await client.execute(
        "DELETE FROM org_gateway_models WHERE org_id = $1 AND model_id = $2",
        org_id,
        model_id,
    )
    # asyncpg returns the command tag as a string like "DELETE 1"
    if isinstance(result, str):
        return result.endswith(" 1")
    return bool(result)


def names_only(configs: Iterable[UpstreamModelConfig]) -> list[str]:
    """Helper for the gateway's static-fallback path."""
    return [c.name for c in configs]
