"""WebSocket endpoint for real-time job trace streaming.

Phase 5.4: Provides a WebSocket connection that streams live job checkpoint
updates, pipeline stage transitions, and trace events to connected clients.
This enables the portal to show real-time job progress without polling.

Usage:
    wscat -c "ws://localhost:8000/ws/jobs/{job_id}/trace?token=..."
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from eden.api.utils.redact import redact_all
from eden.storage.postgres import get_postgres_client
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])

# Track active WebSocket connections per job
_job_connections: dict[str, set[WebSocket]] = {}

# Audit 2026-07-03 — bounded TTL role cache. Pre-fix the cache was
# a plain ``dict[(user_id, job_id), bool]`` with no eviction: a
# revoked admin stayed privileged for any future HILT call on the
# same job; a key farmer could grow the dict without bound. Now:
# TTL 30 s (stale state auto-expires even if revocation events miss
# the cache), hard cap 4096 entries with FIFO eviction at the cap.
#
# Audit 2026-07-03 (post-pass) — Redis-backed when REDIS_URL is set
# so multi-worker Northflank deploys share the cache (pre-fix each
# worker had its own OrderedDict, and a revocation on worker A could
# leave worker B's cache stale for 30 s). Local OrderedDict is the
# fallback when Redis is unavailable so single-node dev still works.
_USER_ROLE_TTL_SECONDS = 30.0
_USER_ROLE_CACHE_CAP = 4_096
_USER_ROLE_REDIS_PREFIX = "hilt-role:"
_user_role_cache: OrderedDict[tuple[str, str], tuple[float, bool]] = (
    OrderedDict()
)


def _role_cache_get_local(key: tuple[str, str]) -> bool | None:
    """In-memory fallback for ``_role_cache_get_async``.

    Same TTL+FIFO contract as the Redis path. Used when REDIS_URL is
    unset or unreachable.
    """
    now = time.monotonic()
    entry = _user_role_cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if now - ts >= _USER_ROLE_TTL_SECONDS:
        with contextlib.suppress(KeyError):
            del _user_role_cache[key]
        return None
    _user_role_cache.move_to_end(key)
    return value


def _role_cache_set_local(key: tuple[str, str], value: bool) -> None:
    if key in _user_role_cache:
        _user_role_cache.move_to_end(key)
    _user_role_cache[key] = (time.monotonic(), value)
    while len(_user_role_cache) > _USER_ROLE_CACHE_CAP:
        _user_role_cache.popitem(last=False)


async def _role_cache_get_async(key: tuple[str, str]) -> bool | None:
    """Return the cached role decision for ``key``, or ``None`` on miss.

    Local L0 first (zero Redis commands). Redis is only consulted on
    a local miss when RATE_LIMIT_DISTRIBUTED is on — same conserve
    posture as rate limiting for Upstash Free.
    """
    local = _role_cache_get_local(key)
    if local is not None:
        return local

    use_redis = False
    try:
        from eden.config import get_settings

        use_redis = bool(get_settings().rate_limit_distributed)
    except Exception:
        use_redis = False
    if not use_redis:
        return None

    try:
        redis = await get_redis_client()
    except Exception:
        redis = None
    if redis is not None:
        try:
            raw = await redis.get(
                f"{_USER_ROLE_REDIS_PREFIX}{key[0]}:{key[1]}"
            )
            if raw is None:
                return None
            value = raw == "1"
            _role_cache_set_local(key, value)
            return value
        except Exception as exc:
            logger.debug(
                "hilt role cache Redis GET failed; using local: %s", redact_all(str(exc)),
            )
    return None


async def _role_cache_set_async(key: tuple[str, str], value: bool) -> None:
    """Cache a role decision for ``key`` for ``_USER_ROLE_TTL_SECONDS``.

    Always writes local L0. Redis write only when distributed mode is on.
    """
    _role_cache_set_local(key, value)
    use_redis = False
    try:
        from eden.config import get_settings

        use_redis = bool(get_settings().rate_limit_distributed)
    except Exception:
        use_redis = False
    if not use_redis:
        return
    try:
        redis = await get_redis_client()
    except Exception:
        redis = None
    if redis is not None:
        try:
            await redis.set(
                f"{_USER_ROLE_REDIS_PREFIX}{key[0]}:{key[1]}",
                "1" if value else "0",
                ex=int(_USER_ROLE_TTL_SECONDS) + 1,
            )
        except Exception as exc:
            logger.debug(
                "hilt role cache Redis SET failed (local-only): %s", redact_all(str(exc)),
            )


def reset_hilt_role_cache() -> None:
    """Clear cache for tests; no-op in production."""
    _user_role_cache.clear()


async def _hilt_privileged_for_job(
    user: dict | None, job_id: str
) -> bool:
    """True iff ``user`` is admin/owner for ``job_id``'s org.

    Audit 2026-07-02 S-9 — approve / reject on the WebSocket require
    admin privileges. Returns False for any falsy user (defence-in-depth
    even before the route-level gate). Audit 2026-07-03 — bounded
    TTL+cap cache so a revoked admin reverts within 30 s and a key
    farmer cannot grow memory; the cache is now Redis-backed so
    multi-worker deploys share state.
    """
    if not user:
        return False
    user_id = user.get("user_id") if isinstance(user, dict) else None
    if not user_id:
        return False
    cache_key = (str(user_id), str(job_id))
    cached = await _role_cache_get_async(cache_key)
    if cached is not None:
        return cached
    try:
        client = await get_postgres_client()
        if client is None:
            return False
        job = await client.get_job(job_id, user_id=str(user_id))
        if not job:
            await _role_cache_set_async(cache_key, False)
            return False
        # Owner of the job counts as privileged; admins/owners via the
        # org_members table also count. ``user_id`` field on the job is
        # the canonical ownership marker (Eden convention).
        owner_id = job.get("user_id") if isinstance(job, dict) else None
        privileged = str(owner_id) == str(user_id)
        await _role_cache_set_async(cache_key, privileged)
        return privileged
    except Exception as exc:
        logger.debug(f"hilt role check failed: {exc}")
        return False


async def _authenticate_ws(websocket: WebSocket) -> dict | None:
    """Authenticate WebSocket connection via subprotocol, query param, or cookie.

    Accepts token from, in order of precedence:
      1. ``Sec-WebSocket-Protocol`` subprotocol header (PREFERRED —
         the subprotocol value is not logged by reverse proxies, unlike
         query-param tokens). Format on the wire:
         ``Sec-WebSocket-Protocol: eden-auth-<base64url-token>, eden-ws-v1``
         The server picks ``eden-auth-...`` and echoes it back so the
         upgrade handshake succeeds.
      2. ``?token=JWT`` query parameter (legacy back-compat — query
         strings are logged by Vercel/Northflank edge access logs, so
         this is being phased out).
      3. ``Cookie: access_token`` (legacy back-compat).

    Returns user dict or None if authentication fails.

    Audit 2026-07-02 S-8 — try ``verify_clerk_token`` first (portal uses
    Clerk session JWTs as of June 2026); fall back to ``decode_access_token``
    for legacy Eden-issued JWTs.
    Audit 2026-07-03 — added ``Sec-WebSocket-Protocol`` extraction so
    multi-tenant reverse proxies don't write the JWT to access logs.
    """
    token = _extract_token_from_subprotocol(websocket.headers)

    if not token:
        token = websocket.query_params.get("token")

    if not token:
        # Try cookie
        cookie = websocket.cookies.get("access_token")
        if cookie:
            token = cookie

    if not token:
        return None

    # Audit 2026-07-02 S-8 — Clerk-first, legacy-fallback.
    # B-6 (Session 23): verify_clerk_token is async; await it so the
    # WebSocket upgrade handshake doesn't block on a sync JWKS fetch.
    try:
        from eden.api.utils.clerk_auth import verify_clerk_token

        clerk_payload = await verify_clerk_token(token)
        if clerk_payload:
            return {
                "user_id": clerk_payload.get("sub"),
                "email": clerk_payload.get("email"),
                "name": clerk_payload.get("name"),
            }
    except Exception as exc:
        logger.debug(f"WebSocket Clerk auth failed: {exc}")

    try:
        from eden.api.utils.auth import decode_access_token
        payload = decode_access_token(token)
        if payload:
            return {
                "user_id": payload.get("sub"),
                "email": payload.get("email"),
                "name": payload.get("name"),
            }
    except Exception as exc:
        logger.warning(f"WebSocket auth failed: {exc}")

    return None


_WS_AUTH_SUBPROTOCOL_PREFIX = "eden-auth-"


def _extract_token_from_subprotocol(headers: Any) -> str | None:
    """Pull the auth token from the ``Sec-WebSocket-Protocol`` header.

    The portal sets::

        Sec-WebSocket-Protocol: eden-auth-<base64url-token>, eden-ws-v1

    on the upgrade request. We pick the first subprotocol starting with
    ``eden-auth-``, base64url-decode the suffix, and return the JWT.
    Returns ``None`` if the header is missing, has no ``eden-auth-...``
    entry, or the suffix doesn't base64-decode cleanly. Defensive:
    malformed headers are silently ignored so a buggy client doesn't
    poison the upgrade.
    """
    raw = (headers.get("sec-websocket-protocol") if headers else None)
    if not raw:
        return None
    for proto in [p.strip() for p in raw.split(",")]:
        if not proto.startswith(_WS_AUTH_SUBPROTOCOL_PREFIX):
            continue
        b64 = proto[len(_WS_AUTH_SUBPROTOCOL_PREFIX):]
        if not b64:
            return None
        # urlsafe_b64decode needs padding; add it.
        try:
            padded = b64 + "=" * (-len(b64) % 4)
            decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
            return decoded.decode("utf-8")
        except Exception:
            return None
    return None


async def _accept_with_subprotocol(websocket: WebSocket) -> str | None:
    """Accept the WebSocket, echoing the ``eden-auth-...`` subprotocol.

    The WS spec requires the server to pick exactly one of the
    subprotocols the client offered and echo it back in the response
    ``Sec-WebSocket-Protocol`` header. If no ``eden-auth-...`` was
    offered, accept without a subprotocol (legacy clients still work).
    Returns the chosen subprotocol name, or None.
    """
    chosen: str | None = None
    raw = websocket.headers.get("sec-websocket-protocol") if websocket.headers else None
    if raw:
        for proto in [p.strip() for p in raw.split(",")]:
            if proto.startswith(_WS_AUTH_SUBPROTOCOL_PREFIX):
                chosen = proto
                break
    if chosen:
        await websocket.accept(subprotocol=chosen)
    else:
        await websocket.accept()
    return chosen


@router.websocket("/ws/jobs/{job_id}/trace")
async def job_trace_websocket(
    websocket: WebSocket,
    job_id: str,
):
    """WebSocket endpoint for live job trace streaming.

    Streams in real-time:
      - Status changes (pending → running → completed/failed)
      - Stage transitions (planning → spec → executor → tester → ...)
      - New checkpoint blob events (code fragments, messages)
      - Completion / error events

    Authentication: pass JWT as ?token= query param or via cookie.

    Protocol:
      Client → Server: JSON commands with 'type' field:
        { "type": "ping" }                            — heartbeat
        { "type": "pause" }                           — HILT pause
        { "type": "resume" }                          — HILT resume
        { "type": "step" }                            — HILT step
        { "type": "inject", "message": "..." }        — inject msg
        { "type": "subscribe", "fields": ["code"] }    — field filter
        { "type": "approve" | "reject", "id": "..." } — approval workflow
      Server → Client: JSON events with 'type' field:
        { "type": "status", "status": "running", "current_stage": "executor", ... }
        { "type": "stage_change", "from": "planning", "to": "executor", ... }
        { "type": "code_fragment", "field": "code:main.py", "code": "...", ... }
        { "type": "message", "text": "New data available: final_res", ... }
        { "type": "complete", "status": "completed", "outcome_tier": "A", ... }
        { "type": "error", "message": "..." }
        { "type": "command_ack", "command": "pause", "status": "ok" }
    """
    # Authenticate
    user = await _authenticate_ws(websocket)
    if not user:
        await websocket.close(code=4001, reason="Authentication required")
        return

    # Verify job ownership
    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        await websocket.close(code=4004, reason="Job not found")
        return

    try:
        await _accept_with_subprotocol(websocket)

        # Register connection
        if job_id not in _job_connections:
            _job_connections[job_id] = set()
        _job_connections[job_id].add(websocket)

        # Phase 5.4.1: bidirectional support. Run a receive task in
        # parallel with the polling loop so the client can issue HILT
        # commands (pause/resume/step/inject/approve) over the same WS
        # connection instead of opening a REST round-trip.
        from eden.realtime.human_in_the_loop import HILTController

        hilt = HILTController(job_id=job_id)
        receive_task = asyncio.create_task(
            _ws_receive_commands(websocket, job_id, hilt, user),
            name=f"ws-recv-{job_id}",
        )

        # Send initial state
        await websocket.send_json({
            "type": "status",
            "job_id": job_id,
            "status": job["status"],
            "current_stage": job["current_stage"],
            "outcome_tier": job.get("outcome_tier"),
            "stage_history": job.get("stage_history", []),
            "timestamp": datetime.now(UTC).isoformat(),
        })
        last_stage = job["current_stage"]
        last_status = job["status"]
        last_blob_keys: set[tuple[str, str]] = set()

        while True:
            # If the receive task died (e.g. malformed JSON), stop
            if receive_task.done() and receive_task.exception():
                break

            # Poll for updates every 2 seconds (or break early if HILT paused)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(hilt.wait_for_resume(timeout=2.0), timeout=2.0)

            # Fetch latest job state
            job = await client.get_job(job_id, user_id=user["user_id"])
            if not job:
                await websocket.send_json({
                    "type": "error",
                    "message": "Job no longer accessible",
                })
                break

            current_stage = job["current_stage"]
            current_status = job["status"]

            # Emit stage change before updating last_stage
            if current_stage != last_stage and last_stage is not None:
                await websocket.send_json({
                    "type": "stage_change",
                    "job_id": job_id,
                    "from": last_stage,
                    "to": current_stage,
                    "at": job.get("updated_at", datetime.now(UTC).isoformat()),
                })

            # Emit status update if changed
            if current_stage != last_stage or current_status != last_status:
                await websocket.send_json({
                    "type": "status",
                    "job_id": job_id,
                    "status": current_status,
                    "current_stage": current_stage,
                    "outcome_tier": job.get("outcome_tier"),
                    "stage_history": job.get("stage_history", []),
                    "timestamp": datetime.now(UTC).isoformat(),
                })
                last_stage = current_stage
                last_status = current_status

            # Check for new checkpoint blobs
            try:
                blobs = await client.get_checkpoint_blobs(job_id)
                current_blob_keys = {(b["field"], b.get("created_at", "")) for b in blobs}
                new_blob_keys = current_blob_keys - last_blob_keys

                for field, ts in new_blob_keys:
                    blob_map = {b["field"]: b["value"] for b in blobs}
                    value = blob_map.get(field)

                    if field.startswith("code:"):
                        await websocket.send_json({
                            "type": "code_fragment",
                            "job_id": job_id,
                            "field": field,
                            "code": value if isinstance(value, str) else "",
                            "timestamp": ts,
                        })
                    elif field in ("edp", "edp_history", "res", "final_res", "quality_report", "tester_results"):
                        await websocket.send_json({
                            "type": "message",
                            "job_id": job_id,
                            "text": f"New data available: {field}",
                            "field": field,
                            "timestamp": ts,
                        })

                last_blob_keys = current_blob_keys
            except Exception:
                pass  # Non-fatal during streaming

            # Check terminal state
            if current_status in {"completed", "failed", "cancelled", "human_review"}:
                await websocket.send_json({
                    "type": "complete",
                    "job_id": job_id,
                    "status": current_status,
                    "outcome_tier": job.get("outcome_tier"),
                    "timestamp": datetime.now(UTC).isoformat(),
                })
                break

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for job {job_id}")
    except Exception as exc:
        logger.error(f"WebSocket error for job {job_id}: {exc}")
        with contextlib.suppress(Exception):
            await websocket.send_json({"type": "error", "message": str(exc)})
    finally:
        if not receive_task.done():
            receive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await receive_task
        # Unregister connection
        if job_id in _job_connections:
            _job_connections[job_id].discard(websocket)
            if not _job_connections[job_id]:
                del _job_connections[job_id]
        with contextlib.suppress(Exception):
            await websocket.close()


@router.websocket("/ws/jobs/{job_id}/logs")
async def job_logs_websocket(
    websocket: WebSocket,
    job_id: str,
):
    """WebSocket endpoint for streaming structured job logs.

    Similar to /ws/jobs/{job_id}/trace but focused on log-like events
    (pipeline stages, errors, warnings) rather than checkpoint data.

    Authentication: same as job_trace_websocket.
    """
    user = await _authenticate_ws(websocket)
    if not user:
        await websocket.close(code=4001, reason="Authentication required")
        return

    client = await get_postgres_client()
    job = await client.get_job(job_id, user_id=user["user_id"])
    if not job:
        await websocket.close(code=4004, reason="Job not found")
        return

    try:
        await _accept_with_subprotocol(websocket)

        if job_id not in _job_connections:
            _job_connections[job_id] = set()
        _job_connections[job_id].add(websocket)

        last_stage = job["current_stage"]
        last_status = job["status"]

        while True:
            await asyncio.sleep(2)

            job = await client.get_job(job_id, user_id=user["user_id"])
            if not job:
                break

            current_stage = job["current_stage"]
            current_status = job["status"]

            # Emit log entry for status changes
            if current_status != last_status:
                await websocket.send_json({
                    "type": "log",
                    "level": "info",
                    "job_id": job_id,
                    "message": f"Status changed: {last_status} → {current_status}",
                    "timestamp": datetime.now(UTC).isoformat(),
                })
                last_status = current_status

            # Emit log entry for stage changes
            if current_stage != last_stage:
                await websocket.send_json({
                    "type": "log",
                    "level": "info",
                    "job_id": job_id,
                    "message": f"Stage transition: {last_stage} → {current_stage}",
                    "timestamp": datetime.now(UTC).isoformat(),
                })
                last_stage = current_stage

            # Check terminal state
            if current_status in {"completed", "failed", "cancelled", "human_review"}:
                level = "info" if current_status == "completed" else "error"
                await websocket.send_json({
                    "type": "log",
                    "level": level,
                    "job_id": job_id,
                    "message": f"Job {current_status}",
                    "timestamp": datetime.now(UTC).isoformat(),
                })
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.error(f"Job logs WebSocket error: {exc}")
    finally:
        if job_id in _job_connections:
            _job_connections[job_id].discard(websocket)
            if not _job_connections[job_id]:
                del _job_connections[job_id]
        with contextlib.suppress(Exception):
            await websocket.close()


# ─────────────────────────────────────────────────────────────────────────────
# Phase 5.4.1: bidirectional command receiver
# ─────────────────────────────────────────────────────────────────────────────

async def _ws_receive_commands(
    websocket: WebSocket,
    job_id: str,
    hilt: Any,
    user: dict | None = None,
) -> None:
    """Listen for client→server commands on the same WebSocket as the
    server→client trace stream. Dispatches HILT commands and acks.

    Supported commands:
        ping       — heartbeat; responds with ``pong``
        pause      — HILT pause
        resume     — HILT resume
        step       — HILT single-step
        inject     — inject a message into the pipeline
        approve    — HILT approval (id = proposal_id) — admin/owner only
        reject     — HILT rejection (id = proposal_id) — admin/owner only
        subscribe  — update field filter

    Any unknown command type is logged and acked with status="unknown"
    so the client can handle protocol mismatches gracefully.

    Audit 2026-07-02 S-9 — ``approve`` and ``reject`` require the
    authenticated user to be a privileged caller for this job (job
    owner, or admin/owner of the job's org). Other commands remain
    open to anyone authenticated.
    """
    while True:
        try:
            raw = await websocket.receive_text()
        except WebSocketDisconnect:
            return
        except Exception as exc:
            logger.debug(f"WebSocket receive error for {job_id}: {exc}")
            return

        try:
            cmd = json.loads(raw)
        except json.JSONDecodeError:
            await _safe_send(websocket, {
                "type": "command_ack",
                "command": "<unparseable>",
                "status": "error",
                "detail": "invalid JSON",
            })
            continue

        cmd_type = cmd.get("type")
        try:
            if cmd_type == "ping":
                await _safe_send(websocket, {
                    "type": "command_ack",
                    "command": "ping",
                    "status": "ok",
                    "detail": "pong",
                })
            elif cmd_type == "pause":
                await hilt.handle_command("PAUSE", payload=cmd)
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "pause", "status": "ok",
                })
            elif cmd_type == "resume":
                await hilt.handle_command("RESUME", payload=cmd)
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "resume", "status": "ok",
                })
            elif cmd_type == "step":
                await hilt.handle_command("STEP", payload=cmd)
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "step", "status": "ok",
                })
            elif cmd_type == "inject":
                message = cmd.get("message", "")
                await hilt.handle_command("INJECT", payload={"message": message})
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "inject", "status": "ok",
                })
            elif cmd_type == "approve":
                proposal_id = cmd.get("id", "")
                # Audit 2026-07-02 S-9 — admin/owner only.
                if not await _hilt_privileged_for_job(user, job_id):
                    await _safe_send(websocket, {
                        "type": "command_ack",
                        "command": "approve",
                        "status": "forbidden",
                        "detail": "approve requires admin/owner of the job's org",
                        "id": proposal_id,
                    })
                    continue
                await hilt.handle_command(
                    "APPROVE", payload={"proposal_id": proposal_id}
                )
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "approve",
                    "status": "ok", "id": proposal_id,
                })
            elif cmd_type == "reject":
                proposal_id = cmd.get("id", "")
                # Audit 2026-07-02 S-9 — admin/owner only.
                if not await _hilt_privileged_for_job(user, job_id):
                    await _safe_send(websocket, {
                        "type": "command_ack",
                        "command": "reject",
                        "status": "forbidden",
                        "detail": "reject requires admin/owner of the job's org",
                        "id": proposal_id,
                    })
                    continue
                await hilt.handle_command(
                    "REJECT", payload={"proposal_id": proposal_id}
                )
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "reject",
                    "status": "ok", "id": proposal_id,
                })
            elif cmd_type == "subscribe":
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "subscribe",
                    "status": "ok",
                    "fields": cmd.get("fields", []),
                })
            else:
                await _safe_send(websocket, {
                    "type": "command_ack",
                    "command": str(cmd_type),
                    "status": "unknown",
                    "detail": "unrecognised command type",
                })
        except Exception as exc:
            logger.warning(f"WS command '{cmd_type}' failed for {job_id}: {exc}")
            await _safe_send(websocket, {
                "type": "command_ack",
                "command": str(cmd_type),
                "status": "error",
                "detail": str(exc),
            })


async def _safe_send(websocket: WebSocket, payload: dict[str, Any]) -> None:
    """Send JSON on the WebSocket, swallowing client-disconnect errors."""
    with contextlib.suppress(Exception):
        await websocket.send_json(payload)
