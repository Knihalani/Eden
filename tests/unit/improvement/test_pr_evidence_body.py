"""M9 (§4.3): PR body evidence table rendering.

The table must render whatever evidence the plan actually carries —
tier badge, static/replay/sandbox statuses (incl. the M8
``synthesized: true`` marker), failure signature, example traces,
issue link — and degrade to em-dashes for anything absent. It must
stay compact: humans review it at merge time.

W2-8 (§9.1): judge-score delta section is always present — real scores
when judge_score_deltas is stamped in evidence, 'no judge baseline yet'
fallback otherwise.  Contract: 100% of PR bodies carry the section.
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
    def test_body_stays_under_fifty_lines(self) -> None:
        # W2-8: expanded from 40 to 50 to accommodate the judge-score delta
        # section (adds ~5 lines for the no-baseline fallback).
        plan = _full_evidence_plan()
        plan["evidence"]["suppress_reasons"] = ["late_review"]
        plan["evidence"]["ci_ingestion"] = "unavailable"
        body = render_pr_evidence_body(
            plan, plan_id="plan-1", summary="s", static_status="passed"
        )
        assert len(body.splitlines()) <= 50

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


class TestJudgeScoreDeltaSection:
    """W2-8 (§9.1) contract: judge-score section ALWAYS appears in PR body."""

    def test_judge_section_present_with_scores(self) -> None:
        """When judge_score_deltas is stamped, PR body contains the table."""
        plan = _full_evidence_plan()
        plan["evidence"]["judge_score_deltas"] = [
            {"judge": "quality", "before": 0.72, "after": 0.85, "delta": 0.13},
            {"judge": "relevance", "before": 0.60, "after": 0.58, "delta": -0.02},
        ]
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="Fix foo")
        # Table header must be present.
        assert "| Judge | Before | After | Delta |" in body
        # Real judge rows must be present.
        assert "quality" in body
        assert "0.720" in body and "0.850" in body and "+0.130" in body
        assert "relevance" in body and "-0.020" in body
        # One-line interpretation present.
        assert "judge(s) improved" in body or "degraded" in body or "mixed signal" in body
        # Fallback row must NOT appear when real scores exist.
        assert "no judge baseline yet" not in body

    def test_judge_section_fallback_when_no_scores(self) -> None:
        """When no judge_score_deltas, PR body contains the 'no judge baseline yet' row."""
        plan = _full_evidence_plan()
        # Ensure no judge_score_deltas key is present.
        plan["evidence"].pop("judge_score_deltas", None)
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="Fix foo")
        assert "| Judge | Before | After | Delta |" in body
        assert "no judge baseline yet" in body
        assert "code-patch lane" in body

    def test_judge_section_fallback_when_empty_list(self) -> None:
        """Empty judge_score_deltas list also triggers the fallback row."""
        plan = _full_evidence_plan()
        plan["evidence"]["judge_score_deltas"] = []
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="Fix foo")
        assert "| Judge | Before | After | Delta |" in body
        assert "no judge baseline yet" in body

    def test_judge_section_always_present_on_empty_evidence(self) -> None:
        """Even on an empty-evidence plan the judge section appears."""
        body = render_pr_evidence_body({}, plan_id="plan-1", summary="Fix foo")
        assert "| Judge | Before | After | Delta |" in body
        assert "no judge baseline yet" in body

    def test_judge_only_improving_interpretation(self) -> None:
        plan = _full_evidence_plan()
        plan["evidence"]["judge_score_deltas"] = [
            {"judge": "safety", "before": 0.80, "after": 0.90, "delta": 0.10},
        ]
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="s")
        assert "improved" in body
        assert "degraded" not in body.lower().split("improved")[0]  # before the word

    def test_judge_only_degrading_interpretation(self) -> None:
        plan = _full_evidence_plan()
        plan["evidence"]["judge_score_deltas"] = [
            {"judge": "safety", "before": 0.90, "after": 0.80, "delta": -0.10},
        ]
        body = render_pr_evidence_body(plan, plan_id="plan-1", summary="s")
        assert "degraded" in body

    def test_judge_section_does_not_break_compactness(self) -> None:
        """Full judge table with 5 judges still stays under 50 lines."""
        plan = _full_evidence_plan()
        plan["evidence"]["suppress_reasons"] = ["late_review"]
        plan["evidence"]["ci_ingestion"] = "unavailable"
        plan["evidence"]["judge_score_deltas"] = [
            {"judge": f"judge_{i}", "before": 0.7, "after": 0.75, "delta": 0.05}
            for i in range(5)
        ]
        body = render_pr_evidence_body(
            plan, plan_id="plan-1", summary="s", static_status="passed"
        )
        # Relaxed to 50 for the judge section; original 40-line contract was
        # pre-W2-8 and must expand to accommodate the new table.
        assert len(body.splitlines()) <= 50


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
