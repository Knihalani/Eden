"""Closed-loop executor (Cat 17) — surface + apply the hook recommendations.

The v0 ship:

* :class:`ClosedLoopExecutor.list_pending` — list the org's
  ``closed_loop_actions`` rows in ``pending_approval`` status.
  Read path for the portal's "Pending Actions" panel.
* :class:`ClosedLoopExecutor.approve` — mark a row as
  ``approved`` (in v0.1 this is what triggers the side effect;
  v0 ships the marker only so the RBAC + audit trail is in
  place before the side-effect code paths are added).
* :class:`ClosedLoopExecutor.deny` — mark a row as
  ``denied``; the executor will not retry it.
* :class:`ClosedLoopExecutor.apply_approved` — best-effort
  side effect applier. The v0 ship logs the action; v0.1
  wires the per-action handlers (block_promotion, rollback,
  archive, …).
* :class:`ClosedLoopExecutor.dashboard` — aggregate counts
  per ``action_kind`` for the closed-loop dashboard.

Conventions:
* Every method uses the existing
  :func:`eden.intelligence_envelope`-style ``ok`` envelope.
* The DB write paths are best-effort — a missing Postgres
  substrate never breaks the API. Errors are logged at
  debug and the caller sees a graceful empty list / 0 count.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from eden.intelligence_envelope import not_implemented

logger = logging.getLogger(__name__)


# ─── Helpers ──────────────────────────────────────────────────────


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "timestamp": _now_iso(),
        "data": data,
    }


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    if isinstance(row, dict):
        d = dict(row)
    else:
        try:
            d = dict(row)
        except Exception:
            return {}
    payload = d.get("payload_json")
    if isinstance(payload, str) and payload:
        try:
            d["payload"] = json.loads(payload)
        except Exception:
            d["payload"] = {}
    else:
        d["payload"] = {}
    d.pop("payload_json", None)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif v is not None and not isinstance(v, (str, int, float, bool, list, dict)):
            d[k] = str(v)
    return d


async def _fetch_actions(
    org_id: str,
    *,
    status: str | None = "pending_approval",
    limit: int = 50,
) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return []
    try:
        client = await get_postgres_client()
    except Exception:
        return []
    if client is None:
        return []
    if status is None:
        # No status filter
        try:
            rows = await client.fetch(
                """
                SELECT id, org_id, hook_name, action_kind, target,
                       payload_json, severity, status,
                       applied_at, applied_by, created_at
                FROM closed_loop_actions
                WHERE org_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                org_id, int(limit),
            )
        except Exception as exc:
            logger.debug("closed_loop_executor: fetch failed: %s", exc)
            return []
    else:
        try:
            rows = await client.fetch(
                """
                SELECT id, org_id, hook_name, action_kind, target,
                       payload_json, severity, status,
                       applied_at, applied_by, created_at
                FROM closed_loop_actions
                WHERE org_id = $1 AND status = $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                org_id, status, int(limit),
            )
        except Exception as exc:
            logger.debug("closed_loop_executor: fetch failed: %s", exc)
            return []
    return [_row_to_dict(r) for r in (rows or [])]


async def _fetch_action_by_id(
    org_id: str, action_id: str
) -> dict[str, Any] | None:
    """Fetch a single closed-loop action by id (G8).

    The old ``apply_approved`` fetched ``limit=1`` approved rows then
    linearly scanned for the id — which silently missed the target
    whenever it was not the single most-recent approved row. This reads
    the exact row.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, hook_name, action_kind, target,
                   payload_json, severity, status,
                   applied_at, applied_by, created_at
            FROM closed_loop_actions
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id, action_id,
        )
    except Exception as exc:
        logger.debug("closed_loop_executor: fetch_by_id failed: %s", exc)
        return None
    return _row_to_dict(row) if row else None


