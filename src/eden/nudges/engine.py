"""F39 nudge engine — load, evaluate, and apply runtime nudges."""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID, uuid4

from eden.nudges.models import Nudge
from eden.nudges.trigger_eval import evaluate_trigger

logger = logging.getLogger(__name__)

_NUDGE_CACHE: dict[str, list[Nudge]] = {}
_GATEWAY_MODES: tuple[str, ...] = ("shadow", "promoted")


def _cache_key(
    org_id: str, agent_id: str, modes: tuple[str, ...] = _GATEWAY_MODES
) -> str:
    return f"{org_id}:{agent_id}:{','.join(sorted(modes))}"


def _agent_prefix(org_id: str, agent_id: str) -> str:
    return f"{org_id}:{agent_id}:"


class NudgeEngine:
    """Evaluate active nudges for an agent at gateway request time."""

    async def list_active(
        self, org_id: str, agent_id: str, *, modes: tuple[str, ...] = ("shadow", "promoted")
    ) -> list[Nudge]:
        key = _cache_key(org_id, agent_id, modes)
        if key in _NUDGE_CACHE:
            return _NUDGE_CACHE[key]

        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT id, org_id, agent_id, name, trigger, action_type,
                       content, mode, source_issue_id, evidence
                FROM nudges
                WHERE org_id = $1 AND agent_id = $2 AND mode = ANY($3::text[])
                ORDER BY created_at ASC
                LIMIT 50
                """,
                org_id,
                agent_id,
                list(modes),
            )
            nudges = [Nudge.from_row(dict(r)) for r in rows]
            # Modes-aware key: portal archived listings never overwrite gateway cache.
            _NUDGE_CACHE[key] = nudges
            return nudges
        except Exception as exc:
            logger.debug("nudge engine: list_active failed: %s", exc)
            return []

    def evaluate_sync(self, context: dict[str, Any]) -> list[Nudge]:
        """Sync evaluate from in-memory cache (populated by list_active)."""
        org_id = str(context.get("org_id") or "")
        agent_id = str(context.get("agent_id") or "")
        if not org_id or not agent_id:
            return []
        nudges = _NUDGE_CACHE.get(_cache_key(org_id, agent_id, _GATEWAY_MODES), [])
        return [
            n
            for n in nudges
            if n.mode in ("shadow", "promoted") and evaluate_trigger(n.trigger, context)
        ]

    def cache_warmed(self, org_id: str, agent_id: str) -> bool:
        """True when gateway modes cache has been populated for this agent."""
        return _cache_key(org_id, agent_id, _GATEWAY_MODES) in _NUDGE_CACHE

    async def warm_cache(self, org_id: str, agent_id: str) -> None:
        await self.list_active(org_id, agent_id)

    def invalidate_cache(self, org_id: str, agent_id: str) -> None:
        prefix = _agent_prefix(org_id, agent_id)
        for key in list(_NUDGE_CACHE):
            if key.startswith(prefix):
                _NUDGE_CACHE.pop(key, None)

    async def log_shadow(
        self,
        nudge: Nudge,
        *,
        trace_id: str,
        matched: bool,
        applied: bool,
        outcome_success: bool | None = None,
    ) -> None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            await client.execute(
                """
                INSERT INTO nudge_outcomes
                    (id, nudge_id, trace_id, mode, matched, applied, outcome_success)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """,
                uuid4(),
                nudge.id,
                trace_id,
                nudge.mode,
                matched,
                applied,
                outcome_success,
            )
        except Exception as exc:
            logger.debug("nudge engine: log_shadow failed: %s", exc)

    async def create_shadow(
        self,
        org_id: str,
        *,
        agent_id: str,
        name: str,
        trigger: dict[str, Any],
        action_type: str,
        content: str,
        source_issue_id: str | None = None,
    ) -> str | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            nudge_id = uuid4()
            await client.execute(
                """
                INSERT INTO nudges
                    (id, org_id, agent_id, name, trigger, action_type,
                     content, mode, source_issue_id)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'shadow', $8)
                """,
                nudge_id,
                org_id,
                agent_id,
                name,
                json.dumps(trigger),
                action_type,
                content,
                source_issue_id,
            )
            self.invalidate_cache(org_id, agent_id)
            return str(nudge_id)
        except Exception as exc:
            logger.warning("nudge engine: create_shadow failed: %s", exc)
            return None

    async def set_mode(self, org_id: str, nudge_id: str, mode: str) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return False
            row = await client.fetchrow(
                """
                UPDATE nudges SET mode = $3,
                    promoted_at = CASE WHEN $3 = 'promoted' THEN now() ELSE promoted_at END,
                    archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE archived_at END
                WHERE org_id = $1 AND id = $2
                RETURNING agent_id
                """,
                org_id,
                nudge_id,
                mode,
            )
            if row:
                self.invalidate_cache(org_id, str(row["agent_id"]))
            return row is not None
        except Exception as exc:
            logger.warning("nudge engine: set_mode failed: %s", exc)
            return False


def apply_nudge_to_request(nudge: Nudge, request: Any) -> tuple[Any, str, bool]:
    """Apply promoted nudge actions to gateway request (sync hot path)."""
    prompt = getattr(request, "prompt", "") or ""
    if nudge.action_type == "system_append":
        request.prompt = f"{prompt}\n\n<!-- eden-nudge:{nudge.id} -->\n{nudge.content}"
        return request, f"nudge_applied:{nudge.id}", True
    if nudge.action_type == "subagent_hint":
        hint = f"[Eden hint] {nudge.content}"
        request.prompt = f"{prompt}\n\n{hint}"
        return request, f"nudge_hint:{nudge.id}", True
    if nudge.action_type == "tool_block":
        tool = str((nudge.evidence or {}).get("tool") or nudge.content.split()[0])
        blocked = list(getattr(request, "blocked_tools", None) or [])
        if tool and tool not in blocked:
            blocked.append(tool)
        setattr(request, "blocked_tools", blocked)
        return request, f"nudge_tool_block:{nudge.id}", True
    if nudge.action_type == "tool_rewrite":
        rewrites = dict(getattr(request, "tool_rewrites", None) or {})
        tool = str((nudge.evidence or {}).get("tool") or "")
        if tool:
            rewrites[tool] = nudge.content
        setattr(request, "tool_rewrites", rewrites)
        return request, f"nudge_tool_rewrite:{nudge.id}", True
    return request, f"nudge_matched:{nudge.id}", False


def apply_nudge_to_prompt(nudge: Nudge, prompt: str) -> tuple[str, str]:
    """Apply a promoted nudge to the request prompt."""
    if nudge.action_type == "system_append":
        appended = f"{prompt}\n\n<!-- eden-nudge:{nudge.id} -->\n{nudge.content}"
        return appended, f"nudge_applied:{nudge.id}"
    if nudge.action_type == "subagent_hint":
        hint = f"[Eden hint] {nudge.content}"
        return f"{prompt}\n\n{hint}", f"nudge_hint:{nudge.id}"
    return prompt, f"nudge_matched:{nudge.id}"


def microbench_evaluate_sync(*, iterations: int = 5000) -> dict[str, float]:
    """Hot-path microbench for NudgeEngine.evaluate_sync (p95 target <5ms)."""
    import time
    from uuid import uuid4

    from eden.nudges.models import Nudge

    org_id = "bench-org"
    agent_id = "bench-agent"
    nudge = Nudge(
        id=uuid4(),
        org_id=org_id,
        agent_id=agent_id,
        name="bench",
        trigger={"all": [{"event": "prompt_contains", "text": "hello"}]},
        action_type="system_append",
        content="fix",
        mode="promoted",
    )
    _NUDGE_CACHE[_cache_key(org_id, agent_id)] = [nudge]
    ctx = {"org_id": org_id, "agent_id": agent_id, "prompt": "hello world"}
    samples: list[float] = []
    for _ in range(iterations):
        t0 = time.perf_counter()
        evaluate_trigger(nudge.trigger, ctx)
        samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    p95_idx = int(len(samples) * 0.95) - 1
    return {
        "iterations": float(iterations),
        "p50_ms": samples[len(samples) // 2],
        "p95_ms": samples[max(p95_idx, 0)],
        "p99_ms": samples[int(len(samples) * 0.99) - 1],
    }
