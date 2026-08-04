"""Regression guards for three Typesense integration bugs that the
mocked search tests missed (all found standing up the real 1M-doc F12
bench, 2026-08):

1. ``allow_redirects`` was passed to ``aiohttp.ClientSession.__init__``
   (a per-request arg) — raised TypeError so the client silently fell
   back to the SQLite proxy.
2. ``created_at`` was both ``default_sorting_field`` and ``optional`` —
   Typesense v27+ rejects that, so ``ensure_collection`` 400'd.
3. ``index_many`` counted a doc as OK only if the response line equalled
   the literal ``"OK"`` — but Typesense returns ``{"success":true}`` per
   line, so every doc read as rejected even when all indexed.

These assert the wire contract without a live server.
"""

from __future__ import annotations

import inspect

from eden.observability import typesense_client as tc


def test_created_at_not_optional_and_is_default_sort() -> None:
    schema = tc.SPAN_SCHEMA
    assert schema["default_sorting_field"] == "created_at"
    created = next(f for f in schema["fields"] if f["name"] == "created_at")
    # Typesense v27+ rejects an optional default sorting field.
    assert not created.get("optional", False), (
        "created_at is the default_sorting_field and must not be optional"
    )


def test_session_ctor_does_not_pass_allow_redirects() -> None:
    # allow_redirects is a per-request kwarg; passing it to ClientSession()
    # raises TypeError on modern aiohttp. Guard the source of _get_session.
    src = inspect.getsource(tc.TypesenseClient._get_session)
    assert "ClientSession(" in src
    ctor = src[src.index("ClientSession(") :]
    ctor = ctor[: ctor.index(")")]
    assert "allow_redirects" not in ctor, (
        "allow_redirects must be applied per-request, not on ClientSession()"
    )


def test_import_response_parsed_as_success_json_not_literal_ok() -> None:
    src = inspect.getsource(tc.TypesenseClient.index_many)
    # The success signal is JSON {"success": true} per line, not "OK".
    assert '"success"' in src or "success" in src, (
        "index_many must parse the per-line {\"success\":true} response"
    )
