"""Session 29 tests — Portal critical (PT-9, PT-11).

Two audit items:

* **PT-9** — ``uploadAvatar`` + ``exportOrgData`` in
  ``lib/api.ts`` route through ``fetchApi`` (not raw ``fetch``)
  so the 401-retry + in-flight dedup machinery applies.
* **PT-11** — the settings API-keys surface reads ``raw_key``
  (not the legacy ``key``) so the copy-one-time-key button works.

Refactor note: ``settings/_components/api-keys-tab.tsx`` was folded
into ``src/app/(portal)/settings/page.tsx`` (the whole settings tab
set now lives in that one client page). The PT-11 guard is repointed
there — the invariant is unchanged, only its address moved.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests._portal_api_source import portal_api_source

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


def _read(rel: str) -> str:
    if rel in ("src/lib/api.ts", "src/lib/api"):
        return portal_api_source()
    return (_PORTAL_ROOT / rel).read_text()


# ─── PT-9 — uploadAvatar + exportOrgData via fetchApi ──────────


class TestUploadAvatarThroughFetchApi:
    """``uploadAvatar`` must use ``fetchApi`` not raw ``fetch``."""

    def test_calls_fetchApi(self) -> None:
        source = _read("src/lib/api.ts")
        # In the uploadAvatar block, fetchApi is the call.
        assert (
            "fetchApi<{ avatar_url: string }>(\n"
            "      \"/auth/users/me/avatar\""
        ) in source, (
            "PT-9 regression: uploadAvatar must route through fetchApi"
        )

    def test_uses_formdata_body(self) -> None:
        """The multipart boundary must be preserved (fetchApi's
        ``Content-Type: application/json`` default is skipped for
        FormData bodies)."""
        source = _read("src/lib/api.ts")
        assert "formData.append(\"file\", file);" in source, (
            "PT-9 regression: uploadAvatar must construct FormData with 'file'"
        )

    def test_no_raw_fetch_for_avatar(self) -> None:
        """Within the ``uploadAvatar`` block, no bare ``await fetch(...)``
        for the avatar endpoint."""
        source = _read("src/lib/api.ts")
        # Slice uploadAvatar block.
        start = source.index("uploadAvatar: async")
        # Find the closing of the method (next blank + non-continued method).
        end = source.index("\n  },\n", start)
        block = source[start:end]
        assert "await fetch" not in block, (
            "PT-9 regression: uploadAvatar must not use bare `await fetch`"
        )


class TestExportOrgDataThroughFetchApi:
    """``exportOrgData`` goes through ``fetchApi`` (with
    ``stream: true`` to bypass JSON parsing of the binary body).
    """

    def test_calls_fetchApi_for_export(self) -> None:
        source = _read("src/lib/api.ts")
        assert "fetchApi<Blob>(`/orgs/${orgId}/export`" in source, (
            "PT-9 regression: exportOrgData must route through fetchApi"
        )

    def test_export_uses_stream_flag(self) -> None:
        """``stream: true`` skips fetchApi's JSON parse — required for
        the binary zip download.
        """
        source = _read("src/lib/api.ts")
        assert "stream: true," in source, (
            "PT-9 regression: exportOrgData must pass ``stream: true`` "
            "to skip JSON parsing of the binary body"
        )


# ─── PT-11 — api-keys-tab.tsx reads raw_key, not key ──────────


class TestApiKeysTabRawKey:
    """The API-keys surface must read ``raw_key`` (not the legacy
    ``key``) so the copy-one-time-key button receives the new key.

    Lives in ``settings/page.tsx`` since the tab extraction was
    reversed (was ``settings/_components/api-keys-tab.tsx``).
    """

    _SETTINGS = "src/app/(portal)/settings/page.tsx"

    def test_reads_raw_key(self) -> None:
        source = _read(self._SETTINGS)
        # ``createApiKey``'s result is bound as ``res`` now (was
        # ``data``) — assert on the field, not the local name.
        assert ".raw_key" in source, (
            "PT-11 regression: settings API-keys surface must read "
            ".raw_key off the create-key response"
        )

    def test_no_bare_data_key(self) -> None:
        """Belt-and-braces: the legacy bare ``.key`` access must be
        gone from the create-result handler."""
        # Strip line comments — the audit-fix comment mentions the
        # literal ``data.key`` in prose.
        raw = _read(self._SETTINGS)
        source = "\n".join(
            line for line in raw.splitlines()
            if not line.lstrip().startswith("//")
        )
        # The legacy access pattern from pre-fix code. Match it as a
        # discrete token so ``res.key_prefix`` / ``data.key_raw``
        # don't trip the guard.
        legacy = re.search(r"\b(?:data|res|result)\.key\b", source)
        assert legacy is None, (
            "PT-11 regression: settings page must not access the "
            f"legacy bare `.key` field ({legacy.group(0) if legacy else ''}) "
            "— the create response only carries raw_key"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
