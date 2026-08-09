"""FEAT-166 — run_prompt_lint rename / run_auto_eval alias."""

from __future__ import annotations

from eden.services import prompt_versioning as pv


def test_run_auto_eval_is_alias_of_run_prompt_lint() -> None:
    assert pv.run_auto_eval is pv.run_prompt_lint


def test_run_prompt_lint_docstring_says_not_dataset_eval() -> None:
    doc = pv.run_prompt_lint.__doc__ or ""
    assert "does NOT evaluate against a dataset" in doc
    assert "clarity" in doc.lower() or "specificity" in doc.lower()
