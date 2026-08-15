"""Unit tests for the PII filter (PIIFilter + PIIFilterConfig).

Locks in:
- email/phone/SSN masking behavior matches the pre-registry inline call
- per-request opt-out via ``pii_filter_enabled=False``
- per-filter global enable/disable via PIIFilterConfig
- registry ordering and idempotency
"""

import pytest

from eden.llmops.ai_gateway import ModelRequest
from eden.llmops.filters import PIIFilter, PIIFilterConfig


def _req(prompt: str, **kw) -> ModelRequest:
    return ModelRequest(
        model_family="claude",
        model_version="claude-sonnet-4",
        prompt=prompt,
        tenant_id="tenant-test",
        **kw,
    )


# ────────────────────────────────────────────────────────────────────────
# Masking behavior — must match the pre-registry inline call exactly
# ────────────────────────────────────────────────────────────────────────


def test_pii_filter_masks_email():
    f = PIIFilter()
    original = "Contact me at jane.doe@example.com please"
    req = _req(original)
    out, findings = f.apply(req)
    assert "jane.doe@example.com" not in out.prompt
    assert out.prompt != original  # mutated relative to the original text
    assert findings and findings[0].startswith("pii_masked:")


def test_pii_filter_masks_phone_and_ssn():
    f = PIIFilter()
    req = _req("Call 415-555-1234 or SSN 123-45-6789")
    out, findings = f.apply(req)
    assert "415-555-1234" not in out.prompt
    assert "123-45-6789" not in out.prompt
    assert findings


def test_pii_filter_idempotent():
    """Running the filter twice produces the same result."""
    f = PIIFilter()
    req1 = _req("email: foo@bar.com")
    out1, _ = f.apply(req1)
    out2, _ = f.apply(out1)
    assert out1.prompt == out2.prompt


def test_pii_filter_no_pii_no_findings():
    f = PIIFilter()
    original = "just a normal question about cooking"
    req = _req(original)
    out, findings = f.apply(req)
    assert out.prompt == original
    assert findings == []


# ────────────────────────────────────────────────────────────────────────
# Enable / disable
# ────────────────────────────────────────────────────────────────────────


def test_pii_filter_disabled_per_request():
    """When pii_filter_enabled is False, the filter is skipped by the
    registry (the ``enabled()`` check is the contract — ``apply()`` is
    not a public entry point and can be called directly)."""
    from eden.llmops.filters import FilterRegistry

    f = PIIFilter()
    req = _req("email: foo@bar.com", pii_filter_enabled=False)
    assert f.enabled(req) is False
    # Registry respects enabled() and skips the filter entirely
    reg = FilterRegistry()
    reg.register(f)
    original = req.prompt
    out, findings = reg.run(req)
    assert out.prompt == original
    assert findings == []


def test_pii_filter_default_opt_in():
    """When ``pii_filter_enabled`` is unset, default is True (matches
    the pre-registry ``getattr(request, 'pii_filter_enabled', True)``)."""
    f = PIIFilter()
    req = _req("foo@bar.com")  # no pii_filter_enabled attr
    assert f.enabled(req) is True


def test_pii_filter_globally_disabled():
    cfg = PIIFilterConfig(enabled=False)
    f = PIIFilter(cfg)
    req = _req("email: foo@bar.com")
    assert f.enabled(req) is False


def test_pii_filter_pattern_subset():
    """Custom enabled_patterns restricts which PII types are masked."""
    cfg = PIIFilterConfig(enabled_patterns={"email"})
    f = PIIFilter(cfg)
    req = _req("email: foo@bar.com phone: 415-555-1234")
    out, findings = f.apply(req)
    assert "foo@bar.com" not in out.prompt
    # phone NOT masked because not in enabled_patterns
    assert "415-555-1234" in out.prompt
    assert "email" in findings[0]


# ────────────────────────────────────────────────────────────────────────
# Registry
# ────────────────────────────────────────────────────────────────────────


def test_registry_runs_in_registration_order():
    """A second filter sees the request as mutated by the first."""
    from eden.llmops.filters import FilterRegistry

    order: list[str] = []

    class Marker:
        name = "marker"
        def enabled(self, request):
            return True
        def apply(self, request):
            order.append("marker")
            return request, ["m"]

    class After:
        name = "after"
        def enabled(self, request):
            return True
        def apply(self, request):
            order.append("after")
            return request, ["a"]

    reg = FilterRegistry()
    reg.register(Marker())
    reg.register(After())
    req = _req("hello")
    reg.run(req)
    assert order == ["marker", "after"]


def test_registry_fail_open_on_filter_exception():
    """If a filter raises, the request passes through (fail-open default)."""
    from eden.llmops.filters import FilterRegistry

    class Boom:
        name = "boom"
        def enabled(self, request):
            return True
        def apply(self, request):
            raise RuntimeError("kaboom")

    class After:
        name = "after"
        def enabled(self, request):
            return True
        def apply(self, request):
            return request, ["after-ran"]

    reg = FilterRegistry()
    reg.register(Boom())
    reg.register(After())
    req = _req("hello")
    out, findings = reg.run(req)
    assert reg.errors == 1
    assert "after-ran" in findings


def test_registry_fail_closed_propagates():
    from eden.llmops.filters import FilterRegistry

    class Boom:
        name = "boom"
        def enabled(self, request):
            return True
        def apply(self, request):
            raise RuntimeError("kaboom")

    reg = FilterRegistry(fail_open=False)
    reg.register(Boom())
    req = _req("hello")
    with pytest.raises(RuntimeError):
        reg.run(req)
