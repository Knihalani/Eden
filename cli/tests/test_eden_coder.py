"""Tests for ``eden.coders.eden_coder`` — EdenCoder context injection.

We don't require Aider to be importable for these tests — the
``EdenCoder`` module is designed to import cleanly without it (it
exposes a stub class with a useful import error). Tests that need
the real ``EditBlockCoder`` base are gated by a fixture that
skips when Aider isn't installed.
"""

from __future__ import annotations

import pytest

from eden.coders.eden_coder import (
    EDIT_FORMAT,
    EdenContextPayload,
    is_aider_available,
)


def test_edit_format_constant():
    assert EDIT_FORMAT == "eden"


def test_payload_empty_to_message_is_none():
    p = EdenContextPayload()
    assert p.to_system_message() is None


def test_payload_includes_only_nonempty_sections():
    p = EdenContextPayload(
        global_kb="GK",
        tenant_kb="",  # intentionally blank
        observability="OBS",
    )
    msg = p.to_system_message()
    assert msg is not None
    assert msg["role"] == "system"
    assert "GK" in msg["content"]
    assert "OBS" in msg["content"]
    # tenant section blank → no TENANT header
    assert "[TENANT CONTEXT]" not in msg["content"]


def test_payload_combined_text_uses_separators():
    p = EdenContextPayload(
        global_kb="### G", tenant_kb="### T", observability="### O"
    )
    msg = p.to_system_message()
    assert msg is not None
    assert msg["content"].count("---") >= 2


def test_aider_optional():
    # The point of this test is that the module is importable and
    # the helper reports the correct state — Aider may or may not
    # be installed in CI; both outcomes are valid.
    state = is_aider_available()
    assert isinstance(state, bool)
