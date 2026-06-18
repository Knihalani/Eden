"""Schema registry for Bronze-layer events.

Manages Avro/JSON schemas for all event types flowing through the Bronze layer:
- Schema registration and versioning
- Event validation against registered schemas
- Schema evolution tracking (backward/forward compatibility)
- Integration with the Bronze sink for automatic schema enforcement

In production this would wrap Confluent Schema Registry or AWS Glue.
This implementation uses PostgreSQL for durability.

Usage:
    from eden.data_platform.schema_registry import SchemaRegistry
    registry = SchemaRegistry()
    await registry.register_schema("usage_event", schema_json, version="1.0")
    ok, errors = await registry.validate_event("usage_event", event_dict)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class SchemaVersion:
    """A single version of a registered schema."""

    schema_id: str
    schema_type: str  # "json", "avro", "protobuf"
    version: str
    definition: dict[str, Any]
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    is_active: bool = True
    compatibility: str = "BACKWARD"  # BACKWARD, FORWARD, FULL, NONE


@dataclass
class SchemaValidationResult:
    """Result of validating an event against a schema."""

    valid: bool
    schema_id: str
    version: str
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class SchemaRegistry:
    """In-house schema registry for Bronze-layer events.

    Features:
    - Schema registration with versioning
    - JSON Schema validation (via jsonschema when available)
    - Compatibility checking between schema versions
    - Integration with Bronze sink for automatic schema enforcement
    """

    def __init__(self) -> None:
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    async def init_tables(self) -> None:
        """Ensure schema registry tables exist. Idempotent."""
        client = await self._get_postgres()
        await client.execute("""
            CREATE TABLE IF NOT EXISTS schema_registry (
                schema_id         VARCHAR(128) PRIMARY KEY,
                schema_type       VARCHAR(32) NOT NULL DEFAULT 'json',
                latest_version    VARCHAR(32) NOT NULL DEFAULT '1.0',
                created_at        TIMESTAMPTZ DEFAULT NOW(),
                updated_at        TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await client.execute("""
            CREATE TABLE IF NOT EXISTS schema_versions (
                version_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                schema_id         VARCHAR(128) NOT NULL REFERENCES schema_registry(schema_id),
                version           VARCHAR(32) NOT NULL,
                definition        JSONB NOT NULL,
                compatibility     VARCHAR(32) DEFAULT 'BACKWARD',
                is_active         BOOLEAN DEFAULT TRUE,
                created_at        TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(schema_id, version)
            )
        """)
        await client.execute("""
            CREATE INDEX IF NOT EXISTS idx_schema_versions_active
            ON schema_versions (schema_id, is_active, created_at DESC)
        """)
        logger.info("Schema registry tables initialized")

    async def register_schema(
        self,
        schema_id: str,
        definition: dict[str, Any],
        version: str = "1.0",
        schema_type: str = "json",
        compatibility: str = "BACKWARD",
    ) -> str:
        """Register a new schema version.

        Returns the version_id.
        """
        await self.init_tables()
        client = await self._get_postgres()

        # Ensure schema exists in registry
        await client.execute("""
            INSERT INTO schema_registry (schema_id, schema_type, latest_version)
            VALUES ($1, $2, $3)
            ON CONFLICT (schema_id) DO UPDATE SET
                latest_version = EXCLUDED.latest_version,
                updated_at = NOW()
        """, schema_id, schema_type, version)

        # Insert version
        version_id = await client.fetchval("""
            INSERT INTO schema_versions (schema_id, version, definition, compatibility, is_active)
            VALUES ($1, $2, $3, $4, TRUE)
            ON CONFLICT (schema_id, version) DO UPDATE SET
                definition = EXCLUDED.definition,
                compatibility = EXCLUDED.compatibility,
                updated_at = NOW()
            RETURNING version_id
        """, schema_id, version, json.dumps(definition), compatibility)

        logger.info(f"Schema registered: {schema_id} v{version}")
        return str(version_id)

    async def get_schema(
        self,
        schema_id: str,
        version: str | None = None,
    ) -> SchemaVersion | None:
        """Get a schema definition by ID and optional version.

        If version is omitted, returns the latest active version.
        """
        client = await self._get_postgres()
        if version:
            row = await client.fetchrow("""
                SELECT sv.*, sr.schema_type
                FROM schema_versions sv
                JOIN schema_registry sr ON sv.schema_id = sr.schema_id
                WHERE sv.schema_id = $1 AND sv.version = $2
            """, schema_id, version)
        else:
            row = await client.fetchrow("""
                SELECT sv.*, sr.schema_type
                FROM schema_versions sv
                JOIN schema_registry sr ON sv.schema_id = sr.schema_id
                WHERE sv.schema_id = $1 AND sv.is_active = TRUE
                ORDER BY sv.created_at DESC
                LIMIT 1
            """, schema_id)

        if not row:
            return None

        return SchemaVersion(
            schema_id=row["schema_id"],
            schema_type=row["schema_type"],
            version=row["version"],
            definition=json.loads(row["definition"]) if isinstance(row["definition"], str) else row["definition"],
            created_at=row["created_at"].isoformat() if hasattr(row["created_at"], "isoformat") else str(row["created_at"]),
            is_active=row["is_active"],
            compatibility=row["compatibility"],
        )

    async def validate_event(
        self,
        schema_id: str,
        event: dict[str, Any],
        version: str | None = None,
    ) -> SchemaValidationResult:
        """Validate an event against a registered schema.

        Uses jsonschema when available; falls back to lightweight validation.
        """
        schema = await self.get_schema(schema_id, version)
        if not schema:
            return SchemaValidationResult(
                valid=False,
                schema_id=schema_id,
                version=version or "unknown",
                errors=[f"Schema not found: {schema_id}"],
            )

        definition = schema.definition

        # Try jsonschema if available
        try:
            import jsonschema
            jsonschema.validate(instance=event, schema=definition)
            return SchemaValidationResult(
                valid=True,
                schema_id=schema_id,
                version=schema.version,
            )
        except ImportError:
            pass
        except jsonschema.ValidationError as exc:
            return SchemaValidationResult(
                valid=False,
                schema_id=schema_id,
                version=schema.version,
                errors=[str(exc)],
            )

        # Fallback: lightweight structural validation
        return self._fallback_validate(event, definition, schema_id, schema.version)

    def _fallback_validate(
        self,
        event: dict[str, Any],
        definition: dict[str, Any],
        schema_id: str,
        version: str,
    ) -> SchemaValidationResult:
        """Lightweight JSON schema validation without jsonschema dependency."""
        errors: list[str] = []
        warnings: list[str] = []

        required = definition.get("required", [])
        properties = definition.get("properties", {})

        for field_name in required:
            if field_name not in event or event[field_name] is None:
                errors.append(f"Missing required field: {field_name}")

        for field_name, prop in properties.items():
            if field_name in event and event[field_name] is not None:
                value = event[field_name]
                prop_type = prop.get("type")

                if prop_type == "string" and not isinstance(value, str):
                    errors.append(f"Field '{field_name}' expected string, got {type(value).__name__}")
                elif prop_type == "integer" and not isinstance(value, int):
                    errors.append(f"Field '{field_name}' expected integer, got {type(value).__name__}")
                elif prop_type == "number" and not isinstance(value, (int, float)):
                    errors.append(f"Field '{field_name}' expected number, got {type(value).__name__}")
                elif prop_type == "boolean" and not isinstance(value, bool):
                    errors.append(f"Field '{field_name}' expected boolean, got {type(value).__name__}")
                elif prop_type == "object" and not isinstance(value, dict):
                    errors.append(f"Field '{field_name}' expected object, got {type(value).__name__}")
                elif prop_type == "array" and not isinstance(value, list):
                    errors.append(f"Field '{field_name}' expected array, got {type(value).__name__}")

                # Enum check
                enum_values = prop.get("enum")
                if enum_values and value not in enum_values:
                    errors.append(f"Field '{field_name}' value '{value}' not in allowed values: {enum_values}")

        return SchemaValidationResult(
            valid=len(errors) == 0,
            schema_id=schema_id,
            version=version,
            errors=errors,
            warnings=warnings,
        )

    async def list_schemas(self) -> list[dict[str, Any]]:
        """List all registered schemas."""
        client = await self._get_postgres()
        rows = await client.fetch("""
            SELECT schema_id, schema_type, latest_version, created_at, updated_at
            FROM schema_registry
            ORDER BY schema_id
        """)
        return [dict(r) for r in rows]

    async def list_versions(self, schema_id: str) -> list[dict[str, Any]]:
        """List all versions of a schema."""
        client = await self._get_postgres()
        rows = await client.fetch("""
            SELECT version, compatibility, is_active, created_at
            FROM schema_versions
            WHERE schema_id = $1
            ORDER BY created_at DESC
        """, schema_id)
        return [dict(r) for r in rows]

    async def check_compatibility(
        self,
        schema_id: str,
        new_definition: dict[str, Any],
    ) -> tuple[bool, list[str]]:
        """Check if a new schema definition is backward compatible with the latest version.

        Returns (is_compatible, list_of_issues).
        """
        latest = await self.get_schema(schema_id)
        if not latest:
            # First version — always compatible
            return True, []

        issues: list[str] = []
        old_props = latest.definition.get("properties", {})
        old_required = set(latest.definition.get("required", []))
        new_props = new_definition.get("properties", {})
        new_required = set(new_definition.get("required", []))

        # Backward compatibility: old readers must read new data
        # - Cannot remove required fields
        # - Cannot change types of existing fields
        for field_name, old_prop in old_props.items():
            if field_name not in new_props:
                if field_name in old_required:
                    issues.append(f"Cannot remove required field '{field_name}'")
            else:
                new_prop = new_props[field_name]
                old_type = old_prop.get("type")
                new_type = new_prop.get("type")
                if old_type and new_type and old_type != new_type:
                    issues.append(
                        f"Cannot change type of '{field_name}' from {old_type} to {new_type}"
                    )

        return len(issues) == 0, issues


# ── Built-in schemas for Eden event types ──────────────────────────────────

USAGE_EVENT_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["org_id", "event_type", "resource", "quantity", "unit", "timestamp"],
    "properties": {
        "org_id": {"type": "string", "format": "uuid"},
        "user_id": {"type": "string", "format": "uuid"},
        "event_type": {"type": "string", "enum": [
            "llm_call", "job_start", "job_complete", "job_cancel",
            "storage", "sandbox", "api_request", "benchmark_run",
        ]},
        "resource": {"type": "string", "enum": ["tokens", "jobs", "storage_mb", "sandbox_seconds", "requests"]},
        "quantity": {"type": "number", "minimum": 0},
        "unit": {"type": "string"},
        "model": {"type": "string"},
        "cost_usd": {"type": "number", "minimum": 0},
        "metadata": {"type": "object"},
        "correlation_id": {"type": "string"},
        "timestamp": {"type": "string", "format": "date-time"},
    },
}

