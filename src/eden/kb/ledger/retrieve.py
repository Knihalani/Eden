"""LedgerRetriever — top-k retrieval packed through InjectBudget."""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from eden.llmops.inject_budget import InjectBudget, InjectItem

logger = logging.getLogger(__name__)

_PACK_CACHE: dict[str, tuple[str, int, bool]] = {}
_LEDGER_SYNC_CACHE: dict[str, str] = {}
_CACHE_TTL_SEC = 120


class LedgerRetriever:
    """Retrieve ledger lines for gateway inject."""

    @staticmethod
    def cache_packed(org_id: str, agent_id: str, text: str) -> None:
        _LEDGER_SYNC_CACHE[f"{org_id}:{agent_id}"] = text

    def pack_sync(self, org_id: str, agent_id: str) -> tuple[str, dict[str, Any]]:
        """Sync hot-path read from warmed cache."""
        text = _LEDGER_SYNC_CACHE.get(f"{org_id}:{agent_id}", "")
        if not text:
            return "", {}
        tokens = len(text) // 4
        return text, {"inject_tokens": tokens, "inject_truncated": False, "cache_hit": True}

    async def pack_for_request(
        self,
        org_id: str,
        agent_id: str,
        *,
        task_text: str = "",
        soft_share: float = 0.6,
    ) -> tuple[str, dict[str, Any]]:
        from eden.kb.ledger.generator import LedgerGenerator
        from eden.preview.gates import ledger_enabled

        if not await ledger_enabled(org_id):
            return "", {}

        config = await LedgerGenerator().get_config(org_id, agent_id)
        if not config.get("enabled"):
            return "", {"inject_skipped": "ledger_disabled"}

        max_tokens = int(config.get("max_tokens") or 800)
        hard_cap = min(max_tokens, InjectBudget().hard_cap)

        cache_key = hashlib.sha256(
            f"{org_id}:{agent_id}:{task_text[:200]}".encode()
        ).hexdigest()[:24]
        if cache_key in _PACK_CACHE:
            text, tokens, truncated = _PACK_CACHE[cache_key]
            return text, {
                "inject_tokens": tokens,
                "inject_truncated": truncated,
                "cache_hit": True,
            }

        entries = await self._top_k(org_id, agent_id, task_text, k=5)
        items: list[InjectItem] = []
        for e in entries:
            chapter = str(e.get("chapter") or "")
            always = chapter == "do_not_repeat"
            items.append(
                InjectItem(
                    source="ledger",
                    ref_id=str(e.get("version") or e.get("id") or ""),
                    text=str(e.get("text") or ""),
                    priority=float(e.get("weight") or 1.0),
                    always_include=always,
                )
            )

        budget = InjectBudget(ledger_share=soft_share, hard_cap=hard_cap)
        packed = budget.pack(items)
        _PACK_CACHE[cache_key] = (packed.text, packed.tokens, packed.truncated)
        self.cache_packed(org_id, agent_id, packed.text)
        return packed.text, packed.audit

    async def preview(
        self, org_id: str, agent_id: str, task_text: str
    ) -> dict[str, Any]:
        text, audit = await self.pack_for_request(org_id, agent_id, task_text=task_text)
        from eden.nudges.cost_estimator import CostEstimator

        est = CostEstimator().estimate(text or " ")
        return {
            "injected_block": text,
            "tokens": audit.get("inject_tokens", est.tokens_per_match),
            "est_usd_per_match": est.est_usd_per_match,
            "truncated": audit.get("inject_truncated", False),
        }

    async def _top_k(
        self, org_id: str, agent_id: str, task_text: str, *, k: int = 5
    ) -> list[dict[str, Any]]:
        try:
            from eden.kb.ledger.embeddings import cosine, embed_text, unpack_embedding
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT le.id, le.chapter, le.text, le.weight, le.version,
                       le.citations, le.embedding
                FROM ledger_entries le
                JOIN agent_ledgers al ON al.id = le.ledger_id
                WHERE al.org_id = $1 AND al.agent_id = $2
                LIMIT 50
                """,
                org_id,
                agent_id,
            )
            entries = [dict(r) for r in rows or []]
            if not entries:
                return []
            if task_text.strip():
                query_vec = unpack_embedding(embed_text(task_text))
                for entry in entries:
                    vec = unpack_embedding(entry.get("embedding"))
                    sim = cosine(query_vec, vec) if vec else 0.0
                    chapter_boost = 2.0 if entry.get("chapter") == "do_not_repeat" else 0.0
                    entry["_score"] = sim + chapter_boost + float(entry.get("weight") or 0) * 0.01
                entries.sort(key=lambda e: e.get("_score", 0), reverse=True)
            else:
                entries.sort(
                    key=lambda e: (
                        0 if e.get("chapter") == "do_not_repeat" else 1,
                        -float(e.get("weight") or 0),
                    )
                )
            return entries[:k]
        except Exception as exc:
            logger.debug("ledger top_k failed: %s", exc)
            return []

    @staticmethod
    def invalidate(org_id: str, agent_id: str) -> None:
        prefix = f"{org_id}:{agent_id}"
        for key in list(_PACK_CACHE):
            if key.startswith(hashlib.sha256(prefix.encode()).hexdigest()[:8]):
                _PACK_CACHE.pop(key, None)
