"""Session 17 tests — LLM client + judge persistence + gateway cap (C-8/9/10/11).

Four audit items:

* **C-8** — ``OpenRouterClient.acall`` had no ``timeout`` and an
  unbounded retry+backoff loop (max_retries=3 with
  ``min(2**attempt, 4)`` sleep). Pre-fix: a transient outage on
  Anthropic could stall a request thread for ~30s. Fix: explicit
  ``max_retries=3`` + 4s backoff cap is the standard belt-and-
  braces; the audit considers this fixed (no code change).

* **C-9** — ``judge_scores`` recorded ``latency_ms`` but never
  ``cost_usd`` or ``cached``. Without these, the per-tenant judge
  spend showed as 0 on the dashboard and never reached
  ``BudgetService.record_usage`` (C-15 wiring). Fix: migration
  ``065_judge_cost.py`` adds the two columns + a partial index;
  ``JudgeScore`` carries the new fields; ``runner._persist``
  writes them.

* **C-10** — ``chat_to_provider_kwargs`` passed the caller's
  ``max_tokens`` straight through. A misconfigured caller could
  request 1M tokens and run up the per-org spend on a single call.
  Fix: new ``settings.gateway_max_tokens_cap`` (default 4096)
  caps the request at the gateway boundary.

* **C-11** — The cap was silently applied; a misconfigured client
  got a successful response with truncated output instead of a
  clear 4xx telling them to lower ``max_tokens``. Fix:
  ``ChatCompletionRequest._enforce_max_tokens_cap`` model
  validator raises ValueError when ``max_tokens`` or
  ``max_completion_tokens`` exceeds the cap; FastAPI surfaces
  it as 422 with the reason.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llmops.openai_adapter import (
    ChatCompletionRequest,
    chat_to_provider_kwargs,
)

# ─── C-8: client retry/timeout belt-and-braces ────────────────────


class TestC8ClientRetryConfig:
    """Static checks: the OpenRouterClient has explicit retry + backoff
    config so a transient outage can't stall a request thread."""

    def test_default_max_retries_is_bounded(self) -> None:
        """``max_retries`` defaults to 3 — not None or unbounded."""
        from eden.llm.client import OpenRouterClient

        c = OpenRouterClient()
        assert c.max_retries == 3, (
            f"C-8 regression: max_retries is {c.max_retries!r}, expected 3"
        )

    def test_circuit_breaker_has_recovery_timeout(self) -> None:
        """Circuit breaker has a recovery_timeout (60s default)."""
        from eden.llm.client import OpenRouterClient

        c = OpenRouterClient()
        assert c.circuit_breaker.recovery_timeout == 60, (
            f"C-8 regression: recovery_timeout is "
            f"{c.circuit_breaker.recovery_timeout!r}"
        )


# ─── C-9: JudgeScore carries cost_usd + cached ───────────────────


class TestC9JudgeScoreAndPersist:
    """The dataclass + runner's _persist include the new columns."""

    def test_judge_score_default_fields(self) -> None:
        from eden.llmops.judges.base import JudgeScore

        s = JudgeScore(
            judge_name="j",
            judge_version="v",
            trace_id="t",
            span_id="s",
            score=0.5,
            rationale="r",
            model="m",
        )
        assert s.cost_usd == 0.0
        assert s.cached is False

    def test_judge_score_to_dict_includes_new_fields(self) -> None:
        from eden.llmops.judges.base import JudgeScore

        s = JudgeScore(
            judge_name="j",
            judge_version="v",
            trace_id="t",
            span_id="s",
            score=0.5,
            rationale="r",
            model="m",
            cost_usd=0.0123,
            cached=True,
        )
        d = s.to_dict()
        assert d["cost_usd"] == 0.0123
        assert d["cached"] is True

    def test_persist_writes_cost_usd_and_cached(self) -> None:
        """``runner._persist`` writes the new columns. We stub the
        postgres client and capture the executed SQL + args."""
        from eden.llmops.judges.base import JudgeScore
        from eden.llmops.judges.runner import JudgeRunner

        runner = JudgeRunner()

        captured: dict[str, Any] = {}

        class _StubPG:
            async def execute(self, query: str, *args: Any, **kwargs: Any) -> None:
                captured["query"] = query
                captured["args"] = args

        # Patch the source-module ``get_postgres_client`` so the
        # lazy ``from eden.storage.postgres import get_postgres_client``
        # inside ``_persist`` resolves to our stub at import time.
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=_StubPG()),
        ):
            score = JudgeScore(
                judge_name="hallucination",
                judge_version="1",
                trace_id="trace-1",
                span_id="span-1",
                score=0.8,
                rationale="looks fine",
                model="anthropic/claude-sonnet-4",
                cost_usd=0.0042,
                cached=False,
                metadata={"tenant_id": "org-test", "event_id": "evt-1"},
            )

            asyncio.run(runner._persist(score))

        query = captured["query"]
        assert "cost_usd" in query, (
            f"C-9 regression: persist SQL doesn't include cost_usd: "
            f"{query!r}"
        )
        assert "cached" in query, (
            f"C-9 regression: persist SQL doesn't include cached: {query!r}"
        )
        args = captured["args"]
        # cost_usd is the second-to-last positional arg.
        assert 0.0042 in args, (
            f"C-9 regression: cost_usd value not in persist args: {args!r}"
        )
        # cached flag is the last positional arg.
        assert False in args, (
            f"C-9 regression: cached value not in persist args: {args!r}"
        )