AGENT_TRACE_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["trace_id", "org_id", "job_id", "event_type", "timestamp"],
    "properties": {
        "trace_id": {"type": "string", "format": "uuid"},
        "org_id": {"type": "string", "format": "uuid"},
        "job_id": {"type": "string", "format": "uuid"},
        "event_type": {"type": "string", "enum": [
            "agent.start", "agent.think", "agent.act", "agent.tool_call",
            "agent.tool_result", "agent.complete", "agent.error", "agent.pause", "agent.resume",
        ]},
        "payload": {"type": "object"},
        "duration_ms": {"type": "integer", "minimum": 0},
        "input_tokens": {"type": "integer", "minimum": 0},
        "output_tokens": {"type": "integer", "minimum": 0},
        "timestamp": {"type": "string", "format": "date-time"},
    },
}

PIPELINE_EVENT_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["job_id", "org_id", "stage", "status", "timestamp"],
    "properties": {
        "job_id": {"type": "string", "format": "uuid"},
        "org_id": {"type": "string", "format": "uuid"},
        "stage": {"type": "string"},
        "status": {"type": "string", "enum": ["success", "error", "started", "completed"]},
        "duration_ms": {"type": "integer", "minimum": 0},
        "error_message": {"type": "string"},
        "metadata": {"type": "object"},
        "timestamp": {"type": "string", "format": "date-time"},
    },
}

