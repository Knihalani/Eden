"""Unit tests for the AIGateway filter integration.

These tests lock in the contract for the refactored gateway:
- ``register_filter`` / ``unregister_filter`` API
- ``set_filter_enabled`` for runtime toggles
- Filter chain scrubs PII (back-compat with the pre-refactor inline call)
- filter metrics surface via ``get_filter_metrics()``
"""

import pytest

from eden.llmops.ai_gateway import AIGateway, ModelRequest
from eden.llmops.filters import PIIFilter, PIIFilterConfig


def _req(prompt: str, **kw) -> ModelRequest:
    return ModelRequest(
        model_family="claude",
        model_version="claude-sonnet-4",
        prompt=prompt,
        tenant_id="tenant-test",
        **kw,
    )


def test_filters_scrub_pii_by_default():
    """Pre-refactor behavior: the gateway scrubs PII from every request."""
    g = AIGateway()
    req = _req("send to foo@bar.com please")
    filtered, _ = g._filters.run(req)
    assert "foo@bar.com" not in filtered.prompt


def test_filters_respect_pii_opt_out():
    g = AIGateway()
    req = _req("send to foo@bar.com please", pii_filter_enabled=False)
    filtered, _ = g._filters.run(req)
    assert "foo@bar.com" in filtered.prompt


def test_set_filter_enabled_disables_pii_at_runtime():
    g = AIGateway()
    g.set_filter_enabled("pii", False)
    req = _req("email: foo@bar.com")
    filtered, _ = g._filters.run(req)
    assert "foo@bar.com" in filtered.prompt
    g.set_filter_enabled("pii", True)
    req2 = _req("email: bar@baz.com")
    filtered2, _ = g._filters.run(req2)
    assert "bar@baz.com" not in filtered2.prompt


def test_register_unregister_filter():
    g = AIGateway()
    initial = g.get_filter_metrics()["filter_names"]
    assert "pii" in initial

    class Stamp:
        name = "stamp"

        def enabled(self, request):
            return True

        def apply(self, request):
            request.prompt = "[STAMPED] " + request.prompt
            return request, ["stamped"]

    g.register_filter(Stamp())
    assert "stamp" in g.get_filter_metrics()["filter_names"]

    removed = g.unregister_filter("stamp")
    assert removed == 1
    assert "stamp" not in g.get_filter_metrics()["filter_names"]


def test_custom_filter_sees_request_after_pii():
    g = AIGateway()

    class AfterPII:
        name = "after-pii"

        def enabled(self, request):
            return True

        def apply(self, request):
            assert "foo@bar.com" not in request.prompt
            return request, ["after-pii-saw-scrubbed"]

    g.register_filter(AfterPII())
    req = _req("ping foo@bar.com")
    g._filters.run(req)
    metrics = g.get_filter_metrics()
    assert metrics["invocations"] >= 2  # pii + after-pii
