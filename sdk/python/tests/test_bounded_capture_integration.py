"""Integration tests: bounded capture wired into provider instrumentations,
``eden.trace()``'s ``set_input``/``set_output``, and its interaction with
client-side sampling.

Each provider's private ``_enqueue_*`` helper is called directly (bypassing
the SDK-patching machinery in ``test_instrumentations.py``) so these tests
stay focused on one thing: does the enqueued payload carry a truncated (or
full, or dropped) content field plus the right ``eden.truncated`` /
``eden.original_bytes`` / ``eden.capture_mode`` metadata for the active
``capture_mode``.
"""

from __future__ import annotations

from typing import Any

import eden
from eden_sdk.capture import CAPTURE_MODE_ATTR, ORIGINAL_BYTES_ATTR, TRUNCATED_ATTR
from eden_sdk.client import EdenClient, TraceEvent, get_default_client


def _capture_enqueued(monkeypatch) -> list[TraceEvent]:
    """Replace ``EdenClient.enqueue`` so every call is recorded verbatim
    (sampling is bypassed entirely — use this when the test only cares
    about the payload capture built before ``enqueue()`` is reached)."""
    import eden_sdk.client as client_mod

    captured: list[TraceEvent] = []
    monkeypatch.setattr(
        client_mod.EdenClient, "enqueue", lambda self, event, **kw: captured.append(event)
    )
    return captured


def _spy_on_enqueue(client: EdenClient, monkeypatch) -> list[TraceEvent]:
    """Wrap (not replace) ``client.enqueue`` so the real sampling logic
    still runs — use this for the capture+sampling interaction tests."""
    captured: list[TraceEvent] = []
    original = client.enqueue

    def _wrapped(event, **kw):
        captured.append(event)
        return original(event, **kw)

    monkeypatch.setattr(client, "enqueue", _wrapped)
    return captured


LONG_TEXT = "eden-test-content-" * 2000  # ~38 KiB, well over the 8 KiB default


# ── OpenAI ────────────────────────────────────────────────────────────


