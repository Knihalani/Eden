"""BUG-30: retrain_tool_calibrator requires a typed Pydantic body."""

from __future__ import annotations

import inspect

import pytest
from pydantic import ValidationError

from eden.api.routes.tool_call_labels import (
    RetrainToolCalibratorBody,
    retrain_tool_calibrator,
)


def test_retrain_body_requires_tool_name() -> None:
    with pytest.raises(ValidationError):
        RetrainToolCalibratorBody()


def test_retrain_body_rejects_empty_tool_name() -> None:
    with pytest.raises(ValidationError):
        RetrainToolCalibratorBody(tool_name="")


def test_retrain_body_accepts_tool_name() -> None:
    body = RetrainToolCalibratorBody(tool_name="search")
    assert body.tool_name == "search"


def test_retrain_handler_uses_pydantic_body() -> None:
    """Missing/empty tool_name must 422 via FastAPI, not return 200+error string."""
    hints = inspect.get_annotations(retrain_tool_calibrator)
    assert hints["body"] is RetrainToolCalibratorBody or hints["body"] == "RetrainToolCalibratorBody"
    src = inspect.getsource(retrain_tool_calibrator)
    assert "tool_name required" not in src
    assert "RetrainToolCalibratorBody" in src
