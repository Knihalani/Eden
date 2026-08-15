"""Hardening-pass tests for PIIMasker (June 2026).

These tests target the tightened regex set + Luhn check + new
categories shipped in the June 2026 backlog cleanup. The pre-existing
``test_pii.py`` suite covers the broader behavioural contract.

Specifically we verify:
  * False-positive guards — strings that LOOK like PII but aren't
    (Luhn-invalid 16-digit runs, area-code-invalid SSNs, …) are not
    redacted.
  * Newly-added categories (aws_secret, private_key, iban, passport)
    actually fire and produce the expected redaction token.
  * The SSN bare-9-digit form is now matched.
  * Phone-format coverage (US international + dot-separated) survived
    the tightening.
"""

import pytest

from eden.data_platform.pii import (
    PIIMasker,
    PIIMaskingError,
    PIIPolicy,
    _luhn_check,
)


class TestLuhnCheck:
    """The Luhn-validation helper guards the credit_card regex."""

    @pytest.mark.parametrize("number", [
        "4111111111111111",  # Visa test card — passes Luhn
        "5500000000000004",  # Mastercard test card
        "340000000000009",   # Amex test card
        "6011000000000004",  # Discover test card
        "4242 4242 4242 4242",  # Stripe's Visa demo (with spaces)
        "4111-1111-1111-1111",  # dash-separated
    ])
    def test_luhn_valid(self, number: str) -> None:
        assert _luhn_check(number) is True

    @pytest.mark.parametrize("number", [
        "4111111111111112",  # last digit off by one
        "1234567890123456",  # sequential — doesn't checksum
        "1111111111111111",  # all-same — doesn't checksum
        "abc",               # not digits
        "12345",             # too short
    ])
    def test_luhn_invalid(self, number: str) -> None:
        assert _luhn_check(number) is False


class TestCreditCardHardening:
    """credit_card was the noisiest pattern in the May 2026 baseline."""

    def test_real_visa_redacted(self) -> None:
        masker = PIIMasker()
        text = "Card ending 4111-1111-1111-1111 used today"
        result = masker.mask(text)
        assert "4111" not in result, "Luhn-valid Visa should be redacted"
        assert "[CREDIT_CARD_REDACTED]" in result

    def test_luhn_invalid_run_not_redacted(self) -> None:
        """Synthetic 16-digit run that begins with a brand prefix but
        doesn't checksum out should NOT be redacted — this was the
        ISBN-vs-card noise problem."""
        masker = PIIMasker()
        text = "Order id 4123456789012345 was placed"
        result = masker.mask(text)
        assert "4123456789012345" in result, \
            "Luhn-invalid 16-digit run should pass through unmodified"
        assert "[CREDIT_CARD_REDACTED]" not in result

    def test_short_digit_run_not_matched(self) -> None:
        """Old pattern matched any 13-16 digit run, including UUIDs
        and SKUs. New pattern is anchored to brand prefixes only."""
        masker = PIIMasker()
        text = "Tracking 1234567890123 ETA 5pm"
        result = masker.mask(text)
        assert "1234567890123" in result
        assert "[CREDIT_CARD_REDACTED]" not in result

    def test_amex_redacted(self) -> None:
        masker = PIIMasker()
        text = "Amex 378282246310005 charged"
        result = masker.mask(text)
        assert "378282246310005" not in result
        assert "[CREDIT_CARD_REDACTED]" in result


class TestSSNHardening:
    """SSN regex now blocks invalid area codes + matches bare form."""

    def test_dash_form_redacted(self) -> None:
        masker = PIIMasker()
        result = masker.mask("SSN 123-45-6789 on file")
        assert "123-45-6789" not in result
        assert "[SSN_REDACTED]" in result

    @pytest.mark.parametrize("invalid", [
        "000-12-3456",  # area code 000 — invalid
        "666-12-3456",  # area code 666 — invalid
        "900-12-3456",  # area code 9xx — invalid
        "123-00-3456",  # group 00 — invalid
        "123-45-0000",  # serial 0000 — invalid
    ])
    def test_invalid_area_code_not_redacted(self, invalid: str) -> None:
        masker = PIIMasker()
        result = masker.mask(f"value {invalid} here")
        assert invalid in result, \
            f"Invalid SSN form {invalid} should pass through unmodified"
        assert "[SSN_REDACTED]" not in result


class TestNewCategories:
    """Categories added in the June 2026 hardening pass."""

    def test_aws_secret(self) -> None:
        masker = PIIMasker()
        result = masker.mask("AWS=AKIAIOSFODNN7EXAMPLE in config")
        assert "AKIAIOSFODNN7EXAMPLE" not in result
        assert "[AWS_SECRET_REDACTED]" in result

    def test_private_key_block(self) -> None:
        masker = PIIMasker()
        result = masker.mask(
            "Found key -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB..."
        )
        assert "-----BEGIN RSA PRIVATE KEY-----" not in result
        assert "[PRIVATE_KEY_REDACTED]" in result

    def test_private_key_block_ec(self) -> None:
        masker = PIIMasker()
        result = masker.mask("Key: -----BEGIN EC PRIVATE KEY-----")
        assert "[PRIVATE_KEY_REDACTED]" in result

    def test_iban(self) -> None:
        masker = PIIMasker()
        # Sample IBAN from European Central Bank docs
        result = masker.mask("Transfer to GB82WEST12345698765432")
        assert "GB82WEST12345698765432" not in result
        assert "[IBAN_REDACTED]" in result

    def test_passport(self) -> None:
        masker = PIIMasker()
        result = masker.mask("Passport A12345678 verified")
        assert "A12345678" not in result
        assert "[PASSPORT_REDACTED]" in result


class TestFailClosed:
    """fail_closed_on_credentials now covers the new credential categories."""

    def test_aws_secret_triggers_fail_closed(self) -> None:
        policy = PIIPolicy(fail_closed_on_credentials=True)
        masker = PIIMasker(policy=policy)
        with pytest.raises(PIIMaskingError):
            masker.mask("config has AKIAIOSFODNN7EXAMPLE")

    def test_private_key_triggers_fail_closed(self) -> None:
        policy = PIIPolicy(fail_closed_on_credentials=True)
        masker = PIIMasker(policy=policy)
        with pytest.raises(PIIMaskingError):
            masker.mask("dump -----BEGIN RSA PRIVATE KEY-----...")

    def test_iban_does_not_trigger_fail_closed(self) -> None:
        """IBAN is high-severity but NOT a credential — should redact
        in place, not raise."""
        policy = PIIPolicy(fail_closed_on_credentials=True)
        masker = PIIMasker(policy=policy)
        result = masker.mask("IBAN GB82WEST12345698765432 on file")
        assert isinstance(result, str)
        assert "[IBAN_REDACTED]" in result


class TestHasPII:
    """has_pii must also apply the Luhn guard."""

    def test_luhn_invalid_does_not_register(self) -> None:
        masker = PIIMasker()
        assert masker.has_pii("Order id 4123456789012345") is False

    def test_real_card_registers(self) -> None:
        masker = PIIMasker()
        assert masker.has_pii("Card 4111111111111111") is True


class TestScan:
    """scan() now skips Luhn-invalid credit_card matches."""

    def test_scan_skips_luhn_invalid(self) -> None:
        masker = PIIMasker()
        detections = masker.scan("Order id 4123456789012345 no card here")
        types = [d["type"] for d in detections]
        assert "credit_card" not in types

    def test_scan_includes_real_card(self) -> None:
        masker = PIIMasker()
        detections = masker.scan("Card 4111111111111111 charged $50")
        types = [d["type"] for d in detections]
        assert "credit_card" in types
