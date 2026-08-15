"""P1.1: ExtraWorkEvent → outcome fingerprint → HelpMiss → prompt canary."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.fingerprint import (
    HELP_MISS_REASON_BY_KIND,
    compute_help_miss_fingerprint,
    help_miss_reason_for_kind,
)
from eden.issues.issue_promoter import promote_from_extra_work
from eden.issues.models import HELP_MISS_KIND, STUMBLE_KINDS


def test_reason_map_covers_spec_kinds() -> None:
    took_over = {
        "human_did_agents_job",
        "thread_takeover",
        "ill_just_do_it",
        "escalate",
        "reassigned",
        "mention_intended_owner",
        "cleanup_thread",
        "human_comment",
    }
    for kind in took_over:
        assert help_miss_reason_for_kind(kind) == "took_over"
    assert help_miss_reason_for_kind("rewrite_new_message") == "rewrote"
    assert help_miss_reason_for_kind("reopened") == "ticket_still_open"
    assert help_miss_reason_for_kind("ticket_still_open") == "ticket_still_open"
    assert help_miss_reason_for_kind("explicit_negative") == "thumbs_down"
    assert help_miss_reason_for_kind("customer_posted") is None
    assert help_miss_reason_for_kind(None) is None
    assert set(HELP_MISS_REASON_BY_KIND) == took_over | {
        "rewrite_new_message",
        "reopened",
        "ticket_still_open",
        "explicit_negative",
    }


def test_help_miss_is_not_a_stumble_kind() -> None:
    assert HELP_MISS_KIND == "help_miss"
    assert HELP_MISS_KIND not in STUMBLE_KINDS


def test_fingerprint_uses_only_org_agent_contract_reason() -> None:
    a = compute_help_miss_fingerprint("org", "agent-a", "c1", "took_over")
    b = compute_help_miss_fingerprint("org", "agent-a", "c1", "took_over")
    assert a == b
    assert len(a) == 32
    assert a != compute_help_miss_fingerprint("org", "agent-a", "c1", "rewrote")
    assert a != compute_help_miss_fingerprint("org", "agent-b", "c1", "took_over")
    assert a != compute_help_miss_fingerprint("org", "agent-a", "c2", "took_over")
    assert a != compute_help_miss_fingerprint("org-2", "agent-a", "c1", "took_over")
    empty = compute_help_miss_fingerprint("org", "agent-a", None, "took_over")
    assert empty == compute_help_miss_fingerprint("org", "agent-a", "", "took_over")
    assert empty != a


def test_fingerprint_ignores_snippet_even_if_caller_has_it() -> None:
    # Wrapper must not take snippet; calling with only the four inputs is the contract.
    fp = compute_help_miss_fingerprint("org", "agent-a", "c1", "took_over")
    assert fp == compute_help_miss_fingerprint("org", "agent-a", "c1", "took_over")
    assert "i will just do the refund" not in fp


@pytest.mark.asyncio
async def test_low_confidence_does_not_promote() -> None:
    with patch.object(
        __import__("eden.issues.issue_promoter", fromlist=["IssuePromoter"]),
        "IssuePromoter",
    ) as promo_cls:
        out = await promote_from_extra_work(
            {
                "org_id": "org",
                "agent_id": "agent-a",
                "kind": "human_did_agents_job",
                "polarity": "extra_work",
                "confidence": "low",
                "help_contract_id": "c1",
            }
        )
    assert out is None
    promo_cls.assert_not_called()


@pytest.mark.asyncio
async def test_unlisted_kind_does_not_promote() -> None:
    with patch(
        "eden.issues.issue_promoter.IssuePromoter.upsert_help_miss",
        new_callable=AsyncMock,
    ) as upsert:
        out = await promote_from_extra_work(
            {
                "org_id": "org",
                "agent_id": "agent-a",
                "kind": "customer_posted",
                "polarity": "extra_work",
                "confidence": "high",
            }
        )
    assert out is None
    upsert.assert_not_called()


@pytest.mark.asyncio
async def test_high_medium_promotes_help_miss_without_session() -> None:
    issue = SimpleNamespace(id="i1", kind=HELP_MISS_KIND, was_created=True)
    with patch(
        "eden.issues.issue_promoter.IssuePromoter.upsert_help_miss",
        new_callable=AsyncMock,
        return_value=issue,
    ) as upsert:
        out = await promote_from_extra_work(
            {
                "org_id": "org",
                "agent_id": "agent-a",
                "kind": "human_did_agents_job",
                "polarity": "extra_work",
                "confidence": "medium",
                "help_contract_id": "c1",
                "session_id": None,
                "snippet": "I'll just do the refund myself",
                "path": "ambient",
            }
        )
    assert out is issue
    kwargs = upsert.await_args.kwargs
    assert kwargs["agent_id"] == "agent-a"
    assert kwargs["reason"] == "took_over"
    assert kwargs["session_id"] is None
    assert kwargs["help_contract_id"] == "c1"
    expected_fp = compute_help_miss_fingerprint("org", "agent-a", "c1", "took_over")
    assert kwargs["fingerprint"] == expected_fp
    # snippet is passed through for the card, not the fingerprint
    assert kwargs["snippet"] == "I'll just do the refund myself"


@pytest.mark.asyncio
async def test_upsert_help_miss_notifies_only_on_create() -> None:
    from eden.issues.issue_promoter import IssuePromoter
    from eden.issues.models import Issue

    created = Issue(
        id="i1",
        org_id="org",
        fingerprint="fp1",
        kind=HELP_MISS_KIND,
        title="agent-a didn't help (took_over)",
        status="open",
        severity="p1",
        agent_id="agent-a",
        was_created=True,
    )
    bumped = Issue(
        id="i1",
        org_id="org",
        fingerprint="fp1",
        kind=HELP_MISS_KIND,
        title="agent-a didn't help (took_over)",
        status="open",
        severity="p1",
        agent_id="agent-a",
        stumble_count=2,
        was_created=False,
        was_regressed=False,
    )
    promoter = IssuePromoter()
    notify = AsyncMock()
    propose = AsyncMock(return_value={"status": "drafted", "plan_id": "p1"})
    with (
        patch.object(promoter, "_repo") as repo,
        patch.object(promoter, "_insert_help_miss", AsyncMock(return_value=created)),
        patch.object(promoter, "_update_help_miss", AsyncMock(return_value=bumped)),
        patch.object(promoter, "_notify_help_miss", notify),
        patch.object(promoter, "_propose_help_miss_plan", propose),
    ):
        conn = AsyncMock()
        acquire_cm = AsyncMock()
        acquire_cm.__aenter__.return_value = conn
        acquire_cm.__aexit__.return_value = None
        tx_cm = AsyncMock()
        tx_cm.__aenter__.return_value = None
        tx_cm.__aexit__.return_value = None
        client = MagicMock()
        client.acquire.return_value = acquire_cm
        client.transaction = MagicMock(return_value=tx_cm)
        # conn.transaction() is used as `async with conn.transaction()`
        conn.transaction = MagicMock(return_value=tx_cm)
        repo._client = AsyncMock(return_value=client)

        conn.fetchrow = AsyncMock(return_value=None)
        first = await promoter.upsert_help_miss(
            "org",
            agent_id="agent-a",
            fingerprint="fp1",
            reason="took_over",
            path="ambient",
        )
        assert first is created
        notify.assert_awaited_once()
        propose.assert_awaited_once()

        notify.reset_mock()
        propose.reset_mock()
        conn.fetchrow = AsyncMock(return_value={"id": "i1", "status": "open"})
        second = await promoter.upsert_help_miss(
            "org",
            agent_id="agent-a",
            fingerprint="fp1",
            reason="took_over",
        )
        assert second is bumped
        notify.assert_not_awaited()
        propose.assert_not_awaited()


@pytest.mark.asyncio
async def test_notify_help_miss_dedupe_key() -> None:
    from eden.issues.issue_promoter import IssuePromoter
    from eden.issues.models import Issue

    issue = Issue(
        id="i1",
        org_id="org",
        fingerprint="fp1",
        kind=HELP_MISS_KIND,
        title="t",
        status="open",
        severity="p1",
        agent_id="agent-a",
        was_created=True,
    )
    captured: dict = {}

    async def fake_notify(org_id, **kwargs):
        captured["org_id"] = org_id
        captured.update(kwargs)
        return {"status": "sent"}

    with patch("eden.services.slack_notify.notify_help_miss", fake_notify):
        await IssuePromoter()._notify_help_miss(
            issue,
            reason="took_over",
            session_id="sess-1",
            snippet="x",
            path="ambient",
            help_contract_id="c1",
        )
    assert captured["agent_id"] == "agent-a"
    assert captured["fingerprint"] == "fp1"
    # The send-level key is built inside notify_help_miss; assert the public contract.
    from eden.services import slack_notify

    send_captured: dict = {}

    async def fake_send(org_id, **kwargs):
        send_captured.update(kwargs)
        return {"status": "sent"}

    with patch.object(slack_notify, "_send", fake_send):
        await slack_notify.notify_help_miss(
            "org", agent_id="agent-a", fingerprint="fp1"
        )
    assert send_captured["dedupe_key"] == "helpmiss:agent-a:fp1"


@pytest.mark.asyncio
async def test_resolve_canary_arm_zero_one_many() -> None:
    from eden.agents.prompt_canary import resolve_canary_arm

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=None)

    client.fetch = AsyncMock(return_value=[])
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        assert await resolve_canary_arm("org", "agent-a") is None

    exp = {
        "experiment_id": "exp-1",
        "control_version": 1,
        "candidate_version": 2,
    }
    client.fetch = AsyncMock(
        side_effect=[
            [exp],
            [{"version": 2, "traffic_pct": 100, "experiment_id": "exp-1"}],
        ]
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        assert await resolve_canary_arm("org", "agent-a") == "treatment"

    client.fetch = AsyncMock(
        return_value=[
            {"experiment_id": "e1", "control_version": 1, "candidate_version": 2},
            {"experiment_id": "e2", "control_version": 3, "candidate_version": 4},
        ]
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        assert await resolve_canary_arm("org", "agent-a") is None


@pytest.mark.asyncio
async def test_resolve_canary_arm_reuses_session_arm() -> None:
    from eden.agents.prompt_canary import resolve_canary_arm

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"canary_arm": "control"})
    client.fetch = AsyncMock(side_effect=AssertionError("must not list experiments"))
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        assert await resolve_canary_arm("org", "agent-a", session_id="sess-1") == "control"


def _help_miss_issue() -> SimpleNamespace:
    return SimpleNamespace(
        id="i1",
        fingerprint="fp1",
        agent_id="agent-a",
        title="agent-a didn't help (took_over)",
        kind=HELP_MISS_KIND,
    )


def test_help_miss_draft_from_leftovers_never_attempted() -> None:
    from eden.improvement.issue_patch_trigger import (
        _NEVER_ATTEMPTED,
        build_help_miss_improve_draft,
        instruction_is_generic,
    )

    leftovers = [
        {"snippet": "I'll just process the refund myself", "kind": "human_did_agents_job"},
        {"snippet": "taking ENG-123, the bot never ran", "kind": "ill_just_do_it"},
        {"snippet": "I'll handle the chargeback", "kind": "human_did_agents_job"},
        {"snippet": "fourth leftover is dropped", "kind": "human_did_agents_job"},
    ]
    draft = build_help_miss_improve_draft(leftovers)
    assert draft is not None
    assert draft["never_attempted"] is True
    assert draft["summary"].splitlines()[0] == _NEVER_ATTEMPTED
    assert "I'll just process the refund myself" in draft["summary"]
    assert "taking ENG-123, the bot never ran" in draft["summary"]
    assert "I'll handle the chargeback" in draft["summary"]
    assert "fourth leftover is dropped" not in draft["summary"]
    assert len(draft["leftovers"]) == 3
    assert "Prompt canary aimed at" not in draft["summary"]
    assert not instruction_is_generic(draft["summary"])


def test_help_miss_draft_includes_paired_traces() -> None:
    from eden.improvement.issue_patch_trigger import build_help_miss_improve_draft

    leftovers = [
        {
            "snippet": "I'll just process the refund myself",
            "session_id": "sess-1",
            "trace_id": "tr-1",
            "kind": "thread_takeover",
        },
        {"snippet": "rewrote the reply in-thread", "session_id": "sess-2", "kind": "rewrite_new_message"},
    ]
    draft = build_help_miss_improve_draft(leftovers)
    assert draft is not None
    assert draft["never_attempted"] is False
    assert "this job was never attempted" not in draft["summary"]
    assert "I'll just process the refund myself" in draft["summary"]
    assert "session sess-1" in draft["summary"]
    assert "trace tr-1" in draft["summary"]
    assert "rewrote the reply in-thread" in draft["summary"]


def test_help_miss_draft_generic_or_empty_is_none() -> None:
    from eden.improvement.issue_patch_trigger import (
        build_help_miss_improve_draft,
        instruction_is_generic,
    )

    assert build_help_miss_improve_draft([]) is None
    assert build_help_miss_improve_draft([{"snippet": "   "}]) is None
    leftovers = [{"snippet": "I'll just process the refund myself"}]
    assert build_help_miss_improve_draft(leftovers, instruction="be more helpful") is None
    assert build_help_miss_improve_draft(leftovers, instruction="Follow the instructions") is None
    assert build_help_miss_improve_draft(leftovers, instruction="be careful") is None
    assert instruction_is_generic(
        "Prompt canary aimed at HelpMiss reason=took_over. Human approve."
    )


@pytest.mark.asyncio
async def test_propose_prompt_canary_draft_not_code_patch() -> None:
    from eden.improvement.issue_patch_trigger import propose_prompt_canary_for_help_miss

    issue = _help_miss_issue()
    leftovers = [
        {"snippet": "I'll just process the refund myself", "kind": "human_did_agents_job"},
        {"snippet": "taking ENG-123, the bot never ran", "kind": "ill_just_do_it"},
        {"snippet": "I'll handle the chargeback", "kind": "human_did_agents_job"},
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
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org",
            issue,
            reason="took_over",
            help_contract_id="c1",
            leftovers=leftovers,
        )
    assert out["status"] == "drafted"
    assert out["plan_kind"] == "prompt_update"
    assert out["never_attempted"] is True
    kwargs = create.await_args.kwargs
    assert kwargs["plan_kind"] == "prompt_update"
    assert kwargs["status"] == "draft"
    assert kwargs["source_fingerprint"] == "fp1"
    assert kwargs["source_ref"] == "help_miss:i1"
    assert kwargs["evidence"]["help_miss"] is True
    assert kwargs["evidence"]["reason"] == "took_over"
    assert kwargs["evidence"]["never_attempted"] is True
    shown = kwargs["evidence"]["leftovers"]
    assert [item["snippet"] for item in shown] == [
        "I'll just process the refund myself",
        "taking ENG-123, the bot never ran",
        "I'll handle the chargeback",
    ]
    assert "this job was never attempted" in kwargs["summary"]
    assert "I'll just process the refund myself" in kwargs["summary"]
    assert "Prompt canary aimed at" not in kwargs["summary"]

    with patch(
        "eden.improvement.plans_repo.find_open_by_fingerprint",
        AsyncMock(return_value={"id": "plan-1"}),
    ):
        again = await propose_prompt_canary_for_help_miss(
            "org", issue, reason="took_over", leftovers=leftovers
        )
    assert again["status"] == "suppressed"
    assert again["reason"] == "duplicate_open_plan"


@pytest.mark.asyncio
async def test_propose_prompt_canary_no_leftovers_is_no_draft() -> None:
    from eden.improvement.issue_patch_trigger import propose_prompt_canary_for_help_miss

    issue = _help_miss_issue()
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(side_effect=AssertionError("must not invent a draft")),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org", issue, reason="took_over", leftovers=[]
        )
    assert out["status"] == "suppressed"
    assert out["reason"] == "no_leftovers"


@pytest.mark.asyncio
async def test_propose_prompt_canary_generic_instruction_is_no_draft() -> None:
    from eden.improvement.issue_patch_trigger import propose_prompt_canary_for_help_miss

    issue = _help_miss_issue()
    leftovers = [{"snippet": "I'll just process the refund myself"}]
    with (
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(side_effect=AssertionError("must not offer a generic draft")),
        ),
    ):
        out = await propose_prompt_canary_for_help_miss(
            "org",
            issue,
            reason="took_over",
            leftovers=leftovers,
            instruction="be more helpful",
        )
    assert out["status"] == "suppressed"
    assert out["reason"] == "generic_draft"


@pytest.mark.asyncio
async def test_insert_extra_work_promotes_and_does_not_write_stumbles() -> None:
    from eden.integrations.slack import store as slack_store

    row = {
        "id": "e1",
        "org_id": "org",
        "agent_id": "agent-a",
        "kind": "human_did_agents_job",
        "confidence": "high",
        "polarity": "extra_work",
        "help_contract_id": "c1",
        "session_id": None,
        "snippet": "x",
        "path": "ambient",
        "canary_arm": "treatment",
        "user_id": None,
        "event_id": "evt-1",
    }
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value=row)
    promote = AsyncMock(return_value=SimpleNamespace(kind=HELP_MISS_KIND))
    with (
        patch.object(slack_store, "_pg", AsyncMock(return_value=client)),
        patch(
            "eden.agents.prompt_canary.resolve_canary_arm",
            AsyncMock(return_value="treatment"),
        ),
        patch(
            "eden.issues.issue_promoter.promote_from_extra_work",
            promote,
        ),
        patch("eden.issues.stumble_writer.StumbleWriter") as stumble_cls,
    ):
        out = await slack_store.insert_extra_work_event(
            "org",
            agent_id="agent-a",
            event_id="evt-1",
            user_id=None,
            help_contract_id="c1",
            surface="slack",
            kind="human_did_agents_job",
            path="ambient",
            join_key={"system": "slack"},
            snippet="x",
            confidence="high",
            polarity="extra_work",
            raw={"event_id": "evt-1"},
            observed_at="2026-08-14T00:00:00Z",
        )
    assert out is not None
    assert out["canary_arm"] == "treatment"
    promote.assert_awaited_once()
    stumble_cls.assert_not_called()


def test_code_change_enabled_stays_false() -> None:
    from eden.config import Settings

    # Product flag, not a git merge switch. Default must remain False.
    field = Settings.model_fields["code_change_enabled"]
    assert field.default is False
