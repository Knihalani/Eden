"""F40 agent Book generator."""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)

_DEFAULT_CHAPTERS = """## Recent failures
_No resolved issues in window._

## Proven fixes
_No promoted nudges yet._

## Tool/MCP gotchas
_Review procedural KB skills for patterns._

## Do-not-repeat
_Archived nudges and regressions appear here._
"""


class BookGenerator:
    """Synthesize versioned markdown Book per agent."""

    async def generate(
        self,
        org_id: str,
        agent_id: str,
        *,
        publish_mode: str = "auto_draft",
        published_by: str | None = None,
    ) -> dict[str, Any] | None:
        content = await self._synthesize(org_id, agent_id)
        token_count = len(content.split())
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            version_row = await client.fetchrow(
                """
                SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                FROM agent_books
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
            )
            version = int(version_row["next_version"]) if version_row else 1
            book_id = uuid4()
            await client.execute(
                """
                INSERT INTO agent_books
                    (id, org_id, agent_id, version, content_md, token_count,
                     publish_mode, published_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                book_id,
                org_id,
                agent_id,
                version,
                content,
                token_count,
                publish_mode,
                published_by,
            )
            from eden.llmops.filters.book import BookGatewayFilter

            config = await self.get_config(org_id, agent_id)
            BookGatewayFilter.cache_book(
                org_id,
                agent_id,
                content_md=content[: (config.get("max_tokens") or 2000) * 4],
                version=version,
                max_tokens=config.get("max_tokens") or 2000,
            )
            return {
                "id": str(book_id),
                "version": version,
                "token_count": token_count,
                "content_md": content,
            }
        except Exception as exc:
            logger.warning("book generator: generate failed: %s", exc)
            return None

    async def _synthesize(self, org_id: str, agent_id: str) -> str:
        sections: list[str] = []
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return _DEFAULT_CHAPTERS

            issues = await client.fetch(
                """
                SELECT title, kind, stumble_count
                FROM agent_issues
                WHERE org_id = $1 AND agent_id = $2 AND status = 'resolved'
                ORDER BY last_seen DESC LIMIT 10
                """,
                org_id,
                agent_id,
            )
            if issues:
                lines = [f"- **{r['title']}** ({r['kind']}, stumbles={r['stumble_count']})" for r in issues]
                sections.append("## Recent failures\n" + "\n".join(lines))
            else:
                sections.append("## Recent failures\n_No resolved issues in window._")

            nudges = await client.fetch(
                """
                SELECT name, content FROM nudges
                WHERE org_id = $1 AND agent_id = $2 AND mode = 'promoted'
                ORDER BY promoted_at DESC LIMIT 5
                """,
                org_id,
                agent_id,
            )
            if nudges:
                lines = [f"- **{r['name']}**: {r['content'][:200]}" for r in nudges]
                sections.append("## Proven fixes\n" + "\n".join(lines))
            else:
                sections.append("## Proven fixes\n_No promoted nudges yet._")

            from eden.kb.artifact_context import format_book_section, list_agent_context

            ctx_rows = await list_agent_context(org_id, agent_id)
            sections.append(format_book_section(ctx_rows))

            sections.append("## Tool/MCP gotchas\n_Review procedural KB skills for patterns._")
            sections.append("## Do-not-repeat\n_Archived nudges and regressions appear here._")
            return "\n\n".join(sections)
        except Exception as exc:
            logger.debug("book generator: synthesize failed: %s", exc)
            return _DEFAULT_CHAPTERS

    async def get_latest(self, org_id: str, agent_id: str) -> dict[str, Any] | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            row = await client.fetchrow(
                """
                SELECT id, version, content_md, token_count, published_at, publish_mode
                FROM agent_books
                WHERE org_id = $1 AND agent_id = $2
                ORDER BY version DESC LIMIT 1
                """,
                org_id,
                agent_id,
            )
            return dict(row) if row else None
        except Exception as exc:
            logger.debug("book generator: get_latest failed: %s", exc)
            return None

    async def get_config(self, org_id: str, agent_id: str) -> dict[str, Any]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"enabled": False, "max_tokens": 2000, "auto_update": True}
            row = await client.fetchrow(
                """
                SELECT enabled, max_tokens, auto_update
                FROM agent_book_config
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
            )
            if row:
                return dict(row)
            return {"enabled": False, "max_tokens": 2000, "auto_update": True}
        except Exception:
            return {"enabled": False, "max_tokens": 2000, "auto_update": True}

    async def set_config(
        self, org_id: str, agent_id: str, *, enabled: bool, max_tokens: int = 2000
    ) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return False
            await client.execute(
                """
                INSERT INTO agent_book_config (org_id, agent_id, enabled, max_tokens)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (org_id, agent_id)
                DO UPDATE SET enabled = EXCLUDED.enabled, max_tokens = EXCLUDED.max_tokens
                """,
                org_id,
                agent_id,
                enabled,
                max_tokens,
            )
            return True
        except Exception as exc:
            logger.warning("book generator: set_config failed: %s", exc)
            return False