def test_openai_enqueue_truncates_long_content_and_stamps_metadata(monkeypatch):
    from eden_sdk.instrumentations.openai import _enqueue_openai_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_openai_event(
        request_payload={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={
            "model": "gpt-4o",
            "choices": [{"message": {"role": "assistant", "content": LONG_TEXT}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        },
        duration_ms=42.0,
        error=None,
    )

    assert len(captured) == 1
    payload = captured[0].payload
    assert len(payload["request_payload"]["messages"][0]["content"]) < len(LONG_TEXT)
    assert len(payload["choices"][0]["message"]["content"]) < len(LONG_TEXT)
    attrs = payload["attributes"]
    assert attrs[TRUNCATED_ATTR] == "true"
    assert int(attrs[ORIGINAL_BYTES_ATTR]) > 0
    assert attrs[CAPTURE_MODE_ATTR] == "bounded"
    # Metrics survive truncation untouched.
    assert payload["usage"]["total_tokens"] == 30
    assert payload["model_normalized"]


def test_openai_enqueue_error_keeps_full_content(monkeypatch):
    from eden_sdk.instrumentations.openai import _enqueue_openai_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_openai_event(
        request_payload={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload=None,
        duration_ms=42.0,
        error="RateLimitError: boom",
    )

    payload = captured[0].payload
    assert payload["request_payload"]["messages"][0]["content"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"
    assert payload["error"]["message"] == "RateLimitError: boom"


def test_openai_enqueue_capture_mode_full_bypasses_truncation(monkeypatch):
    from eden_sdk.instrumentations.openai import _enqueue_openai_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="full")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_openai_event(
        request_payload={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={"model": "gpt-4o", "choices": [{"message": {"content": LONG_TEXT}}]},
        duration_ms=42.0,
        error=None,
    )

    payload = captured[0].payload
    assert payload["request_payload"]["messages"][0]["content"] == LONG_TEXT
    assert payload["choices"][0]["message"]["content"] == LONG_TEXT
    assert payload["attributes"][CAPTURE_MODE_ATTR] == "full"


def test_openai_enqueue_metrics_only_drops_content_but_keeps_usage_and_model(monkeypatch):
    """Regression: metrics_only must not silently drop `usage`/`model` for
    openai — those live *inside* response_payload, unlike bedrock/gemini/
    cohere/mistral which extract them independently of captured content."""
    from eden_sdk.instrumentations.openai import _enqueue_openai_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="metrics_only")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_openai_event(
        request_payload={"model": "gpt-4o-2024-08-06", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={
            "model": "gpt-4o-2024-08-06",
            "choices": [{"message": {"role": "assistant", "content": LONG_TEXT}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        },
        duration_ms=42.0,
        error=None,
    )

    payload = captured[0].payload
    assert payload["request_payload"] is None
    assert "choices" not in payload
    # But the metrics survive.
    assert payload["usage"]["total_tokens"] == 30
    assert payload["model"] == "gpt-4o-2024-08-06"
    assert payload["model_normalized"]
    assert payload["attributes"][CAPTURE_MODE_ATTR] == "metrics_only"


# ── Anthropic ─────────────────────────────────────────────────────────


def test_anthropic_enqueue_truncates_and_stamps(monkeypatch):
    from eden_sdk.instrumentations.anthropic import _enqueue_anthropic_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_anthropic_event(
        request_payload={"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={
            "model": "claude-3-5-sonnet-20241022",
            "content": [{"type": "text", "text": LONG_TEXT}],
            "usage": {"input_tokens": 5, "output_tokens": 7},
        },
        duration_ms=10.0,
        error=None,
    )

    payload = captured[0].payload
    assert len(payload["content"][0]["text"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    assert payload["usage"]["output_tokens"] == 7


def test_anthropic_enqueue_metrics_only_keeps_usage_and_model(monkeypatch):
    from eden_sdk.instrumentations.anthropic import _enqueue_anthropic_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="metrics_only")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_anthropic_event(
        request_payload={"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={
            "model": "claude-3-5-sonnet-20241022",
            "content": [{"type": "text", "text": LONG_TEXT}],
            "usage": {"input_tokens": 5, "output_tokens": 7},
        },
        duration_ms=10.0,
        error=None,
    )

    payload = captured[0].payload
    assert "content" not in payload
    assert payload["usage"]["output_tokens"] == 7
    assert payload["model"] == "claude-3-5-sonnet-20241022"


# ── Groq ──────────────────────────────────────────────────────────────


def test_groq_enqueue_truncates_and_stamps(monkeypatch):
    from eden_sdk.instrumentations.groq import _enqueue_groq_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_groq_event(
        request_payload={"model": "llama3-70b-8192", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={
            "model": "llama3-70b-8192",
            "choices": [{"message": {"role": "assistant", "content": LONG_TEXT}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
        },
        duration_ms=5.0,
        error=None,
    )

    payload = captured[0].payload
    assert len(payload["choices"][0]["message"]["content"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    assert payload["input_tokens"] == 3
    assert payload["output_tokens"] == 4


def test_groq_enqueue_metrics_only_keeps_usage_model_and_tool_calls(monkeypatch):
    """Regression: groq flattens usage/tool_calls out of response_payload
    the same way openai does, so it needs the same metrics_only fix."""
    from eden_sdk.instrumentations.groq import _enqueue_groq_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="metrics_only")
    captured = _capture_enqueued(monkeypatch)

    _enqueue_groq_event(
        request_payload={"model": "llama3-70b-8192", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={
            "model": "llama3-70b-8192",
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{}"}}
                        ],
                    }
                }
            ],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
        },
        duration_ms=5.0,
        error=None,
    )

    payload = captured[0].payload
    assert "choices" not in payload
    assert payload["input_tokens"] == 3
    assert payload["output_tokens"] == 4
    assert payload["model"] == "llama3-70b-8192"
    assert payload.get("tool_call_count") == 1
    assert payload.get("tool_names") == ["get_weather"]


# ── Cohere ────────────────────────────────────────────────────────────


def test_cohere_enqueue_truncates_request_payload(monkeypatch):
    from eden_sdk.instrumentations.cohere import _enqueue_cohere_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    kwargs = {"model": "command-r-plus", "messages": [{"role": "user", "content": LONG_TEXT}]}
    response = {
        "finish_reason": "COMPLETE",
        "usage": {"billed_units": {"input_tokens": 5, "output_tokens": 6}},
        "message": {},
    }

    _enqueue_cohere_event(kwargs, response, duration_ms=8.0, error=None)

    payload = captured[0].payload
    assert len(payload["request_payload"]["messages"][0]["content"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    assert payload["input_tokens"] == 5


def test_cohere_enqueue_error_keeps_request_payload_full(monkeypatch):
    from eden_sdk.instrumentations.cohere import _enqueue_cohere_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    kwargs = {"model": "command-r-plus", "messages": [{"role": "user", "content": LONG_TEXT}]}
    _enqueue_cohere_event(kwargs, None, duration_ms=8.0, error="boom")

    payload = captured[0].payload
    assert payload["request_payload"]["messages"][0]["content"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"


# ── Mistral ───────────────────────────────────────────────────────────


def test_mistral_enqueue_truncates_request_payload(monkeypatch):
    # Note: mistral's `_REQUEST_KWARGS` allow-list deliberately excludes
    # `messages` (see mistral.py) — truncation here is exercised via
    # `tools`, which the allow-list *does* pass through to capture.
    from eden_sdk.instrumentations.mistral import _enqueue_mistral_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    kwargs = {
        "model": "mistral-large-latest",
        "tools": [{"type": "function", "function": {"name": "f", "description": LONG_TEXT}}],
    }
    response = {"model": "mistral-large-latest", "usage": {"prompt_tokens": 1, "completion_tokens": 2}, "choices": []}

    _enqueue_mistral_event(kwargs, response, duration_ms=3.0, error=None)

    payload = captured[0].payload
    assert len(payload["request_payload"]["tools"][0]["function"]["description"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"


def test_mistral_enqueue_capture_mode_full_bypasses_truncation(monkeypatch):
    from eden_sdk.instrumentations.mistral import _enqueue_mistral_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="full")
    captured = _capture_enqueued(monkeypatch)

    kwargs = {
        "model": "mistral-large-latest",
        "tools": [{"type": "function", "function": {"name": "f", "description": LONG_TEXT}}],
    }
    _enqueue_mistral_event(kwargs, None, duration_ms=3.0, error=None)

    payload = captured[0].payload
    assert payload["request_payload"]["tools"][0]["function"]["description"] == LONG_TEXT
    assert payload["attributes"][CAPTURE_MODE_ATTR] == "full"


# ── Bedrock ───────────────────────────────────────────────────────────


def test_bedrock_enqueue_truncates_and_stamps(monkeypatch):
    from eden_sdk.instrumentations.bedrock import _enqueue as bedrock_enqueue

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    bedrock_enqueue(
        operation="converse",
        model="anthropic.claude-3-5-sonnet",
        request={"modelId": "anthropic.claude-3-5-sonnet", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response={"output": {"message": {"content": [{"text": LONG_TEXT}]}}, "usage": {"inputTokens": 3, "outputTokens": 4}},
        duration_ms=6.0,
        error=None,
    )

    payload = captured[0].payload
    assert len(payload["request_payload"]["messages"][0]["content"]) < len(LONG_TEXT)
    assert len(payload["response_payload"]["output"]["message"]["content"][0]["text"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    # Usage is extracted from the *original* response before truncation.
    assert payload["input_tokens"] == 3
    assert payload["output_tokens"] == 4


def test_bedrock_enqueue_error_keeps_full_payload(monkeypatch):
    from eden_sdk.instrumentations.bedrock import _enqueue as bedrock_enqueue

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    bedrock_enqueue(
        operation="converse",
        model="anthropic.claude-3-5-sonnet",
        request={"modelId": "anthropic.claude-3-5-sonnet", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response=None,
        duration_ms=6.0,
        error="ThrottlingException",
    )

    payload = captured[0].payload
    assert payload["request_payload"]["messages"][0]["content"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"


# ── Gemini ────────────────────────────────────────────────────────────


def test_gemini_enqueue_truncates_response_text_and_stamps(monkeypatch):
    """Regression: gemini used to hard-truncate response text to 2000
    chars unconditionally, with no metadata marking the cut. Now it
    routes through the same bounded-capture policy as every other
    provider and stamps eden.truncated/eden.original_bytes."""
    from eden_sdk.instrumentations.gemini import _enqueue as gemini_enqueue

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    gemini_enqueue(
        provider="gemini",
        model="gemini-1.5-pro",
        duration_ms=9.0,
        error=None,
        text=LONG_TEXT,
        usage={"input_tokens": 1, "output_tokens": 2, "cache_read_tokens": None, "cache_creation_tokens": None},
    )

    payload = captured[0].payload
    assert len(payload["response_payload"]["text"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    assert payload["input_tokens"] == 1
    assert payload["output_tokens"] == 2


def test_gemini_enqueue_error_keeps_full_text(monkeypatch):
    from eden_sdk.instrumentations.gemini import _enqueue as gemini_enqueue

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    gemini_enqueue(
        provider="gemini",
        model="gemini-1.5-pro",
        duration_ms=9.0,
        error="ResourceExhausted",
        text=LONG_TEXT,
    )

    payload = captured[0].payload
    assert payload["response_payload"]["text"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"


def test_gemini_enqueue_capture_mode_full_bypasses_truncation(monkeypatch):
    from eden_sdk.instrumentations.gemini import _enqueue as gemini_enqueue

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="full")
    captured = _capture_enqueued(monkeypatch)

    gemini_enqueue(provider="gemini", model="gemini-1.5-pro", duration_ms=9.0, error=None, text=LONG_TEXT)

    payload = captured[0].payload
    assert payload["response_payload"]["text"] == LONG_TEXT
    assert payload["attributes"][CAPTURE_MODE_ATTR] == "full"


# ── HTTP capture ──────────────────────────────────────────────────────


def test_http_capture_emit_truncates_and_stamps(monkeypatch):
    from eden_sdk.http_capture import _emit_http_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    _emit_http_event(
        source_format="openai",
        url="https://api.openai.com/v1/chat/completions",
        method="POST",
        request_body={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_body={"choices": [{"message": {"content": LONG_TEXT}}]},
        status_code=200,
        duration_ms=11.0,
        error=None,
    )

    payload = captured[0].payload
    assert len(payload["request_payload"]["messages"][0]["content"]) < len(LONG_TEXT)
    assert len(payload["response_payload"]["choices"][0]["message"]["content"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    assert payload["model"] == "gpt-4o"  # extracted before capture mutates request_body


def test_http_capture_emit_http_error_status_bypasses_truncation(monkeypatch):
    """A 4xx/5xx HTTP status counts as an error for capture purposes even
    when no exception was raised on the client side."""
    from eden_sdk.http_capture import _emit_http_event

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    _emit_http_event(
        source_format="openai",
        url="https://api.openai.com/v1/chat/completions",
        method="POST",
        request_body={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_body={"error": {"message": LONG_TEXT}},
        status_code=500,
        duration_ms=11.0,
        error=None,
    )

    payload = captured[0].payload
    assert payload["request_payload"]["messages"][0]["content"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"


# ── eden.trace() set_input / set_output ────────────────────────────────


def test_trace_set_input_output_truncated_when_long(monkeypatch):
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    with eden.trace("long-io") as span:
        span.set_input({"prompt": LONG_TEXT})
        span.set_output({"completion": LONG_TEXT})

    payload = captured[0].payload
    assert len(payload["input"]["prompt"]) < len(LONG_TEXT)
    assert len(payload["output"]["completion"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"


def test_trace_set_input_output_error_keeps_full_payload(monkeypatch):
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    captured = _capture_enqueued(monkeypatch)

    with eden.trace("long-io-error") as span:
        span.set_input({"prompt": LONG_TEXT})
        span.set_status("error", error="boom")

    payload = captured[0].payload
    assert payload["input"]["prompt"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"


def test_trace_set_input_output_capture_mode_full_bypasses_truncation(monkeypatch):
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="full")
    captured = _capture_enqueued(monkeypatch)

    with eden.trace("long-io-full") as span:
        span.set_input(LONG_TEXT)
        span.set_output(LONG_TEXT)

    payload = captured[0].payload
    assert payload["input"] == LONG_TEXT
    assert payload["output"] == LONG_TEXT
    assert payload["attributes"][CAPTURE_MODE_ATTR] == "full"


def test_trace_set_input_output_metrics_only_drops_content(monkeypatch):
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="metrics_only")
    captured = _capture_enqueued(monkeypatch)

    with eden.trace("long-io-metrics-only") as span:
        span.set_input({"prompt": "hi"})
        span.set_output({"completion": "hi"})

    payload = captured[0].payload
    assert payload["input"] is None
    assert payload["output"] is None
    assert payload["attributes"][CAPTURE_MODE_ATTR] == "metrics_only"


# ── Sampling + bounded-capture interaction ─────────────────────────────
#
# Truncation happens in the instrumentation, before the payload ever
# reaches ``EdenClient.enqueue`` — sampling happens *inside* ``enqueue``.
# The two are independent mechanisms; these tests exercise that they
# compose correctly rather than one silently defeating the other.


def test_force_keep_bypasses_aggressive_sampling_regardless_of_truncation(monkeypatch):
    """``skip_sampling=True`` (durable offline replay) must always be
    kept by the sampler even under an aggressive (5% keep-rate) profile,
    independent of whether the payload was truncated upstream."""
    eden.configure(
        org_id="o", api_key="k", dry_run=True,
        capture_mode="bounded", sampling_profile="aggressive",
    )
    client = get_default_client()

    from eden_sdk.capture import CaptureLimits, capture_value

    result = capture_value(LONG_TEXT, limits=CaptureLimits(mode="bounded", max_string_bytes=64))
    assert result.truncated is True

    payload = {
        "duration_ms": 5.0,
        "request_payload": {"messages": [{"content": result.value}]},
        "attributes": {},
    }
    client.enqueue(TraceEvent(payload=payload, source_format="openai"), skip_sampling=True)

    assert client.sampled_out == 0
    assert client.sent == 1


def test_error_event_force_kept_by_sampler_while_capture_keeps_full_payload(monkeypatch):
    """An error response is force-kept by ClientSampler (keep_errors),
    even under an aggressive sampling profile, AND bounded capture's
    own error bypass means the error's full content ships too — the
    two force-keep mechanisms line up rather than fighting."""
    from eden_sdk.instrumentations.openai import _enqueue_openai_event

    eden.configure(
        org_id="o", api_key="k", dry_run=True,
        capture_mode="bounded", sampling_profile="aggressive",
    )
    client = get_default_client()
    captured = _spy_on_enqueue(client, monkeypatch)

    _enqueue_openai_event(
        request_payload={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload=None,
        duration_ms=10.0,
        error="RuntimeError: boom",
    )

    assert len(captured) == 1
    payload = captured[0].payload
    assert payload["request_payload"]["messages"][0]["content"] == LONG_TEXT
    assert payload["attributes"][TRUNCATED_ATTR] == "false"
    # Aggressive profile keep-rate is 5% — force-keep-on-error must not
    # be probabilistic.
    assert client.sampled_out == 0
    assert client.sent == 1


def test_truncated_success_payload_still_delivered_under_full_sampling(monkeypatch):
    """A non-error payload gets truncated by bounded capture (since it
    doesn't hit the error/slow bypass) but is still delivered normally
    by the sampler under the (deterministic) "full" profile — proving
    the two mechanisms are independent rather than one skipping the
    other's work."""
    from eden_sdk.instrumentations.openai import _enqueue_openai_event

    eden.configure(
        org_id="o", api_key="k", dry_run=True,
        capture_mode="bounded", sampling_profile="full",
    )
    client = get_default_client()
    captured = _spy_on_enqueue(client, monkeypatch)

    _enqueue_openai_event(
        request_payload={"model": "gpt-4o", "messages": [{"role": "user", "content": LONG_TEXT}]},
        response_payload={"model": "gpt-4o", "choices": [{"message": {"content": LONG_TEXT}}]},
        duration_ms=10.0,
        error=None,
    )

    assert len(captured) == 1
    payload = captured[0].payload
    assert len(payload["choices"][0]["message"]["content"]) < len(LONG_TEXT)
    assert payload["attributes"][TRUNCATED_ATTR] == "true"
    assert client.sampled_out == 0
    assert client.sent == 1
