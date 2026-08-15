"""F40 agent Book / Ledger gateway filter.

Boot-cost note (PERF): importing this module must stay cheap. The
Ledger retriever pulls the whole KB chain (~100ms cold), so both heavy
imports are deferred to first request in :meth:`BookGatewayFilter.apply`
— the filter is registered at boot on every gateway, but only runs when
an org has the ledger feature enabled. Keeps ``gateway.py → ai_gateway
→ filters → book`` out of the eager boot graph.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.preview.gates import ledger_enabled_sync

logger = logging.getLogger(__name__)

_BOOK_CACHE: dict[str, dict[str, Any]] = {}


def _book_cache_key(org_id: str, agent_id: str) -> str:
    return f"{org_id}:{agent_id}"


class BookGatewayFilter:
    """Append Ledger retrieval to request context for shared InjectBudget."""

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

        org_s = str(org_id)
        agent_s = str(agent_id)
        if ledger_enabled_sync(org_s):
            # Lazy: ``LedgerRetriever`` pulls the KB chain (~100ms cold);
            # ``schedule_warm_learn`` fires a background warm-up task.
            from eden.kb.ledger.retrieve import LedgerRetriever
            from eden.llmops.warm_learn import schedule_warm_learn

            text, audit = LedgerRetriever().pack_sync(org_s, agent_s)
            if audit.get("cache_miss"):
                schedule_warm_learn(
                    org_s, agent_s, task_text=str(getattr(request, "prompt", "") or "")
                )
            elif text:
                request._ledger_inject_text = text
                request.inject_tokens = audit.get("inject_tokens", 0)
                request.inject_truncated = audit.get("inject_truncated", False)
                return request, [f"ledger_injected:{audit.get('inject_tokens', 0)}"]

        return self._legacy_book_apply(request, org_s, agent_s)

    def _legacy_book_apply(
        self, request: Any, org_id: str, agent_id: str
    ) -> tuple[Any, list[str]]:
        book = _BOOK_CACHE.get(_book_cache_key(org_id, agent_id))
        if not book or not book.get("content_md"):
            return request, []

        max_tokens = int(book.get("max_tokens") or 2000)
        excerpt = str(book["content_md"])[: max_tokens * 4]
        request.prompt = (
            f"<!-- eden-book:v{book.get('version', 1)} -->\n{excerpt}\n\n{request.prompt}"
        )
        request.book_version = book.get("version")
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
