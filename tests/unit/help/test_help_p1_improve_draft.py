"""P1: HelpMiss Improve draft is written from ExtraWorkEvent leftovers."""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.issue_patch_trigger import (
    build_help_miss_improve_draft,
    instruction_is_generic,
    kinds_for_help_miss_reason,
    propose_prompt_canary_for_help_miss,
)
from eden.integrations.slack.store import list_help_miss_leftovers
from eden.issues.models import HELP_MISS_KIND


def _issue() -> SimpleNamespace:
    return SimpleNamespace(
        id="i1",
        fingerprint="fp1",
        agent_id="agent-a",
        title="agent-a didn't help (took_over)",
        kind=HELP_MISS_KIND,
    )


def test_generic_instruction_denylist() -> None:
    assert instruction_is_generic("be more helpful")
    assert instruction_is_generic("Please follow the instructions.")
    assert instruction_is_generic("Be careful")
    assert instruction_is_generic("")
    assert instruction_is_generic(None)
    assert not instruction_is_generic(
        "Do the job yourself when you see this leftover work. "
        "Do not leave it for the human."
    )
    # Quoted leftover text is not the instruction.
    assert not instruction_is_generic(
        'Do the refund yourself. Leftovers: "be more helpful"'
    )


def test_kinds_for_took_over_match_fingerprint_map() -> None:
    kinds = kinds_for_help_miss_reason("took_over")
    assert "human_did_agents_job" in kinds
    assert "rewrite_new_message" not in kinds
    assert kinds_for_help_miss_reason(None) == []


def test_draft_from_three_leftovers_without_session() -> None:
    leftovers = [
        {"snippet": "I'll just do the refund myself"},
        {"snippet": "handling the refund in #ops"},
        {"snippet": "taking this ticket back"},
        {"snippet": "should not appear — fourth"},
    ]
    draft = build_help_miss_improve_draft(leftovers)
    assert draft is not None
    assert draft["never_attempted"] is True
    assert "this job was never attempted" in draft["summary"].lower()
    assert "I'll just do the refund myself" in draft["summary"]
    assert "handling the refund in #ops" in draft["summary"]
    assert "taking this ticket back" in draft["summary"]
    assert "should not appear" not in draft["summary"]
    assert len(draft["leftovers"]) == 3
    assert "Leftovers that caused this draft:" in draft["summary"]


def test_draft_pairs_trace_when_session_exists() -> None:
    leftovers = [
        {
            "snippet": "rewrote the reply",
            "session_id": "sess-1",
            "trace_id": "tr-1",
        },
        {"snippet": "I'll just do the refund myself"},
    ]
    draft = build_help_miss_improve_draft(leftovers)
    assert draft is not None
    assert draft["never_attempted"] is False
    assert "session sess-1" in draft["summary"]
    assert "trace tr-1" in draft["summary"]
    assert "this job was never attempted" in draft["summary"]
    assert not draft["summary"].lower().startswith("this job was never attempted")


def test_empty_or_generic_draft_is_not_offered() -> None:
    assert build_help_miss_improve_draft([]) is None
    assert build_help_miss_improve_draft([{"snippet": "   "}]) is None
    leftovers = [{"snippet": "I'll just do the refund myself"}]
    assert (
        build_help_miss_improve_draft(leftovers, instruction="be more helpful")
        is None
    )
    assert (
        build_help_miss_improve_draft(leftovers, instruction="follow the instructions")
        is None
    )
    assert build_help_miss_improve_draft(leftovers, instruction="be careful") is None


def test_list_help_miss_leftovers_default_limit_is_3() -> None:
    sig = inspect.signature(list_help_miss_leftovers)
    assert sig.parameters["limit"].default == 3


