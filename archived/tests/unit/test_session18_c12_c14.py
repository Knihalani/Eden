"""Session 18 tests — Cache async + PII + SDK PII (C-12/13/14).

Three audit items:

* **C-12** — ``SemanticCache._get_embedding`` previously called
  the SYNC ``openai.OpenAI`` client's ``embeddings.create``
  inside an ``async def`` method. The blocking call held the
  event loop for ~80ms per cache lookup, making the cache hit
  path a bottleneck under load. Fix: switch to
  ``openai.AsyncOpenAI`` + ``await`` so the loop releases.

* **C-13** — ``llmops/filters/pii.py:75-82`` iterates over
  ``PIIMasker.PATTERNS`` and substitutes matches with
  ``[<TYPE>_<TOKEN>]``. Verified wired.

* **C-14** — ``sdk/streaming.py:50-62`` ``mask_pii`` is a SYNC
  function (correct — the SDK is sync) called from the SDK
  capture path on every token in ``capture_mode="full"``.
  Verified wired.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ─── C-12: SemanticCache uses AsyncOpenAI ─────────────────────────


class _AsyncEmbeddingsAPI:
    """Stub for the AsyncOpenAI ``embeddings.create`` coroutine."""

    def __init__(self, vector: list[float] | None = None) -> None:
        self._vector = vector or [0.0] * 1536
        self.calls = 0

    async def create(self, *, model: str, input: str) -> Any:
        self.calls += 1
        # Cheap vector distinct per input so the test can prove
        # the request reached the underlying client.
        return MagicMock(
            data=[MagicMock(embedding=[hash(input) % 7 / 100.0] * 1536)],
        )


class _AsyncEmbeddingsClient:
    """Stub for the AsyncOpenAI client. Only ``embeddings`` attr
    is exercised; ``chat.completions`` etc. are unused here."""

    def __init__(self) -> None:
        self.embeddings = _AsyncEmbeddingsAPI()


class TestC12CacheAsyncEmbedding:
    """The cache lookup must release the event loop while it
    fetches an embedding. Verified by:

    1. The client used is ``AsyncOpenAI``, not the sync ``OpenAI``.
    2. The ``create`` call is awaited (not a blocking sync call).
    """

    def test_uses_async_openai(self) -> None:
        """The cache wires ``AsyncOpenAI`` so the loop releases
        while the embedding is fetched."""
        from eden.optimization.cache import SemanticCache

        cache = SemanticCache()

        async_client = _AsyncEmbeddingsClient()
        with patch(
            "openai.AsyncOpenAI",
            return_value=async_client,
        ) as mock_async_openai:
            asyncio.run(cache._get_embedding("hello world"))

        mock_async_openai.assert_called_once(), (
            "C-12 regression: cache didn't instantiate AsyncOpenAI"
        )

    def test_embedding_create_is_awaited(self) -> None:
        """``create`` is awaited — if it were sync, the test would
        return a coroutine that was never awaited and the assertion
        on ``calls`` would stay at 0."""
        from eden.optimization.cache import SemanticCache

        cache = SemanticCache()
        async_client = _AsyncEmbeddingsClient()

        async def _go() -> Any:
            # Reset the mock and inject via the cache's lazy init.
            cache._embed_client = async_client
            return await cache._get_embedding("hi")

        result = asyncio.run(_go())

        assert async_client.embeddings.calls == 1, (
            f"C-12 regression: embed create wasn't awaited; "
            f"calls={async_client.embeddings.calls}"
        )
        assert len(result) == 1536, (
            f"C-12 regression: wrong embedding length: {len(result)}"
        )

    def test_get_embedding_does_not_block_loop(self) -> None:
        """If the underlying ``create`` were sync and called
        inside ``async def`` without ``await``, the loop would be
        blocked for the duration of the call. We prove the loop
        is released by scheduling a sibling coroutine that runs
        during the embedding fetch."""
        from eden.optimization.cache import SemanticCache

        cache = SemanticCache()
        side_ran = False

        async def _slow_create(**kwargs: Any) -> Any:
            # Yield to the loop 5 times during a sync-ish workload.
            for _ in range(5):
                await asyncio.sleep(0.01)
            return MagicMock(
                data=[MagicMock(embedding=[0.1] * 1536)],
            )

        async def _sibling() -> None:
            nonlocal side_ran
            await asyncio.sleep(0.005)
            side_ran = True

        async def _go() -> None:
            client = MagicMock()
            client.embeddings.create = _slow_create
            cache._embed_client = client
            await asyncio.gather(
                cache._get_embedding("hi"),
                _sibling(),
            )

        t0 = time.monotonic()
        asyncio.run(_go())
        elapsed = time.monotonic() - t0

        # The sibling must have run DURING the embedding fetch,
        # proving the loop wasn't blocked. Total wall-clock should
        # be ~50ms (5×10ms sleeps overlapping with the sibling).
        assert side_ran, (
            "C-12 regression: sibling coroutine never ran — "
            "loop was blocked"
        )
        # If blocked, total would be ~50ms + side_run serialized.
        # With proper await, they overlap to ~50ms.
        assert elapsed < 0.10, (
            f"C-12 regression: embedding fetch blocked the loop: "
            f"{elapsed:.3f}s"
        )

    def test_falls_back_to_random_vector_on_error(self) -> None:
        """If ``embeddings.create`` raises (network blip, 429,
        invalid key), the cache falls back to a deterministic
        random vector so the lookup doesn't crash the call path."""
        from eden.optimization.cache import SemanticCache

        cache = SemanticCache()

        class _BadClient:
            embeddings = MagicMock()
            embeddings.create = AsyncMock(
                side_effect=RuntimeError("upstream timeout"),
            )

        async def _go() -> Any:
            cache._embed_client = _BadClient()
            return await cache._get_embedding("hi")

        result = asyncio.run(_go())

        assert len(result) == cache.VECTOR_SIZE, (
            f"C-12 regression: fallback vector wrong length: "
            f"{len(result)} vs {cache.VECTOR_SIZE}"
        )


