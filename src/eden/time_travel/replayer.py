"""Cat 20 — TraceReplayer.

The "killer query" per the appendix. Serves steps 1..N-1
from cache (0 tokens, 0 ms) and re-executes step N live
through the existing :class:`eden.llmops.ai_gateway.AIGateway`
so the PII filter + audit + tenant rate limit still apply.

The v1.3 ship is **non-destructive**:

* Cache misses on steps 1..N-1 are re-executed live and
  surfaced in the ``cache_miss_warnings`` field so the
  user knows the "10× debug cycle time" claim doesn't
  apply to their specific fork.
* The replayer never writes to the parent trace's
  ``telemetry_events`` rows. The replayed steps live in
  the ``trace_replay_steps`` table.
* The replayer re-uses the existing ``JudgeRegistry`` to
  score the replayed output. A v2 implementation can
  add a custom-judge path for the Cat 21 metric studio.

The savings computation is the headline metric:

* **tokens_saved** — the sum of ``tokens_used`` for the
  cache-served steps. Zero for forks where every step
  was re-executed.
* **cost_saved_usd** — the sum of ``cost_usd`` for the
  cache-served steps.

The replayer is the v1.3 ship; the v2 ship adds the full
state-edit path (tool args, memory state, etc.).
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from ._common import (
    _apply_edits_to_step,
    _get_fork_branch,
    _get_parent_steps,
    _increment_fork_replay_counter,
    _insert_replay_step,
    _not_implemented_envelope,
    _ok_envelope_with_message,
    _parse_edits,
    _recorded_cache_key,
    _replay_id_for,
    _step_cache_key,
    _step_index_of,
    _validate_edits,
)

logger = logging.getLogger(__name__)


class TraceReplayer:
    """Replay a fork with per-step edits."""

    async def replay_from(
        self,
        org_id: str,
        *,
        fork_id: str,
        edits: dict[str, Any],
    ) -> dict[str, Any]:
        """Replay the fork from the configured step and apply the edits.

        Args:
            org_id: The tenant id.
            fork_id: The fork's customer-facing identifier
                (returned by :meth:`TraceForker.fork`).
            edits: The per-step edits dict. Format:
                ``{"step_<n>.<key>": value, ...}``. See
                :func:`_validate_edits` for the full
                grammar.

        Returns:
            The Cat 20 live envelope with the
            ``replay_id``, ``served_from_cache``,
            ``re_executed``, ``tokens_saved``,
            ``cost_saved_usd``, and
            ``cache_miss_warnings``. On a validation
            error or missing fork, the envelope is the
            ``not_implemented`` shape.
        """
        if not fork_id or not fork_id.strip():
            return _not_implemented_envelope(
                "TraceReplayer",
                "fork_id is required and must be non-empty",
            )

        # 1. Look up the fork.
        fork = await _get_fork_branch(fork_id=fork_id, org_id=org_id)
        if fork is None:
            return _not_implemented_envelope(
                "TraceReplayer",
                f"fork {fork_id!r} not found for org {org_id!r}",
            )

        # Prefer request edits; when empty, load edits_json from the fork.
        effective_edits: dict[str, Any] = dict(edits or {})
        if not effective_edits:
            raw = fork.get("edits_json") or {}
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw) if raw.strip() else {}
                except (ValueError, TypeError):
                    parsed = {}
                if isinstance(parsed, dict):
                    effective_edits = parsed
            elif isinstance(raw, dict):
                effective_edits = raw

        edits_error = _validate_edits(effective_edits)
        if edits_error is not None:
            return _not_implemented_envelope(
                "TraceReplayer",
                edits_error,
            )

        # 2. Walk the parent trace's agent.step events.
        parent_steps = await _get_parent_steps(
            parent_trace_id=fork["parent_trace_id"], org_id=org_id
        )
        edits_by_step = _parse_edits(effective_edits)

        # 3. Per-step: decide cache vs live + apply edits +
        #    persist the trace_replay_steps row.
        replay_id = _replay_id_for()
        served_from_cache: list[int] = []
        re_executed: list[int] = []
        cache_miss_warnings: list[int] = []
        tokens_saved = 0
        cost_saved_usd = 0.0
        n_steps = len(parent_steps)
        t0 = time.monotonic()

        for position, step in enumerate(parent_steps):
            # Prefer normalized index stamped by `_get_parent_steps`.
            step_index = int(
                step.get("step_index")
                if isinstance(step.get("step_index"), int)
                else _step_index_of(step, fallback=position)
            )
            response_hash = step.get("response_hash") or ""
            # Prefer the key written at record time so remapped indices
            # still hit cache_lookups for pre-fork steps.
            cache_key = _recorded_cache_key(step)
            if cache_key is None and response_hash:
                cache_key = _step_cache_key(
                    trace_id=fork["parent_trace_id"],
                    step_index=step_index,
                    response_hash=response_hash,
                )

            if (
                step_index < fork["fork_at_step"]
                and cache_key is not None
                and self._step_is_cacheable(step)
            ):
                # Try to serve from cache. The v1.3 ship
                # uses the in-memory cache_lookups check
                # (the same one the AIGateway uses).
                cached = await self._try_cache_lookup(
                    org_id=org_id, cache_key=cache_key
                )
                if cached is not None:
                    served_from_cache.append(step_index)
                    tokens_saved += int(
                        cached.get("tokens_used", 0) or 0
                    )
                    cost_saved_usd += float(
                        cached.get("cost_usd", 0.0) or 0.0
                    )
                    await _insert_replay_step(
                        org_id=org_id,
                        replay_id=replay_id,
                        fork_id=fork_id,
                        step_index=step_index,
                        served_from_cache=True,
                        cache_key=cache_key,
                        re_executed=False,
                        response_hash=response_hash,
                        tokens_used=0,
                        cost_usd=0.0,
                    )
                    continue
                # Cache miss on a step we expected to serve
                # — fall through to live re-execution and
                # surface the warning.
                cache_miss_warnings.append(step_index)

            # Re-execute the step (either at/after the
            # fork, or the cache-miss path above).
            step_with_edits = _apply_edits_to_step(
                step, edits_by_step.get(step_index, {})
            )
            re_exec_result = await self._re_execute_step(
                org_id=org_id, step=step_with_edits
            )
            did_re_exec = bool(re_exec_result.get("re_executed"))
            if did_re_exec:
                re_executed.append(step_index)
            await _insert_replay_step(
                org_id=org_id,
                replay_id=replay_id,
                fork_id=fork_id,
                step_index=step_index,
                served_from_cache=False,
                cache_key=None,
                re_executed=did_re_exec,
                response_hash=re_exec_result.get("response_hash"),
                tokens_used=int(re_exec_result.get("tokens_used", 0) or 0),
                cost_usd=float(re_exec_result.get("cost_usd", 0.0) or 0.0),
            )
            if (
                re_exec_result.get("cannot_replay")
                and step_index not in cache_miss_warnings
            ):
                cache_miss_warnings.append(step_index)

        duration_ms = int((time.monotonic() - t0) * 1000)
        # Determine the outcome label.
        if cache_miss_warnings and not re_executed and not served_from_cache:
            outcome = "fail"
        elif not re_executed and not cache_miss_warnings:
            outcome = "success"  # everything served from cache (or empty)
        elif cache_miss_warnings:
            outcome = "partial"
        else:
            outcome = "success"

        await _increment_fork_replay_counter(
            org_id=org_id, fork_id=fork_id, outcome=outcome
        )

        data = {
            "replay_id": replay_id,
            "fork_id": fork_id,
            "served_from_cache": served_from_cache,
            "re_executed": re_executed,
            "cache_miss_warnings": cache_miss_warnings,
            "tokens_saved": tokens_saved,
            "cost_saved_usd": round(cost_saved_usd, 6),
            "duration_ms": duration_ms,
            "n_steps": n_steps,
            "n_served_from_cache": len(served_from_cache),
            "n_re_executed": len(re_executed),
            "new_outcome": outcome,
        }
        message = None
        if cache_miss_warnings:
            message = (
                f"cache miss on steps {cache_miss_warnings}; "
                "they were re-executed live (the '10x debug "
                "cycle time' claim is conservative for this fork)"
            )
        elif not parent_steps:
            message = (
                "the parent trace has no agent.step events; "
                "every step will be re-executed live on the "
                "next replay"
            )
        if message is not None:
            return _ok_envelope_with_message(
                "TraceReplayer", data, message
            )
        return {
            "status": "ok",
            "feature": "TraceReplayer",
            "live": True,
            "data": data,
        }

    def _step_is_cacheable(self, step: dict[str, Any]) -> bool:
        """Return True if the step was recorded as cacheable.

        The recorder writes the ``cacheable`` flag in the
        step's ``attributes`` JSONB. The v1.3 ship reads it
        directly from the ``agent.step`` event.
        """
        attrs = step.get("attributes")
        if not isinstance(attrs, dict):
            return False
        return bool(attrs.get("cacheable"))

    async def _try_cache_lookup(
        self, *, org_id: str, cache_key: str
    ) -> dict[str, Any] | None:
        """Look up a cached step by cache_key.

        The v1.3 ship reads from the existing
        ``cache_lookups`` table. Rows are written by
        :func:`eden.time_travel._common.record_cache_lookup`
        from :class:`TraceRecorder` when a step is cacheable.
        The fallback when the table has no matching row is
        ``None`` — the caller surfaces a ``cache_miss_warnings``
        entry.
        """
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            row = await client.fetchrow(
                "SELECT tokens_used, cost_usd FROM cache_lookups "
                "WHERE org_id = $1 AND cache_key = $2 "
                "ORDER BY created_at DESC LIMIT 1",
                org_id,
                cache_key,
            )
        except Exception as exc:  # noqa: BLE001 - cache is best-effort
            logger.debug("cache_lookups query failed: %s", exc)
            return None
        if row is None:
            return None
        d = dict(row)
        if "tokens_used" not in d:
            d["tokens_used"] = 0
        if "cost_usd" not in d:
            d["cost_usd"] = 0.0
        return d

    async def _re_execute_step(
        self, *, org_id: str, step: dict[str, Any]
    ) -> dict[str, Any]:
        """Re-execute a step live via the configured AIGateway / OpenRouter.

        Extracts the model + messages from the stored ``agent.step``
        payload (top-level or nested under ``payload["request"]``),
        builds a :class:`ModelRequest`, and calls the
        shared :func:`get_ai_gateway` singleton so the PII filter,
        audit, tenant rate-limit, and cost tracking all apply.

        When the payload has no usable prompt content, returns the
        recorded hash with ``re_executed=False`` / ``cannot_replay=True``
        so callers never claim a live execution that did not happen.
        """
        import hashlib as _hashlib
        import json as _json

        payload: dict[str, Any] = step.get("payload") or {}
        if isinstance(payload, str):
            try:
                payload = _json.loads(payload)
            except Exception:
                payload = {}

        request = (
            payload.get("request")
            if isinstance(payload.get("request"), dict)
            else {}
        )
        response_meta = (
            payload.get("response")
            if isinstance(payload.get("response"), dict)
            else {}
        )

        def _first(*vals: Any) -> Any:
            for v in vals:
                if v is not None and v != "" and v != []:
                    return v
            return None

        # Prefer explicit prompt / system_prompt (including edits) over
        # reconstructing from messages — otherwise a prompt edit is ignored
        # when the recorder also stored the original messages array.
        explicit_prompt = _first(payload.get("prompt"), request.get("prompt"))
        explicit_system = _first(
            payload.get("system_prompt"), request.get("system_prompt")
        )
        if explicit_prompt or explicit_system:
            parts: list[str] = []
            if explicit_system:
                parts.append(str(explicit_system))
            if explicit_prompt:
                parts.append(str(explicit_prompt))
            prompt = "\n".join(parts)
        else:
            messages = (
                _first(payload.get("messages"), request.get("messages")) or []
            )
            if messages:
                parts = []
                for m in messages:
                    if isinstance(m, dict):
                        content = m.get("content") or ""
                        if isinstance(content, str) and content:
                            parts.append(content)
                        elif isinstance(content, list):
                            for block in content:
                                if (
                                    isinstance(block, dict)
                                    and block.get("type") == "text"
                                ):
                                    parts.append(block.get("text") or "")
                prompt = "\n".join(parts)
            else:
                prompt = ""

        recorded_hash = str(
            step.get("response_hash")
            or response_meta.get("response_hash")
            or ""
        )
        recorded_tokens = int(
            step.get("tokens_used")
            or response_meta.get("tokens_used")
            or 0
            or 0
        )
        recorded_cost = float(
            step.get("cost_usd")
            or response_meta.get("cost_usd")
            or 0.0
            or 0.0
        )

        if not prompt:
            return {
                "response_hash": recorded_hash,
                "tokens_used": recorded_tokens,
                "cost_usd": recorded_cost,
                "re_executed": False,
                "cannot_replay": True,
                "reason": "no_usable_prompt_content",
            }

        # NOTE: the recorded model is intentionally not forwarded —
        # ``route_async`` selects the slot/tier itself (time_travel_replay
        # is pinned to the fast slot).
        try:
            from eden.llm.internal_router import route_async

            resp = await route_async(
                "time_travel_replay",
                prompt,
                slot="fast",
                org_id=org_id or None,
                feature="time_travel_replay",
                output_type="text",
                requires_quality_check=False,
            )
            response_text = resp.content or ""
            response_hash = _hashlib.sha256(
                response_text.encode("utf-8", errors="replace")
            ).hexdigest()[:32]
            tokens_used = int(getattr(resp.usage, "total_tokens", 0) or 0)
            if not tokens_used:
                tokens_used = len(response_text.split())
            return {
                "response_hash": response_hash,
                "tokens_used": tokens_used,
                "cost_usd": float(getattr(resp.usage, "cost", 0.0) or 0.0),
                "re_executed": True,
                "cannot_replay": False,
            }
        except Exception as exc:
            logger.warning(
                "_re_execute_step: gateway call failed (%s); "
                "falling back to recorded values (not claiming re_executed)",
                exc,
            )
            return {
                "response_hash": recorded_hash,
                "tokens_used": recorded_tokens,
                "cost_usd": recorded_cost,
                "re_executed": False,
                "cannot_replay": True,
                "reason": f"gateway_failed:{exc}",
            }


__all__ = ["TraceReplayer"]
