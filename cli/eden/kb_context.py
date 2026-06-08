"""Knowledge Base context provider.

The CLI injects KB context into the LLM system prompt as two clearly
labelled sections:

    [GLOBAL KNOWLEDGE]    — Eden-curated best practices, failure modes,
                             exploit library, framework facts.
    [TENANT CONTEXT]      — Org-specific patterns, conventions, history.

Both are queried through the Eden API (``/v1/orgs/{org}/kb/query``).
Results are formatted as compact markdown (the LLM consumes this much
better than raw JSON) and bounded by a token budget so the system
prompt stays within model context limits.

Caching: 5 min TTL on (query, scope) to avoid hammering the API when
the chat loop sends many turns.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

from eden.api_client import EdenAPIClient, EdenAPIError
from eden.config import ContextConfig

logger = logging.getLogger("eden.cli.kb_context")


@dataclass
class KBEntry:
    """A single KB hit, ready to render."""

    title: str
    content: str
    source: str
    scope: str  # "global" | "tenant"
    confidence: float = 1.0


@dataclass
class KBContext:
    """A rendered chunk of KB context for system-prompt injection."""

    scope: str  # "global" | "tenant" | "combined"
    text: str
    hit_count: int
    truncated: bool = False
    cached: bool = False


# ── Heuristic token budget ──────────────────────────────────────────────
# Aider and the LLM ecosystem in general still uses tiktoken in places
# but for context budgeting the rough "4 chars ≈ 1 token" rule is good
# enough and avoids an extra dep here.

_CHARS_PER_TOKEN = 4


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)


def _truncate_to_budget(entries: list[KBEntry], budget: int) -> tuple[str, bool]:
    """Render entries as compact markdown and truncate to ``budget`` tokens.

    Returns ``(text, truncated)`` where ``truncated`` is True if at least
    one entry was dropped due to budget exhaustion.
    """
    rendered: list[str] = []
    used = 0
    dropped = False

    for e in entries:
        block = (
            f"### {e.title}\n"
            f"_{e.scope} · {e.source} · conf={e.confidence:.2f}_\n\n"
            f"{e.content.strip()}\n"
        )
        block_tokens = _approx_tokens(block)
        if used + block_tokens > budget and rendered:
            dropped = True
            break
        rendered.append(block)
        used += block_tokens

    return ("\n".join(rendered).strip(), dropped)


# ── Provider ────────────────────────────────────────────────────────────


class KBContextProvider:
    """Queries the Eden KB and renders results for prompt injection."""

    def __init__(
        self,
        client: EdenAPIClient,
        config: ContextConfig,
    ):
        self.client = client
        self.config = config
        self._cache: dict[tuple[str, str], tuple[float, KBContext]] = {}

    # ── Cache helpers ────────────────────────────────────────────────

    def _cache_get(self, key: tuple[str, str]) -> Optional[KBContext]:
        item = self._cache.get(key)
        if not item:
            return None
        ts, value = item
        if (time.time() - ts) > self.config.cache_ttl_seconds:
            self._cache.pop(key, None)
            return None
        # Mark as cached for the caller
        value.cached = True
        return value

    def _cache_set(self, key: tuple[str, str], value: KBContext) -> None:
        self._cache[key] = (time.time(), value)

    @staticmethod
    def _hash_query(query: str) -> str:
        return hashlib.sha1(query.encode("utf-8")).hexdigest()[:12]

    # ── Public API ────────────────────────────────────────────────────

    async def get_global_context(
        self, query: str, *, budget: Optional[int] = None
    ) -> KBContext:
        return await self._fetch(query, scope="global", budget=budget)

    async def get_tenant_context(
        self, query: str, *, budget: Optional[int] = None
    ) -> KBContext:
        return await self._fetch(query, scope="tenant", budget=budget)

    async def get_combined_context(
        self, query: str, *, budget: Optional[int] = None
    ) -> KBContext:
        """Get global + tenant in one rendered block."""
        budget = budget or self.config.kb_token_budget
        half = budget // 2

        g = await self.get_global_context(query, budget=half)
        t = await self.get_tenant_context(query, budget=budget - half)

        sections: list[str] = []
        if g.text:
            sections.append(f"## [GLOBAL KNOWLEDGE]\n\n{g.text}")
        if t.text:
            sections.append(f"## [TENANT CONTEXT]\n\n{t.text}")

        combined = "\n\n---\n\n".join(sections).strip()
        return KBContext(
            scope="combined",
            text=combined,
            hit_count=g.hit_count + t.hit_count,
            truncated=g.truncated or t.truncated,
        )

    # ── Internals ─────────────────────────────────────────────────────

    async def _fetch(
        self, query: str, *, scope: str, budget: Optional[int] = None
    ) -> KBContext:
        if not query.strip():
            return KBContext(scope=scope, text="", hit_count=0)

        budget = budget or self.config.kb_token_budget
        cache_key = (self._hash_query(query), scope)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached

        try:
            resp = await self.client.query_kb(query, scope=scope, limit=20)
        except EdenAPIError as exc:
            logger.warning("KB query failed (scope=%s): %s", scope, exc)
            return KBContext(scope=scope, text="", hit_count=0)

        entries = self._parse_entries(resp, scope=scope)
        text, truncated = _truncate_to_budget(entries, budget)
        ctx = KBContext(
            scope=scope,
            text=text,
            hit_count=len(entries),
            truncated=truncated,
        )
        self._cache_set(cache_key, ctx)
        return ctx

    @staticmethod
    def _parse_entries(resp: dict[str, Any], *, scope: str) -> list[KBEntry]:
        """Translate the API response shape into ``KBEntry`` records.

        The KB API returns a heterogeneous list (episodic, semantic,
        skills, exploits). We accept any list of dicts with at minimum
        a ``content`` field. Missing fields fall back to safe defaults
        so a forward-compatible API addition doesn't crash us.
        """
        out: list[KBEntry] = []

        # Common shapes: {"results": [...]}, {"episodic_results": [...], "semantic_results": [...]}
        candidates: list[list[dict[str, Any]]] = []
        for key in (
            "results",
            "episodic_results",
            "semantic_results",
            "skills",
            "exploits",
        ):
            v = resp.get(key)
            if isinstance(v, list):
                candidates.append(v)

        for batch in candidates:
            for raw in batch:
                if not isinstance(raw, dict):
                    continue
                content = str(raw.get("content") or raw.get("text") or "").strip()
                if not content:
                    continue
                title = str(raw.get("title") or raw.get("name") or "(untitled)")
                source = str(raw.get("source") or raw.get("collection") or scope)
                confidence_raw = raw.get("confidence", raw.get("score", 1.0))
                try:
                    confidence = float(confidence_raw)
                except (TypeError, ValueError):
                    confidence = 1.0
                out.append(
                    KBEntry(
                        title=title[:120],
                        content=content,
                        source=source[:80],
                        scope=scope,
                        confidence=max(0.0, min(1.0, confidence)),
                    )
                )

        return out
