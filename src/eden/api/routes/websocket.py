"""WebSocket endpoint for real-time job trace streaming.

Phase 5.4: Provides a WebSocket connection that streams live job checkpoint
updates, pipeline stage transitions, and trace events to connected clients.
This enables the portal to show real-time job progress without polling.

Usage:
    wscat -c "ws://localhost:8000/ws/jobs/{job_id}/trace?token=..."
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])

# Track active WebSocket connections per job
_job_connections: dict[str, set[WebSocket]] = {}


async def _authenticate_ws(websocket: WebSocket) -> dict | None:
    """Authenticate WebSocket connection via query param or cookie.

    Accepts token from:
      - ?token=JWT query parameter
      - Cookie: access_token

    Returns user dict or None if authentication fails.
    """
    token = websocket.query_params.get("token")

    if not token:
        # Try cookie
        cookie = websocket.cookies.get("access_token")
        if cookie:
            token = cookie

    if not token:
        return None

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
        await websocket.accept()

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
            _ws_receive_commands(websocket, job_id, hilt),
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
            try:
                await asyncio.wait_for(hilt.wait_for_resume(timeout=2.0), timeout=2.0)
            except TimeoutError:
                pass

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
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if not receive_task.done():
            receive_task.cancel()
            try:
                await receive_task
            except (asyncio.CancelledError, Exception):
                pass
        # Unregister connection
        if job_id in _job_connections:
            _job_connections[job_id].discard(websocket)
            if not _job_connections[job_id]:
                del _job_connections[job_id]
        try:
            await websocket.close()
        except Exception:
            pass


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
        await websocket.accept()

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
        try:
            await websocket.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Phase 5.4.1: bidirectional command receiver
# ─────────────────────────────────────────────────────────────────────────────

async def _ws_receive_commands(
    websocket: WebSocket,
    job_id: str,
    hilt: Any,
) -> None:
    """Listen for client→server commands on the same WebSocket as the
    server→client trace stream. Dispatches HILT commands and acks.

    Supported commands:
        ping       — heartbeat; responds with ``pong``
        pause      — HILT pause
        resume     — HILT resume
        step       — HILT single-step
        inject     — inject a message into the pipeline
        approve    — HILT approval (id = proposal_id)
        reject     — HILT rejection (id = proposal_id)
        subscribe  — update field filter

    Any unknown command type is logged and acked with status="unknown"
    so the client can handle protocol mismatches gracefully.
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
                await hilt.handle_command(
                    "APPROVE", payload={"proposal_id": proposal_id}
                )
                await _safe_send(websocket, {
                    "type": "command_ack", "command": "approve",
                    "status": "ok", "id": proposal_id,
                })
            elif cmd_type == "reject":
                proposal_id = cmd.get("id", "")
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
    try:
        await websocket.send_json(payload)
    except Exception:
        pass
