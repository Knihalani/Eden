"""Integration-style flywire test (mocked DB)."""

import asyncio
from uuid import uuid4

import pytest

from eden.nudges.author import ArtifactAuthor


@pytest.mark.asyncio
async def test_author_loop_dsl_no_db():
    author = ArtifactAuthor()
    trigger, content, name = author._loop_dsl("loop", {"tool_name": "grep"})
    assert trigger
    assert content
    assert name