# ─── C-13: PII filter masks with [<TYPE>_<TOKEN>] ────────────────


class TestC13PiiFilterMask:
    """The ``LLMPIIFilter`` in
    ``src/eden/llmops/filters/pii.py`` substitutes PII matches
    with ``[<TYPE>_<mask_token>]`` via
    ``PIIMasker.PATTERNS``.
    """

    def test_email_is_masked(self) -> None:
        from eden.data_platform.pii import PIIMasker

        text = "ping me at jane.doe@example.com today"
        masked = PIIMasker.PATTERNS["email"].sub(
            "[EMAIL_REDACTED]", text,
        )
        assert "jane.doe@example.com" not in masked, (
            f"C-13 regression: email not masked: {masked!r}"
        )
        assert "[EMAIL_REDACTED]" in masked, (
            f"C-13 regression: substitution marker missing: {masked!r}"
        )

    def test_phone_is_masked(self) -> None:
        from eden.data_platform.pii import PIIMasker

        text = "call 555-867-5309 for details"
        masked = PIIMasker.PATTERNS["phone"].sub(
            "[PHONE_REDACTED]", text,
        )
        assert "555-867-5309" not in masked
        assert "[PHONE_REDACTED]" in masked

    def test_jwt_is_masked(self) -> None:
        from eden.data_platform.pii import PIIMasker

        text = "token=eyJabc123def456ghi789jkl012mno.pqr345stu678vwx901yza234bcd567efg890.hij123klm456nop789qrs012tuv345wxy678"
        masked = PIIMasker.PATTERNS["jwt"].sub(
            "[JWT_REDACTED]", text,
        )
        assert "eyJabc" not in masked, (
            f"C-13 regression: JWT not masked: {masked!r}"
        )

    def test_aws_secret_is_masked(self) -> None:
        from eden.data_platform.pii import PIIMasker

        text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
        masked = PIIMasker.PATTERNS["aws_secret"].sub(
            "[AWS_SECRET_REDACTED]", text,
        )
        assert "AKIAIOSFODNN7EXAMPLE" not in masked

    def test_filter_pipeline_substitutes_known_patterns(self) -> None:
        """End-to-end: build a PIIFilter request, run through
        ``apply``, verify the prompt is rewritten + a finding is
        returned."""
        from eden.llmops.filters.pii import PIIFilter, PIIFilterConfig

        cfg = PIIFilterConfig(enabled=True)
        # Use the explicit patterns path (the ``else`` branch).
        cfg.enabled_patterns = ["email", "phone"]
        f = PIIFilter(cfg)

        class _Req:
            prompt = "ping jane@example.com or 555-867-5309 today"
            tenant_id = "org-x"

        req = _Req()
        result_req, findings = f.apply(req)  # type: ignore[arg-type]

        assert "jane@example.com" not in result_req.prompt, (
            f"C-13 regression: email survived the filter: "
            f"{result_req.prompt!r}"
        )
        assert "555-867-5309" not in result_req.prompt, (
            f"C-13 regression: phone survived the filter: "
            f"{result_req.prompt!r}"
        )
        assert findings, (
            f"C-13 regression: no findings returned: {findings!r}"
        )


