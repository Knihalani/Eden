-- Phase 1.7: Visual builder graphs (§8.1).
--
-- Stores user-authored React Flow DAGs from the visual
-- environment builder. One row per (org, name); the user can
-- save / overwrite / list / delete via the four routes in
-- ``src/eden/api/routes/builder_graphs.py``.
--
-- The ``graph`` JSONB holds the full ``{ nodes, edges }``
-- shape (EdenNode[] / EdenEdge[]) so reloads are exact. The
-- ``agent_id`` is the backend agent the graph was last
-- pushed to (used to filter the run-history sidebar on
-- re-load). The ``yaml`` column is the most-recent
-- eden-sim-eval.yaml so the portal can show it in the
-- Inspector without re-translating.

CREATE TABLE builder_graphs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    graph JSONB NOT NULL,
    yaml TEXT NOT NULL DEFAULT '',
    agent_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_builder_graphs_org_name UNIQUE (org_id, name)
);

-- Common query paths
CREATE INDEX idx_builder_graphs_org_updated
    ON builder_graphs (org_id, updated_at DESC);
CREATE INDEX idx_builder_graphs_org_user
    ON builder_graphs (org_id, user_id);
