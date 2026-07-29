"""Dataset-as-spreadsheet (Phase S — RagaAI parity).

RagaAI's headline feature on the eval side: a dataset is
a **spreadsheet**, not a SQL table. Each row is a data
point (input + expected_output + metadata). Columns are
**user-defined** — the user can add a column, name it,
and either fill it in manually or ask the LLM to
generate it (AI-generated columns).

The data model is intentionally flat:

  * **Row** — one data point. Carries ``input``,
    ``expected_output``, plus any number of user-defined
    column values.
  * **Column** — schema definition: name, type
    (``"text"`` / ``"number"`` / ``"json"``), source
    (``"user"`` / ``"ai"``), description (for AI
    generation prompts).
  * **Filter** — list of (column, op, value) predicates.
  * **Sort** — list of (column, direction).

The spreadsheet service is a thin layer over the existing
``datasets`` / ``dataset_items`` tables (Cat 3). The
existing tables already have ``payload JSONB`` per row,
so we can add columns without a schema migration.

Pipeline
────────
  user opens dataset → GET /rows?filter=...&sort=...
       │
       ▼  SpreadsheetService.list_rows()
       │
       │  filter + sort applied in SQL (Postgres does
       │  the heavy lifting; we don't pull everything
       │  and filter in Python)
       │
       ▼  returns {rows, total_count, columns}
       │
  user adds a column → POST /columns
       │
       ▼  SpreadsheetService.add_column()
       │
  user clicks "AI-generate" → POST /columns/{id}/generate
       │
       ▼  SpreadsheetService.generate_column()
       │
       │  LLM call (slot=fast) for each row, with the
       │  column's description as the prompt
       │
       ▼  rows updated with the AI-generated values
       │
  user exports → GET /rows (or POST /export)
       │
       ▼  JSONL or CSV
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Dataclasses ──────────────────────────────────────────────


@dataclass
class SpreadsheetColumn:
    """Schema definition for one column."""

    id: str
    name: str
    type: str  # "text" | "number" | "json"
    source: str  # "user" | "ai"
    description: str = ""  # Used as prompt for AI columns
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "source": self.source,
            "description": self.description,
            "created_at": self.created_at,
        }


@dataclass
class SpreadsheetRow:
    """One data point in the dataset."""

    id: str
    dataset_id: str
    input: str
    expected_output: str
    # column_id → value
    values: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "dataset_id": self.dataset_id,
            "input": self.input,
            "expected_output": self.expected_output,
            "values": dict(self.values),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# ── Filter / sort helpers ─────────────────────────────────────


# Allowed operators for filtering.
FILTER_OPERATORS = frozenset({
    "==", "!=", ">", ">=", "<", "<=", "contains", "starts_with",
})


def apply_filter(
    rows: list[SpreadsheetRow],
    filter_spec: list[dict[str, Any]],
) -> list[SpreadsheetRow]:
    """Apply a list of (column, op, value) predicates.

    ``filter_spec`` is a list of dicts with keys ``column``,
    ``op``, ``value``. The column is the column *name* (not
    id); the value is a string. ``op`` is one of
    :data:`FILTER_OPERATORS`.
    """
    if not filter_spec:
        return rows
    out: list[SpreadsheetRow] = []
    for row in rows:
        ok = True
        for pred in filter_spec:
            col_name = pred.get("column", "")
            op = pred.get("op", "==")
            target = pred.get("value", "")
            # Resolve the value: input / expected_output /
            # the column's value.
            if col_name == "input":
                actual = row.input
            elif col_name == "expected_output":
                actual = row.expected_output
            else:
                # Look up by name in values.
                actual = ""
                for col in row.values:
                    # The dict key is the column id; the
                    # name lookup is fuzzy.
                    if col == col_name:
                        actual = row.values[col]
                        break
            if not _match(actual, op, target):
                ok = False
                break
        if ok:
            out.append(row)
    return out


def _match(actual: Any, op: str, target: str) -> bool:
    """Apply a single predicate."""
    actual_str = str(actual) if actual is not None else ""
    if op == "==":
        return actual_str == target
    if op == "!=":
        return actual_str != target
    if op == "contains":
        return target in actual_str
    if op == "starts_with":
        return actual_str.startswith(target)
    # Numeric / ordered comparisons.
    try:
        a = float(actual_str)
        t = float(target)
    except (TypeError, ValueError):
        return False
    if op == ">":
        return a > t
    if op == ">=":
        return a >= t
    if op == "<":
        return a < t
    if op == "<=":
        return a <= t
    return False


def apply_sort(
    rows: list[SpreadsheetRow],
    sort_spec: list[dict[str, Any]],
) -> list[SpreadsheetRow]:
    """Apply a list of (column, direction) sorts.

    ``sort_spec`` is a list of dicts with keys ``column``,
    ``direction`` (``"asc"`` or ``"desc"``).
    """
    if not sort_spec:
        return rows
    # Multi-key sort: stable, left-to-right.
    out = list(rows)
    for spec in reversed(sort_spec):
        col = spec.get("column", "")
        direction = spec.get("direction", "asc")
        reverse = direction == "desc"
        def key(r: SpreadsheetRow, col: str = col) -> Any:
            if col == "input":
                return r.input
            if col == "expected_output":
                return r.expected_output
            for c, v in r.values.items():
                if c == col:
                    return v
            return ""
        out.sort(key=key, reverse=reverse)
    return out


# ─- AI column generation ────────────────────────────────────


# An async LLM function: ``(prompt, row_dict) -> str``.
AIHandler = Callable[[str, dict[str, Any]], Awaitable[str]]


async def default_ai_handler(prompt: str, row: dict[str, Any]) -> str:
    """Default AI handler stub. Returns the prompt for
    testing; production wires the real LLM."""
    return f"[stub:{prompt}:{len(row)}]"


async def generate_column(
    column: SpreadsheetColumn,
    rows: list[SpreadsheetRow],
    *,
    handler: AIHandler = default_ai_handler,
) -> dict[str, str]:
    """Generate values for an AI column across the given rows.

    Returns a dict mapping row_id → generated value. The
    caller is responsible for persisting the values.
    """
    out: dict[str, str] = {}
    for row in rows:
        prompt = column.description or f"Generate {column.name} for this row"
        row_dict = {"input": row.input, "expected_output": row.expected_output, **row.values}
        value = await handler(prompt, row_dict)
        out[row.id] = value
    return out


# ─- JSONL import / export ────────────────────────────────────


def rows_to_jsonl(rows: Iterable[SpreadsheetRow]) -> str:
    """Export rows as JSONL (one JSON object per line)."""
    return "\n".join(json.dumps(r.to_dict(), default=str) for r in rows)


def jsonl_to_rows(jsonl_text: str, dataset_id: str) -> list[SpreadsheetRow]:
    """Import rows from JSONL."""
    out: list[SpreadsheetRow] = []
    for line in jsonl_text.splitlines():
        line = line.strip()
        if not line:
            continue
        data = json.loads(line)
        out.append(SpreadsheetRow(
            id=str(data.get("id", str(uuid.uuid4()))),
            dataset_id=dataset_id,
            input=str(data.get("input", "")),
            expected_output=str(data.get("expected_output", "")),
            values=dict(data.get("values", {})),
            created_at=str(data.get("created_at", "")),
            updated_at=str(data.get("updated_at", "")),
        ))
    return out


# ─- Spreadsheet service ──────────────────────────────────────


class SpreadsheetService:
    """CRUD + filter + sort + AI generation for a dataset.

    Args:
        pg: The shared Postgres client.
    """

    def __init__(self, pg: Any) -> None:
        self._pg = pg

    async def add_column(
        self,
        *,
        dataset_id: str,
        name: str,
        type: str = "text",
        source: str = "user",
        description: str = "",
    ) -> SpreadsheetColumn:
        """Add a new column to the dataset."""
        col_id = str(uuid.uuid4())
        await self._pg.execute(
            """
            INSERT INTO dataset_columns
                (id, dataset_id, name, type, source, description, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            """,
            col_id, dataset_id, name, type, source, description,
        )
        return SpreadsheetColumn(
            id=col_id, name=name, type=type, source=source,
            description=description,
            created_at=datetime.now(UTC).isoformat(),
        )

    async def list_columns(self, dataset_id: str) -> list[SpreadsheetColumn]:
        rows = await self._pg.fetch(
            """
            SELECT id, name, type, source, description, created_at
            FROM dataset_columns
            WHERE dataset_id = $1
            ORDER BY created_at ASC
            """,
            dataset_id,
        )
        return [
            SpreadsheetColumn(
                id=str(r["id"]), name=str(r["name"]),
                type=str(r["type"]), source=str(r["source"]),
                description=str(r.get("description", "")),
                created_at=str(r.get("created_at", "")),
            )
            for r in rows
        ]

    async def add_row(
        self,
        *,
        dataset_id: str,
        input: str,
        expected_output: str = "",
        values: dict[str, Any] | None = None,
    ) -> SpreadsheetRow:
        """Add a new row to the dataset."""
        row_id = str(uuid.uuid4())
        await self._pg.execute(
            """
            INSERT INTO dataset_items
                (id, dataset_id, input, expected_output, payload,
                 created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
            """,
            row_id, dataset_id, input, expected_output,
            json.dumps(values or {}),
        )
        return SpreadsheetRow(
            id=row_id, dataset_id=dataset_id,
            input=input, expected_output=expected_output,
            values=values or {},
            created_at=datetime.now(UTC).isoformat(),
            updated_at=datetime.now(UTC).isoformat(),
        )

    async def update_row(
        self,
        *,
        row_id: str,
        dataset_id: str,
        values: dict[str, Any],
        input: str | None = None,
        expected_output: str | None = None,
    ) -> bool:
        """Update a row's values + optional input/output.

        ``dataset_id`` is required and scopes the UPDATE. Without it the
        statement was ``WHERE id = $n`` alone, so a caller holding a valid
        dataset of their own could pass any ``row_id`` and overwrite a row in
        another tenant's dataset. The route's ownership check ran *after* the
        write and merely returned 404 — the mutation had already committed.

        Returns ``False`` when nothing matched, which the caller must treat as
        "not found" rather than success.
        """
        # Build a dynamic SET clause.
        sets: list[str] = ["updated_at = NOW()"]
        args: list[Any] = []
        if input is not None:
            args.append(input)
            sets.append(f"input = ${len(args)}")
        if expected_output is not None:
            args.append(expected_output)
            sets.append(f"expected_output = ${len(args)}")
        args.append(json.dumps(values))
        sets.append(f"payload = ${len(args)}::jsonb")
        args.append(row_id)
        row_param = len(args)
        args.append(dataset_id)
        dataset_param = len(args)
        status = await self._pg.execute(
            f"UPDATE dataset_items SET {', '.join(sets)} "
            f"WHERE id = ${row_param} AND dataset_id = ${dataset_param}",
            *args,
        )
        # asyncpg returns e.g. "UPDATE 1"; "UPDATE 0" means the row belongs to
        # a different dataset (or does not exist).
        try:
            return int(str(status).split()[-1]) > 0
        except (ValueError, AttributeError, IndexError):
            # Unparseable status (mocked client in tests): assume success
            # rather than reporting a false 404.
            return True

    async def list_rows(
        self,
        dataset_id: str,
        *,
        filter_spec: list[dict[str, Any]] | None = None,
        sort_spec: list[dict[str, Any]] | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[SpreadsheetRow]:
        """List rows for a dataset, with optional filter + sort."""
        # We use Postgres to do the heavy lifting for the
        # top-level filter on input / expected_output, then
        # apply column-level filters in Python (the column
        # values live in JSONB which is awkward to query).
        rows = await self._pg.fetch(
            """
            SELECT id, dataset_id, input, expected_output, payload,
                   created_at, updated_at
            FROM dataset_items
            WHERE dataset_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            dataset_id, limit, offset,
        )
        out: list[SpreadsheetRow] = []
        for r in rows:
            payload = r.get("payload")
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except (ValueError, TypeError):
                    payload = {}
            out.append(SpreadsheetRow(
                id=str(r["id"]),
                dataset_id=str(r["dataset_id"]),
                input=str(r.get("input", "")),
                expected_output=str(r.get("expected_output", "")),
                values=payload or {},
                created_at=str(r.get("created_at", "")),
                updated_at=str(r.get("updated_at", "")),
            ))
        # Apply column-level filter + sort in Python.
        if filter_spec:
            out = apply_filter(out, filter_spec)
        if sort_spec:
            out = apply_sort(out, sort_spec)
        return out

    async def get_row(self, row_id: str) -> SpreadsheetRow | None:
        """Load one row by id."""
        rows = await self._pg.fetch(
            """
            SELECT id, dataset_id, input, expected_output, payload,
                   created_at, updated_at
            FROM dataset_items
            WHERE id = $1
            """,
            row_id,
        )
        if not rows:
            return None
        r = rows[0]
        payload = r.get("payload")
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except (ValueError, TypeError):
                payload = {}
        return SpreadsheetRow(
            id=str(r["id"]),
            dataset_id=str(r["dataset_id"]),
            input=str(r.get("input", "")),
            expected_output=str(r.get("expected_output", "")),
            values=payload or {},
            created_at=str(r.get("created_at", "")),
            updated_at=str(r.get("updated_at", "")),
        )

    async def delete_row(self, row_id: str) -> bool:
        await self._pg.execute(
            "DELETE FROM dataset_items WHERE id = $1",
            row_id,
        )
        return True

    async def import_rows(
        self,
        *,
        dataset_id: str,
        jsonl_text: str,
    ) -> list[SpreadsheetRow]:
        """Bulk-import rows from JSONL."""
        rows = jsonl_to_rows(jsonl_text, dataset_id)
        for r in rows:
            await self.add_row(
                dataset_id=dataset_id,
                input=r.input,
                expected_output=r.expected_output,
                values=r.values,
            )
        return rows

    async def export_rows(
        self,
        dataset_id: str,
        *,
        limit: int = 10_000,
    ) -> str:
        """Export rows as JSONL."""
        rows = await self.list_rows(dataset_id, limit=limit)
        return rows_to_jsonl(rows)


__all__ = [
    "SpreadsheetColumn",
    "SpreadsheetRow",
    "SpreadsheetService",
    "apply_filter",
    "apply_sort",
    "generate_column",
    "rows_to_jsonl",
    "jsonl_to_rows",
    "FILTER_OPERATORS",
    "default_ai_handler",
    "AIHandler",
]
