"""Shared helpers for Cat 23 (Autonomous Code Modification) services.

The Cat 23 STUB surface follows the same patterns as Cat 16
(:file:`eden/decision/_common.py`):

* envelope shape: ``status`` / ``feature`` / ``live`` / ``trace_id`` /
  ``timestamp`` / ``data`` — same fields as the v0
  :class:`eden.intelligence_envelope.IntelligenceStubResponse`
* persistence: ``_delete_then_insert`` for the 8 Cat 23 tables; the
  migration (023_autonomous_code_modification.py) doesn't declare a
  unique constraint on the 8 tables, so the only way to make the
  services re-runnable is to clear the (org, ...) rows and re-insert.
* policy gate: the two-stage opt-in policy is read at every entry
  point (``_check_two_stage_optin``) so the auto-mode routes
  (``POST /patches/{id}/pr`` and ``POST /prs/{id}/revert``) cannot
  fire without both ``code_change_enabled`` AND the per-action
  ``auto_pr_enabled`` / ``auto_revert_enabled`` opt-ins.

STUB mode contract (per the v1.6 STUB checklist):

* **Read-only routes** (POST /repos/connect, GET /repos, GET /policy,
  GET /patches/{id}, GET /inbox*, GET /prs*) return the live
  envelope (``status="ok"``, ``live=True``) with a deterministic
  in-memory response derived from the input. No external calls.
* **Destructive routes** (POST /patches, POST /patches/{id}/pr,
  POST /prs/{id}/revert) return the not-implemented envelope
  (``status="not_implemented"``, ``live=False``) with a
  ``gate=<N>_blocked`` marker so the portal can show
  "this requires Gate N (real ship)".
* **TestPlanRunner.run** is the canonical example: it returns
  ``gate=3_blocked`` because the sandbox worker (Gate 3) is
  intentionally not yet wired.

The helpers are intentionally local to the package — Cat 23 is a
self-contained unit and the package boundary is the right place to
hide the per-service glue.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


# ── Envelope helpers ────────────────────────────────────────────────


def _new_id(prefix: str) -> str:
    """Deterministic-ish id with a ``<prefix>_<16-hex>`` shape.

    Mirrors the v0 pattern from Cat 5 (``mem_<uuid>``) and Cat 9
    (``cnv_<uuid>``) but with a Cat 23-specific prefix. The id is
    used as the row id for the 8 Cat 23 tables and as the
    ``trace_id`` in the live envelope so server logs can correlate.
    """
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _new_envelope_trace_id() -> str:
    """Per-envelope trace id, distinct from the row id.

    The envelope's ``trace_id`` is the standard
    ``stub_<uuid>`` / ``live_<uuid>`` shape so the existing
    logging infrastructure can recognise it.
    """
    return _new_id("live")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The live-response envelope for read-only Cat 23 routes.

    Returns ``status="ok"`` and ``live=True`` so the front-end can
    render the data without a "preview" badge. The shape matches
    :class:`eden.intelligence_envelope.IntelligenceStubResponse` so
    the front-end renders uniformly across all 23 cats.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_envelope_trace_id(),
        "timestamp": _now_iso(),
        "data": data,
    }


def _not_implemented_envelope(
    feature: str,
    *,
    message: str | None = None,
    gate: str | None = None,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The Cat 23 STUB envelope for destructive / blocked routes.

    The ``gate`` marker (e.g. ``"3_blocked"``) tells the portal
    "this requires Gate 3 (sandbox safety) to be completed before
    the real implementation can ship". The marker is surfaced in
    the response data so the front-end can show a clear
    "requires Gate N" badge.

    Example:
        >>> env = _not_implemented_envelope(
        ...     "code_change", gate="3_blocked"
        ... )
        >>> env["status"]
        'not_implemented'
        >>> env["live"]
        False
        >>> env["data"]["gate"]
        '3_blocked'
        >>> env["feature"]
        'code_change'
    """
    msg = message or "Stub registered; implementation pending Gate 3 (sandbox safety)"
    payload: dict[str, Any] = {"feature": feature, "message": msg}
    if gate is not None:
        payload["gate"] = gate
    if data is not None:
        payload["data"] = data
    return {
        "status": "not_implemented",
        "feature": feature,
        "live": False,
        "trace_id": _new_id("stub"),
        "timestamp": _now_iso(),
        "data": payload,
        "message": msg,
    }


