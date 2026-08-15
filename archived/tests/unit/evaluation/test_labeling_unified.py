"""Tests for FEAT-162 labeling_unified bridge."""

from eden.evaluation.labeling_unified import (
    LABEL_SOURCE_TOOL_CALL,
    label_subject_key,
)


def test_label_subject_key_is_stable() -> None:
    a = label_subject_key("org-1", LABEL_SOURCE_TOOL_CALL, "span-1")
    b = label_subject_key("org-1", LABEL_SOURCE_TOOL_CALL, "span-1")
    c = label_subject_key("org-2", LABEL_SOURCE_TOOL_CALL, "span-1")
    assert a == b
    assert a != c
