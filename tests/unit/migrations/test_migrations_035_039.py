"""Migration shape tests for raw SQL files 035-039.

These five files live under ``migrations/`` (not alembic) and were
called out by the audit as untested. This test ensures each one is
non-empty + contains a recognised DDL statement (CREATE/ALTER/DROP)
and at least one expected table or column.
"""

import os
import re
from pathlib import Path

import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"

CASES = [
    (35, "labeling", "labeling"),
    (36, "nl_signals", "nl_signal"),
    (37, "dataset_columns", "dataset_column"),
    (38, "org_clerk_id", "org"),
    (39, "org_member_last_writer", "org_member"),
]


@pytest.mark.parametrize("num,slug,expected_token", CASES)
def test_migration_file_shape(num: int, slug: str, expected_token: str):
    path = MIGRATIONS_DIR / f"{num:03d}_{slug}.sql"
    assert path.exists(), f"Missing migration: {path}"
    text = path.read_text()
    assert text.strip(), f"Empty migration: {path}"
    ddl = re.search(r"\b(CREATE|ALTER|DROP)\b", text, re.IGNORECASE)
    assert ddl, f"No DDL statement in {path}"
    assert expected_token.lower() in text.lower(), (
        f"Expected token {expected_token!r} not found in {path}"
    )
