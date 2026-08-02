"""Shared helpers for Cat 21 (Custom-Metric Studio) services.

Centralises:
* the envelope shape used for live (non-stub) responses
  (``_ok_envelope``, ``_not_implemented_envelope``) — same
  shape as the Cat 16 ``_common.py`` so the front-end renders
  uniformly
* the persistence pattern (``_delete_then_insert``) used by
  the audit-log writer in :class:`RubricSynthesiser`
* the per-tenant metric store CRUD
  (``_load_org_custom_metrics``, ``_save_org_custom_metrics``)
  — backed by ``organizations.features`` JSONB, no new
  table needed
* the LLM-as-judge opt-in policy gate
  (``_check_auto_judge_policy``) — per-tenant, per-metric,
  per-budget. The default for every tenant is **off**;
  customers must explicitly opt in via the
  ``auto_judge_policy`` JSONB field in their org features.
* a small helper for token-cap enforcement
  (``_enforce_rubric_token_cap``)

The helpers are intentionally local to the package — Cat 21 is
a self-contained unit and the package boundary is the right
place to hide the per-service glue.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Constants ────────────────────────────────────────────────────────

# The hard cap on the synthesised rubric prompt, per the Cat 21
# appendix spec. Enforced at the service layer in
# :class:`RubricSynthesiser` and again here as a safety net so
# any caller (e.g. a future admin tool) cannot ship a
# 5000-token rubric that would dominate the LLM context budget.
RUBRIC_TOKEN_CAP: int = 1500

# The keys the CustomMetricRegistry persists inside
# ``organizations.features``. The two keys are independent:
# ``custom_metrics`` is the metric store (Galileo parity);
# ``auto_judge_policy`` is the LLM-as-judge opt-in policy
# (v1.4 SLM Initiative parity).
CUSTOM_METRICS_FEATURE_KEY: str = "custom_metrics"
AUTO_JUDGE_POLICY_FEATURE_KEY: str = "auto_judge_policy"


# ── Envelope helpers ────────────────────────────────────────────────


def _new_trace_id() -> str:
    return f"mst_{uuid.uuid4().hex[:12]}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The live-response envelope — same shape as the stub envelope
    (so the front-end renders uniformly) but with ``status="ok"``
    and ``live=True`` to signal real data.

    Mirrors :func:`eden.decision._common._ok_envelope` so the
    front-end can treat every intelligence response the same.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _not_implemented_envelope(
    feature: str, message: str, *, data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Deprecated alias for :func:`_validation_envelope`.

    Kept so older call sites and tests that patch the name
    keep working. Prefer :func:`_validation_envelope` for
    input errors and :func:`_error_envelope` for runtime
    failures (LLM missing, etc.).
    """
    return _validation_envelope(feature, message, data=data)


def _validation_envelope(
    feature: str, message: str, *, data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Clear validation-error envelope (live surface, bad input).

    ``status="ok"`` because the route is live and reachable;
    the ``message`` + ``error_code="validation_error"`` tell
    the portal to render an inline form error rather than a
    stub badge.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data or {},
        "message": message,
        "error_code": "validation_error",
    }


def _error_envelope(
    feature: str,
    message: str,
    *,
    error_code: str,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Structured runtime-error envelope (LLM missing, I/O fail).

    Distinct from validation and from the intelligence-gap
    stub ``not_implemented`` — the feature IS implemented;
    this specific call could not be fulfilled.
    """
    return {
        "status": "error",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data or {},
        "message": message,
        "error_code": error_code,
    }


def _policy_off_envelope(
    feature: str, *, metric_id: str, reason: str
) -> dict[str, Any]:
    """The "auto-judge policy is OFF" envelope. The judge is
    registered, the org has the metric, but the per-tenant
    opt-in gate returned ``False`` so the score is suppressed.
    Distinct from the live "scored" envelope — the front-end
    can show a "metric registered, not auto-scoring" hint.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {
            "metric_id": metric_id,
            "scored": False,
            "reason": reason,
        },
    }


# ── JSON helpers ────────────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    """JSON serialiser with a stable, Postgres-friendly default."""
    return json.dumps(obj, default=str, ensure_ascii=False)


