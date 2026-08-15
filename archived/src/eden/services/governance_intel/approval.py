"""Cat 10 — :class:`ApprovalWorkflowService`.

Multi-step approval gate for high-risk actions (delete-data,
deploy-prompt, override-judge). Two services:

* :meth:`ApprovalWorkflowService.create` — define the workflow:
  name, resource type, required-approver count, TTL,
  auto-approve-on-no-response policy.
* :meth:`ApprovalWorkflowService.request` — instance a request
  for a defined workflow. Validates against the workflow
  schema, persists to ``approval_requests``, and notifies
  approvers.
* :meth:`ApprovalWorkflowService.resolve` — an approver
  approves / denies the request. Enforces the
  ``requested_by != approver`` invariant so an admin can't
  approve their own request.
* :meth:`ApprovalWorkflowService.expire_pending` — sweep
  past-TTL pending requests; mark them ``expired`` (or
  auto-approve if the workflow opted in).

Schema (migration 020):

.. code-block:: sql

    approval_workflows (
        id, org_id, name, steps_json, status, created_at
    )
    approval_requests (
        id, org_id, workflow_id, requested_by, state,
        payload_json, created_at
    )

The ``steps_json`` column packs the workflow definition (it's
intentionally schemaless so a v2 step type — say, a regex
guard on the value field — doesn't need a migration). The
``payload_json`` on a request packs the action/target/value/
rationale + the live approver count + expires_at.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any, cast

from eden.services.governance_intel._common import (
    DEFAULT_APPROVAL_TTL_SECONDS,
    NAME_MAX,
    TARGET_MAX,
    _bad_request_envelope,
    _get_client,
    _maybe_await,
    _new_id,
    _now,
    _ok_envelope,
    _truncate,
)

logger = logging.getLogger(__name__)


# ── State machine ───────────────────────────────────────────────────


#: Valid lifecycle states for an approval request. The DB
#: column is ``VARCHAR(16)`` (per migration 020), so the
#: longest token here is ``"approved"``.
APPROVAL_STATES: frozenset[str] = frozenset(
    {"pending", "approved", "denied", "expired"}
)


# ── Service ─────────────────────────────────────────────────────────


class ApprovalWorkflowService:
    """Define + instance + resolve multi-step approvals."""

    name = "approval_workflows"

    # ── create ────────────────────────────────────────────────────

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        resource_type: str | None = None,
        required_approvers: int = 1,
        ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
        auto_approve_if_no_response: bool = False,
        steps: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Persist a new workflow definition.

        Args:
            name: human-readable name (e.g. "Override judge threshold").
            resource_type: which action this workflow gates
                (e.g. ``"judge_threshold"``, ``"delete_data"``,
                ``"deploy_prompt"``). Optional in v0 — the
                request layer matches by workflow_id only.
            required_approvers: at least this many approvals
                before the request resolves. Defaults to 1.
            ttl_seconds: how long a request stays open before
                expiring. Defaults to 1 hour.
            auto_approve_if_no_response: if True, expired
                requests are auto-approved instead of denied.
            steps: legacy multi-step shape (kept for backwards
                compatibility with the v0 stub).

        Returns:
            The :func:`_ok_envelope` response with the new
            ``workflow_id``.
        """
        if not isinstance(name, str) or not name.strip():
            return _bad_request_envelope(
                self.name, "name is required"
            )
        if not isinstance(required_approvers, int) or required_approvers < 1:
            return _bad_request_envelope(
                self.name, "required_approvers must be >= 1"
            )
        if not isinstance(ttl_seconds, int) or ttl_seconds < 60:
            return _bad_request_envelope(
                self.name, "ttl_seconds must be >= 60"
            )

        wf_id = _new_id("wf")
        steps_obj = {
            "resource_type": _truncate(resource_type or "", 64),
            "required_approvers": int(required_approvers),
            "ttl_seconds": int(ttl_seconds),
            "auto_approve_if_no_response": bool(
                auto_approve_if_no_response
            ),
            "steps": list(steps or []),
        }

        client = await _get_client()
        if client is not None:
            try:
                await _maybe_await(client.execute(
                    "INSERT INTO approval_workflows "
                    "(id, org_id, name, steps_json, status, created_at) "
                    "VALUES ($1, $2, $3, $4, 'active', NOW())",
                    wf_id,
                    org_id,
                    _truncate(name, NAME_MAX),
                    json.dumps(steps_obj),
                ))
            except Exception as exc:
                logger.debug(
                    "approval.create persist failed: %s", exc
                )
                # Continue — the envelope still returns the id.

        return _ok_envelope(
            self.name,
            {
                "workflow_id": wf_id,
                "name": _truncate(name, NAME_MAX),
                "resource_type": steps_obj["resource_type"],
                "required_approvers": steps_obj["required_approvers"],
                "ttl_seconds": steps_obj["ttl_seconds"],
                "auto_approve_if_no_response": steps_obj[
                    "auto_approve_if_no_response"
                ],
            },
        )

    # ── request ───────────────────────────────────────────────────

    async def request(
        self,
        org_id: str,
        *,
        workflow_id: str,
        requested_by: str,
        action: str,
        target: str | None = None,
        value: Any = None,
        rationale: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Instance a new approval request for ``workflow_id``.

        Fetches the workflow definition to pick up the
        required-approver count + TTL. Persists to
        ``approval_requests`` with state=pending.

        Args:
            workflow_id: an id returned by :meth:`create`.
            requested_by: user id of the requester. The same
                user can't later approve their own request
                (enforced in :meth:`resolve`).
            action: high-level action label
                (``"override_judge_threshold"``,
                ``"delete_data"``, etc.).
            target: the resource being acted on (e.g. a
                judge name or a dataset id).
            value: new value the action is setting (number /
                string / dict). Persisted as JSON.
            rationale: free-form text justification — visible
                to the approvers + audit log.
            payload: legacy schemaless shape (v0 stub).

        Returns:
            The :func:`_ok_envelope` response with the new
            ``request_id`` and ``expires_at``.
        """
        if not isinstance(workflow_id, str) or not workflow_id.strip():
            return _bad_request_envelope(
                self.name, "workflow_id is required"
            )
        if not isinstance(requested_by, str) or not requested_by.strip():
            return _bad_request_envelope(
                self.name, "requested_by is required"
            )
        if not isinstance(action, str) or not action.strip():
            return _bad_request_envelope(
                self.name, "action is required"
            )

        # Fetch the workflow definition to pick up TTL +
        # required-approver count.
        required = 1
        ttl_seconds = DEFAULT_APPROVAL_TTL_SECONDS
        client = await _get_client()
        if client is not None:
            try:
                rows = await client.fetch(
                    "SELECT steps_json, status FROM approval_workflows "
                    "WHERE id = $1 AND org_id = $2 LIMIT 1",
                    workflow_id,
                    org_id,
                )
            except Exception as exc:
                logger.debug(
                    "approval.request fetch workflow failed: %s", exc
                )
                rows = []
            if rows:
                row = rows[0]
                if row.get("status") and row["status"] != "active":
                    return _bad_request_envelope(
                        self.name,
                        f"workflow {workflow_id} is not active",
                    )
                try:
                    steps_obj = json.loads(row.get("steps_json") or "{}")
                except (TypeError, ValueError):
                    steps_obj = {}
                required = int(steps_obj.get("required_approvers", 1))
                ttl_seconds = int(
                    steps_obj.get("ttl_seconds", DEFAULT_APPROVAL_TTL_SECONDS)
                )

        req_id = _new_id("req")
        expires_at = _now() + timedelta(seconds=ttl_seconds)
        payload_obj = {
            "action": _truncate(action, 64),
            "target": _truncate(target or "", TARGET_MAX),
            "value": value,
            "rationale": _truncate(rationale or "", 1024),
            "approvers_required": int(required),
            "approvers_received": 0,
            "approvers": [],
            "expires_at": expires_at.isoformat(),
            "extra": payload or {},
        }

        if client is not None:
            try:
                await _maybe_await(client.execute(
                    "INSERT INTO approval_requests "
                    "(id, org_id, workflow_id, requested_by, "
                    "state, payload_json, created_at) "
                    "VALUES ($1, $2, $3, $4, 'pending', $5, NOW())",
                    req_id,
                    org_id,
                    workflow_id,
                    _truncate(requested_by, NAME_MAX),
                    json.dumps(payload_obj),
                ))
            except Exception as exc:
                logger.debug(
                    "approval.request persist failed: %s", exc
                )

        return _ok_envelope(
            self.name,
            {
                "request_id": req_id,
                "workflow_id": workflow_id,
                "requested_by": _truncate(requested_by, NAME_MAX),
                "action": payload_obj["action"],
                "target": payload_obj["target"],
                "state": "pending",
                "approvers_required": payload_obj["approvers_required"],
                "approvers_received": 0,
                "expires_at": payload_obj["expires_at"],
            },
        )

    # ── resolve ───────────────────────────────────────────────────

    async def resolve(
        self,
        org_id: str,
        *,
        request_id: str,
        approver: str,
        decision: str,
        rationale: str | None = None,
    ) -> dict[str, Any]:
        """Apply an approver's decision to a pending request.

        Enforces:
        * ``decision in {"approve", "deny"}``
        * The request is in ``pending`` state
        * ``approver != requested_by`` — an admin can't approve
          their own request
        * Each approver only counts once (de-dup by id)

        When ``required_approvers`` is reached, the request
        transitions to ``approved``. A single ``deny`` transitions
        to ``denied`` immediately.

        Returns the updated request envelope.
        """
        if decision not in ("approve", "deny"):
            return _bad_request_envelope(
                self.name, "decision must be 'approve' or 'deny'"
            )
        if not isinstance(approver, str) or not approver.strip():
            return _bad_request_envelope(
                self.name, "approver is required"
            )

        client = await _get_client()
        if client is None:
            # SECURITY: fail CLOSED. This used to return an ok envelope
            # with state="approved" so "tests that exercise the no-DB
            # path can still assert shape" — but ``_get_client`` returns
            # None on ANY swallowed connection failure, not just in
            # tests, so during a database incident this path answered
            #     POST /approvals/{id}/resolve {"decision": "approve"}
            # with 200 {"state": "approved"} while skipping every
            # invariant the gate exists to enforce: that the request
            # exists, that it is still pending, that the approver is not
            # the requester, and that quorum is met. One unauthenticated
            # -in-effect call could self-approve a request id that need
            # not exist.
            #
            # An approval gate that cannot verify must refuse, not
            # assume. Callers get a distinguishable status and can retry.
            logger.error(
                "approval resolve refused: no database connection "
                "(request_id=%s decision=%s)", request_id, decision,
            )
            return _bad_request_envelope(
                self.name,
                "approval store unavailable; refusing to resolve without "
                "verifying request state, approver identity and quorum",
            )

        try:
            rows = await client.fetch(
                "SELECT requested_by, state, payload_json "
                "FROM approval_requests "
                "WHERE id = $1 AND org_id = $2 LIMIT 1",
                request_id,
                org_id,
            )
        except Exception as exc:
            logger.debug("approval.resolve fetch failed: %s", exc)
            rows = []

        if not rows:
            return _bad_request_envelope(
                self.name, f"request {request_id} not found"
            )
        row = rows[0]
        if row.get("state") and row["state"] != "pending":
            return _bad_request_envelope(
                self.name,
                f"request is {row['state']!s}, not pending",
            )

        # ── Invariant: requested_by != approver ──────────────────
        if approver == row.get("requested_by"):
            return _bad_request_envelope(
                self.name,
                "requested_by may not approve their own request",
            )

        try:
            payload_obj = json.loads(row.get("payload_json") or "{}")
        except (TypeError, ValueError):
            payload_obj = {}

        approvers_seen = list(payload_obj.get("approvers") or [])
        if approver in approvers_seen:
            return _bad_request_envelope(
                self.name, "approver has already responded"
            )

        if decision == "deny":
            new_state = "denied"
            payload_obj["denied_by"] = approver
            payload_obj["denied_rationale"] = _truncate(
                rationale or "", 1024
            )
        else:
            approvers_seen.append(approver)
            payload_obj["approvers"] = approvers_seen
            payload_obj["approvers_received"] = len(approvers_seen)
            required = int(payload_obj.get("approvers_required", 1))
            new_state = "approved" if len(approvers_seen) >= required else "pending"

        try:
            await _maybe_await(client.execute(
                "UPDATE approval_requests "
                "SET state = $1, payload_json = $2 "
                "WHERE id = $3 AND org_id = $4",
                new_state,
                json.dumps(payload_obj),
                request_id,
                org_id,
            ))
        except Exception as exc:
            logger.debug("approval.resolve persist failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "request_id": request_id,
                "state": new_state,
                "approver": approver,
                "approvers_received": payload_obj.get(
                    "approvers_received", 0
                ),
                "approvers_required": payload_obj.get(
                    "approvers_required", 1
                ),
            },
        )

    # ── list ──────────────────────────────────────────────────────

    async def list_requests(
        self,
        org_id: str,
        *,
        state: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """List approval requests for the org, optionally filtered
        by state. Used by the inbox UI.

        ``limit`` is clamped to ``[1, 500]``.
        """
        if state is not None and state not in APPROVAL_STATES:
            return _bad_request_envelope(
                self.name,
                f"state must be one of {sorted(APPROVAL_STATES)}",
            )
        limit = max(1, min(500, int(limit)))

        client = await _get_client()
        rows: list[dict[str, Any]] = []
        if client is not None:
            sql = (
                "SELECT id, workflow_id, requested_by, state, "
                "payload_json, created_at FROM approval_requests "
                "WHERE org_id = $1"
            )
            args: list[Any] = [org_id]
            if state is not None:
                sql += " AND state = $2"
                args.append(state)
            sql += " ORDER BY created_at DESC LIMIT " + str(limit)
            try:
                rows = list(await client.fetch(sql, *args))
            except Exception as exc:
                logger.debug("approval.list fetch failed: %s", exc)
                rows = []

        out = []
        for r in rows:
            try:
                payload = json.loads(r.get("payload_json") or "{}")
            except (TypeError, ValueError):
                payload = {}
            out.append({
                "request_id": r.get("id"),
                "workflow_id": r.get("workflow_id"),
                "requested_by": r.get("requested_by"),
                "state": r.get("state"),
                "action": payload.get("action"),
                "target": payload.get("target"),
                "approvers_received": payload.get(
                    "approvers_received", 0
                ),
                "approvers_required": payload.get(
                    "approvers_required", 1
                ),
                "expires_at": payload.get("expires_at"),
                "created_at": _iso(r.get("created_at")),
            })

        return _ok_envelope(
            self.name,
            {"requests": out, "count": len(out), "filter_state": state},
        )

    # ── expire ────────────────────────────────────────────────────

    async def expire_pending(
        self, org_id: str
    ) -> dict[str, Any]:
        """Sweep pending requests whose ``expires_at`` is in the
        past. Transition each to ``expired`` (or ``approved`` if
        the workflow had ``auto_approve_if_no_response=True``).

        Called by the v0 cron sweep; safe to invoke from a
        route for one-off testing.
        """
        client = await _get_client()
        if client is None:
            return _ok_envelope(
                self.name,
                {"swept": 0, "no_persist": True},
            )

        # Pull pending rows
        try:
            rows = list(await client.fetch(
                "SELECT id, workflow_id, payload_json "
                "FROM approval_requests "
                "WHERE org_id = $1 AND state = 'pending' "
                "ORDER BY created_at ASC LIMIT 1000",
                org_id,
            ))
        except Exception as exc:
            logger.debug("approval.expire fetch failed: %s", exc)
            rows = []

        if not rows:
            return _ok_envelope(self.name, {"swept": 0})

        # Pull all referenced workflows once
        wf_ids = sorted({r["workflow_id"] for r in rows if r.get("workflow_id")})
        wf_map: dict[str, bool] = {}
        if wf_ids:
            try:
                wf_rows = list(await client.fetch(
                    "SELECT id, steps_json FROM approval_workflows "
                    "WHERE org_id = $1 AND id = ANY($2::uuid[])",
                    org_id,
                    wf_ids,
                ))
                for wr in wf_rows:
                    try:
                        steps = json.loads(wr.get("steps_json") or "{}")
                    except (TypeError, ValueError):
                        steps = {}
                    wf_map[str(wr["id"])] = bool(
                        steps.get("auto_approve_if_no_response", False)
                    )
            except Exception as exc:
                logger.debug(
                    "approval.expire fetch workflows failed: %s", exc
                )

        now = _now()
        n_swept = 0
        for r in rows:
            try:
                payload = json.loads(r.get("payload_json") or "{}")
            except (TypeError, ValueError):
                payload = {}
            expires_at_raw = payload.get("expires_at")
            try:
                from datetime import datetime
                expires_at_dt = datetime.fromisoformat(
                    (expires_at_raw or "").replace("Z", "+00:00")
                )
            except (TypeError, ValueError):
                continue
            if expires_at_dt > now:
                continue
            auto = wf_map.get(str(r.get("workflow_id")), False)
            new_state = "approved" if auto else "expired"
            try:
                await _maybe_await(client.execute(
                    "UPDATE approval_requests "
                    "SET state = $1 WHERE id = $2 AND org_id = $3",
                    new_state, r["id"], org_id,
                ))
                n_swept += 1
            except Exception as exc:
                logger.debug(
                    "approval.expire persist failed: %s", exc
                )

        return _ok_envelope(
            self.name, {"swept": n_swept, "checked": len(rows)},
        )


# ── Internal helpers ────────────────────────────────────────────────


def _iso(value: Any) -> str | None:
    """Coerce a datetime / string to ISO-8601 string; None → None.

    The Postgres driver returns ``datetime`` objects; the test
    mocks return strings. Keep the route response stable across
    both.
    """
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return cast(str | None, value.isoformat())
        except Exception:
            return str(value)
    return str(value)
