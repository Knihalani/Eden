"""P2.1: leftover-work rate vs control is the only SHIP check."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from eden.closed_loop import verify
from eden.improvement.post_merge_monitor import PostMergeMonitor
from eden.issues.statgate_p0_rail import (
    BLOCK,
    INCONCLUSIVE,
    LEFTOVER_MIN_N,
    SHIP,
    leftover_rates,
    leftover_work_verdict,
)
from eden.promotion.evidence_gate import EvidenceGate


def _ship_kwargs(**overrides: object) -> dict[str, object]:
    rates = leftover_rates(
        extra_work_control=10,
        extra_work_treatment=4,
        n_control=20,
        n_treatment=20,
        unknown_n=2,
    )
    out: dict[str, object] = {
        **rates,
        "listen_silent": False,
        "mapped_channel": True,
    }
    out.update(overrides)
    return out


def test_leftover_min_n_is_product_floor() -> None:
    assert LEFTOVER_MIN_N == 20


def test_treatment_extra_work_down_n20_unknown_low_ships() -> None:
    verdict, detail = leftover_work_verdict(**_ship_kwargs())
    assert verdict == SHIP
    assert detail["reason"] == "extra_work_fell"
    assert detail["n_control"] == 20
    assert detail["n_treatment"] == 20
    assert detail["unknown_share"] < 0.5


def test_issue_rate_quiet_extra_work_unchanged_is_not_ship() -> None:
    rates = leftover_rates(
        extra_work_control=8,
        extra_work_treatment=8,
        n_control=20,
        n_treatment=20,
        unknown_n=0,
    )
    verdict, detail = leftover_work_verdict(
        **rates,
        listen_silent=False,
        mapped_channel=True,
        issue_rate_quiet=True,
        issue_rate=0,
    )
    assert verdict != SHIP
    assert detail["reason"] == "extra_work_unchanged"


def test_slack_quieter_ambient_unchanged_is_not_ship() -> None:
    rates = leftover_rates(
        extra_work_control=8,
        extra_work_treatment=8,
        n_control=20,
        n_treatment=20,
        unknown_n=0,
    )
    verdict, _ = leftover_work_verdict(
        **rates,
        listen_silent=False,
        mapped_channel=True,
        slack_quieter=True,
        slack_message_volume_down=True,
    )
    assert verdict != SHIP


def test_thumbs_up_clean_trace_eval_up_is_not_ship() -> None:
    rates = leftover_rates(
        extra_work_control=8,
        extra_work_treatment=8,
        n_control=20,
        n_treatment=20,
        unknown_n=0,
    )
    verdict, _ = leftover_work_verdict(
        **rates,
        listen_silent=False,
        mapped_channel=True,
        thumbs_up=True,
        clean_trace=True,
        eval_score_up=True,
        traces_flowing=True,
    )
    assert verdict != SHIP


def test_listen_kicked_traces_flowing_is_inconclusive() -> None:
    verdict, detail = leftover_work_verdict(
        **_ship_kwargs(listen_silent=True, traces_flowing=True)
    )
    assert verdict == INCONCLUSIVE
    assert detail["reason"] == "listen_silent"


def test_unmapped_channel_is_inconclusive() -> None:
    verdict, detail = leftover_work_verdict(**_ship_kwargs(mapped_channel=False))
    assert verdict == INCONCLUSIVE
    assert detail["reason"] == "listen_silent"


def test_n3_is_inconclusive() -> None:
    rates = leftover_rates(
        extra_work_control=1,
        extra_work_treatment=0,
        n_control=3,
        n_treatment=3,
        unknown_n=0,
    )
    verdict, detail = leftover_work_verdict(
        **rates, listen_silent=False, mapped_channel=True
    )
    assert verdict == INCONCLUSIVE
    assert detail["reason"] == "thin_n"


def test_unknown_share_0_8_is_inconclusive() -> None:
    verdict, detail = leftover_work_verdict(
        n_control=20,
        n_treatment=20,
        extra_work_rate_control=0.5,
        extra_work_rate_treatment=0.2,
        unknown_share=0.8,
        listen_silent=False,
        mapped_channel=True,
    )
    assert verdict == INCONCLUSIVE
    assert detail["reason"] == "unknown_share"


def test_treatment_worse_with_enough_n_blocks() -> None:
    rates = leftover_rates(
        extra_work_control=4,
        extra_work_treatment=12,
        n_control=20,
        n_treatment=20,
        unknown_n=0,
    )
    verdict, detail = leftover_work_verdict(
        **rates, listen_silent=False, mapped_channel=True
    )
    assert verdict == BLOCK
    assert detail["reason"] == "extra_work_worse"


@pytest.mark.asyncio
async def test_help_miss_verify_uses_leftover_only() -> None:
    issue = SimpleNamespace(
        id="iss-help",
        kind="help_miss",
        agent_id="ops-agent",
        fingerprint="fp-help",
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    payload = _ship_kwargs()
    with (
        patch("eden.issues.repo.IssuesRepo", return_value=repo),
        patch.object(
            verify, "collect_leftover_canary_input", AsyncMock(return_value=payload)
        ),
    ):
        passed, detail = await verify._verify_issue("org", "iss-help", "fp-help")
    assert passed is True
    assert detail["verdict"] == SHIP
    repo.count_recent_stumbles.assert_not_called()


@pytest.mark.asyncio
async def test_help_miss_issue_rate_quiet_does_not_ship() -> None:
    issue = SimpleNamespace(
        id="iss-help",
        kind="help_miss",
        agent_id="ops-agent",
        fingerprint="fp-help",
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.count_recent_stumbles = AsyncMock(return_value=0)
    rates = leftover_rates(
        extra_work_control=8,
        extra_work_treatment=8,
        n_control=20,
        n_treatment=20,
        unknown_n=0,
    )
    payload = {**rates, "listen_silent": False, "mapped_channel": True}
    with (
        patch("eden.issues.repo.IssuesRepo", return_value=repo),
        patch.object(
            verify, "collect_leftover_canary_input", AsyncMock(return_value=payload)
        ),
    ):
        passed, detail = await verify._verify_issue("org", "iss-help", "fp-help")
    assert passed is not True
    assert detail["verdict"] != SHIP


@pytest.mark.asyncio
async def test_help_miss_listen_silent_is_inconclusive() -> None:
    issue = SimpleNamespace(
        id="iss-help",
        kind="help_miss",
        agent_id="ops-agent",
        fingerprint="fp-help",
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    payload = _ship_kwargs(listen_silent=True)
    with (
        patch("eden.issues.repo.IssuesRepo", return_value=repo),
        patch.object(
            verify, "collect_leftover_canary_input", AsyncMock(return_value=payload)
        ),
    ):
        passed, detail = await verify._verify_issue("org", "iss-help", "fp-help")
    assert passed is None
    assert detail["verdict"] == INCONCLUSIVE


def test_evidence_gate_leftover_n_missing_holds_even_if_stumble_better() -> None:
    gate = EvidenceGate()
    org_id = str(uuid4())
    cid = str(uuid4())

    class _Client:
        candidates = {
            cid: {
                "id": cid,
                "org_id": org_id,
                "kind": "prompt_version",
                "ref_id": "agent:7",
                "status": "shadow",
                "evidence": {
                    "control": [0.9] * 60,
                    "treatment": [0.1] * 60,
                },
            }
        }

        async def fetchrow(self, query: str, *args):
            return self.candidates.get(str(args[1]))

        async def execute(self, query: str, *args):
            return "OK"

    client = _Client()

    async def _get():
        return client

    with patch("eden.storage.postgres.get_postgres_client", _get):
        report = asyncio.run(gate.evaluate(org_id, cid))
    assert report.passed is False
    assert report.recommendation == "hold"
    assert "leftover" in report.explanation.lower()


def test_evidence_gate_leftover_ship_promotes_prompt_version() -> None:
    gate = EvidenceGate()
    org_id = str(uuid4())
    cid = str(uuid4())
    rates = leftover_rates(
        extra_work_control=10,
        extra_work_treatment=3,
        n_control=20,
        n_treatment=20,
        unknown_n=1,
    )

    class _Client:
        candidates = {
            cid: {
                "id": cid,
                "org_id": org_id,
                "kind": "prompt_version",
                "ref_id": "agent:7",
                "status": "shadow",
                "evidence": {
                    "leftover_n_control": rates["n_control"],
                    "leftover_n_treatment": rates["n_treatment"],
                    "leftover_extra_control": 10,
                    "leftover_extra_treatment": 3,
                    "leftover_unknown_n": 1,
                    "listen_silent": False,
                    "mapped_channel": True,
                },
            }
        }

        async def fetchrow(self, query: str, *args):
            return self.candidates.get(str(args[1]))

        async def execute(self, query: str, *args):
            return "OK"

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_Client()),
    ):
        report = asyncio.run(gate.evaluate(org_id, cid))
    assert report.passed is True
    assert report.recommendation == "promote"
    assert report.gate_verdict == SHIP


@pytest.mark.asyncio
async def test_post_merge_issue_rate_quiet_extra_work_unchanged_not_ok() -> None:
    client = MagicMock()
    client.execute = AsyncMock(return_value="UPDATE 1")
    opened = __import__("datetime").datetime(2026, 8, 1, tzinfo=__import__("datetime").UTC)
    window = {
        "id": "pmw_24",
        "org_id": "org",
        "plan_id": "plan",
        "agent_id": "agent",
        "window_hours": 24,
        "opened_at": opened,
        "closes_at": opened,
        "pre_issue_rate": 0.3,
        "evidence": {
            "leftover_pre": {
                "extra_work_n": 8,
                "resolved_n": 20,
                "unknown_n": 0,
                "rate": 0.4,
                "mapped_channel": True,
                "listen_silent": False,
            }
        },
    }
    client.fetch = AsyncMock(return_value=[window])
    client.fetchval = AsyncMock(return_value=0)  # issue-rate quiet
    monitor = PostMergeMonitor()
    post_stats = {
        "extra_work_n": 8,
        "resolved_n": 20,
        "unknown_n": 0,
        "rate": 0.4,
        "mapped_channel": True,
        "listen_silent": False,
    }
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(monitor, "_threshold_pct", AsyncMock(return_value=10.0)),
        patch.object(
            monitor, "_leftover_window_stats", AsyncMock(return_value=post_stats)
        ),
        patch("eden.improvement.plans_repo.emit_event", AsyncMock()) as emit,
        patch("eden.services.slack_notify.notify_help_miss_result", AsyncMock()) as posted,
    ):
        summary = await monitor.run_due()
    assert summary["ok"] == 0
    assert summary["degrading"] == 0
    update = client.execute.await_args.args
    assert update[3] == "pending"
    emit.assert_not_awaited()
    posted.assert_awaited()


def test_leftover_result_copy_never_calls_quiet_a_win() -> None:
    from eden.services.slack_notify import leftover_result_copy

    assert leftover_result_copy("SHIP") == "Leftover went down — the change worked."
    assert leftover_result_copy("BLOCK") == "Leftover did not go down — the change failed."
    assert leftover_result_copy("BLOCK", apply_kind="instruction_replace") == (
        "This job still needs a person."
    )
    assert leftover_result_copy("INCONCLUSIVE") == "We cannot tell."
    assert leftover_result_copy("INCONCLUSIVE", reason="extra_work_unchanged") == (
        "Leftover did not go down — the change failed."
    )
    assert leftover_result_copy(
        "INCONCLUSIVE",
        reason="extra_work_unchanged",
        apply_kind="instruction_replace",
    ) == "This job still needs a person."