@pytest.mark.asyncio
async def test_propose_three_leftovers_no_session_drafts_prompt_update() -> None:
    leftovers = [
        {"snippet": "I'll just do the refund myself", "kind": "human_did_agents_job"},
        {"snippet": "handling the refund in #ops", "kind": "ill_just_do_it"},
        {"snippet": "taking this ticket back", "kind": "thread_takeover"},
    ]
    created = {"id": "plan-1", "plan_kind": "prompt_update", "status": "draft"}
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=created),
        ) as create,
        patch(
            "eden.integrations.slack.store.list_help_miss_leftovers",
            AsyncMock(return_value=[]),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org",
            _issue(),
            reason="took_over",
            help_contract_id="c1",
            leftovers=leftovers,
        )
    assert out["status"] == "drafted"
    assert out["plan_kind"] == "prompt_update"
    assert out["never_attempted"] is True
    assert len(out["leftovers"]) == 3
    kwargs = create.await_args.kwargs
    assert kwargs["plan_kind"] == "prompt_update"
    assert kwargs["status"] == "draft"
    summary = kwargs["summary"]
    assert "this job was never attempted" in summary.lower()
    for item in leftovers:
        assert item["snippet"] in summary
    assert kwargs["evidence"]["leftovers"] == out["leftovers"]
    assert kwargs["evidence"]["never_attempted"] is True


@pytest.mark.asyncio
async def test_propose_with_session_includes_trace_not_global_never_attempted() -> None:
    leftovers = [
        {
            "snippet": "rewrote the reply",
            "session_id": "sess-1",
            "trace_id": "tr-9",
        }
    ]
    created = {"id": "plan-2", "plan_kind": "prompt_update", "status": "draft"}
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=created),
        ) as create,
        patch(
            "eden.integrations.slack.store.list_help_miss_leftovers",
            AsyncMock(return_value=[]),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org",
            _issue(),
            reason="rewrote",
            leftovers=leftovers,
        )
    assert out["status"] == "drafted"
    assert out["never_attempted"] is False
    summary = create.await_args.kwargs["summary"]
    assert "session sess-1" in summary
    assert "trace tr-9" in summary
    assert not summary.lower().startswith("this job was never attempted")


@pytest.mark.asyncio
async def test_propose_without_leftovers_does_not_invent_tweak() -> None:
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(),
        ) as create,
        patch(
            "eden.integrations.slack.store.list_help_miss_leftovers",
            AsyncMock(return_value=[]),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org", _issue(), reason="took_over", help_contract_id="c1"
        )
    assert out["status"] == "suppressed"
    assert out["reason"] == "no_leftovers"
    create.assert_not_called()


@pytest.mark.asyncio
async def test_propose_generic_draft_is_not_offered() -> None:
    leftovers = [{"snippet": "I'll just do the refund myself"}]
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(),
        ) as create,
        patch(
            "eden.integrations.slack.store.list_help_miss_leftovers",
            AsyncMock(return_value=[]),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org",
            _issue(),
            reason="took_over",
            leftovers=leftovers,
            instruction="be more helpful",
        )
    assert out["status"] == "suppressed"
    assert out["reason"] == "generic_draft"
    create.assert_not_called()


@pytest.mark.asyncio
async def test_propose_uses_store_leftovers_when_caller_has_none() -> None:
    stored = [
        {"snippet": "I'll just do the refund myself", "session_id": None},
        {"snippet": "handling the refund in #ops"},
        {"snippet": "taking this ticket back"},
    ]
    created = {"id": "plan-3", "plan_kind": "prompt_update", "status": "draft"}
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=created),
        ) as create,
        patch(
            "eden.integrations.slack.store.list_help_miss_leftovers",
            AsyncMock(return_value=stored),
        ) as listed,
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org", _issue(), reason="took_over", help_contract_id="c1"
        )
    listed.assert_awaited_once()
    kwargs = listed.await_args.kwargs
    assert kwargs["agent_id"] == "agent-a"
    assert kwargs["help_contract_id"] == "c1"
    assert "human_did_agents_job" in kwargs["kinds"]
    assert kwargs["limit"] == 3
    assert out["status"] == "drafted"
    summary = create.await_args.kwargs["summary"]
    assert "I'll just do the refund myself" in summary


