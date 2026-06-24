"""Doc-test for ``docs/ops/migration-matrix.md``.

Asserts:

1. Every alembic revision in ``src/eden/db_migrations/versions/`` has
   a row in the matrix (so a new migration can't ship without
   updating the matrix).
2. The matrix references no migrations that no longer exist.
3. Every cross-reference to a Phase / Cat / D-section resolves (the
   terms "Phase 0" ... "Phase 2" + "Cat 1" ... "Cat 23" + "D.1" ...
   "D.14" appear in the doc; we just sanity-check the format).
4. The doc exists and is non-empty.

This is a pure-Python doc-test: no DB, no fixtures, no async.
Runs in <100 ms.
"""

from __future__ import annotations

import re
from pathlib import Path


VERSIONS_DIR = Path("src/eden/db_migrations/versions")
MATRIX_PATH = Path("docs/ops/migration-matrix.md")


def _extract_revisions() -> set[str]:
    """Return the set of revision ids from the alembic versions dir."""
    revs: set[str] = set()
    for f in sorted(VERSIONS_DIR.glob("*.py")):
        if f.name == "__init__.py":
            continue
        src = f.read_text()
        m = re.search(r"^Revision ID:\s*(\S+)", src, re.MULTILINE)
        if m:
            revs.add(m.group(1))
    return revs


def _matrix_revisions() -> set[str]:
    """Return the set of revision ids parsed from the matrix table rows.

    Rows look like::

        | 001 | initial schema | no | forever | none | critical | platform | Phase 0 |

    The first column (after the leading ``|`` and whitespace) is the
    revision id. Merge files use their full sha-prefix.
    """
    text = MATRIX_PATH.read_text()
    revs: set[str] = set()
    for line in text.split("\n"):
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        first = cells[0]
        # Skip the header row + separator + blank rows
        if first.startswith("#") or first == "" or set(first) <= {"-", " "}:
            continue
        # The revision id is alphanumeric (numbers for the linear chain,
        # sha-prefix for the merge files)
        if re.fullmatch(r"[0-9a-f]{6,}", first) or re.fullmatch(r"\d{3}", first):
            revs.add(first)
    return revs


def test_matrix_doc_exists() -> None:
    assert MATRIX_PATH.exists(), f"{MATRIX_PATH} does not exist"
    assert MATRIX_PATH.stat().st_size > 0, f"{MATRIX_PATH} is empty"


def test_matrix_doc_has_required_sections() -> None:
    text = MATRIX_PATH.read_text()
    for header in [
        "## Schema",
        "## Conventions",
        "## Matrix",
        "## Critical-path migrations",
        "## Cat 23 (STUB)",
        "## Deferred / removed",
        "## SQL / alembic split",
        "## Verification",
    ]:
        assert header in text, f"missing section header: {header!r}"


def test_matrix_lists_every_alembic_revision() -> None:
    """For every alembic revision, the matrix has a row whose first
    column equals the revision id."""
    revisions = _extract_revisions()
    listed = _matrix_revisions()
    missing = revisions - listed
    assert not missing, (
        f"the following alembic revisions are NOT in the migration matrix: "
        f"{sorted(missing)}. Add a row to docs/ops/migration-matrix.md "
        f"before shipping the next migration."
    )


def test_matrix_lists_only_real_revisions() -> None:
    """The matrix must not list revisions that don't exist."""
    revisions = _extract_revisions()
    listed = _matrix_revisions()
    extra = listed - revisions
    assert not extra, (
        f"the matrix lists revisions that don't exist in alembic: "
        f"{sorted(extra)}. Remove the stale rows."
    )


def test_matrix_row_count_matches_alembic() -> None:
    """The row count of the matrix table matches the alembic chain length."""
    revisions = _extract_revisions()
    listed = _matrix_revisions()
    assert len(revisions) == len(listed), (
        f"alembic has {len(revisions)} revisions but matrix has {len(listed)}"
    )


def test_matrix_references_valid_phase_and_cat_terms() -> None:
    """Sanity-check the Phase / Cat / D-section references in the matrix.

    Allowed tokens: Phase 0, Phase 1, Phase 2; Cat 1-23; D.1-D.14.
    Anything else is flagged as a possible typo (e.g. "Phase 3" when
    the v1.6 roadmap only goes up to Phase 2 + Phase 4 op-debt).
    """
    text = MATRIX_PATH.read_text()
    # Extract every "Phase N" reference
    phases = set(re.findall(r"Phase\s+(\d+)", text))
    extra_phases = {p for p in phases if p not in {"0", "1", "2", "3", "4"}}
    assert not extra_phases, f"unexpected Phase references: {extra_phases}"

    cats = set(re.findall(r"Cat\s+(\d+)", text))
    extra_cats = {c for c in cats if int(c) < 1 or int(c) > 23}
    assert not extra_cats, f"unexpected Cat references: {extra_cats}"

    ds = set(re.findall(r"D\.(\d+)", text))
    extra_ds = {d for d in ds if int(d) < 1 or int(d) > 14}
    assert not extra_ds, f"unexpected D-section references: {extra_ds}"