async def _dispatch_side_effect(
    org_id: str, action: dict[str, Any]
) -> dict[str, Any]:
    """Execute the real side-effect for an approved action (G8).

    Routes ``action_kind`` to a concrete service:

    * ``investigate`` → triage the issue (or investigate the trigger).
    * ``rollback``/``rollback_canary`` → canary rollback.
    * ``reweight`` → ModelRouter reweight.
    * ``cache_bust`` → flush the response cache.
    * ``propose_patch``/``propose_patch_from_rca`` → autonomous patch.

    Unknown kinds are recorded (no destructive default). Never raises —
    returns a ``{side_effect, detail}`` dict.
    """
    kind = str(action.get("action_kind") or "unknown")
    payload = action.get("payload") or {}
    target = action.get("target")
    issue_id = payload.get("issue_id") if isinstance(payload, dict) else None

    try:
        if kind == "investigate":
            if issue_id:
                from eden.issues.triage_agent import TriageAgent

                await TriageAgent().triage(org_id, str(issue_id))
                return {"side_effect": "triage", "detail": {"issue_id": issue_id}}
            trigger = _trigger_from_payload(payload, target)
            if trigger:
                from eden.autonomous import InvestigationAgent

                await InvestigationAgent().investigate(org_id, trigger=trigger)
                return {"side_effect": "investigate", "detail": {"trigger": trigger}}
            return {"side_effect": "recorded", "detail": {"reason": "no target"}}

        if kind in ("rollback", "rollback_canary"):
            from eden.autonomous.investigation import _execute_rollback

            after = await _execute_rollback(org_id, {}, {"action_type": "rollback"})
            return {"side_effect": "rollback", "detail": after}

        if kind == "reweight":
            from eden.autonomous.investigation import _execute_reweight

            after = await _execute_reweight({"action_type": "reweight"})
            return {"side_effect": "reweight", "detail": after}

        if kind == "cache_bust":
            from eden.autonomous.investigation import _execute_cache_bust

            after = await _execute_cache_bust({"action_type": "cache_bust"})
            return {"side_effect": "cache_bust", "detail": after}

        if kind in ("propose_patch", "propose_patch_from_rca"):
            try:
                from eden.patches.issue_patch_trigger import (
                    propose_patch_for_action,
                )

                detail = await propose_patch_for_action(org_id, action)
                return {"side_effect": "propose_patch", "detail": detail}
            except Exception as exc:
                logger.debug("dispatch: propose_patch unavailable: %s", exc)
                return {"side_effect": "recorded", "detail": {"kind": kind}}
    except Exception as exc:
        logger.warning(
            "closed_loop_executor: side-effect %s failed: %s", kind, exc
        )
        return {"side_effect": "error", "detail": {"error": str(exc)}}

    return {"side_effect": "recorded", "detail": {"kind": kind}}


def _trigger_from_payload(payload: Any, target: str | None) -> str | None:
    if isinstance(payload, dict):
        pe = payload.get("primary_entity_id")
        if isinstance(pe, str) and ":" in pe:
            # e.g. "cluster:<id>" → "incident:<id>"; "issue:<id>" as-is.
            head, _, rest = pe.partition(":")
            if head == "cluster":
                return f"incident:{rest}"
            if head in ("issue", "incident", "drift_alert", "judge_regression"):
                return pe
    if target:
        return f"incident:{target}"
    return None


async def _update_status(
    org_id: str,
    action_id: str,
    *,
    new_status: str,
    applied_by: str | None = None,
) -> bool:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return False
    try:
        client = await get_postgres_client()
    except Exception:
        return False
    if client is None:
        return False
    try:
        if new_status == "approved":
            await client.execute(
                """
                UPDATE closed_loop_actions
                SET status = $1
                WHERE id = $2::uuid AND org_id = $3
                """,
                new_status, action_id, org_id,
            )
        else:
            # approved / applied / denied: stamp applied_at + applied_by
            await client.execute(
                """
                UPDATE closed_loop_actions
                SET status = $1,
                    applied_at = NOW(),
                    applied_by = $4
                WHERE id = $2::uuid AND org_id = $3
                """,
                new_status, action_id, org_id, (applied_by or "")[:128] or None,
            )
    except Exception as exc:
        logger.debug("closed_loop_executor: update failed: %s", exc)
        return False
    return True


# ─── ClosedLoopExecutor ───────────────────────────────────────────


