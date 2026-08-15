"""The portal's key-scope vocabulary must actually unlock ingest/gateway.

Regression guard for the highest-impact bug found in the July 2026 sweep:
``clients/portal/src/lab/fixtures/settings.ts`` offered five scopes in the
Settings → API Keys UI (``ingest``, ``traces:write``, ``traces:read``,
``evals:run``, ``datasets:read``) and defaulted the form to ``["ingest"]``.
``VALID_SCOPES`` in ``routes/api_keys.py`` accepted all five, so key
creation succeeded — but none of them were members of ``INGEST_SCOPES`` or
``GATEWAY_SCOPES`` in ``deps.py``, so every key a user minted the obvious
way was rejected on every ingest and every gateway call.

A follow-on gap: the picker had no gateway-flavoured scope at all, so
``/gateway/v1`` keys could not be minted from the UI. ``gateway:write``
was added to the union/options and the form default is now
``["ingest", "gateway:write"]`` — matching ``_DEFAULT_CREATE_SCOPES``.

Three invariants are pinned here:

1. Every scope the portal can send is accepted by the backend validator.
2. Every scope the portal advertises as granting ingest actually grants it.
3. The portal's gateway scope actually grants ``GATEWAY_SCOPES``.

The second is the one that was broken. If someone adds a scope to the
portal picker without wiring it into a family in ``deps.py``, this fails.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from eden.api.deps import (
    GATEWAY_SCOPES,
    INGEST_SCOPES,
    api_key_has_scope,
    expand_scope_aliases,
)
from eden.api.routes.api_keys import _DEFAULT_CREATE_SCOPES, VALID_SCOPES

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PORTAL_FIXTURE = (
    _REPO_ROOT / "clients" / "portal" / "src" / "lab" / "fixtures" / "settings.ts"
)
_PORTAL_KEYS_VIEW = (
    _REPO_ROOT
    / "clients"
    / "portal"
    / "src"
    / "lab"
    / "settings"
    / "settings-keys-view.tsx"
)


def _strip_ts_comments(src: str) -> str:
    """Drop ``//`` and ``/* */`` comments.

    Must run *before* any ``(.*?);`` scan: the union members carry prose
    notes pointing at ``deps.py``, and a semicolon or a quoted word inside
    one of those notes would otherwise truncate the match or masquerade as
    a scope literal.
    """
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", src)


def _portal_key_scopes() -> list[str]:
    """Parse the ``KeyScope`` union out of the portal fixture module."""
    src = _strip_ts_comments(_PORTAL_FIXTURE.read_text(encoding="utf-8"))
    match = re.search(r"export type KeyScope\s*=\s*(.*?);", src, re.DOTALL)
    assert match, "KeyScope union not found — did the fixture module move?"
    return re.findall(r'"([^"]+)"', match.group(1))


def _portal_default_form_scopes() -> list[str]:
    """Parse ``DEFAULT_SCOPES`` — the pre-checked boxes in the create form."""
    src = _strip_ts_comments(_PORTAL_KEYS_VIEW.read_text(encoding="utf-8"))
    match = re.search(
        r"const DEFAULT_SCOPES\s*:\s*KeyScope\[\]\s*=\s*(\[.*?\]);", src, re.DOTALL
    )
    assert match, "DEFAULT_SCOPES not found — did the create form change shape?"
    return re.findall(r'"([^"]+)"', match.group(1))


@pytest.mark.skipif(
    not _PORTAL_FIXTURE.exists(), reason="portal source not present in this checkout"
)
def test_every_portal_scope_is_accepted_by_the_backend_validator() -> None:
    missing = [s for s in _portal_key_scopes() if s not in VALID_SCOPES]
    assert not missing, (
        f"portal offers scopes the API rejects at create time: {missing}"
    )


@pytest.mark.skipif(
    not _PORTAL_FIXTURE.exists(), reason="portal source not present in this checkout"
)
def test_portal_ingest_scopes_actually_grant_ingest() -> None:
    """A key minted with the portal's ingest-flavoured scopes must pass
    the ingest gate. This is the bug: it did not."""
    for scope in ("ingest", "traces:write"):
        assert scope in _portal_key_scopes(), f"{scope} vanished from the picker"
        assert api_key_has_scope([scope], INGEST_SCOPES), (
            f"a key scoped {scope!r} is rejected by every ingest route"
        )


@pytest.mark.skipif(
    not _PORTAL_FIXTURE.exists(), reason="portal source not present in this checkout"
)
def test_portal_gateway_scope_actually_grants_gateway() -> None:
    """The picker must expose a scope that unlocks ``/gateway/v1``.

    Before this existed a user could not mint a gateway key from the UI
    at all — they had to POST /api-keys by hand. ``gateway:write`` is
    canonical in ``deps.py``; no alias expansion is involved.
    """
    scopes = _portal_key_scopes()
    granting = [s for s in scopes if api_key_has_scope([s], GATEWAY_SCOPES)]
    assert granting, (
        "no scope in the portal picker grants GATEWAY_SCOPES — "
        f"the OpenAI-compatible gateway is unreachable from Settings: {scopes}"
    )
    assert "gateway:write" in scopes, "gateway:write vanished from the picker"
    assert api_key_has_scope(["gateway:write"], GATEWAY_SCOPES)
    # It must stay a passthrough, not an alias that also widens ingest.
    assert expand_scope_aliases(["gateway:write"]) == {"gateway:write"}
    assert not api_key_has_scope(["gateway:write"], INGEST_SCOPES)


@pytest.mark.skipif(
    not _PORTAL_KEYS_VIEW.exists(), reason="portal source not present in this checkout"
)
def test_portal_default_form_scopes_grant_ingest_and_gateway() -> None:
    """``DEFAULT_SCOPES`` is what a user gets if they click Create without
    touching a checkbox. It must cover both families the quickstart uses,
    and every member must be a real ``KeyScope``."""
    defaults = _portal_default_form_scopes()
    assert defaults, "the create form would ship with no scopes pre-checked"
    union = _portal_key_scopes()
    assert all(s in union for s in defaults), (
        f"DEFAULT_SCOPES has members outside the KeyScope union: {defaults}"
    )
    assert api_key_has_scope(defaults, INGEST_SCOPES)
    assert api_key_has_scope(defaults, GATEWAY_SCOPES)


def test_traces_read_grants_read_but_not_write() -> None:
    expanded = expand_scope_aliases(["traces:read"])
    assert "ingest:read" in expanded
    assert "ingest:write" not in expanded


def test_default_create_scopes_grant_both_families() -> None:
    assert api_key_has_scope(_DEFAULT_CREATE_SCOPES, INGEST_SCOPES)
    assert api_key_has_scope(_DEFAULT_CREATE_SCOPES, GATEWAY_SCOPES)


def test_empty_and_unrelated_scopes_still_fail_closed() -> None:
    """Alias expansion must not become accidental grandfathering."""
    assert not api_key_has_scope([], INGEST_SCOPES)
    assert not api_key_has_scope(None, INGEST_SCOPES)
    assert not api_key_has_scope(["references:read", "jobs:read"], INGEST_SCOPES)
    # An ingest-scoped key must not thereby reach the gateway.
    assert not api_key_has_scope(["ingest"], GATEWAY_SCOPES)
    assert not api_key_has_scope(["traces:write"], GATEWAY_SCOPES)


def test_wildcards_still_work() -> None:
    assert api_key_has_scope(["*"], INGEST_SCOPES)
    assert api_key_has_scope(["ingest:*"], INGEST_SCOPES)
    assert api_key_has_scope(["gateway:*"], GATEWAY_SCOPES)


def test_expand_is_stable_and_ignores_blanks() -> None:
    assert expand_scope_aliases(["", "  ", "ingest"]) == {
        "ingest",
        "ingest:write",
        "ingest:read",
    }
    assert expand_scope_aliases(["gateway:write"]) == {"gateway:write"}


@pytest.mark.skipif(
    not _PORTAL_FIXTURE.exists(), reason="portal source not present in this checkout"
)
def test_scope_picker_options_match_the_union() -> None:
    """``KEY_SCOPE_OPTIONS`` drives the checkboxes; drift between it and
    the ``KeyScope`` union means an option the type system blesses but the
    UI never shows (or vice versa)."""
    src = _strip_ts_comments(_PORTAL_FIXTURE.read_text(encoding="utf-8"))
    match = re.search(
        r"export const KEY_SCOPE_OPTIONS[^=]*=\s*(\[.*?\]);", src, re.DOTALL
    )
    assert match, "KEY_SCOPE_OPTIONS not found"
    option_ids = re.findall(r'id:\s*"([^"]+)"', match.group(1))
    assert sorted(option_ids) == sorted(_portal_key_scopes())
    # Guard against a stray JSON-ish parse: ids must be non-empty strings.
    assert all(isinstance(json.loads(f'"{i}"'), str) and i for i in option_ids)
