---
title: "40 — Dataset-as-Spreadsheet (Phase S)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 40 — Dataset-as-Spreadsheet (Phase S)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the RagaAI "dataset-as-spreadsheet" gap. Each row
> is a data point (input + expected_output + values),
> each column is user-defined (text / number / json) with
> an optional AI-generation source. Filter + sort + JSONL
> import/export on top of the existing
> ``dataset_items`` / ``datasets`` tables. ~700 LOC backend
> + 30 unit tests.

## Goal & motivation

RagaAI's headline feature on the eval side: a dataset is a
**spreadsheet**, not a SQL table. The user opens the dataset,
sees rows × columns, can filter / sort / add columns /
generate columns with AI. The spreadsheet is a familiar
mental model that non-engineers can use directly.

Eden's Cat 3 eval surface already has ``datasets`` /
``dataset_items`` tables, but the UX is "import a JSONL
file and run an evaluation." Phase S adds the spreadsheet
layer on top — same tables, new routes + service, no
schema migration beyond the new ``dataset_columns`` table.

## What's in Eden

### Data model

Two tables:

| Table | Purpose |
|---|---|
| ``dataset_items`` (existing) | One row per data point. Carries ``input``, ``expected_output``, ``payload JSONB`` (the user-defined column values). |
| ``dataset_columns`` (new) | Schema definition for one column. Carries ``name``, ``type``, ``source`` (``"user"`` / ``"ai"``), ``description`` (the AI prompt). |

The split: the row data lives in ``dataset_items.payload``
(JSONB), the column metadata lives in ``dataset_columns``.
Adding a new column is just an INSERT; existing rows have
``null`` for that column until the user fills them in.

### Filter + sort

Filter operators (8): ``==``, ``!=``, ``>``, ``>=``, ``<``,
``<=``, ``contains``, ``starts_with``. Filters operate on
the standard columns (``input``, ``expected_output``) and
on user-defined columns (looked up by name in the JSONB
``payload``).

Sort is multi-column, with ``asc`` / ``desc`` per column.
Stable sort, left-to-right (later keys break ties on
earlier ones).

Both filter and sort are applied in Python after the
SQL ``SELECT`` (the column values live in JSONB which is
awkward to query in SQL). For large datasets, the
Postgres ``LIMIT`` clause caps the row scan; the
``filter`` / ``sort`` happen on the returned batch.

### AI column generation

The user adds a column with ``source = "ai"`` and a
``description`` (the prompt). They click "AI fill" → the
service iterates every row, calls the AI handler with
``(description, row_dict)``, and stores the response in
the column.

The default AI handler is a stub that returns a
placeholder string. Production wires the real LLM via the
route layer (using the same ModelRouter as the rest of
Eden).

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/orgs/{org}/datasets/{id}/rows` | yes | List rows (with filter / sort) |
| `POST` | `/orgs/{org}/datasets/{id}/rows` | yes | Add a row |
| `PATCH` | `/orgs/{org}/datasets/{id}/rows/{row_id}` | yes | Update a row |
| `DELETE` | `/orgs/{org}/datasets/{id}/rows/{row_id}` | yes | Delete a row |
| `GET` | `/orgs/{org}/datasets/{id}/columns` | yes | List columns |
| `POST` | `/orgs/{org}/datasets/{id}/columns` | yes | Add a column |
| `POST` | `/orgs/{org}/datasets/{id}/columns/{col_id}/generate` | yes | AI-fill the column |
| `GET` | `/orgs/{org}/datasets/{id}/export` | yes | JSONL export |

## Example session

```bash
# Add a column with AI generation.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "name": "tone",
       "type": "text",
       "source": "ai",
       "description": "Classify the tone of the input as positive, negative, or neutral"
     }' \
     https://app.eden.example/orgs/myorg/datasets/d1/columns
# {"id": "c-1", "name": "tone", "type": "text", "source": "ai", ...}

# AI-fill the column across all rows.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{}' \
     https://app.eden.example/orgs/myorg/datasets/d1/columns/c-1/generate
# {"rows": [...], "total_count": 100}

# Filter + sort.
curl -H "Authorization: Bearer $JWT" \
     "https://app.eden.example/orgs/myorg/datasets/d1/rows?filter=%5B%7B%22column%22%3A%22tone%22%2C%22op%22%3A%22%3D%3D%22%2C%22value%22%3A%22positive%22%7D%5D&sort=%5B%7B%22column%22%3A%22input%22%2C%22direction%22%3A%22asc%22%7D%5D"
