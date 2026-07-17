"""LedgerGenerator — $0 template upsert on resolve/promote/demote."""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

from eden.kb.ledger.models import LedgerEntry

logger = logging.getLogger(__name__)


class LedgerGenerator:
    """Write ledger entries without LLM (template upsert)."""

    async def get_or_create_ledger(self, org_id: str, agent_id: str) -> str | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            row = await client.fetchrow(
                """
                SELECT id FROM agent_ledgers
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
            )
            if row:
                return str(row["id"])
            lid = uuid4()
            await client.execute(
                """
                INSERT INTO agent_ledgers (id, org_id, agent_id, version, inject_enabled)
                VALUES ($1, $2, $3, 1, false)
                """,
                lid,
                org_id,
                agent_id,
            )
            return str(lid)
        except Exception as exc:
            logger.debug("ledger get_or_create failed: %s", exc)
            return None

    async def upsert_from_issue(
        self,
        org_id: str,
        agent_id: str,
        issue: dict[str, Any],
        *,
        artifact_id: str | None = None,
    ) -> str | None:
        ledger_id = await self.get_or_create_ledger(org_id, agent_id)
        if not ledger_id:
            return None
        triage = issue.get("triage_result") or {}
        summary = triage.get("summary") or issue.get("title") or "Resolved issue"
        citations = [str(issue.get("id") or "")]
        if artifact_id:
            citations.append(f"artifact:{artifact_id}")
        text = (
            f"## Resolved: {issue.get('kind', 'issue')}\n"
            f"{summary}\n"
            f"Citations: {', '.join(citations)}"
        )
        return await self._upsert_entry(
            org_id,
            agent_id,
            ledger_id,
            chapter="recent_failures",
            text=text[:4000],
            citations=citations,
            source_ids=citations,
        )

    async def upsert_do_not_repeat(
        self,
        org_id: str,
        agent_id: str,
        *,
        text: str,
        source_ids: list[str],
    ) -> str | None:
        ledger_id = await self.get_or_create_ledger(org_id, agent_id)
        if not ledger_id:
            return None
        return await self._upsert_entry(
            org_id,
            agent_id,
            ledger_id,
            chapter="do_not_repeat",
            text=text[:2000],
            citations=source_ids,
            source_ids=source_ids,
            weight=10.0,
        )

    async def get_latest(self, org_id: str, agent_id: str) -> dict[str, Any] | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            ledger = await client.fetchrow(
                """
                SELECT id, version, inject_enabled, max_tokens, retrieval_enabled
                FROM agent_ledgers
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
            )
            if not ledger:
                return None
            entries = await client.fetch(
                """
                SELECT id, chapter, text, citations, weight, version, created_at
                FROM ledger_entries
                WHERE ledger_id = $1
                ORDER BY weight DESC, created_at DESC
                LIMIT 100
                """,
                ledger["id"],
            )
            return {
                "ledger_id": str(ledger["id"]),
                "version": int(ledger["version"]),
                "inject_enabled": bool(ledger["inject_enabled"]),
                "config": {
                    "enabled": bool(ledger["inject_enabled"]),
                    "max_tokens": int(ledger["max_tokens"] or 800),
                    "retrieval_enabled": bool(ledger.get("retrieval_enabled", True)),
                },
                "entries": [dict(e) for e in entries or []],
            }
        except Exception as exc:
            logger.debug("ledger get_latest failed: %s", exc)
            return None

    async def get_config(self, org_id: str, agent_id: str) -> dict[str, Any]:
        data = await self.get_latest(org_id, agent_id)
        if data:
            return data.get("config") or {
                "enabled": False,
                "max_tokens": 800,
                "retrieval_enabled": True,
            }
        return {"enabled": False, "max_tokens": 800, "retrieval_enabled": True}

    async def set_config(
        self,
        org_id: str,
        agent_id: str,
        *,
        enabled: bool | None = None,
        max_tokens: int | None = None,
        retrieval_enabled: bool | None = None,
    ) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return False
            await self.get_or_create_ledger(org_id, agent_id)
            await client.execute(
                """
                UPDATE agent_ledgers
                SET inject_enabled = COALESCE($3, inject_enabled),
                    max_tokens = COALESCE($4, max_tokens),
                    retrieval_enabled = COALESCE($5, retrieval_enabled),
                    updated_at = now()
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
                enabled,
                max_tokens,
                retrieval_enabled,
            )
            return True
        except Exception as exc:
            logger.debug("ledger set_config failed: %s", exc)
            return False

    async def diff_since_version(
        self, org_id: str, agent_id: str, since_version: int
    ) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT le.chapter, le.text, le.version, le.created_at
                FROM ledger_entries le
                JOIN agent_ledgers al ON al.id = le.ledger_id
                WHERE al.org_id = $1 AND al.agent_id = $2 AND le.version > $3
                ORDER BY le.created_at ASC
                """,
                org_id,
                agent_id,
                since_version,
            )
            return [dict(r) for r in rows or []]
        except Exception as exc:
            logger.debug("ledger diff failed: %s", exc)
            return []

    async def _upsert_entry(
        self,
        org_id: str,
        agent_id: str,
        ledger_id: str,
        *,
        chapter: str,
        text: str,
        citations: list[str],
        source_ids: list[str],
        weight: float = 1.0,
    ) -> str | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            version_row = await client.fetchrow(
                "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ledger_entries WHERE ledger_id = $1",
                ledger_id,
            )
            version = int(version_row["v"]) if version_row else 1
            eid = uuid4()
            from eden.kb.ledger.embeddings import embed_text

            embedding = embed_text(text)
            await client.execute(
                """
                INSERT INTO ledger_entries
                    (id, org_id, agent_id, ledger_id, chapter, text,
                     citations, source_ids, weight, version, embedding)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
                ON CONFLICT (ledger_id, chapter, md5(text))
                DO UPDATE SET text = EXCLUDED.text, weight = EXCLUDED.weight,
                              citations = EXCLUDED.citations, version = EXCLUDED.version,
                              embedding = EXCLUDED.embedding
                """,
                eid,
                org_id,
                agent_id,
                ledger_id,
                chapter,
                text,
                json.dumps(citations),
                json.dumps(source_ids),
                weight,
                version,
                embedding,
            )
            from eden.kb.ledger.retrieve import LedgerRetriever

            LedgerRetriever.invalidate(org_id, agent_id)
            await client.execute(
                "UPDATE agent_ledgers SET version = $2, updated_at = now() WHERE id = $1",
                ledger_id,
                version,
            )
            return str(eid)
        except Exception as exc:
            logger.debug("ledger upsert entry failed: %s", exc)
            return None