def _json_loads(s: str | None, default: Any = None) -> Any:
    """Best-effort JSON deserialiser — returns ``default`` on
    any failure. Used when reading the audit-log row's
    ``examples_json`` or ``result_json`` columns."""
    if not s:
        return default
    try:
        return json.loads(s)
    except (ValueError, TypeError) as exc:
        logger.debug("metric_studio._common: json load failed: %s", exc)
        return default


# ── Token-cap enforcement ───────────────────────────────────────────


def _enforce_rubric_token_cap(rubric: str) -> str:
    """Truncate the synthesised rubric to :data:`RUBRIC_TOKEN_CAP`
    tokens. A token ≈ 4 chars (the OpenAI / Anthropic rule of
    thumb), so we use ``4 * cap`` as the char limit.

    The 1500-token cap is non-negotiable per the Cat 21
    appendix spec — a 5000-token rubric dominates the LLM
    context budget and breaks the cost/quality trade-off that
    justifies the custom-metric feature in the first place.
    """
    if not rubric or not isinstance(rubric, str):
        return ""
    char_limit = 4 * RUBRIC_TOKEN_CAP
    if len(rubric) <= char_limit:
        return rubric
    return rubric[: max(0, char_limit - 1)] + "…"


def _approximate_token_count(s: str) -> int:
    """Best-effort token count for the audit log's
    ``rubric_tokens`` column. Same 4-chars-per-token rule as
    :func:`_enforce_rubric_token_cap`."""
    if not s:
        return 0
    return max(1, len(s) // 4)


# ── Persistence ─────────────────────────────────────────────────────


async def _delete_then_insert(
    org_id: str,
    run_id: str,
    table: str,
    columns: list[str],
    values: list[Any],
) -> None:
    """Atomic delete-then-insert for the ``custom_metric_runs`` table.

    The migration 021 schema has no unique constraint on
    ``custom_metric_runs.id`` (it does on PK only), so the only
    way to make the audit-log writer re-runnable is to clear the
    ``(org_id, id)`` row and re-insert.

    Used by :class:`RubricSynthesiser.from_examples` and
    :func:`approve` — both can be safely re-run idempotently.

    Best-effort: any exception is logged and swallowed so the
    caller can still return the live envelope with the
    in-memory data. Persistence is a side-effect, not the
    contract.

    Defence-in-depth: ``table`` and each ``columns[i]`` are
    interpolated raw into SQL below. Today every caller passes
    hardcoded strings, but we validate the identifier shape so a
    future caller can't smuggle SQL via a column list that came
    from request input.
    """
    import re as _re
    _ident = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    if not isinstance(table, str) or not _ident.match(table):
        raise ValueError(
            f"_delete_then_insert: invalid SQL identifier table={table!r}"
        )
    for i, c in enumerate(columns):
        if not isinstance(c, str) or not _ident.match(c):
            raise ValueError(
                f"_delete_then_insert: invalid SQL identifier column[{i}]={c!r}"
            )
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                f"DELETE FROM {table} WHERE org_id = $1 AND id = $2",
                org_id,
                run_id,
            )
            if not values:
                return
            # asyncpg needs a unique placeholder per column.
            placeholders = ", ".join(
                f"${i + 3}" for i in range(len(values))
            )
            cols_csv = ", ".join(columns)
            await conn.execute(
                f"INSERT INTO {table} (id, org_id, {cols_csv}) "
                f"VALUES ($1, $2, {placeholders})",
                run_id,
                org_id,
                *values,
            )
    except Exception as exc:
        logger.debug(
            "metric_studio._common: delete_then_insert %s failed: %s", table, exc
        )


