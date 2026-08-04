"""M9 (§4.3): PR body evidence table rendering.

The table must render whatever evidence the plan actually carries —
tier badge, static/replay/sandbox statuses (incl. the M8
``synthesized: true`` marker), failure signature, example traces,
issue link — and degrade to em-dashes for anything absent. It must
stay compact: humans review it at merge time.
"""

from __future__ import annotations

from eden.improvement.approve import render_pr_evidence_body


def _full_evidence_plan(tier: str = "tested") -> dict:
    return {
        "id": "plan-1",
        "evidence": {
            "issue_id": "iss-1",
            "evidence_tier": tier,
            "example_trace_ids": ["tr-a", "tr-b", "tr-c", "tr-d"],
            "hermetic_preverify": {"status": "static_passed", "detail": {}},
            "replay": {
                "status": "passed",
                "reason": "signature_absent_in_replay",
                "cost_usd": 0.01,
                "traces_checked": 1,
                "details": {},
            },
            "sandbox_tests": {
                "status": "passed",
                "reason": "tests_passed",
                "tests_run": ["tests/test_foo.py"],
                "failures": 0,
                "output_excerpt": "",
                "synthesized": True,
                "cost_usd": 0.0,
                "details": {},
            },
            "failure_signature": {
                "stumble_kind": "tool_error",
                "error_substring": "boom",
                "failing_span_name": "tool.call",
                "judge_dimension": None,
            },
        },
    }


class TestTiers:
    def test_all_tiers_render_as_badges(self) -> None:
        for tier in ("tested", "replay", "static"):
            body = render_pr_evidence_body(
                _full_evidence_plan(tier), plan_id="plan-1", summary="Fix foo"
            )
            assert f"| Evidence tier | **{tier}** |" in body

    def test_table_carries_all_evidence_rows(self) -> None:
        body = render_pr_evidence_body(
            _full_evidence_plan(),
            plan_id="plan-1",
            summary="Fix foo",
            static_status="passed",
        )
        assert body.startswith("Fix foo")
        assert "| Static checks | passed |" in body
        assert "passed (signature_absent_in_replay)" in body
        assert "tool_error" in body and "boom" in body
        assert "`tr-a`" in body and "`tr-c`" in body
        assert "`tr-d`" not in body  # capped at 3
        assert "iss-1" in body
        assert "plan-1" in body

    def test_static_status_falls_back_to_hermetic_stamp(self) -> None:
        body = render_pr_evidence_body(
            _full_evidence_plan(), plan_id="plan-1", summary="s"
        )
        assert "| Static checks | static_passed |" in body


class TestSynthesizedAnnotation:
    def test_synthesized_marker_present_when_true(self) -> None:
        body = render_pr_evidence_body(
            _full_evidence_plan(), plan_id="plan-1", summary="s"
        )
        assert "`synthesized: true`" in body

    def test_no_marker_for_human_authored_tests(self) -> None:
        plan = _full_evidence_plan()
        plan["evidence"]["sandbox_tests"]["synthesized"] = False
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="s")
        assert "synthesized" not in body


class TestCompactness:
    def test_body_stays_under_forty_lines(self) -> None:
        plan = _full_evidence_plan()
        plan["evidence"]["suppress_reasons"] = ["late_review"]
        plan["evidence"]["ci_ingestion"] = "unavailable"
        body = render_pr_evidence_body(
            plan, plan_id="plan-1", summary="s", static_status="passed"
        )
        assert len(body.splitlines()) <= 40

    def test_long_values_truncated_and_pipes_escaped(self) -> None:
        plan = _full_evidence_plan()
        plan["evidence"]["failure_signature"]["error_substring"] = "a | b\nc" + "x" * 500
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="s")
        row = next(line for line in body.splitlines() if "Failure signature" in line)
        assert "\\|" in row
        assert len(row) < 250


class TestGracefulAbsence:
    def test_empty_evidence_renders_dashes(self) -> None:
        body = render_pr_evidence_body({}, plan_id="plan-1", summary="Fix foo")
        assert body.startswith("Fix foo")
        assert "| Evidence tier | **—** |" in body
        assert "| Replay verify | — |" in body
        assert "| Sandbox tests | — |" in body
        assert "| Issue | — |" in body
        assert "Suppress reasons" not in body

    def test_non_dict_evidence_tolerated(self) -> None:
        body = render_pr_evidence_body(
            {"evidence": "corrupt"}, plan_id="plan-1", summary="s"
        )
        assert "| Evidence tier | **—** |" in body

    def test_ci_unavailable_stamp_renders_row(self) -> None:
        plan = {"evidence": {"ci_ingestion": "unavailable"}}
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="s")
        assert "checks:read" in body


class TestTierHonesty:
    """A plan carrying ONLY static-check evidence can never be labeled
    "tested" — end to end from the tier ladder to the rendered PR body."""

    @staticmethod
    def _static_only_payload(
        *,
        replay: dict | None = None,
        sandbox_tests: dict | None = None,
    ) -> dict:
        from types import SimpleNamespace

        from eden.improvement.issue_patch_trigger import (
            _plan_payload_from_patch,
        )

        ctx = {
            "issue": SimpleNamespace(
                severity="P1", title="Fix foo", stumble_count=3
            ),
            "triage": {"confidence": 0.9},
            "agent_id": "planner",
        }
        return _plan_payload_from_patch(
            "org-1",
            "issue-1",
            ctx,
            {"description": "Fix foo", "diff": "--- a\n+++ b", "files": []},
            hermetic_preverify={"status": "static_passed"},
            replay=replay,
            sandbox_tests=sandbox_tests,
        )

    def test_static_only_plan_is_tier_static(self) -> None:
        payload = self._static_only_payload()
        assert payload["evidence"]["evidence_tier"] == "static"

    def test_skipped_sandbox_and_failed_replay_stay_static(self) -> None:
        payload = self._static_only_payload(
            replay={"status": "failed", "reason": "signature_reproduced"},
            sandbox_tests={"status": "skipped", "reason": "no_tests_found"},
        )
        assert payload["evidence"]["evidence_tier"] == "static"

    def test_static_only_body_never_says_tested(self) -> None:
        payload = self._static_only_payload(
            sandbox_tests={"status": "skipped", "reason": "no_tests_found"},
        )
        body = render_pr_evidence_body(
            {"evidence": payload["evidence"]},
            plan_id="plan-1",
            summary="Fix foo",
            static_status="static_passed",
        )
        assert "| Evidence tier | **static** |" in body
        assert "**tested**" not in body

    def test_only_passed_sandbox_earns_tested(self) -> None:
        for status in ("failed", "skipped", "error", None):
            payload = self._static_only_payload(
                sandbox_tests=(
                    {"status": status} if status is not None else None
                ),
            )
            assert payload["evidence"]["evidence_tier"] != "tested"
        passed = self._static_only_payload(
            sandbox_tests={"status": "passed"},
        )
        assert passed["evidence"]["evidence_tier"] == "tested"
