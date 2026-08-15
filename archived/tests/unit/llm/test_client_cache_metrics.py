"""OPT-36 — prompt-cache instrumentation on OpenRouterClient."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from eden.llm import client as client_module
from eden.observability.simple_metrics import reset_for_tests


@pytest.fixture(autouse=True)
def _reset_metrics() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


def _usage_with_cache(
    reads: int = 0,
    writes: int = 0,
    discount: float | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=10,
        total_tokens=110,
        cost=0.05,
        prompt_tokens_details=SimpleNamespace(
            cached_tokens=reads,
            cache_write_tokens=writes,
        ),
        cache_reads=reads,
        cache_writes=writes,
    )


def _mock_openrouter_response(reads: int, writes: int, discount: float | None = None):
    m = MagicMock()
    m.choices = [MagicMock()]
    m.choices[0].message.content = "ok"
    m.choices[0].finish_reason = "stop"
    m.usage = _usage_with_cache(reads, writes, discount)
    if discount is not None:
        m.cache_discount = discount
    return m


class TestPromptCacheMetrics:
    def test_make_request_records_upstream_cache_counters(self):
        c = client_module.OpenRouterClient(api_key="test")
        with patch.object(
            c.client.chat.completions,
            "create",
            return_value=_mock_openrouter_response(120, 30, 0.012),
        ):
            resp = c._make_request("openai/gpt-4o-mini", "hi", None, 100)

        assert resp.usage.cache_reads == 120
        assert resp.usage.cache_writes == 30
        assert c._prompt_cache_reads_tokens == 120
        assert c._prompt_cache_writes_tokens == 30
        assert c._prompt_cache_hits == 1
        assert c._upstream_llm_requests == 1
        assert c._prompt_cache_discount_usd == pytest.approx(0.012)

    def test_get_prompt_cache_stats_derives_hit_rates(self):
        c = client_module.OpenRouterClient(api_key="test")
        c._prompt_cache_reads_tokens = 80
        c._prompt_cache_writes_tokens = 20
        c._prompt_cache_hits = 2
        c._upstream_llm_requests = 4
        c._prompt_cache_discount_usd = 0.05
        c._cache_hits = 3
        c._cache_misses = 1

        with patch.object(client_module, "_get_llm_client", return_value=c):
            stats = client_module.get_prompt_cache_stats()

        assert stats["prompt_cache_reads_tokens"] == 80.0
        assert stats["prompt_cache_writes_tokens"] == 20.0
        assert stats["token_hit_rate"] == pytest.approx(0.8)
        assert stats["request_hit_rate"] == pytest.approx(0.5)
        assert stats["inprocess_cache_hits"] == 3.0
        assert stats["inprocess_cache_misses"] == 1.0

    def test_simple_metrics_exposed_on_metrics_endpoint(self):
        from eden.observability.metrics_endpoint import metrics

        c = client_module.OpenRouterClient(api_key="test")
        usage = client_module.UsageStats(
            cache_reads=50,
            cache_writes=10,
            cache_discount=0.02,
        )
        c._record_prompt_cache_metrics(usage)

        import asyncio

        text = asyncio.run(metrics()).body.decode("utf-8")
        assert "eden_llm_prompt_cache_reads_tokens_total 50.0" in text
        assert "eden_llm_prompt_cache_writes_tokens_total 10.0" in text
        assert "eden_llm_prompt_cache_hits_total 1.0" in text
        assert "eden_llm_prompt_cache_discount_usd_total 0.02" in text

    def test_inprocess_cache_hit_increments_miss_and_hit_counters(self, monkeypatch):
        monkeypatch.setenv("EDEN_LLM_INPROCESS_CACHE", "1")
        c = client_module.OpenRouterClient(api_key="test")
        c._in_process_cache_enabled = True
        c._in_process_cache.clear()
        c._cache_hits = 0
        c._cache_misses = 0

        assert c._cache_get("missing") is None
        assert c._cache_misses == 1

        resp = client_module.LLMResponse(
            content="cached",
            usage=client_module.UsageStats(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            model="m",
            finish_reason="stop",
        )
        c._cache_put("k", resp)
        assert c._cache_get("k") is resp
        assert c._cache_hits == 1

        import asyncio

        text = asyncio.run(
            __import__(
                "eden.observability.metrics_endpoint", fromlist=["metrics"]
            ).metrics()
        ).body.decode("utf-8")
        assert "eden_llm_inprocess_cache_misses_total 1.0" in text
        assert "eden_llm_inprocess_cache_hits_total 1.0" in text

    def test_log_usage_threads_cache_fields_to_cost_ledger(self):
        from eden.llmops.cost_ledger import cost_context

        c = client_module.OpenRouterClient(api_key="test")
        resp = client_module.LLMResponse(
            content="ok",
            usage=client_module.UsageStats(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
                cost=0.01,
                cache_reads=40,
                cache_writes=5,
                cache_discount=0.003,
            ),
            model="openai/gpt-4o",
            finish_reason="stop",
        )

        with patch(
            "eden.llmops.cost_ledger.schedule_record_from_usage"
        ) as schedule:
            with cost_context(org_id="org-1", feature="patches"):
                c._log_usage(resp)

        schedule.assert_called_once()
        kwargs = schedule.call_args.kwargs
        assert kwargs["cache_reads"] == 40
        assert kwargs["cache_writes"] == 5
        assert kwargs["cache_discount_usd"] == pytest.approx(0.003)

    @pytest.mark.asyncio
    async def test_schedule_record_from_usage_stores_cache_in_metadata(self):
        import asyncio

        from eden.llmops import cost_ledger as cl

        captured: list = []

        async def capture(event):
            captured.append(event)

        def schedule_task(coro, name=None, **kwargs):
            return asyncio.create_task(coro)

        with patch.object(cl, "_safe_record", capture):
            with patch("eden.async_tasks.bounded_create_task", schedule_task):
                with cl.cost_context(org_id="org-42", feature="patches"):
                    cl.schedule_record_from_usage(
                        model="anthropic/claude-sonnet-4",
                        prompt_tokens=100,
                        completion_tokens=20,
                        total_tokens=120,
                        cost_usd=0.1,
                        cache_reads=90,
                        cache_writes=10,
                        cache_discount_usd=0.015,
                    )
                await asyncio.sleep(0)

        assert len(captured) == 1
        meta = captured[0].metadata
        assert meta["cache_reads"] == 90
        assert meta["cache_writes"] == 10
        assert meta["cache_discount_usd"] == pytest.approx(0.015)
