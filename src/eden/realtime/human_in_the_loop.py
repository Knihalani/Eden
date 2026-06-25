"""Human-in-the-Loop (HILT) controller for interactive pipeline control.

Phase 6.2: Enables users to pause, resume, step-through, inject messages,
and approve/reject decisions during pipeline execution via bidirectional
WebSocket commands.

Usage:
    from eden.realtime.human_in_the_loop import HILTController
    controller = HILTController()
    await controller.handle_command(job_id, user, command)
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class HILTCommandType(str, Enum):
    """Supported HILT command types."""

    PAUSE = "pause"
    RESUME = "resume"
    STEP = "step"  # Execute one step then pause
    INJECT = "inject"  # Inject a message into the agent context
    APPROVE = "approve"  # Approve a pending decision
    REJECT = "reject"  # Reject a pending decision
    REWIND = "rewind"  # Rewind to a specific checkpoint
    STATUS = "status"  # Query current HILT state


class HILTState(str, Enum):
    """Current HILT control state for a job."""

    IDLE = "idle"  # No HILT active
    RUNNING = "running"  # Pipeline executing normally
    PAUSED = "paused"  # Explicitly paused by user
    WAITING_APPROVAL = "waiting_approval"  # Waiting for human decision
    STEPPING = "stepping"  # Will pause after next step
    INJECTED = "injected"  # Message injected, awaiting effect


@dataclass
class HILTCommand:
    """A user-issued HILT command."""

    command_id: str
    job_id: str
    user_id: str
    command: HILTCommandType
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "command_id": self.command_id,
            "job_id": self.job_id,
            "user_id": self.user_id,
            "command": self.command.value,
            "payload": self.payload,
            "timestamp": self.timestamp,
        }


@dataclass
class HILTStateRecord:
    """Current HILT state for a job."""

    job_id: str
    state: HILTState
    paused_at: str | None = None
    resumed_at: str | None = None
    waiting_for: str | None = None  # What the pipeline is waiting for
    current_step: int | None = None
    total_steps: int | None = None
    pending_commands: list[HILTCommand] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    last_updated: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "state": self.state.value,
            "paused_at": self.paused_at,
            "resumed_at": self.resumed_at,
            "waiting_for": self.waiting_for,
            "current_step": self.current_step,
            "total_steps": self.total_steps,
            "pending_command_count": len(self.pending_commands),
            "history": self.history,
            "last_updated": self.last_updated,
        }


class HILTController:
    """Controller for Human-in-the-Loop pipeline interactions.

    Manages per-job HILT state and coordinates between:
    - User commands (via WebSocket)
    - Pipeline execution (via state flags)
    - Trace event recording (via TraceEventStore)
    """

    def __init__(self) -> None:
        # Per-job HILT state
        self._states: dict[str, HILTStateRecord] = {}
        # Async events for step/resume signaling
        self._resume_events: dict[str, asyncio.Event] = {}
        self._step_events: dict[str, asyncio.Event] = {}
        self._lock = asyncio.Lock()

    async def get_state(self, job_id: str) -> HILTStateRecord:
        """Get or create HILT state for a job."""
        async with self._lock:
            if job_id not in self._states:
                self._states[job_id] = HILTStateRecord(
                    job_id=job_id,
                    state=HILTState.IDLE,
                )
            return self._states[job_id]

    async def handle_command(
        self,
        job_id: str,
        user: dict[str, Any],
        command_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Process a HILT command from a user.

        Args:
            job_id: The target job.
            user: Authenticated user dict with user_id.
            command_type: One of HILTCommandType values.
            payload: Command-specific data.

        Returns:
            Result dict with status and message.
        """
        try:
            cmd_type = HILTCommandType(command_type)
        except ValueError:
            return {"status": "error", "message": f"Unknown command: {command_type}"}

        command = HILTCommand(
            command_id=str(uuid.uuid4()),
            job_id=job_id,
            user_id=user.get("user_id", "unknown"),
            command=cmd_type,
            payload=payload,
        )

        state = await self.get_state(job_id)

        # Log command to trace store
        await self._log_command(job_id, command)

        # Record in state history
        state.history.append({
            "command": command_type,
            "user_id": user.get("user_id"),
            "timestamp": command.timestamp,
            "payload": payload,
        })
        state.last_updated = command.timestamp

        # Dispatch command
        if cmd_type == HILTCommandType.PAUSE:
            return await self._cmd_pause(job_id, state)
        elif cmd_type == HILTCommandType.RESUME:
            return await self._cmd_resume(job_id, state)
        elif cmd_type == HILTCommandType.STEP:
            return await self._cmd_step(job_id, state)
        elif cmd_type == HILTCommandType.INJECT:
            return await self._cmd_inject(job_id, state, payload)
        elif cmd_type == HILTCommandType.APPROVE:
            return await self._cmd_approve(job_id, state, payload)
        elif cmd_type == HILTCommandType.REJECT:
            return await self._cmd_reject(job_id, state, payload)
        elif cmd_type == HILTCommandType.REWIND:
            return await self._cmd_rewind(job_id, state, payload)
        elif cmd_type == HILTCommandType.STATUS:
            return {"status": "ok", "state": state.to_dict()}

        return {"status": "error", "message": "Command not implemented"}

    async def _cmd_pause(self, job_id: str, state: HILTStateRecord) -> dict[str, Any]:
        """Pause pipeline execution."""
        if state.state in (HILTState.PAUSED, HILTState.WAITING_APPROVAL):
            return {"status": "ok", "message": "Already paused", "state": state.to_dict()}

        state.state = HILTState.PAUSED
        state.paused_at = datetime.now(UTC).isoformat()

        # Signal any resume event to prevent auto-resume
        if job_id in self._resume_events:
            self._resume_events[job_id].clear()

        await self._broadcast_state_change(job_id, state)
        return {"status": "ok", "message": "Pipeline paused", "state": state.to_dict()}

    async def _cmd_resume(self, job_id: str, state: HILTStateRecord) -> dict[str, Any]:
        """Resume pipeline execution."""
        if state.state == HILTState.RUNNING:
            return {"status": "ok", "message": "Already running", "state": state.to_dict()}

        state.state = HILTState.RUNNING
        state.resumed_at = datetime.now(UTC).isoformat()
        state.paused_at = None
        state.waiting_for = None

        # Signal resume event
        if job_id in self._resume_events:
            self._resume_events[job_id].set()
        else:
            self._resume_events[job_id] = asyncio.Event()
            self._resume_events[job_id].set()

        await self._broadcast_state_change(job_id, state)
        return {"status": "ok", "message": "Pipeline resumed", "state": state.to_dict()}

    async def _cmd_step(self, job_id: str, state: HILTStateRecord) -> dict[str, Any]:
        """Execute one step then pause."""
        state.state = HILTState.STEPPING

        # Signal step event
        if job_id in self._step_events:
            self._step_events[job_id].set()
        else:
            self._step_events[job_id] = asyncio.Event()
            self._step_events[job_id].set()

        await self._broadcast_state_change(job_id, state)
        return {"status": "ok", "message": "Stepping mode: will execute one step then pause", "state": state.to_dict()}

    async def _cmd_inject(
        self,
        job_id: str,
        state: HILTStateRecord,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Inject a message into the agent context."""
        message = payload.get("message", "")
        target = payload.get("target", "context")  # context, prompt, memory

        if not message:
            return {"status": "error", "message": "No message provided for injection"}

        # Store injected message for pipeline to pick up
        redis = await self._get_redis()
        if redis:
            inject_key = f"hilt:{job_id}:injected_messages"
            await redis.rpush(inject_key, json.dumps({
                "message": message,
                "target": target,
                "timestamp": datetime.now(UTC).isoformat(),
            }))
            await redis.expire(inject_key, 3600)

        state.state = HILTState.INJECTED
        await self._broadcast_state_change(job_id, state)

        return {
            "status": "ok",
            "message": f"Message injected into {target}",
            "injected_message": message,
            "state": state.to_dict(),
        }

    async def _cmd_approve(
        self,
        job_id: str,
        state: HILTStateRecord,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Approve a pending pipeline decision."""
        decision_id = payload.get("decision_id", "default")

        # Store approval in Redis for pipeline to pick up.
        # Per-decision key (with its own 1h TTL) — the previous
        # single-hash-per-job pattern reset the parent TTL on every
        # approve, pinning the hash in Redis until job cleanup.
        redis = await self._get_redis()
        if redis:
            approve_key = f"hilt:{job_id}:decision:{decision_id}"
            await redis.set(
                approve_key,
                json.dumps({
                    "approved": True,
                    "timestamp": datetime.now(UTC).isoformat(),
                    "notes": payload.get("notes", ""),
                }),
                ex=3600,
            )

        state.state = HILTState.RUNNING
        state.waiting_for = None

        # Signal resume
        if job_id in self._resume_events:
            self._resume_events[job_id].set()

        await self._broadcast_state_change(job_id, state)
        return {"status": "ok", "message": "Decision approved", "state": state.to_dict()}

    async def _cmd_reject(
        self,
        job_id: str,
        state: HILTStateRecord,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Reject a pending pipeline decision."""
        decision_id = payload.get("decision_id", "default")
        reason = payload.get("reason", "")

        redis = await self._get_redis()
        if redis:
            reject_key = f"hilt:{job_id}:decision:{decision_id}"
            await redis.set(
                reject_key,
                json.dumps({
                    "approved": False,
                    "timestamp": datetime.now(UTC).isoformat(),
                    "reason": reason,
                }),
                ex=3600,
            )

        state.state = HILTState.RUNNING
        state.waiting_for = None

        if job_id in self._resume_events:
            self._resume_events[job_id].set()

        await self._broadcast_state_change(job_id, state)
        return {"status": "ok", "message": "Decision rejected", "state": state.to_dict()}

    async def _cmd_rewind(
        self,
        job_id: str,
        state: HILTStateRecord,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Rewind to a specific checkpoint."""
        checkpoint_id = payload.get("checkpoint_id")
        if not checkpoint_id:
            return {"status": "error", "message": "checkpoint_id required for rewind"}

        # Store rewind request for pipeline orchestrator
        redis = await self._get_redis()
        if redis:
            rewind_key = f"hilt:{job_id}:rewind"
            await redis.set(rewind_key, json.dumps({
                "checkpoint_id": checkpoint_id,
                "timestamp": datetime.now(UTC).isoformat(),
            }), ex=3600)

        state.state = HILTState.PAUSED
        await self._broadcast_state_change(job_id, state)
        return {"status": "ok", "message": f"Rewind requested to checkpoint {checkpoint_id}", "state": state.to_dict()}

    async def _broadcast_state_change(self, job_id: str, state: HILTStateRecord) -> None:
        """Broadcast HILT state change to connected WebSocket clients."""
        try:
            from eden.api.routes.websocket import _job_connections
            if job_id in _job_connections:
                message = {
                    "type": "hilt_state_change",
                    "job_id": job_id,
                    "state": state.to_dict(),
                }
                for ws in list(_job_connections[job_id]):
                    try:
                        await ws.send_json(message)
                    except Exception:
                        _job_connections[job_id].discard(ws)
                        if not _job_connections[job_id]:
                            del _job_connections[job_id]
                            break
        except Exception as exc:
            logger.debug(f"HILT broadcast failed for {job_id}: {exc}")

    async def _log_command(self, job_id: str, command: HILTCommand) -> None:
        """Log a HILT command to the trace event store."""
        try:
            from eden.realtime.trace_store import TraceEvent, get_trace_store
            store = await get_trace_store()
            await store.append(
                entity_id=job_id,
                event=TraceEvent(
                    event_id=command.command_id,
                    event_type="hilt.command",
                    timestamp=command.timestamp,
                    sequence=0,  # Will be assigned by store
                    tenant_id="",  # Populated by store if available
                    user_id=command.user_id,
                    entity_id=job_id,
                    priority="high",
                    payload=command.to_dict(),
                ),
                persist=True,
            )
        except Exception as exc:
            logger.debug(f"HILT command logging failed: {exc}")

    async def _get_redis(self) -> Any:
        try:
            from eden.storage.redis import get_redis_client
            return await get_redis_client()
        except Exception:
            return None

    async def should_pause(self, job_id: str, step_number: int) -> bool:
        """Called by pipeline to check if execution should pause.

        Returns True if the pipeline should yield and wait for resume.
        """
        state = await self.get_state(job_id)

        if state.state == HILTState.PAUSED:
            return True

        if state.state == HILTState.STEPPING:
            # After stepping, auto-pause
            state.state = HILTState.PAUSED
            state.current_step = step_number
            return True

        if state.state == HILTState.WAITING_APPROVAL:
            return True

        return False

    async def wait_for_resume(self, job_id: str, timeout: float | None = None) -> bool:
        """Block until resume signal or timeout.

        Called by pipeline when should_pause returns True.
        Returns True if resumed, False if timed out.
        """
        if job_id not in self._resume_events:
            self._resume_events[job_id] = asyncio.Event()

        event = self._resume_events[job_id]
        event.clear()  # Ensure we're waiting

        try:
            await asyncio.wait_for(event.wait(), timeout=timeout or 300)
            return True
        except TimeoutError:
            return False

    async def get_injected_messages(self, job_id: str) -> list[dict[str, Any]]:
        """Retrieve injected messages for a job (called by pipeline)."""
        redis = await self._get_redis()
        if not redis:
            return []

        key = f"hilt:{job_id}:injected_messages"
        raw = await redis.lrange(key, 0, -1)
        messages = []
        for item in raw:
            try:
                messages.append(json.loads(item))
            except Exception:
                pass

        # Clear after retrieval
        await redis.delete(key)
        return messages

    async def get_approval(self, job_id: str, decision_id: str = "default") -> dict[str, Any] | None:
        """Get approval status for a decision (called by pipeline)."""
        redis = await self._get_redis()
        if not redis:
            return None

        key = f"hilt:{job_id}:approvals"
        raw = await redis.hget(key, decision_id)
        if raw:
            try:
                return json.loads(raw)
            except Exception:
                pass
        return None

    async def cleanup(self, job_id: str) -> None:
        """Clean up HILT state for a completed job."""
        async with self._lock:
            self._states.pop(job_id, None)
        self._resume_events.pop(job_id, None)
        self._step_events.pop(job_id, None)

        redis = await self._get_redis()
        if redis:
            await redis.delete(f"hilt:{job_id}:injected_messages")
            await redis.delete(f"hilt:{job_id}:approvals")
            await redis.delete(f"hilt:{job_id}:rewind")


# ── Singleton accessor ──────────────────────────────────────────────────

_hilt_controller: HILTController | None = None


async def get_hilt_controller() -> HILTController:
    """Get the singleton HILT controller."""
    global _hilt_controller
    if _hilt_controller is None:
        _hilt_controller = HILTController()
    return _hilt_controller


async def close_hilt_controller() -> None:
    """Close the HILT controller."""
    global _hilt_controller
    _hilt_controller = None
