"""Pinning test for Wave 2.2 — ``prompt_version`` attribute passthrough.

The SDK used to namespaced every non-``eden.*`` attribute under
``eden.span.*``, so ``span.set_attribute("prompt_version", "3")``
shipped as ``eden.span.prompt_version`` — a key the server's
PromotionLoop (which reads ``attributes->>'prompt_version'``) never
sees. Wave 2 maps ``prompt_version`` to the bare key.
"""

from __future__ import annotations

from eden_sdk.trace import _map_attr_key


def test_prompt_version_passes_through():
    assert _map_attr_key("prompt_version") == "prompt_version"


def test_force_trace_still_maps():
    assert _map_attr_key("force_trace") == "eden.force_trace"


def test_eden_namespaced_keys_unchanged():
    assert _map_attr_key("eden.input") == "eden.input"
    assert _map_attr_key("eden.args") == "eden.args"


def test_other_user_keys_stay_namespaced():
    assert _map_attr_key("temperature") == "eden.span.temperature"