class ClosedLoopExecutor:
    """Surface + apply the closed-loop hook recommendations.

    The v0 ship is *advisory only* — :meth:`approve` and
    :meth:`deny` flip the row's status but do not mutate
    the production system. :meth:`apply_approved` is the
    hook that v0.1 will wire to the per-action handlers
    (block_promotion, rollback, archive, …).
    """

    name = "closed_loop_executor"

    async def list_pending(
        self,
        org_id: str,
        *,
        limit: int = 50,
    ) -> dict[str, Any]:
        """List the org's pending closed-loop actions.

        Returns ``data: {"actions": [...], "count": N}``.
        """
        rows = await _fetch_actions(
            org_id, status="pending_approval", limit=limit
        )
        return _ok_envelope(
            self.name,
            {"actions": rows, "count": len(rows), "status": "pending_approval"},
        )

    async def list_all(
        self,
        org_id: str,
        *,
        limit: int = 50,
    ) -> dict[str, Any]:
        """List all closed-loop actions for the org (any status)."""
        rows = await _fetch_actions(org_id, status=None, limit=limit)
        return _ok_envelope(
            self.name,
            {"actions": rows, "count": len(rows), "status": "all"},
        )

    async def approve(
        self,
        org_id: str,
        *,
        action_id: str,
        applied_by: str | None = None,
    ) -> dict[str, Any]:
        """Mark a pending action as approved.

        The v0 ship flips the status flag; v0.1 wires the
        side-effect applier. Returns the updated row.
        """
        if not action_id:
            return not_implemented(self.name, message="action_id is required")
        ok = await _update_status(
            org_id, action_id, new_status="approved", applied_by=applied_by
        )
        if not ok:
            return not_implemented(
                self.name, message="approve failed (substrate unavailable?)"
            )
        return _ok_envelope(
            self.name,
            {"action_id": action_id, "status": "approved"},
        )

    async def deny(
        self,
        org_id: str,
        *,
        action_id: str,
        applied_by: str | None = None,
    ) -> dict[str, Any]:
        """Mark a pending action as denied.

        The executor will not retry a denied action.
        """
        if not action_id:
            return not_implemented(self.name, message="action_id is required")
        ok = await _update_status(
            org_id, action_id, new_status="denied", applied_by=applied_by
        )
        if not ok:
            return not_implemented(
                self.name, message="deny failed (substrate unavailable?)"
            )
        return _ok_envelope(
            self.name,
            {"action_id": action_id, "status": "denied"},
        )

    async def apply_approved(
        self,
        org_id: str,
        *,
        action_id: str,
        applied_by: str | None = None,
    ) -> dict[str, Any]:
        """Apply a single approved action (G8).

        Fetches the exact action by id, dispatches the real side-effect
        for its ``action_kind`` (investigate / rollback / reweight /
        cache_bust / propose_patch), then flips status to ``applied``.
        Cat 17 StatGate gating (installed by ``trace_quality.wiring``)
        wraps this method and only delegates here on an APPLY verdict.
        """
        if not action_id:
            return not_implemented(self.name, message="action_id is required")

        action = await _fetch_action_by_id(org_id, action_id)
        if action is None:
            return not_implemented(
                self.name, message=f"action {action_id!r} not found"
            )
        if action.get("status") == "denied":
            return not_implemented(
                self.name, message=f"action {action_id!r} is denied"
            )

        applied_action_kind = action.get("action_kind", "unknown")
        side_effect = await _dispatch_side_effect(org_id, action)

        ok = await _update_status(
            org_id, action_id, new_status="applied", applied_by=applied_by
        )
        if not ok:
            return not_implemented(
                self.name, message="apply failed (substrate unavailable?)"
            )
        return _ok_envelope(
            self.name,
            {
                "action_id": action_id,
                "status": "applied",
                "action_kind": applied_action_kind,
                "side_effect": side_effect.get("side_effect"),
                "side_effect_detail": side_effect.get("detail"),
            },
        )

    async def dashboard(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        """Aggregate counts per action_kind + status.

        The v0 dashboard is a single ``fetch`` + in-memory
        reduce. Cheap enough to recompute on every render.
        """
        try:
            rows = await _fetch_actions(org_id, status=None, limit=10_000)
        except Exception:
            rows = []
        by_kind: dict[str, int] = {}
        by_status: dict[str, int] = {}
        by_severity: dict[str, int] = {}
        for r in rows:
            by_kind[r.get("action_kind", "unknown")] = (
                by_kind.get(r.get("action_kind", "unknown"), 0) + 1
            )
            by_status[r.get("status", "unknown")] = (
                by_status.get(r.get("status", "unknown"), 0) + 1
            )
            by_severity[r.get("severity", "unknown")] = (
                by_severity.get(r.get("severity", "unknown"), 0) + 1
            )
        return _ok_envelope(
            self.name,
            {
                "total": len(rows),
                "by_kind": by_kind,
                "by_status": by_status,
                "by_severity": by_severity,
            },
        )
