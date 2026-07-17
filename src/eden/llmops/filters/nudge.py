"""F39 runtime nudge gateway filter (Artifacts product surface)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from eden.llmops.inject_budget import InjectBudget, InjectItem, estimate_tokens
from eden.llmops.warm_learn import schedule_warm_learn
from eden.nudges.composer import ArtifactComposer
from eden.nudges.engine import NudgeEngine, apply_nudge_to_request
from eden.nudges.inrun_rescue import InRunRescue
from eden.preview.gates import artifacts_enabled_sync

logger = logging.getLogger(__name__)


def _request_context(request: Any) -> dict[str, Any]:
    ctx = getattr(request, "context", None)
    if isinstance(ctx, dict):
        return ctx
    return {
        "org_id": getattr(request, "org_id", None) or request.tenant_id,
        "agent_id": getattr(request, "agent_id", ""),
        "trace_id": getattr(request, "trace_id", None) or getattr(request, "job_id", ""),
        "prompt": request.prompt,
        "recent_tool_calls": getattr(request, "recent_tool_calls", []),
        "nudges_enabled": getattr(request, "nudges_enabled", True),
    }


def _schedule(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)
    except RuntimeError:
        asyncio.run(coro)


class NudgeGatewayFilter:
    """Inject promoted Artifacts; log shadow matches without mutation."""

    name = "runtime_nudge"

    def __init__(self, engine: NudgeEngine | None = None) -> None:
        self._engine = engine or NudgeEngine()
        self._composer = ArtifactComposer()
        self._rescue = InRunRescue(self._engine)

    def enabled(self, request: Any) -> bool:
        ctx = _request_context(request)
        return bool(ctx.get("nudges_enabled", True))

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        ctx = _request_context(request)
        org_id = str(ctx.get("org_id") or "")
        agent_id = str(ctx.get("agent_id") or "")
        trace_id = str(ctx.get("trace_id") or "")
        if not org_id or not agent_id:
            return request, []

        if not artifacts_enabled_sync(org_id):
            schedule_warm_learn(org_id, agent_id, task_text=str(ctx.get("prompt") or ""))
            return request, []

        matched = self._composer.compose(self._engine.evaluate_sync(ctx))
        findings: list[str] = []
        audit = getattr(request, "nudge_audit", None)
        if not isinstance(audit, list):
            audit = []
            setattr(request, "nudge_audit", audit)

        inject_items: list[InjectItem] = []
        for nudge in matched:
            applied = False
            if nudge.mode == "shadow":
                findings.append(f"nudge_shadow:{nudge.id}")
                audit.append({"nudge_id": str(nudge.id), "mode": "shadow", "applied": False})
            elif nudge.mode == "promoted":
                if nudge.action_type == "system_append":
                    inject_items.append(
                        InjectItem(
                            source="artifact",
                            ref_id=str(nudge.id),
                            text=nudge.content,
                            priority=float((nudge.evidence or {}).get("value_score") or 0.0),
                            tokens=estimate_tokens(nudge.content),
                        )
                    )
                    findings.append(f"nudge_promoted:{nudge.id}")
                    audit.append({"nudge_id": str(nudge.id), "mode": "promoted", "applied": True})
                    applied = True
                else:
                    request, meta, applied = apply_nudge_to_request(nudge, request)
                    findings.append(meta)
                    audit.append(
                        {"nudge_id": str(nudge.id), "mode": "promoted", "applied": applied}
                    )
            else:
                findings.append(f"nudge_promoted:{nudge.id}")
                audit.append({"nudge_id": str(nudge.id), "mode": nudge.mode, "applied": False})

            if trace_id:
                _schedule(
                    self._engine.log_shadow(
                        nudge,
                        trace_id=trace_id,
                        matched=True,
                        applied=applied,
                    )
                )

        if inject_items:
            ledger_text = getattr(request, "_ledger_inject_text", "") or ""
            all_items = []
            if ledger_text:
                all_items.append(
                    InjectItem(
                        source="ledger",
                        ref_id=str(getattr(request, "ledger_version", "") or ""),
                        text=ledger_text,
                        priority=5.0,
                    )
                )
            all_items.extend(inject_items)
            packed = InjectBudget().pack(all_items)
            if packed.text:
                request.prompt = f"{packed.text}\n\n{request.prompt}"
            setattr(request, "artifact_ids", packed.artifact_ids)
            setattr(request, "inject_tokens", packed.tokens)
            setattr(request, "inject_truncated", packed.truncated)
            audit.append(packed.audit)

        if trace_id:
            recent = ctx.get("recent_tool_calls") or []
            if not ctx.get("loop_detected") and len(recent) >= 2:
                tools = [c.get("tool_name") for c in recent[-5:]]
                ctx["loop_detected"] = len(tools) != len(set(tools))
            if ctx.get("loop_detected"):
                _schedule(self._rescue.try_rescue(org_id, ctx, request))

        return request, findings
