"""Agent Debugger — checkpoint store + re-run engine (Phase P).

Laminar's headline feature on the debugging side: the
ability to **re-run an agent from any step** with an
optional prompt override. The user opens a trace, picks
"step 3", clicks "re-run from here with a different
system prompt", and sees the new trajectory side-by-side
with the original.

Two pieces:

  1. **Checkpoint store** — every trace's LLM call state
     (input messages, tool calls, tool results, response,
     timing) is persisted as a checkpoint. The store is
     a thin layer on top of the existing
     ``telemetry_events`` table — checkpoints are just
     ``telemetry_events`` rows with a special
     ``source_format = "debugger_checkpoint"``.

  2. **Re-run engine** — given a trace + step number +
     optional prompt override, replay the agent from that
     step with the new prompt. The replay is **not** a
     real SDK call — it's a deterministic in-process
     re-execution of the recorded state, which means the
     re-run is hermetic (no model call, no side effects,
     no DB writes) and runs in milliseconds.

The hermetic-replay design is intentional: production
debugger runs should be fast (debug the trace, not
re-execute the production workload) and safe (no model
calls means no surprise costs or PII leakage).

Why this design over "actually re-call the LLM"?
─────────────────────────────────────────────────────
  * **Speed** — re-running in-process is sub-millisecond;
    a real LLM call takes 1-30 seconds.
  * **Determinism** — the replay uses the recorded
    response, not a fresh model call. The user can
    compare trajectories apples-to-apples.
  * **Cost** — debugging a 50-step trace with a real
    re-run would cost 50x the original call.
  * **Safety** — a real re-run would generate real
    outputs (and possibly trigger real side effects via
    tool calls). The hermetic replay preserves the
    original outputs.

The trade-off: the user can override the prompt, but the
override only affects the textual output of the *next*
step. Subsequent steps still use their original recorded
state. For "what if the model had been smarter here?"
questions, the hermetic replay is the right tool. For
"what if I had used a different prompt for the whole
trace?", a real re-run is needed (and that's a future
Phase P.5).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ─- Dataclasses ────────────────────────────────────────────────


@dataclass
class Checkpoint:
    """One LLM-call state within a trace.

    Indexed by (trace_id, step_number). The replay engine
    uses this to construct a synthetic trajectory.
    """

    id: str
    trace_id: str
    step_number: int
    input_messages: list[dict[str, Any]]   # chat history before the call
    tool_calls: list[dict[str, Any]]      # tool calls in this step
    tool_results: list[dict[str, Any]]    # tool results
    response: dict[str, Any]              # the LLM response
    prompt_override: str | None = None  # user-supplied override
    started_at: str = ""
    ended_at: str = ""
    duration_ms: float = 0.0
    # Provenance: which run produced this checkpoint.
    source: str = "live"  # "live" | "replay"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "trace_id": self.trace_id,
            "step_number": self.step_number,
            "input_messages": list(self.input_messages),
            "tool_calls": list(self.tool_calls),
            "tool_results": list(self.tool_results),
            "response": dict(self.response),
            "prompt_override": self.prompt_override,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "duration_ms": self.duration_ms,
            "source": self.source,
        }


@dataclass
class ReRunResult:
    """The result of a re-run."""

    source_trace_id: str
    from_step: int
    to_step: int
    checkpoints: list[Checkpoint]
    prompt_override: str | None = None
    # Diff vs the original trajectory — list of
    # (step_number, original_response, replayed_response)
    # for steps where the response differs.
    diff: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_trace_id": self.source_trace_id,
            "from_step": self.from_step,
            "to_step": self.to_step,
            "prompt_override": self.prompt_override,
            "checkpoints": [c.to_dict() for c in self.checkpoints],
            "diff": self.diff,
        }


@dataclass
class LivePrefixResult:
    """Cached-prefix replay with a live tail boundary (F01)."""

    source_trace_id: str
    live_from_step: int
    prefix_checkpoints: list[Checkpoint]
    live_tail_steps: int
    mode: str = "cached_prefix"
    diff: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_trace_id": self.source_trace_id,
            "live_from_step": self.live_from_step,
            "prefix_checkpoints": [c.to_dict() for c in self.prefix_checkpoints],
            "live_tail_steps": self.live_tail_steps,
            "mode": self.mode,
            "diff": self.diff,
        }


# ─- Checkpoint store ────────────────────────────────────────────


class CheckpointStore:
    """Persist + load checkpoints.

    The store is a thin layer on top of the existing
    Postgres ``telemetry_events`` table. Checkpoints are
    stored as events with ``source_format = "debugger_checkpoint"``
    and the checkpoint data in the ``payload`` field.

    In production this would query the
    ``telemetry_events`` table directly. For unit tests
    the ``pg`` arg can be a FakePg that returns canned
    rows.
    """

    def __init__(self, pg: Any) -> None:
        self._pg = pg

    async def save(
        self,
        checkpoint: Checkpoint,
        org_id: str | None = None,
    ) -> None:
        """Persist a single checkpoint.

        Audit 2026-07-02 S-11 — ``tenant_id`` derives from ``org_id``
        (or ``"default"`` when missing). The old hardcoded
        ``"org-stub"`` string violated tenant isolation: every
        checkpoint was tagged with the same tenant id, so cross-tenant
        reads couldn't distinguish them.
        """
        # Audit 2026-07-02 S-11 — no more "org-stub". tenant_id is
        # always either the real org_id or the explicit "default".
        tenant_id = org_id or "default"
        await self._pg.execute(
            """
            INSERT INTO telemetry_events (
                id, tenant_id, project_id, trace_id, realm,
                event_type, timestamp, span_id, payload
            ) VALUES (
                $1, $2, $3, $4, $5, $6, NOW(), $7, $8::jsonb
            )
            """,
            str(uuid.uuid4()),
            tenant_id,
            "default",
            checkpoint.trace_id,
            "production",
            "debugger.checkpoint",
            f"step-{checkpoint.step_number}",
            _json_dumps(checkpoint.to_dict()),
        )

    async def list_for_trace(
        self,
        trace_id: str,
        org_id: str | None = None,
    ) -> list[Checkpoint]:
        """Load every checkpoint for a trace, in step order."""
        rows = await self._pg.fetch(
            """
            SELECT payload
            FROM telemetry_events
            WHERE trace_id = $1
              AND event_type = 'debugger.checkpoint'
            ORDER BY (payload->>'step_number')::int ASC
            """,
            trace_id,
        )
        out: list[Checkpoint] = []
        for row in rows:
            payload = row["payload"]
            if isinstance(payload, str):
                import json
                payload = json.loads(payload)
            out.append(_payload_to_checkpoint(payload))
        return out

    async def get_at_step(
        self,
        trace_id: str,
        step_number: int,
    ) -> Checkpoint | None:
        """Load one specific checkpoint."""
        rows = await self._pg.fetch(
            """
            SELECT payload
            FROM telemetry_events
            WHERE trace_id = $1
              AND event_type = 'debugger.checkpoint'
              AND (payload->>'step_number')::int = $2
            LIMIT 1
            """,
            trace_id, step_number,
        )
        if not rows:
            return None
        payload = rows[0]["payload"]
        if isinstance(payload, str):
            import json
            payload = json.loads(payload)
        return _payload_to_checkpoint(payload)


# ─- Re-run engine ───────────────────────────────────────────────


class ReRunEngine:
    """Re-run a trace from a given step with an optional
    prompt override. The replay is **hermetic** — no real
    LLM calls, no DB writes, no side effects.

    Args:
        store: The :class:`CheckpointStore` to load from.
    """

    def __init__(self, store: CheckpointStore) -> None:
        self._store = store

    async def rerun(
        self,
        trace_id: str,
        *,
        from_step: int = 0,
        prompt_override: str | None = None,
    ) -> ReRunResult:
        """Replay the trace from ``from_step`` onwards.

        The replay substitutes the ``prompt_override`` (if
        any) into the input messages of the first replayed
        step, then returns the recorded responses for
        subsequent steps. The result includes a diff
        against the original trajectory so the operator
        can see what changed.

        Args:
            trace_id: The trace to replay.
            from_step: The step to start from (inclusive).
                Steps before this are skipped. Default 0
                (replay from the beginning).
            prompt_override: An optional system-prompt
                override. When set, the first replayed
                step's input messages have the system
                message replaced with this string.

        Returns:
            :class:`ReRunResult` with the replayed
            checkpoints + the diff vs the original.
        """
        all_checkpoints = await self._store.list_for_trace(trace_id)
        # Filter to steps >= from_step.
        replayed = [c for c in all_checkpoints if c.step_number >= from_step]
        # If a prompt override is set, apply it to the first
        # replayed checkpoint.
        if prompt_override and replayed:
            replayed[0] = _apply_prompt_override(
                replayed[0], prompt_override,
            )
        # Compute the diff.
        original = {c.step_number: c for c in all_checkpoints}
        diff: list[dict[str, Any]] = []
        for c in replayed:
            orig = original.get(c.step_number)
            if orig is None:
                continue
            if c.response != orig.response or c.input_messages != orig.input_messages:
                diff.append({
                    "step_number": c.step_number,
                    "original_response": orig.response,
                    "replayed_response": c.response,
                    "input_messages_changed": c.input_messages != orig.input_messages,
                })
        return ReRunResult(
            source_trace_id=trace_id,
            from_step=from_step,
            to_step=replayed[-1].step_number if replayed else from_step - 1,
            checkpoints=replayed,
            prompt_override=prompt_override,
            diff=diff,
        )


class LivePrefixEngine:
    """Replay cached prefix steps; mark tail for live re-execution (F01).

    Hermetic prefix replay uses recorded checkpoints up to
    ``live_from_step``; steps at or beyond that boundary are counted as
    the live tail (would invoke the gateway in production).

    F03: when a ``PrefixCacheService`` is supplied, steps are loaded
    from ``debugger_llm_cache`` first (content-addressed, faster lookup).
    Falls back to ``CheckpointStore`` when no cache rows are found.
    """

    def __init__(
        self,
        store: CheckpointStore,
        cache_svc: Any | None = None,
    ) -> None:
        self._store = store
        self._cache_svc = cache_svc
        self._rerun = ReRunEngine(store)

    async def rerun_live_prefix(
        self,
        trace_id: str,
        *,
        live_from_step: int = 0,
        prompt_override: str | None = None,
        org_id: str = "default",
    ) -> LivePrefixResult:
        # Prefer debugger_llm_cache when a PrefixCacheService is wired.
        all_checkpoints = await self._load_checkpoints(trace_id, org_id=org_id)
        prefix = [c for c in all_checkpoints if c.step_number < live_from_step]
        tail = [c for c in all_checkpoints if c.step_number >= live_from_step]

        if prompt_override and prefix:
            prefix = [
                _apply_prompt_override(prefix[0], prompt_override),
                *prefix[1:],
            ]

        diff: list[dict[str, Any]] = []
        if prompt_override and prefix:
            orig = {c.step_number: c for c in all_checkpoints}
            for c in prefix:
                o = orig.get(c.step_number)
                if o and c.input_messages != o.input_messages:
                    diff.append({
                        "step_number": c.step_number,
                        "input_messages_changed": True,
                        "mode": "cached_prefix",
                    })

        return LivePrefixResult(
            source_trace_id=trace_id,
            live_from_step=live_from_step,
            prefix_checkpoints=prefix,
            live_tail_steps=len(tail),
            diff=diff,
        )

    async def _load_checkpoints(
        self,
        trace_id: str,
        org_id: str = "default",
    ) -> list[Checkpoint]:
        """Load checkpoints for a trace.

        Prefers ``debugger_llm_cache`` (via ``PrefixCacheService``) when
        available; falls back to ``CheckpointStore`` audit rows.
        """
        if self._cache_svc is not None:
            try:
                rows = await self._cache_svc.get_prefix_for_trace(
                    org_id=org_id,
                    trace_id=trace_id,
                )
                if rows:
                    return [
                        Checkpoint(
                            id=f"cache-{r['step_number']}",
                            trace_id=trace_id,
                            step_number=int(r["step_number"]),
                            input_messages=[],
                            tool_calls=[],
                            tool_results=[],
                            response=dict(r["response"]),
                            source="live",
                        )
                        for r in rows
                    ]
            except Exception as exc:  # noqa: BLE001
                logger.debug("LivePrefixEngine: cache miss, falling back: %s", exc)

        return await self._store.list_for_trace(trace_id, org_id=org_id)


# ─- RolloutEntrypoint discovery ──────────────────────────────────


@dataclass
class RolloutEntrypoint:
    """A discovered agent entrypoint.

    The debugger needs to know "where is the agent's
    entrypoint?" so it can call the right function with
    the right arguments. ``RolloutEntrypoint`` is the
    discovery result: a function name, a file path, and a
    confidence score.

    In production this is discovered by scanning the
    user's repo for ``@rollout``-decorated functions
    (Laminar's convention). For unit tests we accept a
    list of candidate names + a static dispatch table.
    """

    name: str
    file_path: str
    function_name: str
    confidence: float
    # The arguments the entrypoint expects.
    arg_signature: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "file_path": self.file_path,
            "function_name": self.function_name,
            "confidence": self.confidence,
            "arg_signature": list(self.arg_signature),
        }


def discover_entrypoint(
    candidates: list[dict[str, Any]],
    *,
    min_confidence: float = 0.5,
) -> list[RolloutEntrypoint]:
    """Pick the rollout entrypoints from a list of candidates.

    ``candidates`` is a list of dicts with keys
    ``name``, ``file_path``, ``function_name``, ``confidence``,
    and optional ``arg_signature``. We sort by confidence
    (descending) and return those above ``min_confidence``.

    This is a stand-in for the real scanner (which would
    ``ast.parse`` the user's repo looking for
    ``@rollout`` decorators). The unit-testable surface.
    """
    out: list[RolloutEntrypoint] = []
    for c in candidates:
        conf = float(c.get("confidence", 0.0))
        if conf < min_confidence:
            continue
        out.append(RolloutEntrypoint(
            name=str(c.get("name", "")),
            file_path=str(c.get("file_path", "")),
            function_name=str(c.get("function_name", "")),
            confidence=conf,
            arg_signature=list(c.get("arg_signature", [])),
        ))
    out.sort(key=lambda r: r.confidence, reverse=True)
    return out


# ─- Helpers ──────────────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    import json
    return json.dumps(obj, default=str, separators=(",", ":"))


def _payload_to_checkpoint(payload: dict[str, Any]) -> Checkpoint:
    return Checkpoint(
        id=str(payload.get("id", "")),
        trace_id=str(payload.get("trace_id", "")),
        step_number=int(payload.get("step_number", 0)),
        input_messages=list(payload.get("input_messages", [])),
        tool_calls=list(payload.get("tool_calls", [])),
        tool_results=list(payload.get("tool_results", [])),
        response=dict(payload.get("response", {})),
        prompt_override=payload.get("prompt_override"),
        started_at=str(payload.get("started_at", "")),
        ended_at=str(payload.get("ended_at", "")),
        duration_ms=float(payload.get("duration_ms", 0.0)),
        source=str(payload.get("source", "live")),
    )


def _apply_prompt_override(
    checkpoint: Checkpoint, override: str,
) -> Checkpoint:
    """Substitute the system-prompt message in the input
    messages with the override. If no system message
    exists, prepend one.
    """
    new_messages: list[dict[str, Any]] = []
    replaced = False
    for msg in checkpoint.input_messages:
        if msg.get("role") == "system" and not replaced:
            new_msg = dict(msg)
            new_msg["content"] = override
            new_messages.append(new_msg)
            replaced = True
        else:
            new_messages.append(msg)
    if not replaced:
        # Prepend a new system message.
        new_messages.insert(0, {
            "role": "system",
            "content": override,
        })
    return Checkpoint(
        id=checkpoint.id,
        trace_id=checkpoint.trace_id,
        step_number=checkpoint.step_number,
        input_messages=new_messages,
        tool_calls=list(checkpoint.tool_calls),
        tool_results=list(checkpoint.tool_results),
        response=dict(checkpoint.response),
        prompt_override=override,
        started_at=checkpoint.started_at,
        ended_at=checkpoint.ended_at,
        duration_ms=checkpoint.duration_ms,
        source="replay",
    )


__all__ = [
    "Checkpoint",
    "ReRunResult",
    "LivePrefixResult",
    "CheckpointStore",
    "ReRunEngine",
    "LivePrefixEngine",
    "RolloutEntrypoint",
    "discover_entrypoint",
    "_apply_prompt_override",
    "_payload_to_checkpoint",
]