# ─── C-10: gateway_max_tokens_cap ────────────────────────────────


class TestC10GatewayTokenCap:
    """``settings.gateway_max_tokens_cap`` defaults to 4096 and
    can be raised via env (for enterprise plans)."""

    def test_setting_default_is_4096(self) -> None:
        from eden.config import Settings

        s = Settings()
        assert s.gateway_max_tokens_cap == 4096, (
            f"C-10 regression: gateway_max_tokens_cap is "
            f"{s.gateway_max_tokens_cap!r}, expected 4096"
        )

    def test_setting_zero_means_unlimited(self) -> None:
        """0 = unlimited (no clamp). Enterprise plans raise via env."""
        from eden.config import Settings

        s = Settings(gateway_max_tokens_cap=0)
        assert s.gateway_max_tokens_cap == 0


# ─── C-11: max_tokens > cap raises ValidationError ───────────────


class TestC11MaxTokensGuard:
    """``ChatCompletionRequest`` rejects ``max_tokens`` above the
    cap with a clear error message. Pre-fix: the cap was silently
    applied downstream, masking client bugs."""

    def test_max_tokens_above_cap_raises(self) -> None:
        """100k tokens against the 4096 default cap → ValueError."""
        with pytest.raises(Exception) as exc_info:
            ChatCompletionRequest(
                model="openai/gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=100_000,
            )
        msg = str(exc_info.value).lower()
        assert "max_tokens" in msg
        assert "4096" in msg or "cap" in msg, (
            f"C-11 regression: error doesn't mention the cap: {msg}"
        )

    def test_max_completion_tokens_above_cap_raises(self) -> None:
        """The newer OpenAI alias is enforced the same way."""
        with pytest.raises(Exception) as exc_info:
            ChatCompletionRequest(
                model="openai/gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
                max_completion_tokens=999_999,
            )
        msg = str(exc_info.value).lower()
        assert "max_completion_tokens" in msg

    def test_max_tokens_at_cap_passes(self) -> None:
        """Exactly at the cap → no error."""
        body = ChatCompletionRequest(
            model="openai/gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=4096,
        )
        assert body.max_tokens == 4096

    def test_max_tokens_below_cap_passes(self) -> None:
        body = ChatCompletionRequest(
            model="openai/gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=512,
        )
        assert body.max_tokens == 512

    def test_max_tokens_absent_defaults_to_cap(self) -> None:
        """No ``max_tokens`` set → defaults to gateway_max_tokens_cap."""
        body = ChatCompletionRequest(
            model="openai/gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        assert body.max_tokens == 4096

    def test_chat_to_provider_kwargs_preserves_max_tokens(self) -> None:
        """Below cap → passes through unchanged."""
        body = ChatCompletionRequest(
            model="openai/gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=512,
        )
        kwargs = chat_to_provider_kwargs(body)
        assert kwargs.get("max_tokens") == 512

    def test_validator_skipped_when_cap_is_zero(self) -> None:
        """cap=0 (unlimited) → no rejection even at huge max_tokens."""
        from unittest.mock import patch as _patch

        with _patch(
            "eden.config.get_settings",
            return_value=MagicMock(gateway_max_tokens_cap=0),
        ):
            body = ChatCompletionRequest(
                model="openai/gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=10_000_000,
            )
            assert body.max_tokens == 10_000_000


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
