"""N19 KB flywheel coordinator — unifies detector_loop + procedural KB."""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)


class KBFlywheelCoordinator:
    """Two-speed learning: analyst path (immediate) + gated runtime path."""

    async def on_insight_created(self, insight: Any) -> None:
        org_id = getattr(insight, "organization_id", None) or getattr(insight, "org_id", "")
        if not org_id:
            return
        if not await self._may_draft(str(org_id), "kb_draft"):
            return
        skill = self._draft_from_insight(insight)
        await self._insert_skill(skill)
        await self._notify_cockpit(str(org_id), "kb_skill_draft", skill.get("id"))

    async def on_issue_resolved(self, issue: dict[str, Any]) -> None:
        org_id = str(issue.get("org_id") or "")
        if not org_id:
            return
        skills = self._draft_from_issue(issue)
        for skill in skills:
            await self._insert_skill(skill)
        stumble_count = int(issue.get("stumble_count") or 0)
        if stumble_count >= 3:
            from eden.nudges.author import ArtifactAuthor

            await ArtifactAuthor().from_issue(org_id, issue)
        from eden.llmops.warm_learn import warm_learn_caches

        agent_id = str(issue.get("agent_id") or "default")
        triage = issue.get("triage_result") or {}
        task = str(triage.get("summary") or issue.get("title") or "")[:200]
        await warm_learn_caches(org_id, agent_id, task_text=task)
        await self._enqueue_promotion(issue)
        await self._notify_cockpit(org_id, "kb_learned", issue.get("id"))

    async def suggest_for_issue(self, issue: dict[str, Any]) -> list[dict[str, Any]]:
        org_id = str(issue.get("org_id") or "")
        query = (
            (issue.get("triage_result") or {}).get("summary")
            or issue.get("title")
            or ""
        )
        if not query:
            return []
        try:
            from eden.kb.procedural.client import ProceduralClient

            client = ProceduralClient()
            if hasattr(client, "search_by_embedding"):
                return await client.search_by_embedding(query, org_id=org_id, limit=5)
        except Exception as exc:
            logger.debug("flywheel suggest failed: %s", exc)
        return []

    async def get_status(self, org_id: str) -> dict[str, Any]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"drafts": 0, "promoted": 0}
            drafts = await client.fetchval(
                """
                SELECT COUNT(*) FROM skills
                WHERE archivist_reviewed = false
                """,
            )
            promoted = await client.fetchval(
                """
                SELECT COUNT(*) FROM promotion_candidates
                WHERE org_id = $1 AND status = 'promoted'
                """,
                org_id,
            )
            return {"drafts": int(drafts or 0), "promoted": int(promoted or 0)}
        except Exception:
            return {"drafts": 0, "promoted": 0}

    def _draft_from_insight(self, insight: Any) -> dict[str, Any]:
        title = getattr(insight, "title", None) or getattr(insight, "summary", "Insight skill")
        summary = str(title)[:500]
        insight_id = getattr(insight, "insight_id", uuid4())
        template = (
            f"# Procedural skill from insight\n"
            f"# insight_id={insight_id}\n"
            f"def apply_guard(context: dict) -> str:\n"
            f"    \"\"\"{summary}\"\"\"\n"
            f"    return {repr(summary)}\n"
        )
        return {
            "id": str(uuid4()),
            "name": f"insight-{insight_id}",
            "description": summary,
            "code_template": template,
            "archivist_reviewed": False,
            "confidence_score": float(getattr(insight, "confidence", 0.5) or 0.5),
            "source_insight_id": str(getattr(insight, "insight_id", "")),
        }

    def _draft_from_issue(self, issue: dict[str, Any]) -> list[dict[str, Any]]:
        triage = issue.get("triage_result") or {}
        fix = triage.get("recommended_fix") or triage.get("summary") or issue.get("title")
        template = (
            f"# Skill from resolved issue\n"
            f"# kind={issue.get('kind')}\n"
            f"def guard():\n"
            f"    return {repr(str(fix)[:500])}\n"
        )
        return [
            {
                "id": str(uuid4()),
                "name": f"issue-{issue.get('id', 'unknown')}",
                "description": str(issue.get("title") or "Resolved issue skill")[:500],
                "code_template": template,
                "archivist_reviewed": False,
                "confidence_score": 0.6,
                "source_issue_id": str(issue.get("id") or ""),
            }
        ]

    async def _insert_skill(self, skill: dict[str, Any]) -> None:
        try:
            from eden.kb.procedural.client import ProceduralClient

            await ProceduralClient().insert(skill)
        except Exception as exc:
            logger.debug("flywheel insert_skill failed: %s", exc)

    async def _draft_shadow_nudge(self, issue: dict[str, Any]) -> None:
        from eden.nudges.engine import NudgeEngine

        triage = issue.get("triage_result") or {}
        content = triage.get("recommended_fix") or triage.get("summary") or issue.get("title")
        if not content:
            return
        engine = NudgeEngine()
        nudge_id = await engine.create_shadow(
            str(issue.get("org_id")),
            agent_id=str(issue.get("agent_id") or "default"),
            name=f"nudge-{issue.get('id', 'issue')}",
            trigger={"all": [{"event": "prompt_contains", "text": str(issue.get("kind") or "")}]},
            action_type="system_append",
            content=str(content)[:2000],
            source_issue_id=str(issue.get("id")) if issue.get("id") else None,
        )
        if nudge_id:
            from eden.promotion.evidence_gate import EvidenceGate

            await EvidenceGate().enqueue(
                str(issue.get("org_id")),
                kind="nudge",
                ref_id=nudge_id,
            )

    async def _enqueue_promotion(self, issue: dict[str, Any]) -> None:
        org_id = str(issue.get("org_id") or "")
        issue_id = str(issue.get("id") or "")
        if not org_id or not issue_id:
            return
        if not await self._may_draft(org_id, "kb_draft"):
            return
        try:
            from eden.promotion.evidence_gate import EvidenceGate
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            row = await client.fetchrow(
                """
                SELECT id FROM skills
                WHERE name = $1
                ORDER BY created_at DESC
                LIMIT 1
                """,
                f"issue-{issue_id}",
            )
            if row is None:
                return
            skill_id = str(row["id"])
            await EvidenceGate().enqueue(org_id, kind="kb_skill", ref_id=skill_id)
        except Exception as exc:
            logger.debug("flywheel enqueue promotion failed: %s", exc)

    async def _notify_cockpit(self, org_id: str, kind: str, ref: Any) -> None:
        try:
            from eden.improvement.cockpit_aggregator import ImprovementCockpitAggregator

            agg = ImprovementCockpitAggregator()
            if hasattr(agg, "notify"):
                await agg.notify(org_id, kind, ref)
        except Exception:
            pass

    async def _may_draft(self, org_id: str, action: str) -> bool:
        try:
            from eden.closed_loop.autonomy_policy import decide, resolve

            policy = await resolve(org_id, None)
            verdict, _, _ = decide(policy, action)
            return verdict != "deny"
        except Exception:
            return True

    async def on_promotion(self, org_id: str, kind: str, ref_id: str) -> None:
        """Ledger chapter hook on F41 promotion."""
        if kind == "nudge":
            try:
                from eden.storage.postgres import get_postgres_client

                client = await get_postgres_client()
                if client:
                    row = await client.fetchrow(
                        "SELECT agent_id, name, content FROM nudges WHERE id = $1", ref_id
                    )
                    if row:
                        from eden.kb.ledger.generator import LedgerGenerator
                        from eden.preview.gates import ledger_enabled

                        if await ledger_enabled(org_id):
                            await LedgerGenerator().upsert_do_not_repeat(
                                org_id,
                                str(row["agent_id"]),
                                text=f"Proven fix: {row['name']}\n{row['content'][:1000]}",
                                source_ids=[ref_id],
                            )
                        else:
                            from eden.kb.book.generator import BookGenerator

                            await BookGenerator().generate(
                                org_id, str(row["agent_id"]), publish_mode="auto_publish"
                            )
            except Exception as exc:
                logger.debug("flywheel ledger update failed: %s", exc)


_coordinator = KBFlywheelCoordinator()


def get_flywheel_coordinator() -> KBFlywheelCoordinator:
    return _coordinator