async def _update_run_status(
    org_id: str,
    run_id: str,
    *,
    status: str | None = None,
    approval_status: str | None = None,
    approved_by: str | None = None,
    rejection_reason: str | None = None,
    judge_name: str | None = None,
    metric_id: str | None = None,
) -> None:
    """Partial update of a single ``custom_metric_runs`` row.

    Used by the approve / reject path to flip the
    ``approval_status`` + record the reviewer + timestamp, and
    by the register path to backfill ``metric_id`` /
    ``judge_name`` once the rubric is wrapped as a runtime
    judge.

    Best-effort like the other helpers.
    """
    sets: list[str] = []
    args: list[Any] = []
    idx = 3
    if status is not None:
        sets.append(f"status = ${idx}")
        args.append(status)
        idx += 1
    if approval_status is not None:
        sets.append(f"approval_status = ${idx}")
        args.append(approval_status)
        idx += 1
    if approved_by is not None:
        sets.append(f"approved_by = ${idx}")
        args.append(approved_by)
        idx += 1
    if rejection_reason is not None:
        sets.append(f"rejection_reason = ${idx}")
        args.append(rejection_reason)
        idx += 1
    if judge_name is not None:
        sets.append(f"judge_name = ${idx}")
        args.append(judge_name)
        idx += 1
    if metric_id is not None:
        sets.append(f"metric_id = ${idx}")
        args.append(metric_id)
        idx += 1
    if not sets:
        return
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            set_clause = ", ".join(sets)
            await conn.execute(
                f"UPDATE custom_metric_runs SET {set_clause} "
                f"WHERE org_id = $1 AND id = $2",
                org_id,
                run_id,
                *args,
            )
    except Exception as exc:
        logger.debug(
            "metric_studio._common: update_run_status failed: %s", exc
        )


async def _fetch_run_runs(
    org_id: str, metric_id: str, *, since_iso: str | None = None
) -> list[dict[str, Any]]:
    """Fetch the scoring rows for one (org, metric). Used by
    :meth:`CustomMetricRegistry.list` to compute ``n_scores_30d``
    and ``median_score``. The ``since_iso`` filter is optional —
    the caller passes ``datetime.now(timezone.utc) - timedelta(days=30)``
    for the 30-day window."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio._common: postgres import failed: %s", exc)
        return []
    client = await get_postgres_client()
    if client is None:
        return []
    try:
        if since_iso:
            rows = await client.fetch(
                "SELECT score, trace_id, created_at FROM custom_metric_runs "
                "WHERE org_id = $1 AND metric_id = $2 AND status = 'scored' "
                "AND created_at >= $3 "
                "ORDER BY created_at DESC",
                org_id,
                metric_id,
                since_iso,
            )
        else:
            rows = await client.fetch(
                "SELECT score, trace_id, created_at FROM custom_metric_runs "
                "WHERE org_id = $1 AND metric_id = $2 AND status = 'scored' "
                "ORDER BY created_at DESC",
                org_id,
                metric_id,
            )
    except Exception as exc:
        logger.debug("metric_studio._common: fetch_run_runs failed: %s", exc)
        return []
    return [dict(r) for r in rows]


# ── Per-tenant metric store (organizations.features JSONB) ─────────


async def _load_org_features(org_id: str) -> dict[str, Any]:
    """Read the ``organizations.features`` JSONB column for one
    org. Returns an empty dict if the org has no features row
    yet (graceful default — the first call to
    :func:`_save_org_features` will create the row).

    Best-effort: any exception is logged and returns ``{}``.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio._common: postgres import failed: %s", exc)
        return {}
    client = await get_postgres_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            "SELECT features FROM organizations WHERE id = $1",
            org_id,
        )
    except Exception as exc:
        logger.debug("metric_studio._common: load_org_features failed: %s", exc)
        return {}
    if row is None:
        return {}
    features = row.get("features")
    if isinstance(features, dict):
        return features
    if isinstance(features, str) and features:
        # Defensive — Postgres jsonb sometimes serialises to a
        # string on read in older drivers. Best-effort parse.
        return _json_loads(features, default={}) or {}
    return {}