BENCHMARK_EVENT_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["benchmark_id", "org_id", "event_type", "timestamp"],
    "properties": {
        "benchmark_id": {"type": "string", "format": "uuid"},
        "org_id": {"type": "string", "format": "uuid"},
        "job_id": {"type": "string", "format": "uuid"},
        "event_type": {"type": "string", "enum": [
            "benchmark.start", "benchmark.run_complete", "benchmark.suite_complete", "benchmark.failed",
        ]},
        "score": {"type": "number"},
        "passed": {"type": "boolean"},
        "duration_ms": {"type": "integer", "minimum": 0},
        "metadata": {"type": "object"},
        "timestamp": {"type": "string", "format": "date-time"},
    },
}


async def register_default_schemas(registry: SchemaRegistry) -> None:
    """Register the built-in Eden event schemas."""
    await registry.register_schema("usage_event", USAGE_EVENT_SCHEMA, version="1.0")
    await registry.register_schema("agent_trace", AGENT_TRACE_SCHEMA, version="1.0")
    await registry.register_schema("pipeline_event", PIPELINE_EVENT_SCHEMA, version="1.0")
    await registry.register_schema("benchmark_event", BENCHMARK_EVENT_SCHEMA, version="1.0")
    logger.info("Default schemas registered in schema registry")
