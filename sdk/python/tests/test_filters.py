"""Tests for the per-filter SDK configuration.

Covers:
  * PIIConfig validation + header rendering
  * FilterConfig dispatching to per-filter headers
  * EdenConfig.filters field + gateway_headers integration
  * resolved_gateway_url helper
"""

from __future__ import annotations

import pytest

from eden_sdk.config import EdenConfig
from eden_sdk.filters import FILTER_NAMES, FilterConfig, PIIConfig


class TestPIIConfig:
    def test_defaults(self):
        c = PIIConfig()
        assert c.mode == "redact"
        assert c.disabled_categories == []
        assert c.bypass is False

    def test_invalid_mode_raises(self):
        with pytest.raises(ValueError):
            PIIConfig(mode="bogus")

    def test_all_modes_accepted(self):
        for mode in ("off", "redact", "fail_closed"):
            assert PIIConfig(mode=mode).mode == mode

    def test_to_headers_minimal(self):
        """Default config emits just ``X-PII-Mode`` (no bypass,
        no disabled categories)."""
        h = PIIConfig().to_headers()
        assert h == {"X-PII-Mode": "redact"}

    def test_to_headers_with_bypass(self):
        h = PIIConfig(mode="redact", bypass=True).to_headers()
        assert h["X-PII-Bypass"] == "true"
        assert h["X-PII-Mode"] == "redact"

    def test_to_headers_with_disabled_categories(self):
        h = PIIConfig(
            mode="redact",
            disabled_categories=["api_key", "url_with_creds"],
        ).to_headers()
        assert h["X-PII-Disabled-Categories"] == "api_key,url_with_creds"

    def test_to_headers_full(self):
        h = PIIConfig(
            mode="fail_closed",
            bypass=True,
            disabled_categories=["ssn"],
        ).to_headers()
        assert h["X-PII-Mode"] == "fail_closed"
        assert h["X-PII-Bypass"] == "true"
        assert h["X-PII-Disabled-Categories"] == "ssn"

    def test_to_headers_off_mode_still_emits_header(self):
        """``mode='off'`` must still emit ``X-PII-Mode`` so the
        gateway can distinguish 'tenant policy is off' from 'no
        header at all'."""
        h = PIIConfig(mode="off").to_headers()
        assert h["X-PII-Mode"] == "off"


class TestFilterConfig:
    def test_empty_emits_nothing(self):
        assert FilterConfig().to_headers() == {}

    def test_only_pii_routed(self):
        h = FilterConfig(pii=PIIConfig(mode="fail_closed")).to_headers()
        assert h == {"X-PII-Mode": "fail_closed"}

    def test_filter_names_known(self):
        """The set of filter names exposed on the SDK must match
        what the gateway's FilterRegistry accepts, so adding a
        new server-side filter is a one-line change here."""
        assert "pii" in FILTER_NAMES


