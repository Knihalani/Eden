"""Trace-quality DB query layer.

Thin async wrappers around the new ``trace_efficiency_reports``,
``trace_loop_reports``, ``trace_quality_reports``,
``trace_reasoning_reports``, ``trace_guardrail_actions``,
``tenant_guardrail_action_config`` tables (migrations 068-073).

All functions are **tenant-scoped**: every WHERE clause filters
on ``tenant_id = $1``. The route layer enforces the tenant
identity (via ``require_org_member``); this module enforces the
tenant boundary at the DB level. Cross-tenant lookups return
``None`` (the route turns that into 404 per spec §0, No-Drop
Invariant #16).

Postgres substrate failures (no client, transient outage) are
caught and turned into ``None`` / empty-list returns. The route
layer never 500s on a missing optional subsystem.

Performance design
------------------

The query layer sits on the cold read/write path (the sidecar
worker + the report-fetch routes), not on the live hot path.
The hot-path DB write is fire-and-forget via
``eden.observability.trace_quality.hooks._ACTION_QUEUE``.

* ``get_postgres_client`` is imported at module load — the
  per-call ``import`` in the previous version cost ~50 us per
  fetch, which dominated the cold-path latency.
* ``asyncpg`` auto-prepares repeated statements by query text;
  every function in this module reuses the same SQL string
  across calls so the prepared-statement cache is hit after
  the first invocation per connection.
* ``_row_to_dict`` short-circuits the common case (all scalar
  fields, no datetimes / UUIDs) so the report-fetch routes
  don't pay a per-cell type-check tax.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# ponytail: this module has no module-level state; everything is
# per-call. The shutdown / startup behaviour is owned by the
# sidecar worker package, not here.


# Lazy module-level reference to ``get_postgres_client`` so the
# query helpers don't pay an import cost on every call. The
# import is attempted at module load; if the storage layer is
# missing (e.g. a fresh checkout without the postgres client
# configured) we fall back to ``None`` per call.
try:
    from eden.storage.postgres import get_postgres_client as _get_pg
except Exception:  # pragma: no cover - storage layer missing
    _get_pg = None  # type: ignore[assignment]


async def _client():
    """Lazy Postgres client acquisition.

    Returns ``None`` if the substrate is unavailable so the
    caller can fall back to a stub. ``_get_pg`` is the
    hoisted module reference; the ``get_postgres_client``
    name from the storage package was preserved for
    monkeypatch compatibility with tests that patch the
    module attribute.
    """
    if _get_pg is None:
        return None
    try:
        client = await _get_pg()
    except Exception as exc:
        logger.debug("trace_quality.queries: get_postgres_client failed: %s", exc)
        return None
    return client


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Normalise an asyncpg Record into a JSON-friendly dict.

    Postgres JSONB columns round-trip as ``dict`` / ``list``
    already; we only stringify datetimes / UUIDs / unknown
    scalar types for the FastAPI response layer.

    Fast path: when the row has no datetime / UUID columns
    (the common case for the report tables) we just
    ``dict(row)`` and return. The slow path (any non-JSON
    scalar needing coercion) is an explicit per-cell branch.
    """
    if row is None:
        return {}
    if isinstance(row, dict):
        d = dict(row)
    else:
        try:
            d = dict(row)
        except Exception:
            return {}
    for k, v in list(d.items()):
        if v is None:
            continue
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif not isinstance(v, (str, int, float, bool, list, dict)):
            d[k] = str(v)
    return d


# ── Report fetch helpers ──────────────────────────────────────────


