"""The boot-time KB schema must be re-runnable and name real extensions.

``initialize_kb()`` executes ``migrations/001_kb_schema.sql`` on EVERY
application start, and under ``EDEN_PRODUCTION=1`` any failure there is
re-raised rather than warned about (src/eden/api/app.py, the
``initialize_kb`` block). So a single non-idempotent statement in that
file is not a cosmetic issue — it is an unconditional crash loop the
moment production mode is switched on.

Both defects below were real and both were live:

  1. ``CREATE EXTENSION IF NOT EXISTS "pgvector"`` — "pgvector" is the
     name of the *project*; the extension is named "vector". The wrong
     name fails even with IF NOT EXISTS, because IF NOT EXISTS only
     suppresses the already-installed case, not an unknown name. Neon
     reported it as InsufficientPrivilegeError ("not in the allowed
     extensions list"), which reads like a permissions problem and
     sent earlier investigation down the wrong path entirely.

  2. Seven CREATE TABLE, twenty-six CREATE INDEX and two CREATE TRIGGER
     statements had no idempotency guard, so the second boot against a
     populated database died on `relation "jobs" already exists`.

Together these are why EDEN_PRODUCTION=1 could never be turned on.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

#: The file initialize_kb() executes at startup.
SCHEMA_FILE = (
    Path(__file__).resolve().parents[3] / "migrations" / "001_kb_schema.sql"
)

#: Extension names that genuinely exist and are allowed on Neon.
#: Deliberately a strict allowlist: a typo'd extension name is
#: unrecoverable at boot, so guessing is not acceptable here.
KNOWN_EXTENSIONS = {
    "vector",
    "uuid-ossp",
    "pgcrypto",
    "pg_trgm",
    "timescaledb",
}

#: The specific wrong name that shipped, called out so the failure
#: message explains itself rather than just listing a set difference.
PROJECT_NAMES_THAT_ARE_NOT_EXTENSIONS = {"pgvector"}


def _sql() -> str:
    assert SCHEMA_FILE.is_file(), f"boot schema missing: {SCHEMA_FILE}"
    return SCHEMA_FILE.read_text()


def _statements(sql: str) -> list[str]:
    """Strip comments, then split into statements."""
    no_comments = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    )
    return [s.strip() for s in no_comments.split(";") if s.strip()]


class TestBootSchemaIsIdempotent:
    @pytest.mark.parametrize("verb", ["TABLE", "INDEX"])
    def test_create_statements_guard_against_reruns(self, verb: str):
        offenders = [
            stmt.splitlines()[0]
            for stmt in _statements(_sql())
            if re.match(rf"^CREATE\s+(UNIQUE\s+)?{verb}\b", stmt, re.I)
            and not re.search(r"IF\s+NOT\s+EXISTS", stmt, re.I)
        ]
        assert not offenders, (
            f"{len(offenders)} CREATE {verb} statement(s) in the boot schema "
            f"lack IF NOT EXISTS. This file re-runs on every start and "
            f"raises under EDEN_PRODUCTION=1, so the second boot crash-loops "
            f"the API: {offenders}"
        )

    def test_triggers_are_replaceable(self):
        offenders = [
            stmt.splitlines()[0]
            for stmt in _statements(_sql())
            if re.match(r"^CREATE\s+TRIGGER\b", stmt, re.I)
        ]
        assert not offenders, (
            "CREATE TRIGGER has no IF NOT EXISTS form; use CREATE OR "
            f"REPLACE TRIGGER so a re-run is a no-op: {offenders}"
        )


class TestBootSchemaExtensionNames:
    def test_every_extension_actually_exists(self):
        named = {
            m.group(1).strip('"')
            for m in re.finditer(
                r"CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"
                r'("?[\w-]+"?)',
                _sql(),
                re.I,
            )
        }
        unknown = named - KNOWN_EXTENSIONS
        assert not unknown, (
            f"unknown Postgres extension(s) {unknown} in the boot schema. "
            f"IF NOT EXISTS does NOT protect against a wrong name — it "
            f"still fails, and on Neon it fails as InsufficientPrivilegeError, "
            f"which looks like a permissions problem rather than a typo. "
            f"Known-good: {sorted(KNOWN_EXTENSIONS)}"
        )

    def test_pgvector_is_never_used_as_an_extension_name(self):
        for wrong in PROJECT_NAMES_THAT_ARE_NOT_EXTENSIONS:
            assert not re.search(
                rf'CREATE\s+EXTENSION[^;]*"?{wrong}"?', _sql(), re.I
            ), (
                f'"{wrong}" is the project name, not the extension name. '
                f'The extension is "vector".'
            )
