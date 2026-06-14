"""021_custom_metric_studio — Cat 21 (v1.3) observability gap roadmap.

Revision ID: 021
Revises: 020
Create Date: 2026-06-11

Adds the data model for Cat 21 — Custom-Metric Studio, the
v1.3-ship category that closes the rubric + LLM-as-judge gap
(Braintrust generate-scorer, Langfuse custom Python evaluators,
pre-Luna Galileo CLHF parity).

The category surfaces a single new table — ``custom_metric_runs`` —
which is **both** the audit log for rubric-synthesis runs and the
per-score run log (one row per (org, judge, event) the custom
judge scored). The per-metric versioning (Galileo "metric store"
parity) lives in the existing ``organizations.features`` JSONB
column so no schema change is required there.

The v1.3 ship is intentionally minimal: the Luna-Studio SLM-as-
judge fine-tune path (Cat 21 v2 — separate deferred initiative,
``docs/eden-judge-v2-plan.md``) will add a ``custom_metric_lora_jobs``
table in a follow-up migration.

Conventions
-----------
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* The LLM-as-judge opt-in policy (v1.4) is enforced at the service
  layer (``_check_auto_judge_policy`` in
  ``src/eden/metric_studio/_common.py``), not at the schema layer.

See ``docs/observability-gap/21-custom-metric-studio.md``.
"""

from alembic import op

revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None


# Helper to avoid repetition — mirrors the pattern in
# 020_intelligence_gap_tables.py.
def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ─── Cat 21 — Custom-Metric Studio (v1.3) ────────────────────
    # The custom_metric_runs table serves three roles, all keyed
    # by (org_id, id):
    #
    # 1. Rubric-synthesis audit log. When RubricSynthesiser
    #    .from_examples() is called, a row is written with
    #    ``status='synthesised'``, the input examples in
    #    ``examples_json``, the synthesised rubric in
    #    ``synthesised_rubric``, and the rubric size in
    #    ``rubric_tokens``. The ``approval_status`` starts as
    #    'pending' and is set to 'approved' or 'rejected' by a
    #    subsequent call to RubricSynthesiser.approve().
    #
    # 2. Per-score run log. When the registered RubricJudge runs
    #    on a telemetry event, a row is written with
    #    ``status='scored'``, the judge_name, score, threshold,
    #    passed, trace_id, and result_json (the LLM's full
    #    response). This is what the CustomMetricRegistry.list()
    #    endpoint reads to compute n_scores_30d and median_score.
    #
    # 3. Approval + rejection log. The approve() call updates
    #    the row's ``approval_status``, ``approved_by``,
    #    ``approved_at``, and (on rejection) ``rejection_reason``.
    #
    # The 1500-token cap on the synthesised rubric is enforced at
    # the service layer (RubricSynthesiser.from_examples), not
    # here.
    _table(
        "custom_metric_runs",
        """
        id                      UUID PRIMARY KEY,
        org_id                  VARCHAR(128) NOT NULL,
        -- Link back to the metric (Galileo metric-store parity).
        -- NULL during the initial synthesis (no metric exists yet);
        -- populated when the rubric is registered as a metric.
        metric_id               VARCHAR(128),
        -- The metric name provided by the user at registration
        -- (e.g. "Brand Voice v1") — denormalised here so the
        -- list() endpoint can sort + filter without joining.
        metric_name             VARCHAR(128),
        -- judge_name as registered in the global JudgeRegistry
        -- (e.g. "custom_org_test_metric_xyz"). NULL until the
        -- rubric is approved and wrapped as a judge.
        judge_name              VARCHAR(128),
        -- The score emitted by the custom judge. NULL during the
        -- synthesis phase; populated on each scoring run.
        score                   DOUBLE PRECISION,
        -- The pass / fail threshold the user set. NULL during
        -- the synthesis phase.
        threshold               DOUBLE PRECISION,
        -- Whether the score passed the threshold. NULL during
        -- the synthesis phase.
        passed                  BOOLEAN,
        -- The synthesised rubric prompt text. NULL on scoring
        -- rows (the rubric is in the judge, not the run log).
        synthesised_rubric      TEXT,
        -- Token count of the synthesised rubric. NULL on scoring
        -- rows. The 1500-token cap is enforced at the service
        -- layer; this column is for observability + analytics.
        rubric_tokens           INTEGER,
        -- The user's chosen domain (safety, compliance, …).
        -- NULL on scoring rows.
        domain                  VARCHAR(64),
        -- The trace that produced this run, when applicable.
        -- NULL on synthesis rows; populated on scoring rows.
        trace_id                VARCHAR(128),
        -- Input examples for synthesis, or the LLM response for
        -- scoring. JSON-encoded; for synthesis this is the
        -- [{input, output, label, rationale}, ...] array; for
        -- scoring this is {"score": <float>, "rationale": "..."}.
        examples_json           TEXT,
        -- Result payload. For synthesis: {"rubric_id": "...",
        -- "approval_required": true}. For scoring: the judge's
        -- full result envelope (score + rationale + metadata).
        result_json             TEXT,
        -- Lifecycle: 'synthesised' | 'approved' | 'rejected' |
        -- 'scored'. The first three are the synthesis states;
        -- 'scored' is appended on each judge invocation.
        status                  VARCHAR(16) NOT NULL DEFAULT 'synthesised',
        -- Approval gate (Galileo eval-to-guardrail lifecycle):
        -- 'pending' (default) | 'approved' | 'rejected'. NULL
        -- on scoring rows.
        approval_status         VARCHAR(16) NOT NULL DEFAULT 'pending',
        -- Who approved / rejected the rubric. NULL until the
        -- approval gate is acted on.
        approved_by             VARCHAR(128),
        -- When the approval gate was acted on.
        approved_at             TIMESTAMPTZ,
        -- Free-text rejection rationale from the reviewer.
        rejection_reason        TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        # Secondary index for the "list runs for one (org, trace)"
        # query path used by the per-trace debugging workflow.
        "CREATE INDEX IF NOT EXISTS idx_custom_metric_runs_trace "
        "ON custom_metric_runs (org_id, trace_id)",
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_custom_metric_runs_trace")
    op.execute("DROP INDEX IF EXISTS idx_custom_metric_runs_org")
    op.execute("DROP TABLE IF EXISTS custom_metric_runs")
