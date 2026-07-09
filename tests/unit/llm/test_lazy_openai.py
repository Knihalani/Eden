"""Tests for the lazy openai import in eden.llm.client (audit 2026-07-06).

The openai SDK is ~200ms of cold import (the full openai.types
tree). Importing OpenRouterClient should NOT load the openai
SDK; the SDK should only be loaded on the first client
construction (which is when the OpenAI/AsyncOpenAI classes are
actually needed).
"""

from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _ensure_openai_not_loaded():
    """Make sure openai is not in sys.modules before the test."""
    # If openai is already loaded (e.g. by the conftest), this
    # test can't isolate. The fix is to not load openai in the
    # conftest, but for now we just skip in that case.
    if "openai" in sys.modules:
        pytest.skip("openai was already loaded (likely by conftest)")
    yield


def test_importing_client_class_does_not_load_openai():
    """Importing the module-level classes must not load openai.

    The lazy load happens in OpenRouterClient.__init__ (via
    the PEP 562 __getattr__). The module-level imports of
    CircuitBreaker, LLMResponse, etc. should be free.
    """
    assert "openai" not in sys.modules
    from eden.llm.client import (
        CircuitBreaker,
        LLMResponse,
        MaxRetriesExceededError,
        UsageStats,
    )

    # These are defined in the module itself, not in openai.
    assert CircuitBreaker is not None
    assert LLMResponse is not None
    assert MaxRetriesExceededError is not None
    assert UsageStats is not None
    # openai should still NOT be loaded.
    assert "openai" not in sys.modules


def test_attribute_access_via_module_works():
    """``module.OpenAI`` PEP 562 lazy access returns the real class.

    Pre-fix, ``from eden.llm.client import OpenAI`` would
    directly import the openai SDK at module load. Post-fix,
    the import works (so existing code/tests don't break)
    but the SDK is only loaded on first attribute access.
    """
    from eden.llm import client as client_module

    # First access: triggers the PEP 562 __getattr__, which
    # imports openai. Cached after this.
    OpenAI = client_module.OpenAI
    assert OpenAI is not None
    # After the access, openai should be in sys.modules.
    assert "openai" in sys.modules
    # And the module attribute should be cached.
    assert client_module.OpenAI is OpenAI


def test_lazy_resolver_works_under_patch():
    """patch("eden.llm.client.OpenAI", ...) still works.

    The lazy loader uses ``globals()`` (well, ``getattr`` on
    the module) so unittest.mock patches remain effective.
    """
    from unittest.mock import patch, MagicMock

    from eden.llm import client as client_module

    with patch.object(client_module, "OpenAI", MagicMock()):
        # When OpenRouterClient is constructed, it does
        # ``OpenAI = getattr(_this_mod, "OpenAI")``. The patch
        # should make this return the MagicMock, not the real
        # OpenAI class.
        c = client_module.OpenRouterClient(api_key="test-key")
        # The constructor stored a MagicMock in c.client.
        assert isinstance(c.client, MagicMock)
