"""038 — Extend zstd payload compression to 6 more columns (Phase B2).

Revision ID: 038
Revises: 037
Create Date: 2026-06-19

Phase B2 of the Eden app/storage plan (2026-06-19). Mirrors the
migration 032 pattern (request_body_zstd + response_body_zstd) for
6 more JSONB columns on ``telemetry_events`` that currently sit in
LZ4-TOAST compression but not in dictionary-trained ZSTD.

New BYTEA columns
-----------------
- ``reasoning_zstd``      (paired with ``reasoning``, o1 / Claude thinking)
- ``tool_calls_full_zstd`` (paired with ``tool_calls_full``)
- ``tool_results_zstd``   (paired with ``tool_results``)
- ``payload_zstd``        (paired with ``payload``)
- ``metrics_zstd``        (paired with ``metrics``)
- ``attributes_zstd``     (paired with ``attributes``)

Each new column is ``BYTEA`` and uses the same trained ZSTD
dictionary (``src/eden/storage/compression.py:get_dict``). The
``compress_jsonb`` / ``decompress_jsonb`` helpers are field-agnostic
so no compression code changes are needed.

Backfill: out-of-band (``scripts/backfill_extended_zstd.py``),
matching the migration 032 / request_body_zstd pattern. Run AFTER
deploying the new ``telemetry_collector._route_postgres`` writes
(so new rows write both columns; old rows need the backfill).

Drop originals: gated by migration 039 (``038_zstd_extended_drop.py``)
which is a no-op migration triggered by a 30-day burn-in, mirroring
migration 033.

Why 8 KB dict
-------------
The existing dict was trained on ``request_body`` / ``response_body``
JSON. Adding samples from ``reasoning`` (very repetitive structure),
``tool_calls_full`` (function-calling JSON), ``metrics`` / ``payload``
(key-value objects) widens the dictionary's symbol coverage. The
``train_dictionary`` helper in ``compression.py`` already supports
multi-field samples; retraining is recommended before backfill
(see ``scripts/train_zstd_dict.py`` — pass the new 6 fields).
"""
from alembic import op

revision = "038"
down_revision = "037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Each new column: BYTEA, no default, no NOT NULL (NULL until backfilled).
    new_columns = [
        "reasoning_zstd",
        "tool_calls_full_zstd",
        "tool_results_zstd",
        "payload_zstd",
        "metrics_zstd",
        "attributes_zstd",
    ]
    for col in new_columns:
        op.execute(f'ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS {col} BYTEA;')


def downgrade() -> None:
    new_columns = [
        "reasoning_zstd",
        "tool_calls_full_zstd",
        "tool_results_zstd",
        "payload_zstd",
        "metrics_zstd",
        "attributes_zstd",
    ]
    for col in new_columns:
        op.execute(f'ALTER TABLE telemetry_events DROP COLUMN IF EXISTS {col};')