class TestEdenConfigFilters:
    def test_filters_default_none(self):
        cfg = EdenConfig(org_id="o", api_key="k")
        assert cfg.filters is None

    def test_gateway_headers_omits_filter_headers_when_unset(self):
        """When no filter config is set, no ``X-PII-*`` headers
        leak into the default_headers — the gateway falls back to
        the tenant policy."""
        cfg = EdenConfig(org_id="o", api_key="k")
        h = cfg.gateway_headers()
        assert "X-PII-Mode" not in h
        assert "X-PII-Bypass" not in h
        assert "X-PII-Disabled-Categories" not in h

    def test_gateway_headers_renders_filters(self):
        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
        h = cfg.gateway_headers()
        assert h["X-PII-Mode"] == "fail_closed"
        assert h["X-Org-Api-Key"] == "k"

    def test_gateway_headers_per_call_filter_override(self):
        """A ``filters=`` kwarg to ``gateway_headers`` overrides
        ``config.filters`` for one call."""
        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="redact")),
        )
        # Default uses redact...
        h = cfg.gateway_headers()
        assert h["X-PII-Mode"] == "redact"
        # ...but the per-call override wins.
        h2 = cfg.gateway_headers(
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
        assert h2["X-PII-Mode"] == "fail_closed"

    def test_pii_bypass_kwarg_works_alongside_filters(self):
        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
        h = cfg.gateway_headers(pii_bypass=True)
        # ``pii_bypass=True`` adds X-PII-Bypass: true even though
        # the process-wide filter says fail_closed.
        assert h["X-PII-Bypass"] == "true"
        assert h["X-PII-Mode"] == "fail_closed"


class TestGatewayURL:
    def test_default_base_url_appends_v1(self):
        cfg = EdenConfig(org_id="o", api_key="k")
        assert cfg.resolved_gateway_url() == "http://localhost:8000/v1"

    def test_explicit_gateway_url_wins(self):
        cfg = EdenConfig(
            org_id="o", api_key="k",
            gateway_url="https://gateway.eden.ai/v1",
        )
        assert cfg.resolved_gateway_url() == "https://gateway.eden.ai/v1"

    def test_base_url_already_ends_with_v1(self):
        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com/v1",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"

    def test_base_url_with_trailing_slash(self):
        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com/",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"


# ── Client-side safety-net redactor ────────────────────────────────


from eden_sdk.filters import redact_payload  # noqa: E402


class TestRedactPayload:
    """The client-side PII safety net runs over outgoing payloads."""

    def test_redacts_email(self) -> None:
        out = redact_payload({"text": "contact alice@example.com today"})
        assert out == {"text": "contact [REDACTED] today"}

    def test_redacts_us_phone(self) -> None:
        out = redact_payload("call (415) 555-2671 anytime")
        assert out == "call [REDACTED] anytime"

    def test_redacts_ssn(self) -> None:
        out = redact_payload("SSN 123-45-6789 was on file")
        assert out == "SSN [REDACTED] was on file"

    def test_redacts_credit_card(self) -> None:
        out = redact_payload("card 4111 1111 1111 1111 used")
        assert "[REDACTED]" in out
        assert "4111 1111 1111 1111" not in out

    def test_recurses_into_nested_structures(self) -> None:
        payload = {
            "messages": [
                {"role": "user", "content": "ping alice@example.com"},
                {"role": "assistant", "content": "ok"},
            ],
            "metadata": {"notes": "ssn 111-22-3333"},
        }
        out = redact_payload(payload)
        assert "alice@example.com" not in str(out)
        assert "111-22-3333" not in str(out)
        # The role field is unchanged.
        assert out["messages"][0]["role"] == "user"

    def test_does_not_mutate_original(self) -> None:
        original = {"text": "alice@example.com"}
        _ = redact_payload(original)
        # The caller still sees the unredacted string locally —
        # redaction only touches the wire copy.
        assert original["text"] == "alice@example.com"

    def test_leaves_non_strings_unchanged(self) -> None:
        out = redact_payload({"n": 42, "f": 3.14, "b": True, "none": None})
        assert out == {"n": 42, "f": 3.14, "b": True, "none": None}

    def test_does_not_redact_short_numeric_ids(self) -> None:
        # 4-digit IDs are not phone numbers.
        out = redact_payload("order 1234 placed")
        assert out == "order 1234 placed"

    def test_does_not_redact_pure_digit_strings_as_phones(self) -> None:
        # 10-11 digit strings without separators are NOT phone
        # numbers — they're far more likely to be numeric IDs,
        # Unix timestamps, or order numbers.
        for raw in ("1234567890", "12345678901"):
            assert redact_payload({"id": raw}) == {"id": raw}

    def test_redacts_phones_with_separators(self) -> None:
        # Real phone formats (parentheses, hyphens, dots, spaces)
        # must still be caught.
        for fmt, expected in [
            ("415-555-2671", "[REDACTED]"),
            ("(415) 555-2671", "(415) [REDACTED]"),
            ("+1 415 555 2671", "+1 [REDACTED]"),
            ("415.555.2671", "[REDACTED]"),
        ]:
            out = redact_payload({"phone": fmt})["phone"]
            assert "[REDACTED]" in out, f"{fmt!r} should be redacted, got {out!r}"

    def test_redacts_luhn_valid_credit_cards(self) -> None:
        # Known Luhn-valid test card numbers.
        for cc in ("4111 1111 1111 1111", "5500000000000004"):
            out = redact_payload({"card": cc})["card"]
            assert "[REDACTED]" in out, f"{cc!r} should be redacted, got {out!r}"

    def test_does_not_redact_luhn_invalid_long_numbers(self) -> None:
        # 13-19 digit runs that fail Luhn are far more likely to
        # be timestamps, hashes, or arbitrary IDs than credit
        # cards. Must not be redacted.
        for raw in ("1234567890123", "12345678901234", "1234567890123456789"):
            assert redact_payload({"id": raw}) == {"id": raw}

    def test_redacts_token_counts(self) -> None:
        # The whole point: legitimate payloads with token counts
        # must not be touched.
        out = redact_payload({"usage": {"total_tokens": 1234567}})
        assert out == {"usage": {"total_tokens": 1234567}}



# ── Integration test: real OpenAI / Anthropic response shapes ──────


class TestRedactOnRealisticPayloads:
    """The safety net must work on real-shaped LLM responses, not just
    synthetic strings.  These fixtures mirror the JSON the SDK actually
    ships to the gateway — request messages, response choices, and
    usage blocks — and assert that the obvious PII in them is masked
    while the surrounding structure (token counts, model names, IDs) is
    preserved.
    """

    OPENAI_CHAT_COMPLETION = {
        "id": "chatcmpl-abc123def456",
        "object": "chat.completion",
        "created": 1717000000,
        "model": "gpt-4o-mini-2024-07-18",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": (
                        "Thanks for the message. I'll follow up at "
                        "alice@example.com or call (415) 555-2671."
                    ),
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 142,
            "completion_tokens": 38,
            "total_tokens": 180,
        },
    }

    ANTHROPIC_MESSAGE = {
        "id": "msg_01HXYZ",
        "type": "message",
        "role": "assistant",
        "content": [
            {
                "type": "text",
                "text": (
                    "Your account SSN 123-45-6789 was on file. "
                    "Card ending 4111 1111 1111 1111 was charged."
                ),
            }
        ],
        "model": "claude-3-5-sonnet-20241022",
        "usage": {
            "input_tokens": 87,
            "output_tokens": 24,
        },
    }

    def test_openai_response_masks_pii_keeps_structure(self) -> None:
        out = redact_payload(self.OPENAI_CHAT_COMPLETION)
        # PII is gone.
        assert "alice@example.com" not in str(out)
        assert "(415) 555-2671" not in str(out)
        assert "[REDACTED]" in str(out)
        # Structure is preserved (token counts, model, IDs).
        assert out["usage"]["prompt_tokens"] == 142
        assert out["usage"]["completion_tokens"] == 38
        assert out["model"] == "gpt-4o-mini-2024-07-18"
        assert out["id"] == "chatcmpl-abc123def456"
        # The PII lives inside a deeply-nested string.
        assert out["choices"][0]["message"]["role"] == "assistant"

    def test_anthropic_response_masks_pii_keeps_structure(self) -> None:
        out = redact_payload(self.ANTHROPIC_MESSAGE)
        assert "123-45-6789" not in str(out)
        assert "4111 1111 1111 1111" not in str(out)
        assert "[REDACTED]" in str(out)
        assert out["usage"]["input_tokens"] == 87
        assert out["usage"]["output_tokens"] == 24
        assert out["model"] == "claude-3-5-sonnet-20241022"
        assert out["id"] == "msg_01HXYZ"

    def test_request_payload_with_user_message_is_masked(self) -> None:
        """A typical chat.completion.create request body."""
        request = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {
                    "role": "user",
                    "content": (
                        "My email is bob@example.org and my phone is "
                        "+1 415 555 9999. Please confirm."
                    ),
                },
            ],
            "temperature": 0.7,
        }
        out = redact_payload(request)
        assert "bob@example.org" not in str(out)
        assert "415 555 9999" not in str(out)
        # System prompt + control fields untouched.
        assert out["messages"][0]["content"] == "You are a helpful assistant."
        assert out["temperature"] == 0.7
        assert out["model"] == "gpt-4o-mini"

    def test_token_counts_never_redacted(self) -> None:
        """Even huge token counts must survive the pass intact."""
        for n in (1, 100, 9999, 1_000_000, 1_234_567_890):
            out = redact_payload({"usage": {"total_tokens": n}})
            assert out == {"usage": {"total_tokens": n}}


    def test_redacts_pii_in_dict_keys(self) -> None:
        # Some upstream LLM SDKs stash identifiers in dict keys.
        # String keys are redacted for safety.
        out = redact_payload({"alice@example.com": "value"})
        assert "alice@example.com" not in out
        assert "[REDACTED]" in out
        assert out["[REDACTED]"] == "value"

    def test_redacts_pii_in_nested_dict_keys(self) -> None:
        out = redact_payload({"outer": {"alice@example.com": "value"}})
        assert "alice@example.com" not in str(out)
        assert out["outer"]["[REDACTED]"] == "value"

    def test_does_not_redact_non_string_keys(self) -> None:
        # Integer keys must not be touched (they can't be PII).
        out = redact_payload({42: "value", "model": "gpt-4"})
        assert out[42] == "value"
        assert out["model"] == "gpt-4"

    def test_handles_empty_and_null_inputs(self) -> None:
        assert redact_payload({}) == {}
        assert redact_payload([]) == []
        assert redact_payload("") == ""
        assert redact_payload(None) is None
        assert redact_payload(42) == 42
        assert redact_payload(True) is True
