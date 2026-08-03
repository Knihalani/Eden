"""Phase 5 Wave 6 API routes — online scoring, dashboards, deploy, export."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_path_org_access,
    resolve_eden_org_id,
)
from eden.api.utils.redact import redact_all
from eden.automations.engine import AutomationsEngine
from eden.evaluation.categorical_classifier import CategoricalClassifierService
from eden.evaluation.ci_webhook import CIWebhookHandler
from eden.evaluation.code_evaluator import (
    CodeEvaluatorDisabledError,
    CodeEvaluatorRunner,
)
from eden.evaluation.online.rules_engine import (
    DEFAULT_NEW_RULE_SAMPLE_RATE,
    OnlineScoringRulesEngine,
)
from eden.evaluation.online.span_scores import SpanScoreStore
from eden.evaluation.sql_export import SqlExportService
from eden.monitoring.dashboards import MonitoringDashboardService
from eden.observability.custom_properties.service import CustomPropertiesService
from eden.prompts.deploy import PromptDeployService
from eden.prompts.workspace import PromptWorkspaceService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["wave6-online-quality"],
    dependencies=[Depends(require_path_org_access)],
)

def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"w6_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }

# ── F52 online scoring rules ────────────────────────────────────────

class RuleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = ""
    scope: str = "trace"
    filter_query: str = ""
    scorer_type: str = "slm"
    scorer_ref: str | None = None
    # Must track ``rules_engine.DEFAULT_NEW_RULE_SAMPLE_RATE``. The route
    # hands the whole model to ``create_rule`` via ``**model_dump()``,
    # which always emits this field — so a literal default here silently
    # shadows the engine's and every new rule scores 100% of traffic with
    # an LLM call. Existing persisted rules are untouched.
    sample_rate: float = Field(DEFAULT_NEW_RULE_SAMPLE_RATE, ge=0.0, le=1.0)
    config: dict[str, Any] = Field(default_factory=dict)

class RulePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    filter_query: str | None = None
    scorer_type: str | None = None
    scorer_ref: str | None = None
    sample_rate: float | None = Field(None, ge=0.0, le=1.0)
    config: dict[str, Any] | None = None

@router.get("/online-scoring/rules")
async def list_scoring_rules(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    rules = await OnlineScoringRulesEngine().list_rules(org_id)
    return _ok("f52", {"rules": [r.to_dict() for r in rules]})

@router.post("/online-scoring/rules")
async def create_scoring_rule(
    org_id: str = Depends(require_path_org_access), body: RuleCreate = Body(...)
) -> dict[str, Any]:
    rule = await OnlineScoringRulesEngine().create_rule(org_id, **body.model_dump())
    if rule is None:
        raise HTTPException(status_code=503, detail="rules engine unavailable")
    return _ok("f52", {"rule": rule.to_dict()})

@router.patch("/online-scoring/rules/{rule_id}")
async def patch_scoring_rule(
    org_id: str = Depends(require_path_org_access),
    rule_id: str = Path(...),
    body: RulePatch = Body(...),
) -> dict[str, Any]:
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    rule = await OnlineScoringRulesEngine().update_rule(org_id, rule_id, **fields)
    if rule is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return _ok("f52", {"rule": rule.to_dict()})

@router.post("/online-scoring/rules/{rule_id}/rewind")
async def rewind_scoring_rule(
    org_id: str = Depends(require_path_org_access), rule_id: str = Path(...)
) -> dict[str, Any]:
    job_id = await OnlineScoringRulesEngine().rewind(org_id, rule_id)
    return _ok("f52", {"job_id": job_id})

@router.post("/online-scoring/apply/{trace_id}")
async def apply_scoring(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    agent_id: str | None = Query(None),
    span_id: str | None = Query(None),
) -> dict[str, Any]:
    results = await OnlineScoringRulesEngine().apply_rules_for_trace(
        org_id, trace_id, agent_id=agent_id, span_id=span_id
    )
    return _ok("f52", {"results": results})

# ── F79 span scores ─────────────────────────────────────────────────

@router.get("/spans/{span_id}/scores")
async def span_scores(org_id: str = Depends(require_path_org_access), span_id: str = Path(...)) -> dict[str, Any]:
    scores = await SpanScoreStore().list_for_span(org_id, span_id)
    return _ok("f79", {"span_id": span_id, "scores": scores})

@router.get("/traces/{trace_id}/span-scores")
async def trace_span_scores(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    span_id: str | None = Query(None),
) -> dict[str, Any]:
    scores = await SpanScoreStore().list_for_trace(org_id, trace_id, span_id=span_id)
    return _ok("f79", {"trace_id": trace_id, "scores": scores})

# ── F54 code evaluators ─────────────────────────────────────────────

class CodeEvaluatorCreate(BaseModel):
    name: str
    source_code: str
    entrypoint: str = "evaluate"
    timeout_ms: int = Field(500, ge=50, le=5000)

@router.get("/code-evaluators")
async def list_code_evaluators(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    rows = await CodeEvaluatorRunner().list_evaluators(org_id)
    return _ok("f54", {"evaluators": rows})

@router.post("/code-evaluators")
async def create_code_evaluator(
    org_id: str = Depends(require_path_org_access), body: CodeEvaluatorCreate = Body(...)
) -> dict[str, Any]:
    try:
        rec = await CodeEvaluatorRunner().register(org_id, **body.model_dump())
    except CodeEvaluatorDisabledError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _ok("f54", {"evaluator": rec})

# ── F55 categorical classifiers ───────────────────────────────────

class ClassifierCreate(BaseModel):
    name: str
    column_key: str
    labels: list[str] = Field(default_factory=list)
    scorer_type: str = "slm"
    scorer_ref: str | None = None

@router.get("/categorical-classifiers")
async def list_classifiers(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    rows = await CategoricalClassifierService().list_classifiers(org_id)
    return _ok("f55", {"classifiers": rows})

@router.post("/categorical-classifiers")
async def create_classifier(
    org_id: str = Depends(require_path_org_access), body: ClassifierCreate = Body(...)
) -> dict[str, Any]:
    rec = await CategoricalClassifierService().register(org_id, **body.model_dump())
    return _ok("f55", {"classifier": rec})

@router.post("/categorical-classifiers/{classifier_id}/classify/{trace_id}")
async def classify_trace(
    org_id: str = Depends(require_path_org_access),
    classifier_id: str = Path(...),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    result = await CategoricalClassifierService().classify_trace(
        org_id, classifier_id, trace_id
    )
    return _ok("f55", {"result": result})

# ── F61 automations ─────────────────────────────────────────────────

class AutomationCreate(BaseModel):
    name: str
    trigger_type: str = "score_threshold"
    trigger_config: dict[str, Any] = Field(default_factory=dict)
    action_type: str = "dataset"
    action_config: dict[str, Any] = Field(default_factory=dict)

@router.get("/automations")
async def list_automations(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(100, ge=1, le=100),
) -> dict[str, Any]:
    rows = await AutomationsEngine().list_automations(org_id, limit=limit)
    return _ok("f61", {"automations": rows})

@router.post("/automations")
async def create_automation(
    org_id: str = Depends(require_path_org_access), body: AutomationCreate = Body(...)
) -> dict[str, Any]:
    rec = await AutomationsEngine().create(org_id, **body.model_dump())
    return _ok("f61", {"automation": rec})

# ── F57 dashboards ──────────────────────────────────────────────────

class DashboardCreate(BaseModel):
    name: str
    is_home: bool = False

class WidgetUpsert(BaseModel):
    widget_type: str = "metric"
    title: str = ""
    query: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    position: int = 0
    widget_id: str | None = None

async def _resolved_org(org_id: str) -> str:
    """Prefer Eden UUID; fall back to path id so legacy tenants still work."""
    resolved = await resolve_eden_org_id(org_id)
    return resolved or org_id

@router.get("/dashboards/home")
async def get_home_dashboard(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    dash = await MonitoringDashboardService().get_home(await _resolved_org(org_id))
    return _ok("f57", {"dashboard": dash})

@router.get("/dashboards")
async def list_dashboards(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    rows = await MonitoringDashboardService().list_dashboards(
        await _resolved_org(org_id)
    )
    return _ok("f57", {"dashboards": rows})

@router.post("/dashboards")
async def create_dashboard(
    org_id: str = Depends(require_path_org_access), body: DashboardCreate = Body(...)
) -> dict[str, Any]:
    rec = await MonitoringDashboardService().create_dashboard(
        await _resolved_org(org_id), name=body.name, is_home=body.is_home
    )
    return _ok("f57", {"dashboard": rec})

@router.post("/dashboards/{dashboard_id}/widgets")
async def upsert_widget(
    org_id: str = Depends(require_path_org_access),
    dashboard_id: str = Path(...),
    body: WidgetUpsert = Body(...),
) -> dict[str, Any]:
    rec = await MonitoringDashboardService().upsert_widget(
        await _resolved_org(org_id), dashboard_id, **body.model_dump()
    )
    return _ok("f57", {"widget": rec})

@router.post("/dashboards/widgets/execute")
async def execute_widget_query(
    org_id: str = Depends(require_path_org_access),
    query: str = Body(..., embed=True),
    agent_id: str | None = Body(None, embed=True),
) -> dict[str, Any]:
    result = await MonitoringDashboardService().execute_widget_query(
        await _resolved_org(org_id), query, agent_id=agent_id
    )
    return _ok("f57", {"result": result})

# ── F60 cost analytics KPI ──────────────────────────────────────────

@router.get("/cost-analytics/kpi")
async def cost_kpi(
    org_id: str = Depends(require_path_org_access),
    window_hours: int = Query(24, ge=1, le=720),
    agent_id: str | None = Query(None),
    property_key: str | None = Query(None),
    property_value: str | None = Query(None),
) -> dict[str, Any]:
    """F60 KPI tiles — prefer CH/Tinybird when configured; PG fallback."""
    from eden.llmops.cost_ledger import explorer_summary
    from eden.storage.postgres import get_postgres_client

    summary = await explorer_summary(org_id, window_hours=window_hours)
    ledger_cost = float(summary.get("total_cost_usd") or 0.0)
    prev_cost = float(summary.get("previous_cost_usd") or 0.0)

    traces = 0
    prev_traces = 0
    cache_savings = 0.0
    data_source = "postgres"

    # Prefer ClickHouse / Tinybird rollups when clickhouse_url is set.
    # Reachability is not populatedness: an empty ClickHouse answer must
    # fall through to Postgres so Home does not report zero traces on a
    # first deploy / ingest stall / post-TTL window.
    ch_tiles = await _home_kpi_from_clickhouse(org_id, window_hours=window_hours)
    if ch_tiles is not None and int(ch_tiles.get("event_count") or 0) > 0:
        # Prefer distinct-trace counts from CH/Tinybird; fall back to
        # event_count only when trace_count is absent (pre-T1 responses).
        traces = int(
            ch_tiles["trace_count"]
            if "trace_count" in ch_tiles
            else (ch_tiles.get("event_count") or 0)
        )
        prev_traces = int(
            ch_tiles["prev_trace_count"]
            if "prev_trace_count" in ch_tiles
            else (ch_tiles.get("prev_event_count") or 0)
        )
        data_source = "clickhouse"
        if ledger_cost <= 0 and ch_tiles.get("cost_usd") is not None:
            ledger_cost = float(ch_tiles["cost_usd"] or 0)

    client = await get_postgres_client()
    if client is not None and data_source == "postgres":
        where = "tenant_id = $1 AND timestamp > NOW() - ($2 || ' hours')::interval"
        args: list[Any] = [org_id, str(window_hours)]
        if agent_id:
            args.append(agent_id)
            where += f" AND attributes->>'agent_id' = ${len(args)}"
        if property_key and property_value:
            args.extend([property_key, property_value])
            where += f" AND tags->>${len(args)-1} = ${len(args)}"
        try:
            # ``telemetry_events`` has no ``cost_usd`` /
            # ``prompt_cache_savings_usd`` column (alembic 009) — cost is
            # carried in the ``metrics`` / ``payload`` / ``attributes``
            # JSONB. Selecting the bare columns raised, the raise was
            # swallowed by the ``except Exception: pass`` below, and the
            # Postgres branch of the Home KPI tiles silently reported
            # zero traces for every org without ClickHouse configured.
            # Same COALESCE ladder as routes/observability.py:470.
            cur = await client.fetchrow(
                f"SELECT coalesce(sum(COALESCE("
                f"  NULLIF(metrics->>'cost_usd', '')::float,"
                f"  NULLIF(payload->>'cost_usd', '')::float,"
                f"  NULLIF(attributes->>'cost_usd', '')::float"
                f")),0) AS cost, "
                f"count(DISTINCT trace_id) AS traces, "
                f"coalesce(sum(COALESCE("
                f"  NULLIF(metrics->>'prompt_cache_savings_usd', '')::float,"
                f"  NULLIF(payload->>'prompt_cache_savings_usd', '')::float"
                f")),0) AS cache_savings "
                f"FROM telemetry_events WHERE {where}",
                *args,
            )
            prev = await client.fetchrow(
                "SELECT count(DISTINCT trace_id) AS traces "
                "FROM telemetry_events WHERE tenant_id = $1 "
                "AND timestamp <= NOW() - ($2 || ' hours')::interval "
                "AND timestamp > NOW() - ($2 || ' hours')::interval * 2",
                org_id,
                str(window_hours),
            )
            if cur:
                traces = int(cur["traces"] or 0)
                cache_savings = float(cur["cache_savings"] or 0)
                # Prefer ledger when present; else telemetry cost.
                if ledger_cost <= 0:
                    ledger_cost = float(cur["cost"] or 0)
            if prev:
                prev_traces = int(prev["traces"] or 0)
        except Exception as exc:
            # Was a bare ``pass``, which is how a nonexistent-column query
            # sat here undetected. Degrade to zeros, but say so.
            logger.warning(
                "f60 home KPI postgres query failed: %s", redact_all(str(exc))
            )

    delta = ledger_cost - prev_cost
    delta_pct = round((delta / prev_cost) * 100, 2) if prev_cost else None
    return _ok(
        "f60",
        {
            "tiles": [
                {
                    "key": "cost_usd",
                    "value": ledger_cost,
                    "previous": prev_cost,
                    "delta": delta,
                    "delta_pct": delta_pct,
                },
                {
                    "key": "traces",
                    "value": traces,
                    "previous": prev_traces,
                },
                {
                    "key": "cache_savings_usd",
                    "value": cache_savings,
                },
                {
                    "key": "untagged_events",
                    "value": int(summary.get("untagged_events") or 0),
                },
            ],
            "explorer": {
                "by_feature": summary.get("by_feature") or [],
                "by_model": summary.get("by_model") or [],
                "by_agent": summary.get("by_agent") or [],
            },
            "segment": {"agent_id": agent_id, "property_key": property_key},
            "data_source": data_source,
        },
    )

async def _home_kpi_from_clickhouse(
    org_id: str, *, window_hours: int
) -> dict[str, Any] | None:
    """Read Home KPI aggregates from CH/Tinybird; soft-fail to None."""
    try:
        from eden.config import get_settings
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink

        url = getattr(get_settings(), "clickhouse_url", "") or ""
        if not url.strip():
            return None
        sink = await get_clickhouse_sink()
        return await sink.query_home_kpis(org_id, window_hours=window_hours)
    except Exception as exc:
        logger.debug("home KPI CH read failed; using PG: %s", redact_all(str(exc)))
        return None

# ── F66 prompt workspace ────────────────────────────────────────────

@router.get("/prompts/{name}/workspace")
async def prompt_workspace(org_id: str = Depends(require_path_org_access), name: str = Path(...)) -> dict[str, Any]:
    ws = await PromptWorkspaceService().get_workspace(org_id, name)
    return _ok("f66", {"workspace": ws})

class CollaboratorAdd(BaseModel):
    user_id: str
    role: str = "editor"

@router.post("/prompts/{name}/collaborators")
async def add_collaborator(
    org_id: str = Depends(require_path_org_access), name: str = Path(...), body: CollaboratorAdd = Body(...)
) -> dict[str, Any]:
    rec = await PromptWorkspaceService().add_collaborator(
        org_id, prompt_name=name, user_id=body.user_id, role=body.role
    )
    return _ok("f66", {"collaborator": rec})

# ── F68 prompt deploy ───────────────────────────────────────────────

class PromptDeployBody(BaseModel):
    env: str = "production"
    version: int = Field(..., ge=1)

@router.get("/prompts/{name}/environments")
async def list_prompt_envs(org_id: str = Depends(require_path_org_access), name: str = Path(...)) -> dict[str, Any]:
    envs = await PromptDeployService().list_environments(org_id, name)
    return _ok("f68", {"environments": envs})

@router.post("/prompts/{name}/deploy")
async def deploy_prompt(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    body: PromptDeployBody = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    rec = await PromptDeployService().deploy(
        org_id,
        prompt_name=name,
        env=body.env,
        version=body.version,
        deployed_by=str(user.get("user_id") or "system"),
    )
    return _ok("f68", {"deployment": rec})

@router.get("/prompts/{name}/resolve")
async def resolve_prompt(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    env: str = Query("production"),
) -> dict[str, Any]:
    resolved = await PromptDeployService().resolve(org_id, prompt_name=name, env=env)
    return _ok("f68", {"resolved": resolved})

# ── F56 CI eval ─────────────────────────────────────────────────────

class CIEvalRequest(BaseModel):
    change_id: str
    changed_files: list[str] = Field(default_factory=list)
    agent_id: str | None = None
    baseline_experiment_id: str | None = None

@router.post("/ci-eval/run")
async def ci_eval_run(org_id: str = Depends(require_path_org_access), body: CIEvalRequest = Body(...)) -> dict[str, Any]:
    result = await CIWebhookHandler().on_prompt_change(
        org_id,
        changed_files=body.changed_files,
        change_id=body.change_id,
        agent_id=body.agent_id,
    )
    return _ok("f56", result)

# ── F76 SQL export ──────────────────────────────────────────────────

class SqlExportDataset(BaseModel):
    sql: str
    dataset_name: str
    trace_id_column: str = "trace_id"

class SqlExportQueue(BaseModel):
    sql: str
    queue_id: str
    trace_id_column: str = "trace_id"

@router.post("/sql/export/dataset")
async def sql_export_dataset(
    org_id: str = Depends(require_path_org_access), body: SqlExportDataset = Body(...)
) -> dict[str, Any]:
    result = await SqlExportService().export_to_dataset(org_id, **body.model_dump())
    return _ok("f76", result)

@router.post("/sql/export/queue")
async def sql_export_queue(
    org_id: str = Depends(require_path_org_access), body: SqlExportQueue = Body(...)
) -> dict[str, Any]:
    result = await SqlExportService().export_to_queue(org_id, **body.model_dump())
    return _ok("f76", result)

# ── F75 late metadata ───────────────────────────────────────────────

class LateMetadataBody(BaseModel):
    properties: dict[str, str]

@router.post("/traces/{trace_id}/metadata")
async def late_trace_metadata(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
    body: LateMetadataBody = Body(...),
) -> dict[str, Any]:
    return await CustomPropertiesService().set(
        org_id, trace_id=trace_id, properties=body.properties
    )

# ── N15 shadow promote ──────────────────────────────────────────────

class ShadowPromoteBody(BaseModel):
    judge_name: str
    threshold: float = Field(..., ge=0.0, le=1.0)

@router.post("/eval/promote-to-shadow-guardrail")
async def promote_shadow_guardrail(
    org_id: str = Depends(require_path_org_access), body: ShadowPromoteBody = Body(...)
) -> dict[str, Any]:
    from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

    return await EvalToGuardrailLink().promote_to_shadow(
        org_id, judge_name=body.judge_name, threshold=body.threshold
    )
