"""F40 agent Book gateway filter."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_BOOK_CACHE: dict[str, dict[str, Any]] = {}


def _book_cache_key(org_id: str, agent_id: str) -> str:
    return f"{org_id}:{agent_id}"


class BookGatewayFilter:
    """Append Book excerpt to system prompt when enabled."""

    name = "agent_book"

    def enabled(self, request: Any) -> bool:
        ctx = getattr(request, "context", {}) or {}
        if isinstance(ctx, dict) and ctx.get("book_enabled") is False:
            return False
        return bool(getattr(request, "book_enabled", True))

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        org_id = getattr(request, "org_id", None) or request.tenant_id
        agent_id = getattr(request, "agent_id", "")
        if not org_id or not agent_id:
            return request, []

        book = _BOOK_CACHE.get(_book_cache_key(str(org_id), str(agent_id)))
        if not book or not book.get("content_md"):
            return request, []

        max_tokens = int(book.get("max_tokens") or 2000)
        excerpt = str(book["content_md"])[: max_tokens * 4]
        request.prompt = (
            f"<!-- eden-book:v{book.get('version', 1)} -->\n{excerpt}\n\n{request.prompt}"
        )
        setattr(request, "book_version", book.get("version"))
        return request, [f"book_injected:v{book.get('version', 1)}"]

    @staticmethod
    def cache_book(
        org_id: str,
        agent_id: str,
        *,
        content_md: str,
        version: int,
        max_tokens: int = 2000,
    ) -> None:
        _BOOK_CACHE[_book_cache_key(org_id, agent_id)] = {
            "content_md": content_md,
            "version": version,
            "max_tokens": max_tokens,
        }

    @staticmethod
    def invalidate(org_id: str, agent_id: str) -> None:
        _BOOK_CACHE.pop(_book_cache_key(org_id, agent_id), None)
