"""Unit tests for FEAT-143 topic-cluster dedup helpers."""

from __future__ import annotations

from eden.observability.patterns_clusterer import (
    dedupe_cluster_members,
    stable_pattern_id,
)


def test_dedupe_collapses_duplicate_trace_ids() -> None:
    topics = ["reset password", "reset password again", "other"]
    traces = ["t1", "t1", "t2"]
    out_topics, out_traces = dedupe_cluster_members(topics, traces)
    assert out_traces == ["t1", "t2"]
    assert out_topics == ["reset password", "other"]


def test_dedupe_collapses_identical_topics_without_trace() -> None:
    topics = ["How do I reset?", "  how do i reset?  ", "billing"]
    traces = ["", "", ""]
    out_topics, out_traces = dedupe_cluster_members(topics, traces)
    assert len(out_topics) == 2
    assert out_topics[0] == "How do I reset?"
    assert out_topics[1] == "billing"
    assert out_traces == ["", ""]


def test_stable_pattern_id_is_deterministic() -> None:
    a = stable_pattern_id("org-1", "Password Reset")
    b = stable_pattern_id("org-1", "  password reset  ")
    c = stable_pattern_id("org-2", "Password Reset")
    assert a == b
    assert a != c
