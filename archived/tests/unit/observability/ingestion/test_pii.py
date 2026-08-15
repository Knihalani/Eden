"""Tests for the PII pre-mask wrapper."""

import pytest

from eden.observability.ingestion.pii import (
    mask_attributes,
    mask_payload,
)


@pytest.mark.asyncio
async def test_mask_payload_with_email():
    masked = await mask_payload({"user": "alice@example.com"})
    assert "alice@example.com" not in str(masked)
    assert "EMAIL" in str(masked).upper() or "@" not in str(masked)


@pytest.mark.asyncio
async def test_mask_payload_string():
    masked = await mask_payload("Contact me at bob@example.com")
    assert "@" not in str(masked)


@pytest.mark.asyncio
async def test_mask_payload_list():
    masked = await mask_payload(["alice@example.com", "clean text"])
    assert isinstance(masked, list)
    assert "@" not in str(masked[0])


@pytest.mark.asyncio
async def test_mask_payload_none():
    assert await mask_payload(None) is None


@pytest.mark.asyncio
async def test_mask_payload_clean_unchanged():
    payload = {"clean": "value", "count": 42}
    masked = await mask_payload(payload)
    assert masked == payload


@pytest.mark.asyncio
async def test_mask_attributes_masks_values():
    attrs = {"note": "email alice@example.com", "ok": "clean"}
    out = await mask_attributes(attrs)
    assert "@" not in out["note"]
    assert out["ok"] == "clean"


@pytest.mark.asyncio
async def test_mask_attributes_empty():
    assert await mask_attributes({}) == {}


@pytest.mark.asyncio
async def test_mask_attributes_preserves_non_string_values():
    attrs = {"count": "42", "flag": "true"}
    out = await mask_attributes(attrs)
    # Non-PII values pass through.
    assert out["count"] == "42"
    assert out["flag"] == "true"
