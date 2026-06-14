"""Tests for the PII detection and masking module."""

import pytest

from eden.data_platform.pii import PIIMasker


class TestPIIMasker:
    def test_mask_email(self):
        masker = PIIMasker()
        text = "Contact us at user@example.com for support"
        result = masker.mask(text)
        assert "user@example.com" not in result
        assert "[EMAIL_REDACTED]" in result

    def test_mask_ssn(self):
        masker = PIIMasker()
        text = "SSN: 123-45-6789"
        result = masker.mask(text)
        assert "123-45-6789" not in result
        assert "[SSN_REDACTED]" in result

    def test_mask_jwt(self):
        masker = PIIMasker()
        text = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature"
        result = masker.mask(text)
        assert "eyJhbGci" not in result
        assert "[JWT_REDACTED]" in result

    def test_mask_dict_sensitive_keys(self):
        masker = PIIMasker()
        data = {
            "username": "alice",
            "password": "supersecret123",
            "api_key": "sk-abc123",
            "config": {"timeout": 30},
        }
        result = masker.mask(data)
        assert result["username"] == "alice"
        assert "[PASSWORD_REDACTED]" in result["password"]
        assert "[API_KEY_REDACTED]" in result["api_key"]
        assert result["config"]["timeout"] == 30

    def test_mask_nested_dict(self):
        masker = PIIMasker()
        data = {
            "user": {
                "email": "nested@example.com",
                "phone": "555-123-4567",
            }
        }
        result = masker.mask(data)
        assert "nested@example.com" not in result["user"]["email"]
        assert "[EMAIL_REDACTED]" in result["user"]["email"]
        assert "[PHONE_REDACTED]" in result["user"]["phone"]

    def test_scan_returns_detections(self):
        masker = PIIMasker()
        text = "Email: foo@bar.com and SSN: 111-22-3333"
        detections = masker.scan(text)
        types = {d["type"] for d in detections}
        assert "email" in types
        assert "ssn" in types

    def test_has_pii_true(self):
        masker = PIIMasker()
        assert masker.has_pii("Email: test@test.com") is True

    def test_has_pii_false(self):
        masker = PIIMasker()
        assert masker.has_pii("Just some normal text without PII") is False

    def test_mask_phone(self):
        masker = PIIMasker()
        text = "Call me at (555) 123-4567"
        result = masker.mask(text)
        assert "(555) 123-4567" not in result
        assert "[PHONE_REDACTED]" in result

    def test_mask_credit_card(self):
        masker = PIIMasker()
        text = "Card: 4111 1111 1111 1111"
        result = masker.mask(text)
        assert "4111 1111 1111 1111" not in result
        assert "[CREDIT_CARD_REDACTED]" in result

    def test_mask_url_with_creds(self):
        masker = PIIMasker()
        text = "https://user:pass@example.com/path"
        result = masker.mask(text)
        assert "user:pass@example.com" not in result
        assert "[URL_WITH_CREDS_REDACTED]" in result

    def test_mask_list_items(self):
        masker = PIIMasker()
        data = {
            "contacts": [
                "alice@example.com",
                {"email": "bob@test.org", "name": "Bob"},
            ]
        }
        result = masker.mask(data)
        assert "alice@example.com" not in result["contacts"][0]
        assert "bob@test.org" not in result["contacts"][1]["email"]

    def test_empty_payload(self):
        masker = PIIMasker()
        assert masker.mask("") == ""
        assert masker.mask({}) == {}
        assert masker.mask([]) == []
