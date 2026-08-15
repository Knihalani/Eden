-- June 2026: Dataset column schema (Phase S).
--
-- Closes the RagaAI "dataset-as-spreadsheet" gap. The user
-- defines columns (text / number / json); rows are existing
-- dataset_items with extra values stored in ``payload`` JSONB.
--
-- The columns table is a thin metadata layer — the row data
-- lives in ``dataset_items.payload`` (already JSONB from
-- Cat 3). Adding a new column is just an INSERT; the
-- existing rows have ``null`` for that column until the
-- user fills them in (manually or via AI generation).

CREATE TABLE IF NOT EXISTS dataset_columns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id      UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'text'
        CHECK (type IN ('text', 'number', 'json')),
    -- ``user`` = manually filled, ``ai`` = AI-generated.
    source          TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'ai')),
    -- Description is used as the prompt for AI columns.
    description     TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-dataset "column list" view.
CREATE INDEX IF NOT EXISTS idx_dataset_columns_dataset
    ON dataset_columns (dataset_id, created_at ASC);


COMMENT ON TABLE dataset_columns IS
    'Phase S: spreadsheet column schema. Row values are stored '
    'in dataset_items.payload; this table is just the metadata.';
