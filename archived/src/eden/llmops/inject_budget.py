"""Shared InjectBudget envelope for Artifacts + Ledger gateway injects."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from eden.config import get_settings
from eden.llmops.gateway_optimizations import layout_for_provider_cache


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token)."""
    if not text:
        return 0
    return max(1, len(text) // 4)


@dataclass
class InjectItem:
    """One injectable block with priority metadata."""

    source: str  # "ledger" | "artifact"
    ref_id: str
    text: str
    priority: float = 0.0
    tokens: int = 0
    always_include: bool = False

    def __post_init__(self) -> None:
        if self.tokens <= 0:
            self.tokens = estimate_tokens(self.text)


@dataclass
class InjectPackResult:
    """Packed inject output for gateway filters."""

    text: str = ""
    tokens: int = 0
    truncated: bool = False
    artifact_ids: list[str] = field(default_factory=list)
    ledger_version: int | None = None
    items_packed: list[dict[str, Any]] = field(default_factory=list)
    audit: dict[str, Any] = field(default_factory=dict)


class InjectBudget:
    """Pack Ledger + Artifact injects under soft/hard token caps."""

    def __init__(
        self,
        *,
        soft_cap: int | None = None,
        hard_cap: int | None = None,
        ledger_share: float = 0.6,
    ) -> None:
        settings = get_settings()
        self.soft_cap = soft_cap if soft_cap is not None else settings.inject_budget_soft_tokens
        self.hard_cap = hard_cap if hard_cap is not None else settings.inject_budget_hard_tokens
        self.ledger_share = ledger_share

    def pack(
        self,
        items: list[InjectItem],
        *,
        provider: str = "",
    ) -> InjectPackResult:
        if not items:
            return InjectPackResult()

        ledger_soft = int(self.soft_cap * self.ledger_share)
        artifact_soft = self.soft_cap - ledger_soft

        always = [i for i in items if i.always_include]
        ledger = sorted(
            [i for i in items if i.source == "ledger" and not i.always_include],
            key=lambda x: -x.priority,
        )
        artifacts = sorted(
            [i for i in items if i.source == "artifact" and not i.always_include],
            key=lambda x: -x.priority,
        )

        packed: list[InjectItem] = []
        used = 0
        truncated = False

        def _try_add(item: InjectItem, cap: int) -> bool:
            nonlocal used, truncated
            if used + item.tokens <= cap:
                packed.append(item)
                used += item.tokens
                return True
            remaining = cap - used
            if remaining <= 0:
                truncated = True
                return False
            trimmed = item.text[: max(remaining * 4, 0)]
            if not trimmed:
                truncated = True
                return False
            tok = estimate_tokens(trimmed)
            packed.append(
                InjectItem(
                    source=item.source,
                    ref_id=item.ref_id,
                    text=trimmed,
                    priority=item.priority,
                    tokens=tok,
                    always_include=item.always_include,
                )
            )
            used += tok
            truncated = True
            return False

        for item in always:
            _try_add(item, self.hard_cap)

        ledger_used = sum(i.tokens for i in packed if i.source == "ledger")
        for item in ledger:
            cap = min(self.hard_cap, ledger_soft + (ledger_used if ledger_used else 0))
            if _try_add(item, cap):
                ledger_used += item.tokens

        artifact_used = sum(i.tokens for i in packed if i.source == "artifact")
        for item in artifacts:
            cap = min(self.hard_cap, artifact_soft + artifact_used + ledger_used)
            if _try_add(item, cap):
                artifact_used += item.tokens

        if used > self.soft_cap:
            truncated = True

        blocks = [f"<!-- eden-inject:{p.source}:{p.ref_id} -->\n{p.text}" for p in packed]
        combined = "\n\n".join(blocks)
        messages, _ = layout_for_provider_cache(
            [{"role": "system", "content": combined}],
            provider=provider,
        )
        final_text = messages[0]["content"] if messages else combined

        artifact_ids = [p.ref_id for p in packed if p.source == "artifact"]
        ledger_versions = [
            int(p.ref_id) for p in packed if p.source == "ledger" and p.ref_id.isdigit()
        ]

        return InjectPackResult(
            text=final_text,
            tokens=used,
            truncated=truncated,
            artifact_ids=artifact_ids,
            ledger_version=ledger_versions[0] if ledger_versions else None,
            items_packed=[
                {"source": p.source, "ref_id": p.ref_id, "tokens": p.tokens}
                for p in packed
            ],
            audit={
                "inject_tokens": used,
                "inject_truncated": truncated,
                "soft_cap": self.soft_cap,
                "hard_cap": self.hard_cap,
            },
        )