# ─── C-14: SDK PII is sync + wired on every capture ──────────────


class TestC14SdkPiiSync:
    """``sdk.streaming.mask_pii`` is a SYNC function (correct — the
    SDK is sync) and runs on every token captured in
    ``capture_mode="full"``.
    """

    def test_mask_pii_is_sync(self) -> None:
        """``inspect.iscoroutinefunction`` must be False — a sync
        caller can't ``await`` it, and an async wrapper would
        block the SDK call path."""
        import inspect

        from eden.sdk.streaming import mask_pii

        assert not inspect.iscoroutinefunction(mask_pii), (
            "C-14 regression: mask_pii became async — SDK call "
            "sites would break"
        )

    def test_mask_pii_redacts_email(self) -> None:
        from eden.sdk.streaming import mask_pii

        masked, was = mask_pii("ping me at jane@example.com today")
        assert was is True
        assert "jane@example.com" not in masked
        assert "[REDACTED:email]" in masked

    def test_mask_pii_redacts_phone(self) -> None:
        from eden.sdk.streaming import mask_pii

        masked, was = mask_pii("call 555-867-5309")
        assert was is True
        assert "555-867-5309" not in masked
        assert "[REDACTED:phone]" in masked

    def test_mask_pii_no_match_returns_original(self) -> None:
        """A clean string round-trips unchanged."""
        from eden.sdk.streaming import mask_pii

        text = "just a normal sentence with no pii anywhere"
        masked, was = mask_pii(text)
        assert masked == text
        assert was is False

    def test_mask_pii_handles_multiple_types_in_one_string(self) -> None:
        """Two PII types in the same string → both redacted."""
        from eden.sdk.streaming import mask_pii

        text = "email jane@example.com or phone 555-867-5309"
        masked, was = mask_pii(text)
        assert was is True
        assert "jane@example.com" not in masked
        assert "555-867-5309" not in masked
        assert "[REDACTED:email]" in masked
        assert "[REDACTED:phone]" in masked

    def test_capture_full_mode_calls_mask_pii(self) -> None:
        """The capture helper runs mask_pii when
        ``capture_mode == "full"``."""
        from eden.sdk.streaming import capture_byte_count

        result = capture_byte_count(
            text="ping jane@example.com",
            span_id="sp-1",
            trace_id="tr-1",
            org_id="org-1",
            capture_mode="full",
            last_token_at_ms=None,
        )
        # token_text is the masked string in full mode.
        token_text = result.get("token_text")
        assert token_text is not None, (
            "C-14 regression: full mode dropped token_text"
        )
        assert "jane@example.com" not in token_text, (
            f"C-14 regression: PII not masked in capture path: "
            f"{token_text!r}"
        )

    def test_capture_byte_count_mode_skips_mask(self) -> None:
        """``capture_mode == "byte_count_only"`` skips mask_pii
        (it's expensive on long strings)."""
        from eden.sdk.streaming import capture_byte_count

        result = capture_byte_count(
            text="ping jane@example.com",
            span_id="sp-1",
            trace_id="tr-1",
            org_id="org-1",
            capture_mode="byte_count_only",
            last_token_at_ms=None,
        )
        # token_text is None — we only count bytes.
        assert result.get("token_text") is None
        assert result.get("token_byte_len") == len(
            b"ping jane@example.com",
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
