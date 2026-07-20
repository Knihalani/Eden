"""Intelligence Gap — Trace Query DSL / EQL (Cat 19, v1.3) routes.

Real implementations (2026-06-11):

* ``POST /parse``         — parse an EQL query and return
  the compiled ClickHouse SQL + the shape + the
  relational fields used. SQL only (no BTQL pipe
  syntax, per the 2026-06-11 decision).
* ``POST /resolve``       — translate the
  ``root.`` / ``parent.`` / ``any.`` prefixes into
  the underlying ClickHouse SQL (Honeycomb parity).
* ``POST /lint``          — raise the 4 Braintrust-parity
  warnings (``NO_FILTERS``, ``ANY_SPAN_OVERUSE``,
  ``MISSING_ORG``, ``SHAPE_MISMATCH``); the strict
  mode is enforced at the call site.
* ``POST /alerts/compile`` — compile an EQL alert
  definition into a Cat 19 alert rule that fires on
  the configured interval. Fires
  :class:`DSLHook.on_alert_lint_warning` on the
  lint-warning path.
* ``GET  /alerts``         — list the org's alert rules.

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth

See ``docs/observability-gap/19-trace-query-dsl.md``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/dsl",
    tags=["intelligence-dsl"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


# ─── Schemas ───────────────────────────────────────────────────────


class ParseRequest(BaseModel):
    query: str = Field(..., description="The EQL query (SQL only).")
    shape: str = Field(
        "traces",
        description="traces | spans | summary (default: traces).",
    )
    lint_mode: str = Field(
        "default",
        description="default | strict (strict blocks on error-severity warnings).",
    )


class ResolveRequest(BaseModel):
    query: str = Field(..., description="The EQL query (SQL only).")
    lint_mode: str = Field(
        "default",
        description="default | strict.",
    )


class LintRequest(BaseModel):
    query: str = Field(..., description="The EQL query (SQL only).")
    shape: str | None = Field(
        None,
        description="traces | spans | summary (optional — triggers SHAPE_MISMATCH).",
    )
    lint_mode: str = Field(
        "default",
        description="default | strict.",
    )


class CompileAlertRequest(BaseModel):
    name: str = Field(..., description="Customer-facing alert name.")
    eql_query: str = Field(..., description="The EQL query (SQL only).")
    interval_seconds: int = Field(
        3600,
        description="How often the alert fires (min 60s, default 3600s).",
    )
    severity: str = Field(
        "warning",
        description="info | warning | high | critical (default: warning).",
    )
    shape: str = Field(
        "traces",
        description="traces | spans | summary (default: traces).",
    )


# ─── Routes ────────────────────────────────────────────────────────


@router.post("/parse")
async def parse(
    org_id: str = Depends(require_path_org_access),
    body: ParseRequest = Body(...),
) -> dict[str, Any]:
    """Parse an EQL query and return the compiled form.

    The route is the IDE autocomplete's hot path — the
    front-end will call it on every keystroke. The 1ms-or-
    less target is met by the single-pass regex
    substitution the v1.3 ship uses.
    """
    from eden.dsl import EQLParser

    return await EQLParser().parse(
        org_id,
        query=body.query,
        shape=body.shape,
        lint_mode=body.lint_mode,
    )


@router.post("/resolve")
async def resolve(
    org_id: str = Depends(require_path_org_access),
    body: ResolveRequest = Body(...),
) -> dict[str, Any]:
    """Translate the relational-field prefixes into ClickHouse SQL.

    The "killer feature" of EQL per the appendix — the
    :class:`RelationalFieldResolver` translates
    ``root.`` / ``parent.`` / ``any.`` prefixes into the
    underlying ClickHouse SQL (Honeycomb parity).
    """
    from eden.dsl import RelationalFieldResolver

    return await RelationalFieldResolver().resolve(
        org_id,
        query=body.query,
        lint_mode=body.lint_mode,
    )


@router.post("/lint")
async def lint(
    org_id: str = Depends(require_path_org_access),
    body: LintRequest = Body(...),
) -> dict[str, Any]:
    """Run the 4 Braintrust-parity lint rules against the query.

    The linter is the head of the alert-editor preview
    path: the UI calls ``lint`` on every keystroke and
    surfaces the warnings inline. The strict mode is
    enforced at the call site (the parser + resolver
    block on error-severity warnings in strict mode).
    """
    from eden.dsl import EQLLinter

    return await EQLLinter().lint(
        org_id,
        query=body.query,
        shape=body.shape,
        lint_mode=body.lint_mode,
    )


@router.post("/alerts/compile")
async def compile_alert(
    org_id: str = Depends(require_path_org_access),
    body: CompileAlertRequest = Body(...),
) -> dict[str, Any]:
    """Compile an EQL alert definition and persist the rule.

    Fires :class:`DSLHook.on_alert_lint_warning` when at
    least one lint warning surfaces. The hook is a no-op
    logger in v1.3; v1.4 will surface the warnings in the
    alert editor UI.
    """
    from eden.dsl import AlertAsCode

    return await AlertAsCode().compile(
        org_id,
        name=body.name,
        eql_query=body.eql_query,
        interval_seconds=body.interval_seconds,
        severity=body.severity,
        shape=body.shape,
    )


@router.get("/alerts")
async def list_alerts(
    org_id: str = Depends(require_path_org_access),
    enabled_only: bool = Query(False),
) -> dict[str, Any]:
    """List the org's alert rules.

    Sorted by ``next_fire_at ASC`` (the cron watchdog's
    hot path).
    """
    from eden.dsl import AlertAsCode

    return await AlertAsCode().list_alerts(
        org_id,
        enabled_only=enabled_only,
    )


@router.post("/alerts/{alert_id}/evaluate")
async def evaluate_alert(
    org_id: str = Depends(require_path_org_access),
    alert_id: str = Path(...),
    force: bool = Query(
        True,
        description="Evaluate even if next_fire_at is in the future",
    ),
) -> dict[str, Any]:
    """On-demand alert-as-code evaluation.

    Runs the compiled SQL, persists a firing (or miss) to
    ``eql_alert_firings``, and advances ``next_fire_at``.
    """
    from eden.dsl import AlertAsCode

    return await AlertAsCode().evaluate(
        org_id,
        alert_id=alert_id,
        force=force,
    )


@router.post("/alerts/fire-due")
async def fire_due_alerts(
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    """Evaluate every due alert for this org (manual watchdog tick).

    The global cron watchdog in ``eden.workers.cron_tick``
    covers all orgs; this endpoint scopes to ``org_id`` by
    filtering the fire_due results.
    """
    from eden.dsl import AlertAsCode

    result = await AlertAsCode().fire_due()
    # Scope the response to the path org when present.
    data = result.get("data") or {}
    scoped = [
        r
        for r in (data.get("results") or [])
        if r.get("org_id") == org_id
    ]
    return {
        **result,
        "data": {
            **data,
            "results": scoped,
            "n_due": len(scoped),
            "n_fired": sum(1 for r in scoped if r.get("fired")),
            "org_id": org_id,
        },
    }