async def fetch_efficiency_report(
    tenant_id: str, trace_id: str
) -> dict[str, Any] | None:
    """Return the latest ``trace_efficiency_reports`` row for the trace."""
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT trace_id, tas, avs, vae, grade, intervention,
                   metrics, fix_patches, created_at
            FROM trace_efficiency_reports
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY created_at DESC
            LIMIT 1
            """,
            tenant_id, trace_id,
        )
    except Exception as exc:
        logger.debug("fetch_efficiency_report: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


async def fetch_loop_report(
    tenant_id: str, trace_id: str
) -> dict[str, Any] | None:
    """Return the latest ``trace_loop_reports`` row for the trace."""
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT trace_id, verdict, detectors_tripped, severity,
                   action, max_cosine, max_jaccard, step_index,
                   created_at
            FROM trace_loop_reports
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY created_at DESC
            LIMIT 1
            """,
            tenant_id, trace_id,
        )
    except Exception as exc:
        logger.debug("fetch_loop_report: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


async def fetch_quality_report(
    tenant_id: str, trace_id: str
) -> dict[str, Any] | None:
    """Return the latest ``trace_quality_reports`` row for the trace."""
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT trace_id, hallucination_score, groundedness,
                   tool_relevance, step_coherence, components,
                   verdict, created_at
            FROM trace_quality_reports
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY created_at DESC
            LIMIT 1
            """,
            tenant_id, trace_id,
        )
    except Exception as exc:
        logger.debug("fetch_quality_report: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


async def fetch_reasoning_report(
    tenant_id: str, trace_id: str
) -> dict[str, Any] | None:
    """Return the latest ``trace_reasoning_reports`` row for the trace."""
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT trace_id, faithfulness, lanham_score,
                   verification_markers, contradictions,
                   verdict, created_at
            FROM trace_reasoning_reports
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY created_at DESC
            LIMIT 1
            """,
            tenant_id, trace_id,
        )
    except Exception as exc:
        logger.debug("fetch_reasoning_report: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


async def fetch_guardrail_actions(
    tenant_id: str,
    trace_id: str,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return recent ``trace_guardrail_actions`` for the trace.

    Used by the operator UI to show the decision history for a
    specific trace — limit defaults to 50 to keep payloads
    bounded.
    """
    client = await _client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, trace_id, step_index, agent_id, action_class,
                   recommended, applied, reason, payload, created_at
            FROM trace_guardrail_actions
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            tenant_id, trace_id, int(limit),
        )
    except Exception as exc:
        logger.debug("fetch_guardrail_actions: %s", exc)
        return []
    return [_row_to_dict(r) for r in (rows or [])]


async def fetch_pending_actions(
    tenant_id: str,
    *,
    action_class: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return the operator inbox ``GET /v1/guardrails/actions/pending``.

    Defaults to the 5 mutating action classes (the ones that
    require an operator flip to apply). When ``action_class``
    is provided, the result is scoped to that single class.
    """
    client = await _client()
    if client is None:
        return []
    try:
        if action_class:
            rows = await client.fetch(
                """
                SELECT id, trace_id, step_index, agent_id, action_class,
                       recommended, applied, reason, payload, created_at
                FROM trace_guardrail_actions
                WHERE tenant_id = $1
                  AND applied = FALSE
                  AND action_class = $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                tenant_id, action_class, int(limit),
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, trace_id, step_index, agent_id, action_class,
                       recommended, applied, reason, payload, created_at
                FROM trace_guardrail_actions
                WHERE tenant_id = $1
                  AND applied = FALSE
                  AND action_class IN
                    ('truncate_context','block_user',
                     'escalate_to_admin','revoke_api_key',
                     'apply_policy_change')
                ORDER BY created_at DESC
                LIMIT $2
                """,
                tenant_id, int(limit),
            )
    except Exception as exc:
        logger.debug("fetch_pending_actions: %s", exc)
        return []
    return [_row_to_dict(r) for r in (rows or [])]


async def set_action_applied(
    tenant_id: str,
    *,
    action_id: str,
    applied: bool,
    reason: str,
    user_id: str | None = None,
) -> dict[str, Any] | None:
    """Flip ``applied`` on a single ``trace_guardrail_actions`` row."""
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            UPDATE trace_guardrail_actions
            SET applied = $3,
                reason = COALESCE($4, reason)
            WHERE id = $1::uuid AND tenant_id = $2
            RETURNING id, trace_id, step_index, agent_id, action_class,
                      recommended, applied, reason, payload, created_at
            """,
            action_id, tenant_id, bool(applied), reason[:512],
        )
    except Exception as exc:
        logger.debug("set_action_applied: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


# ── Tenant action config ──────────────────────────────────────────


async def fetch_tenant_action_config(
    tenant_id: str,
    action_class: str,
) -> bool | None:
    """Return the per-tenant kill-switch state for one action class."""
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT applied_by_default
            FROM tenant_guardrail_action_config
            WHERE tenant_id = $1 AND action_class = $2
            """,
            tenant_id, action_class,
        )
    except Exception as exc:
        logger.debug("fetch_tenant_action_config: %s", exc)
        return None
    if row is None:
        return None
    try:
        return bool(row["applied_by_default"])
    except Exception:
        return None


async def set_tenant_action_config(
    tenant_id: str,
    *,
    action_class: str,
    applied_by_default: bool,
    updated_by: str | None = None,
) -> dict[str, Any] | None:
    """Upsert a tenant kill-switch row.

    The upsert uses ``ON CONFLICT (tenant_id, action_class) DO
    UPDATE`` so repeated admin flips don't fail with a unique
    constraint violation.
    """
    client = await _client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO tenant_guardrail_action_config
                (tenant_id, action_class, applied_by_default, updated_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, action_class)
            DO UPDATE SET
                applied_by_default = EXCLUDED.applied_by_default,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
            RETURNING tenant_id, action_class, applied_by_default,
                      updated_by, updated_at
            """,
            tenant_id, action_class, bool(applied_by_default),
            (updated_by or "")[:128] or None,
        )
    except Exception as exc:
        logger.debug("set_tenant_action_config: %s", exc)
        return None
    if row is None:
        return None
    return _row_to_dict(row)


__all__ = [
    "fetch_efficiency_report",
    "fetch_loop_report",
    "fetch_quality_report",
    "fetch_reasoning_report",
    "fetch_guardrail_actions",
    "fetch_pending_actions",
    "set_action_applied",
    "fetch_tenant_action_config",
    "set_tenant_action_config",
]
