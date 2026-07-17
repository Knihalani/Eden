"""ArtifactAuthor — template-first shadow Artifact drafts from detectors."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class ArtifactAuthor:
    """Author shadow Artifacts from loop/issue signals without LLM when possible."""

    async def from_loop_report(
        self,
        org_id: str,
        *,
        agent_id: str,
        report: dict[str, Any],
    ) -> str | None:
        kind = str(report.get("kind") or report.get("loop_kind") or "")
        trigger, content, name = self._loop_dsl(kind, report)
        if not content:
            return None
        from eden.nudges.engine import NudgeEngine
        from eden.promotion.evidence_gate import EvidenceGate

        engine = NudgeEngine()
        nudge_id = await engine.create_shadow(
            org_id,
            agent_id=agent_id,
            name=name,
            trigger=trigger,
            action_type="system_append",
            content=content,
            source_issue_id=report.get("issue_id"),
        )
        if nudge_id:
            await EvidenceGate().enqueue(org_id, kind="nudge", ref_id=nudge_id)
        return nudge_id

    async def from_issue(
        self,
        org_id: str,
        issue: dict[str, Any],
    ) -> str | None:
        triage = issue.get("triage_result") or {}
        content = (
            triage.get("recommended_fix")
            or triage.get("summary")
            or issue.get("title")
        )
        if not content:
            return None
        kind = str(issue.get("kind") or "issue")
        trigger = {
            "all": [
                {"event": "prompt_contains", "text": kind},
            ]
        }
        from eden.nudges.engine import NudgeEngine
        from eden.promotion.evidence_gate import EvidenceGate

        engine = NudgeEngine()
        nudge_id = await engine.create_shadow(
            org_id,
            agent_id=str(issue.get("agent_id") or "default"),
            name=f"artifact-{issue.get('id', 'issue')}",
            trigger=trigger,
            action_type="system_append",
            content=str(content)[:2000],
            source_issue_id=str(issue.get("id")) if issue.get("id") else None,
        )
        if nudge_id:
            await EvidenceGate().enqueue(org_id, kind="nudge", ref_id=nudge_id)
            await self._write_ledger_entry(org_id, issue, nudge_id)
        return nudge_id

    async def from_nl(
        self,
        org_id: str,
        *,
        agent_id: str,
        description: str,
    ) -> str | None:
        """Plain-English authoring — template path first, slot=fast only if needed."""
        from eden.llmops.evolution_spend import EvolutionSpendBudget
        from eden.nudges.engine import NudgeEngine
        from eden.preview.gates import artifacts_enabled

        if not await artifacts_enabled(org_id):
            return None
        budget = EvolutionSpendBudget(org_id)
        content = description.strip()
        trigger = {"all": [{"event": "prompt_contains", "text": description[:80]}]}
        if not await budget.may_spend(0.01):
            pass  # template-only path
        elif len(description) > 200:
            try:
                from eden.llm.internal_router import route_async
                from eden.llmops.cost_ledger import cost_context
                from eden.llmops.feature_kills import is_feature_enabled

                if not await is_feature_enabled(org_id, "nudge_author"):
                    raise RuntimeError("nudge_author kill-switch off")

                with cost_context(org_id, "nudge_author", agent_id=agent_id):
                    resp = await route_async(
                        "artifact_author_nl",
                        (
                            "Extract a short trigger keyword and fix text from: "
                            f"{description}"
                        ),
                        slot="fast",
                        output_type="text",
                        org_id=org_id,
                        feature="nudge_author",
                        requires_quality_check=False,
                    )
                text = (getattr(resp, "content", None) or "").strip()
                if text:
                    content = text[:2000]
                await budget.record(0.005, kind="artifact_author_nl", ref_id=agent_id)
            except Exception as exc:
                logger.debug("artifact author NL fast path failed: %s", exc)

        engine = NudgeEngine()
        nudge_id = await engine.create_shadow(
            org_id,
            agent_id=agent_id,
            name=f"nl-artifact-{description[:40]}",
            trigger=trigger,
            action_type="system_append",
            content=content[:2000],
        )
        if nudge_id:
            from eden.promotion.evidence_gate import EvidenceGate

            await EvidenceGate().enqueue(org_id, kind="nudge", ref_id=nudge_id)
        return nudge_id

    def _loop_dsl(
        self, kind: str, report: dict[str, Any]
    ) -> tuple[dict[str, Any], str, str]:
        tool = str(report.get("tool_name") or report.get("repeated_tool") or "")
        if kind in ("same_tool_repeats", "loop", "tool_repeat"):
            trigger = {
                "all": [{"event": "tool_call", "tool": tool or "*", "min_repeats": 2}]
            }
            content = (
                f"Stop repeating tool `{tool}` without progress. "
                "Summarize what you tried and pick a different approach."
            )
            return trigger, content, f"loop-{tool or 'repeat'}"
        if kind in ("tool_result", "tool_error"):
            trigger = {"all": [{"event": "tool_error", "tool": tool or "*"}]}
            content = (
                f"Tool `{tool}` failed. Verify inputs, try an alternate tool, "
                "or ask the user for missing context."
            )
            return trigger, content, f"tool-result-{tool or 'error'}"
        return {}, "", ""

    async def _write_ledger_entry(
        self, org_id: str, issue: dict[str, Any], artifact_id: str
    ) -> None:
        try:
            from eden.preview.gates import ledger_enabled

            if not await ledger_enabled(org_id):
                return
            from eden.kb.ledger.generator import LedgerGenerator

            await LedgerGenerator().upsert_from_issue(
                org_id,
                str(issue.get("agent_id") or "default"),
                issue,
                artifact_id=artifact_id,
            )
            from eden.llmops.warm_learn import warm_learn_caches

            triage = issue.get("triage_result") or {}
            task = str(triage.get("summary") or issue.get("title") or "")[:200]
            await warm_learn_caches(
                org_id, str(issue.get("agent_id") or "default"), task_text=task
            )
        except Exception as exc:
            logger.debug("artifact author ledger upsert failed: %s", exc)
