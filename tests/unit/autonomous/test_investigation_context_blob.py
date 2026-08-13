"""Unit tests for context_blob truncation in InvestigationAgent.

OOM-IMPROVEMENT-PLAN-2026-08-12 §7.3 / W1-7 (L10): large-incident JSON
context was injected into the LLM prompt without a size cap, causing a 33×
token spike.  The fix truncates the raw JSON string to _CONTEXT_BLOB_MAX_CHARS
(8 000 chars) before wrapping it with wrap_untrusted_data, and appends a
'…[truncated N chars]' marker so the model is aware content was cut.

Covered scenarios
-----------------
1. Oversized blob: prompt contains ≤ 8 000 chars of raw context + the marker.
2. Small blob: prompt content passes through unchanged.
3. Exactly-at-limit blob: treated as small (no truncation).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

import eden.autonomous.investigation as inv_mod
from eden.autonomous.investigation import InvestigationAgent, _CONTEXT_BLOB_MAX_CHARS

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ORG_ID = "org_test_blob"
# Must use a valid prefix from KNOWN_TRIGGER_TYPES (e.g. "incident")
_TRIGGER = "incident:test-001"


def _make_large_context(n_chars: int = 20_000) -> dict[str, Any]:
    """Return a dict whose JSON serialisation is at least *n_chars* long."""
    value = "x" * n_chars
    return {"big_key": value}


def _make_small_context() -> dict[str, Any]:
    return {"service": "api", "error_rate": 0.05}


def _captured_prompt(context_dict: dict[str, Any]) -> str:
    """Run InvestigationAgent.investigate with the given context and return
    the prompt string that was passed to the (mocked) LLM.

    We intercept *_call_llm* so no real network call is made.
    """
    captured: list[str] = []

    async def _fake_call_llm(prompt: str, **kwargs: Any) -> str:
        captured.append(prompt)
        # Return a minimal valid LLM payload so the agent doesn't error out.
        return json.dumps(
            {
                "findings": [{"type": "rca", "summary": "ok", "confidence": 0.9}],
                "proposed_remediations": [
                    {
                        "action": "noop",
                        "blast_radius": "none",
                        "estimated_recovery_time_minutes": 0,
                    }
                ],
            }
        )

    fake_ctx = {"context": context_dict}

    async def _run() -> None:
        with (
            patch.object(inv_mod, "_resolve_trigger_context", new=AsyncMock(return_value=fake_ctx)),
            patch.object(inv_mod, "_call_llm", new=_fake_call_llm),
            patch.object(inv_mod, "_upsert_investigation", new=AsyncMock()),
        ):
            agent = InvestigationAgent()
            await agent.investigate(_ORG_ID, trigger=_TRIGGER)

    asyncio.run(_run())
    assert captured, "LLM was never called — mock wiring failed"
    return captured[0]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestContextBlobTruncation:
    """Large context blobs must be capped and marked; small ones pass through."""

    def test_oversized_blob_is_truncated_in_prompt(self) -> None:
        """When the serialised context exceeds 8 000 chars, the prompt must
        contain at most _CONTEXT_BLOB_MAX_CHARS chars of raw context JSON,
        followed by the truncation marker."""
        ctx = _make_large_context(n_chars=20_000)
        prompt = _captured_prompt(ctx)

        # The raw JSON for this context is much larger than the cap.
        raw = json.dumps(ctx, default=str)
        assert len(raw) > _CONTEXT_BLOB_MAX_CHARS, "precondition: raw JSON must be oversized"

        # The prompt must contain the truncation marker.
        assert "…[truncated" in prompt and "chars]" in prompt, (
            "Expected truncation marker '…[truncated N chars]' in prompt"
        )

        # The slice of raw context appearing in the prompt must be ≤ the cap.
        # We check the first _CONTEXT_BLOB_MAX_CHARS chars of the raw JSON
        # appear in the prompt and nothing beyond that.
        expected_prefix = raw[:_CONTEXT_BLOB_MAX_CHARS]
        assert expected_prefix in prompt, (
            "The first _CONTEXT_BLOB_MAX_CHARS chars of the raw JSON must appear in the prompt"
        )
        # The *full* raw JSON (which is > 8 000 chars) must NOT appear verbatim
        # in the prompt — that would mean no truncation occurred.
        assert raw not in prompt, (
            "The full over-limit raw JSON must not appear verbatim in the prompt"
        )

    def test_oversized_blob_marker_contains_correct_excess_count(self) -> None:
        """The truncation marker must report the exact number of chars cut."""
        ctx = _make_large_context(n_chars=20_000)
        prompt = _captured_prompt(ctx)

        raw = json.dumps(ctx, default=str)
        expected_excess = len(raw) - _CONTEXT_BLOB_MAX_CHARS
        assert f"[truncated {expected_excess} chars]" in prompt, (
            f"Expected marker '[truncated {expected_excess} chars]' in prompt"
        )

    def test_small_blob_passes_through_unchanged(self) -> None:
        """When the serialised context is within the limit, the prompt must
        contain the full JSON string without a truncation marker."""
        ctx = _make_small_context()
        prompt = _captured_prompt(ctx)

        raw = json.dumps(ctx, default=str)
        assert len(raw) < _CONTEXT_BLOB_MAX_CHARS, "precondition: small context must be under limit"

        assert raw in prompt, "Full small-context JSON must appear in the prompt unchanged"
        assert "…[truncated" not in prompt, (
            "No truncation marker should appear for a small blob"
        )

    def test_exactly_at_limit_not_truncated(self) -> None:
        """A blob whose serialisation is exactly _CONTEXT_BLOB_MAX_CHARS chars
        must not be truncated."""
        # Build a context whose JSON is exactly _CONTEXT_BLOB_MAX_CHARS chars.
        # We use a simple string value and adjust padding to hit the target.
        target = _CONTEXT_BLOB_MAX_CHARS
        # {"k": "..."} overhead: '{"k": ""}' = 9 chars, so padding = target - 9
        padding = target - len('{"k": ""}')
        ctx = {"k": "x" * padding}
        raw = json.dumps(ctx, default=str)
        assert len(raw) == target, f"precondition failed: len={len(raw)} want {target}"

        prompt = _captured_prompt(ctx)
        assert raw in prompt
        assert "…[truncated" not in prompt