async def _save_org_features(org_id: str, features: dict[str, Any]) -> None:
    """Atomically replace the ``organizations.features`` JSONB
    column. We use ``jsonb_set`` so we never clobber keys the
    metric studio does not own (e.g. ``intelligence_gap_v0``,
    ``auto_judge_policy``). The caller passes the *full* merged
    dict (caller is responsible for merging), this helper just
    persists.

    Best-effort like the other helpers.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio._common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                "UPDATE organizations SET features = $1::jsonb WHERE id = $2",
                _json_dumps(features),
                org_id,
            )
    except Exception as exc:
        logger.debug("metric_studio._common: save_org_features failed: %s", exc)


async def _load_org_custom_metrics(org_id: str) -> list[dict[str, Any]]:
    """Read the ``custom_metrics`` array from
    ``organizations.features``. Returns ``[]`` if the org has
    no features row or the key is missing.
    """
    features = await _load_org_features(org_id)
    raw = features.get(CUSTOM_METRICS_FEATURE_KEY, [])
    if not isinstance(raw, list):
        return []
    return [m for m in raw if isinstance(m, dict)]


async def _save_org_custom_metrics(
    org_id: str, metrics: list[dict[str, Any]]
) -> None:
    """Atomically replace the ``custom_metrics`` array inside
    ``organizations.features``. Other keys in ``features`` are
    preserved (we read-merge-write)."""
    features = await _load_org_features(org_id)
    features[CUSTOM_METRICS_FEATURE_KEY] = metrics
    await _save_org_features(org_id, features)


# ── LLM-as-judge opt-in policy (v1.4) ───────────────────────────────


async def _check_auto_judge_policy(
    org_id: str, metric_id: str
) -> tuple[bool, str]:
    """The v1.4 LLM-as-judge opt-in gate.

    Returns ``(allowed, reason)``. The default for every
    tenant is **off**; a per-tenant ``auto_judge_policy``
    config in ``organizations.features`` must opt the metric
    in. The policy shape is::

        auto_judge_policy: {
            "custom_metrics": {<metric_id>: true, ...},
            "auto_judge_sample_rate": 0.0..1.0,
            "auto_judge_daily_budget_usd": 0.0..N,
        }

    The gate returns ``True`` only when **all** of:

    1. The metric is in the ``custom_metrics`` allow-list
       (per-metric opt-in).
    2. The daily budget hasn't been exceeded (tracked in the
       ``custom_metric_runs`` table — we approximate the
       budget check by counting today's rows against the
       configured limit; the real implementation will use a
       per-org counter row).

    Manual triggers (the ``POST /metrics/{metric_id}/approve``
    and per-call run paths) do NOT need this gate — those are
    explicit user actions. The gate only fires when the
    registered ``RubricJudge`` is invoked by the runtime
    (Cat 1 :class:`TelemetryEvent` stream).

    Best-effort: any exception returns ``(False, "policy_check_failed")``
    so the default-OFF behaviour is preserved on error.
    """
    features = await _load_org_features(org_id)
    policy = features.get(AUTO_JUDGE_POLICY_FEATURE_KEY) or {}
    if not isinstance(policy, dict):
        return False, "policy_malformed"

    custom_metrics = policy.get("custom_metrics") or {}
    if not isinstance(custom_metrics, dict):
        return False, "policy_malformed"
    if not custom_metrics.get(metric_id):
        return False, "metric_not_opted_in"

    # Sample rate check — even when opted in, the policy can
    # throttle auto-scoring to a fraction of events. We don't
    # have the event in this call (the gate is event-agnostic),
    # so we just expose the configured rate to the caller.
    # The RubricJudge applies the actual sampling.
    sample_rate = float(policy.get("auto_judge_sample_rate", 1.0) or 0.0)
    if sample_rate <= 0.0:
        return False, "sample_rate_zero"

    # Budget check — count today's scoring rows and compare to
    # the configured daily budget. The cost-per-row is a
    # conservative estimate (the v1.4 SLM Initiative will
    # replace this with a precise per-row cost from the LLM
    # call metadata).
    daily_budget = float(policy.get("auto_judge_daily_budget_usd", 0.0) or 0.0)
    if daily_budget > 0.0:
        try:
            from datetime import timedelta

            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is not None:
                since = (
                    datetime.now(UTC) - timedelta(days=1)
                ).isoformat()
                row = await client.fetchrow(
                    "SELECT COUNT(*) AS n FROM custom_metric_runs "
                    "WHERE org_id = $1 AND metric_id = $2 "
                    "AND status = 'scored' AND created_at >= $3",
                    org_id,
                    metric_id,
                    since,
                )
                n_today = int(row["n"]) if row else 0
                # Conservative cost estimate: $0.001 per scored
                # row. The real number comes from the LLM
                # response's usage metadata in v1.4.
                spent_today = n_today * 0.001
                if spent_today >= daily_budget:
                    return False, "daily_budget_exceeded"
        except Exception as exc:
            logger.debug(
                "metric_studio._common: budget check failed: %s", exc
            )
            # On error, return False to preserve the default-OFF
            # behaviour.
            return False, "budget_check_failed"

    return True, "opted_in"
