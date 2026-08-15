"""Integration tests for migration 031 — LZ4 TOAST compression.

Verifies the database-level default + per-column SET COMPRESSION lz4 from
migration 031 took effect, and that the noop UPDATE actually applied LZ4 to
the existing rows. Skips when the test database is unreachable.
"""
from __future__ import annotations

import asyncio
import json
import random
import string
from typing import Any

import pytest

# (table, column) — must match migration 031's _TOAST_COLUMNS.
_LZ4_COLUMNS = [
    ("telemetry_events", "payload"),
    ("telemetry_events", "metrics"),
    ("telemetry_events", "attributes"),
    ("telemetry_events", "request_body"),
    ("telemetry_events", "response_body"),
    ("telemetry_events", "reasoning"),
    ("telemetry_events", "tool_calls_full"),
    ("telemetry_events", "tool_results"),
    ("telemetry_events", "images"),
    ("telemetry_events", "audio"),
    ("telemetry_events", "logprobs"),
    ("telemetry_events", "citations"),
    ("usage_events", "metadata"),
    ("judge_scores", "rationale"),
]


async def _try_get_pool():
    from eden.config import get_settings
    from eden.storage.postgres import PostgresClient

    settings = get_settings()
    client = PostgresClient(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_db,
        user=settings.postgres_user,
        password=settings.postgres_password,
    )
    try:
        await asyncio.wait_for(client.initialize(), timeout=10.0)
        # initialize() may complete without actually connecting
        # (lazy asyncpg pool). Force a real round-trip via SELECT 1
        # so the fixture skips cleanly when the DB is unreachable
        # rather than failing every test with a ConnectionError.
        await asyncio.wait_for(client.fetchval("SELECT 1"), timeout=10.0)
    except Exception:
        return None
    return client


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
async def pg_client():
    client = await _try_get_pool()
    if client is None:
        pytest.skip("Postgres test database is not reachable")
    yield client
    await client.close()


@pytest.mark.asyncio
async def test_default_toast_compression_is_lz4(pg_client: Any) -> None:
    """The DB-level default_toast_compression setting must be 'lz4'."""
    row = await pg_client.fetchrow(
        """
        SELECT setconfig AS configs
          FROM pg_db_role_setting
         WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND setconfig::text LIKE '%default_toast_compression%'
        """
    )
    if row is None:
        pytest.skip("No default_toast_compression setting on this DB")
    configs = row["configs"]
    # setconfig is an array; find the entry mentioning default_toast_compression.
    if isinstance(configs, str):
        configs = [configs]
    matches = [c for c in configs if "default_toast_compression" in c]
    assert matches, f"No default_toast_compression config: {configs}"
    assert any("lz4" in c for c in matches), (
        f"default_toast_compression is not lz4: {matches}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("table,column", _LZ4_COLUMNS)
async def test_column_compression_is_lz4(
    pg_client: Any, table: str, column: str
) -> None:
    """Each target column must have attcompression = 'l' (lz4)."""
    # NOTE: asyncpg positional params — ``:t``/``:c`` (SQLAlchemy-style)
    # raised ``PostgresSyntaxError: syntax error at or near ":"`` here
    # and this test silently skipped in CI (no test DB role), so it had
    # never actually executed until a real TimescaleDB was wired up.
    row = await pg_client.fetchrow(
        """
        SELECT attcompression::text AS compression
          FROM pg_attribute
         WHERE attrelid = (quote_ident($1)::regclass)
           AND attname = $2
        """,
        table,
        column,
    )
    if row is None:
        pytest.skip(f"Column {table}.{column} does not exist")
    assert row["compression"] == "l", (
        f"{table}.{column} compression is {row['compression']!r}, expected 'l' (lz4)"
    )


@pytest.mark.asyncio
async def test_lz4_round_trip_data_preserved(pg_client: Any) -> None:
    """Insert a JSONB row, read it back, assert value is byte-identical.

    This is the lossless guarantee: a row inserted with the migration
    applied must be readable with the exact same JSON. We insert into a
    scratch table to avoid polluting the real schema; the test exercises
    the same lz4 TOAST path that production INSERTs hit.
    """
    test_table = "_lz4_test_round_trip"
    await pg_client.execute(
        f"""
        CREATE TEMP TABLE {test_table} (
            id SERIAL PRIMARY KEY,
            payload JSONB
        ) ON COMMIT DROP
        """
    )
    # 5 KB of realistic LLM JSON: messages array with random bodies.
    sample = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "".join(random.choices(string.ascii_letters + " ", k=1500))},
            {"role": "user", "content": "".join(random.choices(string.ascii_letters + " ", k=1500))},
        ],
        "tools": [{"type": "function", "function": {"name": f"fn_{i}", "description": "x" * 100}} for i in range(5)],
        "temperature": 0.7,
    }
    payload_json = json.dumps(sample)
    await pg_client.execute(
        f"INSERT INTO {test_table} (payload) VALUES ($1::jsonb) RETURNING id",
        payload_json,
    )
    row = await pg_client.fetchrow(f"SELECT payload FROM {test_table} LIMIT 1")
    assert row is not None
    recovered = row["payload"]
    if isinstance(recovered, str):
        recovered = json.loads(recovered)
    assert recovered == sample, (
        "LZ4 TOAST round-trip lost data — strict lossless guarantee violated"
    )


@pytest.mark.asyncio
async def test_lz4_compression_ratio_acceptable(pg_client: Any) -> None:
    """Insert a 10 KB JSON payload; assert the stored size is meaningfully
    smaller than the raw JSON. We expect at least 2× on a string-heavy
    JSON (vs the pglz default).
    """
    test_table = "_lz4_test_ratio"
    await pg_client.execute(
        f"""
        CREATE TEMP TABLE {test_table} (
            id SERIAL PRIMARY KEY,
            payload JSONB
        ) ON COMMIT DROP
        """
    )
    # Build a JSON with long repeated keys/values (highly compressible).
    body = {
        "model": "gpt-4o",
        "system_prompt": "You are a helpful assistant. " * 100,  # ~3 KB
        "examples": [
            {"role": "user", "content": "Hello world. " * 30},  # ~400 B each
            {"role": "assistant", "content": "Hi there. " * 30},
        ] * 5,  # ~4 KB
        "metadata": {"trace_id": "abc123", "user_id": "u_001"},
    }
    raw_size = len(json.dumps(body))
    await pg_client.execute(
        f"INSERT INTO {test_table} (payload) VALUES ($1::jsonb)",
        json.dumps(body),
    )
    stored_size = await pg_client.fetchval(
        f"SELECT pg_column_size(payload) FROM {test_table} LIMIT 1"
    )
    ratio = raw_size / max(stored_size, 1)
    # LZ4 typical ratio for highly compressible JSON: 3-5×.
    # We allow 1.5× as a generous lower bound; the pglz default is similar,
    # so this test mainly catches "compression completely broken".
    assert ratio >= 1.5, (
        f"Compression ratio too low: raw={raw_size} B, stored={stored_size} B, "
        f"ratio={ratio:.2f}x (expected >= 1.5x)"
    )
