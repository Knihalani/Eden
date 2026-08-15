"""Conftest for the llmops unit tests.

Kept minimal — no DB, no FastAPI app. Tests in this directory exercise
the AI Gateway and its filter chain in isolation.
"""

import pytest

from eden.llmops.ai_gateway import AIGateway, ModelRequest


@pytest.fixture
def gateway() -> AIGateway:
    """A bare AIGateway with no providers or caches registered. Tests
    can attach mocks as needed."""
    return AIGateway()


@pytest.fixture
def make_request():
    """Factory for ``ModelRequest`` instances with sensible defaults."""
    def _make(prompt: str = "hello", **overrides) -> ModelRequest:
        defaults = {
            "model_family": "claude",
            "model_version": "claude-sonnet-4",
            "prompt": prompt,
            "tenant_id": "tenant-test",
        }
        defaults.update(overrides)
        return ModelRequest(**defaults)
    return _make