# {"rows": [...], "total_count": 42}
```

## RagaAI parity matrix

| RagaAI feature | Eden Phase S | Notes |
|---|---|---|
| Spreadsheet view | ✅ GET /rows | Filter + sort + paginate |
| User-defined columns | ✅ POST /columns | text / number / json |
| AI-generated columns | ✅ POST /columns/{id}/generate | Stub handler in v1; real LLM in S.5 |
| Column types | ✅ text / number / json | Type-safe (CHECK constraint on insert) |
| Filter | ✅ 8 operators | ==, !=, >, >=, \<, \<=, contains, starts_with |
| Sort | ✅ multi-column | asc / desc per column |
| JSONL import | ✅ Service.import_rows() | One row per line |
| JSONL export | ✅ GET /export | Stdlib fine-tuning format |
| Inline editing | 🟡 PATCH /rows | The UI is a Phase E (UI polish) item |
| Share-by-link | 🟡 Phase N (saved searches) | The dataset share is a follow-up |
| Bulk operations | 🟡 service-level | Not yet exposed as routes |
| Custom formulas | ❌ deferred | The "transform" column is a future cat |
| Per-cell comments | ❌ deferred | Not in v1 |

## What's NOT in this phase (deferred)

- **Real LLM AI handler** — the v1 ships the stub.
  Production wiring requires injecting the
  ``app.state.llm_client`` and switching to the real
  ModelRouter. Phase S.5.
- **Inline editing UI** — the API supports PATCH on a
  single row. The UI is a Phase E (UI polish) item.
- **Bulk operations** — multi-select + bulk delete + bulk
  AI-fill. The service supports the operations; the
  routes don't yet expose them.
- **Custom formulas** — "fill this column with the
  length of input" without going through the LLM. A
  future cat adds formula support.
- **Per-cell comments** — the operator dashboard's
  "reviewer left a comment on this cell" UX. Not in v1.
- **Per-tenant column sharing** — the column schema is
  per-dataset. A future cat adds a "column library" that
  the user can pick from.

## Failure modes

| Failure | Behaviour |
|---|---|
| Empty filter / sort spec | No filter / sort applied |
| Unknown column in filter | Column not found → row fails the filter, dropped |
| Filter value is a number string | Coerced to float for `>` `<` etc. |
| AI handler raises | The error propagates (the route returns 500) |
| Row update with empty values | Allowed (the row's payload is empty JSONB) |
| Delete on unknown row | Returns "deleted": true (idempotent) |
| Filter on JSON column | Coerced to string for substring matching |

## Telemetry

- `dataset.row.added` (counter)
- `dataset.row.updated` (counter)
- `dataset.row.deleted` (counter)
- `dataset.column.added` (counter)
- `dataset.column.ai_generated` (counter) — fires per row generated
- `dataset.exported` (counter) — fires per export call

These flow into the same pipeline as LLM spans.

## Tests

30 unit tests in `tests/unit/test_datasets_spreadsheet.py`:

- `TestApplyFilter` (6) — no filter, ==, !=, contains,
  starts_with, numeric >
- `TestApplySort` (4) — no sort, asc, desc, multi-column
- `TestGenerateColumn` (4) — default handler, custom
  handler, empty rows, custom prompt
- `TestJsonl` (4) — to_jsonl, from_jsonl, round-trip,
  empty input
- `TestSpreadsheetService` (8) — add_column, list_columns,
  add_row, list_rows with filter, list_rows with sort,
  update_row, get_row, export_rows
- `TestDataclass` (4) — Column to_dict + defaults, Row
  to_dict + defaults

All 30 pass; 0 regressions in the existing unit suite
(703/703 total across new modules).

## Cross-references

- [Cat 3 — Evaluation Quality Intelligence](03-evaluation-quality-intelligence.md)
  — the destination for promoted annotations (Phase D
  feeds the dataset).
- [Phase D — Labeling Queue](36-labeling-queue.md) — the
  human review surface that populates the dataset with
  high-quality labels.
- [Phase J — Synthetic Q/A Generation](34-synthetic-qa-generation.md)
  — the producer of dataset items (Phase S consumes them).
- [Phase I — Prompt Management + Playground](prompt-management-playground.md)
  — the future cat that runs the dataset through the
  evaluation pipeline.
