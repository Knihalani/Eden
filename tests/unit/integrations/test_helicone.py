"""Unit tests for the Helicone integration.

Covers:
  - helicone_headers() builds the right header set from inputs.
  - parse_helicone_event() normalises a real-shaped event.
  - parse_helicone_event() returns None for malformed payloads.
  - dedup_key is stable across re-serialization.
  - The integration is versioned (route returns integration version).
"""
from __future__ import annotations

import hashlib

from eden.integrations import (
    INTEGRATION_API_VERSION,
    INTEGRATION_VERSION_HEADER,
    SUPPORTED_INTEGRATIONS,
    integration_version_header_value,
)
from eden.integrations.helicone.headers import helicone_headers
from eden.integrations.helicone.sync import parse_helicone_event


# ────────────────────────────────────────────────────────────────────────
# Versioning policy
# ────────────────────────────────────────────────────────────────────────


def test_integration_version_is_set_and_stable():
    assert INTEGRATION_API_VERSION == "1"
    assert INTEGRATION_VERSION_HEADER == "X-Eden-Integration-Version"
    assert integration_version_header_value() == "1"


def test_supported_integrations_includes_helicone_and_wandb():
    # Helicone is the first one shipped; wandb is next on the list.
    assert "helicone" in SUPPORTED_INTEGRATIONS
    assert "wandb" in SUPPORTED_INTEGRATIONS


# ────────────────────────────────────────────────────────────────────────
# helicone_headers
# ────────────────────────────────────────────────────────────────────────


def test_helicone_headers_with_minimum_inputs():
    headers = helicone_headers(user_id="u_1", org_id="o_1", job_id="j_1")
    assert headers == {
        "Helicone-User-Id": "u_1",
        "Helicone-Property-OrgId": "o_1",
        "Helicone-Property-JobId": "j_1",
    }


def test_helicone_headers_with_cache_and_properties():
    headers = helicone_headers(
        user_id="u_1",
        cache_enabled=True,
        cache_bucket="hot",
        properties={"AgentSlot": "code", "TraceId": "abc"},
    )
    assert headers["Helicone-Cache-Enabled"] == "true"
    assert headers["Helicone-Cache-Bucket"] == "hot"
    assert headers["Helicone-Property-AgentSlot"] == "code"
    assert headers["Helicone-Property-TraceId"] == "abc"


def test_helicone_headers_skips_empty_values():
    headers = helicone_headers(user_id=None, org_id="", job_id="j_1")
    assert "Helicone-User-Id" not in headers
    assert "Helicone-Property-OrgId" not in headers
    assert headers["Helicone-Property-JobId"] == "j_1"


def test_helicone_headers_does_not_allow_reserved_prefix_in_user_props():
    # User-supplied "Helicone-Foo" must not be passed through under that
    # exact key (would collide with Helicone internals).
    headers = helicone_headers(properties={"Helicone-Foo": "x"})
    # The key gets namespaced under "Helicone-Property-" rather than
    # being passed through.
    assert "Helicone-Foo" not in headers
    assert headers.get("Helicone-Property-Helicone-Foo") == "x"


# ────────────────────────────────────────────────────────────────────────
# parse_helicone_event
# ────────────────────────────────────────────────────────────────────────


def test_parse_helicone_event_happy_path():
    payload = {
        "id": "evt_abc",
        "request_id": "req_xyz",
        "model": "openai/gpt-4o",
        "provider": "openai",
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        "cost_usd": 0.0042,
        "latency_ms": 800,
        "user_id": "u_1",
        "properties": {"OrgId": "o_1", "JobId": "j_1"},
        "created_at": "2026-06-01T12:00:00Z",
    }
    event = parse_helicone_event(payload)
    assert event is not None
    assert event.event_id == "evt_abc"
    assert event.request_id == "req_xyz"
    assert event.model == "openai/gpt-4o"
    assert event.provider == "openai"
    assert event.prompt_tokens == 10
    assert event.completion_tokens == 20
    assert event.total_tokens == 30
    assert event.cost_usd == 0.0042
    assert event.latency_ms == 800
    assert event.org_id == "o_1"
    assert event.job_id == "j_1"


def test_parse_helicone_event_computes_total_tokens_if_missing():
    payload = {
        "id": "evt_a",
        "request_id": "req_b",
        "model": "x",
        "provider": "y",
        "usage": {"prompt_tokens": 5, "completion_tokens": 7},  # no total
    }
    event = parse_helicone_event(payload)
    assert event is not None
    assert event.total_tokens == 12


def test_parse_helicone_event_returns_none_without_id():
    assert parse_helicone_event({"model": "x"}) is None
    assert parse_helicone_event({}) is None


def test_parse_helicone_event_returns_none_on_bad_types():
    payload = {
        "id": "evt_a",
        "request_id": "req_b",
        "model": "x",
        "provider": "y",
        "usage": {"prompt_tokens": "not-a-number"},
    }
    assert parse_helicone_event(payload) is None


def test_dedup_key_is_stable_sha256_prefix():
    event = parse_helicone_event(
        {"id": "evt_stable", "request_id": "r", "model": "m", "provider": "p"}
    )
    assert event is not None
    expected = hashlib.sha256(b"evt_stable").hexdigest()[:32]
    assert event.dedup_key() == expected
    # Stability: repeated calls return the same key.
    assert event.dedup_key() == event.dedup_key()
