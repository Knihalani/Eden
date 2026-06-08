"""Unit tests for the AIGateway filter integration.

These tests lock in the contract for the refactored gateway:
- ``register_filter`` / ``unregister_filter`` API
- ``set_filter_enabled`` for runtime toggles
- ``complete()`` still scrubs PII (back-compat with the pre-refactor inline call)
- filter metrics surface via ``get_filter_metrics()``
"""

import asyncio
import pytest

from eden.llmops.ai_gateway import AIGateway, ModelRequest, Provider, ProviderUnavailable
from eden.llmops.filters import PIIFilter, PIIFilterConfig


def _req(prompt: str, **kw) -> ModelRequest:
    return ModelRequest(
        model_family="claude",
        model_version="claude-sonnet-4",
        prompt=prompt,
        tenant_id="tenant-test",
        **kw,
    )


class _MockProvider:
    """Bare-bones async client that returns a canned response."""

    async def complete(self, *, model, prompt, temperature, max_tokens):
        return {
            "text": f"echo:{prompt[:40]}",
            "input_tokens": 10,
            "output_tokens": 5,
        }


@pytest.mark.asyncio
async def test_complete_scrubs_pii_by_default():
    """Pre-refactor behavior: the gateway scrubs PII from every request."""
    g = AIGateway()
    g.register_provider(Provider.OPENROUTER, _MockProvider())

    req = _req("send to foo@bar.com please")
    resp = await g.complete(req)
    # The mock provider echoes back the prompt; it should NOT contain
    # the email.
    assert "foo@bar.com" not in resp.text


@pytest.mark.asyncio
async def test_complete_respects_pii_opt_out():
    g = AIGateway()
    g.register_provider(Provider.OPENROUTER, _MockProvider())
    req = _req("send to foo@bar.com please", pii_filter_enabled=False)
    resp = await g.complete(req)
    # Opt-out: the email is passed through to the provider and echoed back.
    assert "foo@bar.com" in resp.text


@pytest.mark.asyncio
async def test_set_filter_enabled_disables_pii_at_runtime():
    g = AIGateway()
    g.register_provider(Provider.OPENROUTER, _MockProvider())
    g.set_filter_enabled("pii", False)
    req = _req("email: foo@bar.com")
    resp = await g.complete(req)
    assert "foo@bar.com" in resp.text
    # And toggle back on
    g.set_filter_enabled("pii", True)
    req2 = _req("email: bar@baz.com")
    resp2 = await g.complete(req2)
    assert "bar@baz.com" not in resp2.text


def test_register_unregister_filter():
    g = AIGateway()
    initial = g.get_filter_metrics()["filter_names"]
    assert "pii" in initial

    # Add a custom filter
    class Stamp:
        name = "stamp"
        def enabled(self, request):
            return True
        def apply(self, request):
            request.prompt = "[STAMPED] " + request.prompt
            return request, ["stamped"]

    g.register_filter(Stamp())
    assert "stamp" in g.get_filter_metrics()["filter_names"]

    # Remove it
    removed = g.unregister_filter("stamp")
    assert removed == 1
    assert "stamp" not in g.get_filter_metrics()["filter_names"]


@pytest.mark.asyncio
async def test_custom_filter_sees_request_after_pii():
    g = AIGateway()
    g.register_provider(Provider.OPENROUTER, _MockProvider())

    class AfterPII:
        name = "after-pii"
        def enabled(self, request):
            return True
        def apply(self, request):
            # The PII filter should have already scrubbed foo@bar.com
            assert "foo@bar.com" not in request.prompt
            return request, ["after-pii-saw-scrubbed"]

    g.register_filter(AfterPII())
    req = _req("ping foo@bar.com")
    await g.complete(req)
    metrics = g.get_filter_metrics()
    assert metrics["invocations"] >= 2  # pii + after-pii
