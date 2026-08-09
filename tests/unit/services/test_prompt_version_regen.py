"""FEAT-145 — prompt-version-changed regeneration trigger."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_trigger_regen_calls_book_and_ledger() -> None:
    from eden.services.prompt_versioning import trigger_regen_on_prompt_version_change

    with patch(
        "eden.kb.book.generator.BookGenerator.generate",
        new=AsyncMock(return_value={"id": "book-1", "version": 2}),
    ) as book_gen, patch(
        "eden.kb.ledger.generator.LedgerGenerator.upsert_do_not_repeat",
        new=AsyncMock(return_value="entry-1"),
    ) as ledger_upsert:
        summary = await trigger_regen_on_prompt_version_change(
            "org-1",
            "checkout-agent",
            version=7,
            reason="create_version",
        )

    assert summary["ok"] is True
    assert summary["agent_id"] == "checkout-agent"
    assert summary["book"] == {"id": "book-1", "version": 2}
    assert summary["ledger_entry"] == "entry-1"
    book_gen.assert_awaited_once()
    ledger_upsert.assert_awaited_once()


@pytest.mark.asyncio
async def test_trigger_regen_fails_soft() -> None:
    from eden.services.prompt_versioning import trigger_regen_on_prompt_version_change

    with patch(
        "eden.kb.book.generator.BookGenerator.generate",
        new=AsyncMock(side_effect=RuntimeError("book down")),
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.upsert_do_not_repeat",
        new=AsyncMock(side_effect=RuntimeError("ledger down")),
    ):
        summary = await trigger_regen_on_prompt_version_change(
            "org-1", "agent-x", version=1,
        )

    assert summary["ok"] is False
    assert summary["book"] is None
    assert summary["ledger_entry"] is None


@pytest.mark.asyncio
async def test_create_version_triggers_regen(mock_postgres_client) -> None:
    from eden.services.prompt_versioning import PromptService

    svc = PromptService()
    prompt_row = {
        "id": "prm-1",
        "org_id": "org-1",
        "name": "agent-a",
        "description": None,
        "tags": [],
        "auto_eval_on_save": False,
        "created_by": "system",
        "created_at": None,
        "updated_at": None,
    }
    version_row = {
        "id": "ver-1",
        "prompt_id": "prm-1",
        "version": 1,
        "template": "hello",
        "template_hash": "abc",
        "model": "gpt-4o",
        "params": "{}",
        "variables": "[]",
        "parent_version_id": None,
        "change_note": None,
        "created_by": "system",
        "created_at": None,
    }

    mock_postgres_client.fetchrow = AsyncMock(
        side_effect=[
            {"max_v": 0},  # next version lookup
            version_row,   # get_version after insert
        ]
    )
    mock_postgres_client.execute = AsyncMock()

    with patch.object(
        PromptService, "get_prompt", new=AsyncMock(return_value=prompt_row)
    ), patch(
        "eden.services.prompt_versioning.trigger_regen_on_prompt_version_change",
        new=AsyncMock(return_value={"ok": True}),
    ) as regen:
        out = await svc.create_version(
            "org-1",
            "agent-a",
            template="hello {{x}}",
            model="gpt-4o",
        )

    assert out is not None
    regen.assert_awaited_once()
    assert regen.await_args.kwargs.get("reason") == "create_version"


@pytest.mark.asyncio
async def test_promote_triggers_regen(mock_postgres_client) -> None:
    from eden.services.prompt_versioning import PromptService

    svc = PromptService()
    version_row = {
        "id": "ver-1",
        "prompt_id": "prm-1",
        "version": 3,
        "template": "hello",
        "template_hash": "abc",
        "model": "gpt-4o",
        "params": "{}",
        "variables": "[]",
        "parent_version_id": None,
        "change_note": "bump",
        "created_by": "system",
        "created_at": None,
    }
    mock_postgres_client.execute = AsyncMock()

    with patch.object(
        PromptService, "get_version", new=AsyncMock(return_value=version_row)
    ), patch.object(
        PromptService,
        "get_prompt",
        new=AsyncMock(return_value={"id": "prm-1", "name": "agent-a", "tags": []}),
    ), patch(
        "eden.services.prompt_versioning.trigger_regen_on_prompt_version_change",
        new=AsyncMock(return_value={"ok": True}),
    ) as regen:
        out = await svc.promote("org-1", "agent-a", 3)

    assert out is not None
    regen.assert_awaited_once()
    assert regen.await_args.kwargs.get("reason") == "promote"