@pytest.mark.asyncio
async def test_list_help_miss_leftovers_empty_without_kinds_or_pg() -> None:
    assert await list_help_miss_leftovers("org", agent_id="a", kinds=[]) == []
    with patch(
        "eden.integrations.slack.store._pg",
        AsyncMock(return_value=None),
    ):
        assert (
            await list_help_miss_leftovers(
                "org", agent_id="a", kinds=["human_did_agents_job"]
            )
            == []
        )


@pytest.mark.asyncio
async def test_list_help_miss_leftovers_query_filters_group() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "snippet": "I'll just do the refund myself",
                "session_id": None,
                "trace_id": None,
                "kind": "human_did_agents_job",
            }
        ]
    )
    with patch(
        "eden.integrations.slack.store._pg",
        AsyncMock(return_value=client),
    ):
        rows = await list_help_miss_leftovers(
            "org",
            agent_id="agent-a",
            help_contract_id="c1",
            kinds=["human_did_agents_job"],
        )
    assert rows[0]["snippet"] == "I'll just do the refund myself"
    sql, *args = client.fetch.await_args.args
    assert "extra_work_events" in sql
    assert args[0] == "org"
    assert args[1] == "agent-a"
    assert args[2] == ["human_did_agents_job"]
    assert args[3] == "c1"
    assert args[4] == 3

def test_classify_code_change_from_trace_or_path() -> None:
    from eden.improvement.issue_patch_trigger import (
        FIX_KIND_CODE,
        FIX_KIND_INSTRUCTION,
        classify_help_miss_fix,
    )

    assert (
        classify_help_miss_fix(
            [{"snippet": "rewrote the reply", "trace_id": "tr-1"}]
        )
        == FIX_KIND_CODE
    )
    assert (
        classify_help_miss_fix(
            [{"snippet": "I'll just do it", "path": "src/refunds.py"}]
        )
        == FIX_KIND_CODE
    )
    assert (
        classify_help_miss_fix([{"snippet": "I'll just do the refund myself"}])
        == FIX_KIND_INSTRUCTION
    )


def test_draft_labels_instruction_replace_when_never_attempted() -> None:
    leftovers = [
        {"snippet": "I'll just do the refund myself"},
        {"snippet": "handling the refund in #ops"},
    ]
    draft = build_help_miss_improve_draft(leftovers)
    assert draft is not None
    assert draft["fix_kind"] == "instruction_replace"
    assert "This is an instruction replace." in draft["summary"]
    assert "This is a code change." not in draft["summary"]
    assert "this job was never attempted" in draft["summary"].lower()


def test_draft_labels_code_change_when_trace_present() -> None:
    leftovers = [
        {
            "snippet": "rewrote the reply",
            "session_id": "sess-1",
            "trace_id": "tr-1",
        }
    ]
    draft = build_help_miss_improve_draft(leftovers)
    assert draft is not None
    assert draft["fix_kind"] == "code_change"
    assert "This is a code change." in draft["summary"]
    assert "This is an instruction replace." not in draft["summary"]


@pytest.mark.asyncio
async def test_propose_persists_fix_kind_on_evidence() -> None:
    leftovers = [
        {
            "snippet": "rewrote the reply",
            "session_id": "sess-1",
            "trace_id": "tr-9",
        }
    ]
    created = {"id": "plan-4", "plan_kind": "prompt_update", "status": "draft"}
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=created),
        ) as create,
        patch(
            "eden.integrations.slack.store.list_help_miss_leftovers",
            AsyncMock(return_value=[]),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org",
            _issue(),
            reason="rewrote",
            leftovers=leftovers,
        )
    assert out["status"] == "drafted"
    assert out["fix_kind"] == "code_change"
    assert create.await_args.kwargs["evidence"]["fix_kind"] == "code_change"