# ── Real-error envelope ────────────────────────────────────────────


def _error_envelope(
    feature: str,
    *,
    message: str,
    error_code: str,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A real-error envelope for genuine failures.

    Distinct from :func:`_not_implemented_envelope` (which says
    "this feature isn't wired up") — this says "the user made a
    request we couldn't fulfill". Returns ``status="error"`` with
    a stable ``error_code`` so the portal can show a clear message
    and an actionable next step.

    Examples:
        >>> env = _error_envelope(
        ...     "code_change",
        ...     message="Patch patch_abc not found in proposed_patches",
        ...     error_code="patch_not_found",
        ... )
        >>> env["status"]
        'error'
        >>> env["error_code"]
        'patch_not_found'
    """
    payload: dict[str, Any] = {"feature": feature, "message": message, "error_code": error_code}
    if data is not None:
        payload["data"] = data
    return {
        "status": "error",
        "feature": feature,
        "live": True,
        "trace_id": _new_id("err"),
        "timestamp": _now_iso(),
        "error_code": error_code,
        "message": message,
        "data": payload,
    }


# ── Policy gate (the two-stage opt-in) ──────────────────────────────


# Default policy shape — what an org gets before they've configured
# the per-org policy. Mirrors the v0 defaults documented in the
# ``CodeChangePolicyService`` module.
DEFAULT_POLICY: dict[str, Any] = {
    "code_change_enabled": False,
    "auto_pr_enabled": False,
    "auto_revert_enabled": False,
    "max_blast_radius_score": 0.5,
    "min_rca_confidence": 0.7,
    "min_test_pass_rate": 0.95,
    "min_quality_score": 0.8,
    "protected_paths": ["src/auth/", "src/billing/", "infra/"],
    "protected_branch_patterns": ["^main$", "^release/.*"],
    "min_post_merge_window_hours": 24,
    "revert_threshold_pct": 10.0,
    "max_patches_per_day": 3,
    "max_cost_per_patch_usd": 5.0,
    "required_reviewers": ["@security-team", "@oncall"],
}


# The 3 modes a STUB-mode endpoint can be in. The destructive
# routes (POST /patches, POST /patches/{id}/pr, POST /prs/{id}/revert)
# are all gated by ``code_change_enabled`` first, and only the
# auto-mode routes are additionally gated by ``auto_pr_enabled``
# and ``auto_revert_enabled``.
ACTION_KINDS = frozenset(
    {"create_patch", "open_pr", "revert_pr", "auto_approve", "run_tests"}
)


# Map: which action requires which auto-mode opt-in. Used by
# ``_check_two_stage_optin`` to short-circuit with a clear error
# if the opt-in is missing.
_AUTO_OPTIN_REQUIRED: dict[str, str] = {
    "open_pr": "auto_pr_enabled",
    "revert_pr": "auto_revert_enabled",
    "auto_approve": "auto_pr_enabled",  # auto-approval implies auto-PR
}


def _check_two_stage_optin(
    feature: str,
    policy: dict[str, Any],
    action: str,
) -> dict[str, Any] | None:
    """The two-stage opt-in gate.

    Returns ``None`` if the action is allowed (per the policy);
    returns a not-implemented envelope if the policy is missing
    the required opt-in. The check is the single chokepoint for
    every STUB-mode route — the router must call it before any
    side-effect.

    The first stage (``code_change_enabled``) gates every action.
    The second stage (``auto_pr_enabled`` / ``auto_revert_enabled``)
    gates only the auto-mode actions (per the v1.6 STUB checklist:
    "every STUB endpoint reads ``code_change_enabled`` from
    ``organizations.features.code_change_policy`` BEFORE the
    auto-mode gates").

    Examples:
        Default policy → all actions blocked:

        >>> from eden.code_change._common import DEFAULT_POLICY
        >>> result = _check_two_stage_optin(
        ...     "code_change", dict(DEFAULT_POLICY), "open_pr"
        ... )
        >>> result is not None and result["status"] == "not_implemented"
        True
        >>> result["data"]["gate"]
        'optin_blocked'

        code_change_enabled=True but no auto-mode opt-in →
        manual actions allowed, auto-mode actions blocked:

        >>> p = dict(DEFAULT_POLICY, code_change_enabled=True)
        >>> _check_two_stage_optin("code_change", p, "create_patch") is None
        True
        >>> blocked = _check_two_stage_optin("code_change", p, "open_pr")
        >>> blocked["data"]["gate"]
        'auto_mode_blocked'

        Full opt-in (both stages) → all actions allowed:

        >>> p = dict(p, auto_pr_enabled=True, auto_revert_enabled=True)
        >>> _check_two_stage_optin("code_change", p, "open_pr") is None
        True
        >>> _check_two_stage_optin("code_change", p, "revert_pr") is None
        True
    """
    if not bool(policy.get("code_change_enabled", False)):
        return _not_implemented_envelope(
            feature,
            message=(
                "code_change_enabled is false (default for every org). "
                "An org admin must opt in via POST /policy before "
                "any destructive action will be honoured."
            ),
            gate="optin_blocked",
        )

    optin_key = _AUTO_OPTIN_REQUIRED.get(action)
    if optin_key is not None and not bool(policy.get(optin_key, False)):
        return _not_implemented_envelope(
            feature,
            message=(
                f"{action} requires {optin_key}=true. "
                "The two-stage opt-in must be flipped before "
                "this auto-mode action will be honoured."
            ),
            gate="auto_mode_blocked",
        )

    return None  # allowed


# ── Persistence ─────────────────────────────────────────────────────


async def _delete_then_insert(
    org_id: str,
    key_col: str,
    key_val: str,
    table: str,
    columns: list[str],
    values: list[Any],
) -> None:
    """Atomic delete-then-insert for the 8 Cat 23 tables.

    Mirrors the Cat 16 pattern (:func:`eden.decision._common.
    _delete_then_insert`): the migration doesn't declare a unique
    constraint on the 8 tables, so the only way to make the
    services re-runnable is to clear the (org, key) rows and
    re-insert.

    Best-effort: any exception is logged and swallowed so the
    caller can still return the live envelope with the in-memory
    data. Persistence is a side-effect, not the contract.
    """
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                f"DELETE FROM {table} WHERE org_id = $1 AND {key_col} = $2",
                org_id,
                key_val,
            )
            if not values:
                return
            placeholders = ", ".join(
                f"${i + 3}" for i in range(len(values))
            )
            cols_csv = ", ".join(columns)
            await conn.execute(
                f"INSERT INTO {table} (org_id, {key_col}, {cols_csv}) "
                f"VALUES ($1, $2, {placeholders})",
                org_id,
                key_val,
                *values,
            )
    except Exception as exc:
        logger.debug(
            "code_change._common: delete_then_insert %s failed: %s", table, exc
        )


async def _insert_row(
    org_id: str,
    table: str,
    columns: list[str],
    values: list[Any],
) -> None:
    """Insert one row into a Cat 23 table.

    The first column is always assumed to be a deterministic
    id (the ``_new_id`` shape) so re-runs with the same id
    are idempotent at the application layer. Best-effort like
    :func:`_delete_then_insert`.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("code_change._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            placeholders = ", ".join(f"${i + 1}" for i in range(len(values) + 1))
            cols_csv = ", ".join(["org_id", *columns])
            await conn.execute(
                f"INSERT INTO {table} (org_id, {cols_csv}) "
                f"VALUES ({placeholders})",
                org_id,
                *values,
            )
    except Exception as exc:
        logger.debug(
            "code_change._common: insert_row %s failed: %s", table, exc
        )


async def _select_rows(
    org_id: str,
    table: str,
    *,
    where: str = "",
    params: tuple[Any, ...] = (),
    order_by: str = "created_at DESC",
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Read rows from a Cat 23 table scoped by ``org_id``.

    Returns a list of dicts keyed by column name. Returns ``[]``
    on any DB error — the caller treats empty as "no data yet"
    rather than an exception. The WHERE clause is the caller's
    responsibility; only the ``org_id`` filter is appended
    automatically so callers cannot accidentally cross tenants.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("code_change._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        sql = f"SELECT * FROM {table} WHERE org_id = $1"
        query_params: list[Any] = [org_id]
        if where:
            sql += f" AND ({where})"
            for i, p in enumerate(params, start=2):
                sql = sql.replace(f"${i}", f"${len(query_params) + 1}")
                # NOTE: simplistic placeholder rebinding — only supports
                # $2..$N from the caller's WHERE; multi-placeholder WHEREs
                # should use literal values or extend this helper.
                query_params.append(p)
        sql += f" ORDER BY {order_by} LIMIT {int(limit)} OFFSET {int(offset)}"
        async with client.acquire() as conn:
            rows = await conn.fetch(sql, *query_params)
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug(
            "code_change._common: select_rows %s failed: %s", table, exc
        )
        return []


async def _select_one(
    org_id: str,
    table: str,
    *,
    where: str,
    params: tuple[Any, ...] = (),
) -> dict[str, Any] | None:
    """Read a single row from a Cat 23 table scoped by ``org_id``.

    Returns the row dict, or ``None`` if not found. Same error
    semantics as :func:`_select_rows`.
    """
    rows = await _select_rows(
        org_id,
        table,
        where=where,
        params=params,
        limit=1,
    )
    return rows[0] if rows else None


async def _update_row(
    org_id: str,
    table: str,
    *,
    where_col: str,
    where_val: str,
    set_col: str,
    set_val: Any,
) -> bool:
    """Update one column on a single Cat 23 row.

    Returns ``True`` if a row was matched and updated, ``False``
    otherwise. Used by approval flows to flip patch status and by
    disconnect to flip repo status. Same error-swallow semantics
    as :func:`_insert_row` — DB errors return ``False``.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("code_change._common: postgres import failed: %s", exc)
        return False

    client = await get_postgres_client()
    if client is None:
        return False
    try:
        async with client.acquire() as conn:
            result = await conn.execute(
                f"UPDATE {table} SET {set_col} = $3, updated_at = NOW() "
                f"WHERE org_id = $1 AND {where_col} = $2",
                org_id,
                where_val,
                set_val,
            )
        # asyncpg's execute returns "UPDATE <n>"
        return result.endswith(" 1")
    except Exception as exc:
        logger.debug(
            "code_change._common: update_row %s failed: %s", table, exc
        )
        return False


# ── Diff parsing helpers (for the blast-radius + quality scorers) ──


_UNIFIED_DIFF_FILE_RE = re.compile(r"^\+\+\+ b/(.+)$", re.MULTILINE)
_UNIFIED_DIFF_HUNK_RE = re.compile(r"^@@", re.MULTILINE)
_UNIFIED_DIFF_LINE_RE = re.compile(r"^[+-](?!\+\+)(?!--)", re.MULTILINE)


def diff_line_count(diff: str) -> int:
    """Count the number of ``+``/``-`` lines in a unified diff.

    Excludes ``+++``/``---`` file headers and ``@@`` hunk
    headers. Used by the auto-approval metrics collector.
    """
    if not diff:
        return 0
    return len(_UNIFIED_DIFF_LINE_RE.findall(diff))


def diff_files_changed(diff: str) -> list[str]:
    """Extract the list of files changed by a unified diff.

    Returns the file paths in the order they appear in the diff.
    Used by the blast-radius analyzer and the auto-approval
    metrics collector.
    """
    if not diff:
        return []
    return _UNIFIED_DIFF_FILE_RE.findall(diff)


def diff_hunk_count(diff: str) -> int:
    """Count the number of hunks in a unified diff.

    Used by the complexity component of :class:`PRQualityScorer`
    (a rough proxy for cyclomatic complexity when the real
    tree-sitter pass isn't available).
    """
    if not diff:
        return 0
    return len(_UNIFIED_DIFF_HUNK_RE.findall(diff))


# ── JSON helpers ────────────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    """Compact JSON for the JSONB columns on the 8 Cat 23 tables."""
    try:
        return json.dumps(obj, separators=(",", ":"), default=str)
    except Exception:  # pragma: no cover - defensive
        return "{}"


def _json_loads(raw: str | None) -> dict[str, Any]:
    """Best-effort JSON load for the JSONB columns."""
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {"value": value}
    except Exception:  # pragma: no cover - defensive
        return {}
