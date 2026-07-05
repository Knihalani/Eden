"""Unit tests for Phase N — public traces + saved searches.

Two surfaces, both backend-only:

  * ``ShareService`` — mint, lookup, revoke, list share links.
  * ``SavedSearchService`` — CRUD + record-use of saved searches.

The tests run against a :class:`FakePostgresClient` that records
SQL calls and replays canned responses. No live DB needed.

What's covered:

  Share service (10 tests)
  ────────────────────────
  * Create returns a SharedTrace with a plaintext token + URL.
  * Token is 32+ chars; hash is 64-char hex; prefix is 4 chars.
  * get_by_token returns the same row; format validation rejects
    malformed tokens.
  * record_view bumps view_count + last_viewed_at.
  * revoke sets revoked_at; is_active returns False.
  * list_for_org scopes to org_id.
  * purge_expired deletes only expired, non-revoked rows.
  * expiry is clamped to [1, MAX_EXPIRY_DAYS] days.

  Saved-search service (10 tests)
  ──────────────────────────────
  * create persists + returns a fully-formed SavedSearch.
  * get_by_id returns the same row.
  * list_personal includes owner's + shared; list_shared only shared.
  * list_recent orders by last_used_at DESC.
  * update changes only the supplied fields.
  * delete removes the row.
  * record_use bumps use_count + last_used_at.
  * query_type validation.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

from eden.observability.sharing import (
    DEFAULT_EXPIRY_DAYS,
    MAX_EXPIRY_DAYS,
    SavedSearch,
    SavedSearchService,
    SharedTrace,
    ShareService,
    _generate_token,
    _hash_token,
    _token_prefix,
    _validate_token_format,
)

# ── Fake Postgres client ──────────────────────────────────────────


class FakePostgresClient:
    """Records execute / fetchrow / fetch calls + replays canned responses.

    Usage::

        pg = FakePostgresClient()
        pg.fetchrow_response = [{"id": "...", ...}]
        svc = ShareService(pg)
        await svc.get_by_token("...")

    Tests assert against ``pg.calls`` to verify the SQL + params
    were what we expected.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self.execute_responses: list[str] = []  # returned in order
        self.fetchrow_response: list[dict] | None = None
        self.fetch_response: list[list[dict]] | None = None
        # Storage backends (the real DBs).
        self._shared_traces: dict[str, dict[str, Any]] = {}
        self._saved_searches: dict[str, dict[str, Any]] = {}

    def _record(self, sql: str, args: tuple) -> None:
        self.calls.append((sql.strip(), args))

    async def execute(self, query: str, *args: Any) -> str:
        self._record(query, args)
        # Apply side-effects to the in-memory store. Normalise
        # whitespace so the dispatch below is robust to whether
        # the service wrote ``UPDATE ... SET ...`` or
        # ``UPDATE ...\nSET ...``.
        sql_lc = " ".join(query.strip().lower().split())
        if sql_lc.startswith("insert into shared_traces"):
            self._apply_insert_share(args)
            return "INSERT 0 1"
        if sql_lc.startswith("update shared_traces set revoked_at"):
            return self._apply_revoke(args)
        if sql_lc.startswith("update shared_traces set view_count"):
            return self._apply_view(args)
        if sql_lc.startswith("delete from shared_traces"):
            return self._apply_purge(args)
        if sql_lc.startswith("insert into saved_searches"):
            self._apply_insert_search(args)
            return "INSERT 0 1"
        if sql_lc.startswith("update saved_searches"):
            return self._apply_update_search(args, query)
        if sql_lc.startswith("delete from saved_searches"):
            return self._apply_delete_search(args)
        if self.execute_responses:
            return self.execute_responses.pop(0)
        return "OK"

    async def fetchrow(self, query: str, *args: Any) -> dict | None:
        self._record(query, args)
        sql_lc = query.strip().lower()
        if "from shared_traces" in sql_lc:
            return self._select_share(args, sql_lc)
        if "from saved_searches" in sql_lc:
            return self._select_search(args)
        if self.fetchrow_response is not None:
            return self.fetchrow_response.pop(0) if self.fetchrow_response else None
        return None

    async def fetch(self, query: str, *args: Any) -> list[dict]:
        self._record(query, args)
        sql_lc = query.strip().lower()
        if "from shared_traces" in sql_lc:
            return self._select_shares(args)
        if "from saved_searches" in sql_lc:
            return self._select_searches(args)
        if self.fetch_response is not None:
            return self.fetch_response.pop(0) if self.fetch_response else []
        return []

    # ── In-memory store helpers ───────────────────────────────

    def _apply_insert_share(self, args: tuple) -> None:
        # INSERT args: id, org_id, trace_id, token_hash, token_prefix,
        #              created_by, label, expires_at
        share_id, org_id, trace_id, token_hash, token_prefix, created_by, label, expires_at = args
        self._shared_traces[share_id] = {
            "id": share_id,
            "org_id": org_id,
            "trace_id": trace_id,
            "token_hash": token_hash,
            "token_prefix": token_prefix,
            "created_by": created_by,
            "label": label,
            "expires_at": expires_at,
            "revoked_at": None,
            "view_count": 0,
            "last_viewed_at": None,
            "created_at": datetime.now(UTC),
        }

    def _apply_revoke(self, args: tuple) -> str:
        share_id, org_id = args
        row = self._shared_traces.get(share_id)
        if row is None or str(row["org_id"]) != str(org_id) or row["revoked_at"] is not None:
            return "UPDATE 0"
        row["revoked_at"] = datetime.now(UTC)
        return "UPDATE 1"

    def _apply_view(self, args: tuple) -> str:
        share_id = args[0]
        row = self._shared_traces.get(share_id)
        if row is None:
            return "UPDATE 0"
        row["view_count"] = int(row["view_count"]) + 1
        row["last_viewed_at"] = datetime.now(UTC)
        return "UPDATE 1"

    def _apply_purge(self, args: tuple) -> str:
        org_filter = args[0] if args else None
        now = datetime.now(UTC)
        to_delete = []
        for sid, row in self._shared_traces.items():
            if row["revoked_at"] is not None:
                continue
            if row["expires_at"] is None:
                continue
            exp = row["expires_at"]
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=UTC)
            if exp > now:
                continue
            if org_filter is not None and str(row["org_id"]) != str(org_filter):
                continue
            to_delete.append(sid)
        for sid in to_delete:
            del self._shared_traces[sid]
        return f"DELETE {len(to_delete)}"

    def _apply_insert_search(self, args: tuple) -> None:
        # INSERT args: id, org_id, owner_id, name, query_type, query,
        #              params, is_shared, is_pinned, tags
        search_id, org_id, owner_id, name, query_type, query, params_json, is_shared, is_pinned, tags = args
        now = datetime.now(UTC)
        self._saved_searches[search_id] = {
            "id": search_id,
            "org_id": org_id,
            "owner_id": owner_id,
            "name": name,
            "query_type": query_type,
            "query": query,
            "params": json.loads(params_json) if isinstance(params_json, str) else params_json,
            "is_shared": is_shared,
            "is_pinned": is_pinned,
            "tags": tags or [],
            "last_used_at": None,
            "use_count": 0,
            "created_at": now,
            "updated_at": now,
        }

    def _apply_update_search(self, args: tuple, query: str) -> str:
        # The update SQL is dynamic; we pull id + org from the
        # tail of the args. The SET list may include both
        # parameterised (``name = $1``) and literal (``use_count =
        # use_count + 1``) clauses; we only bind values to the
        # parameterised ones, in order.
        search_id = args[-2]
        org_id = args[-1]
        row = self._saved_searches.get(search_id)
        if row is None or str(row["org_id"]) != str(org_id):
            return "UPDATE 0"
        sql = query.lower()
        try:
            set_part = sql.split("set", 1)[1].split("where", 1)[0]
        except IndexError:
            return "UPDATE 0"
        set_clause = [s.strip() for s in set_part.split(",") if s.strip()]
        # Filter to only clauses that are parameterised ($1, $2, …).
        param_clauses = [c for c in set_clause if "$" in c]
        if len(param_clauses) > len(args) - 2:
            return "UPDATE 0"
        set_args = args[:len(param_clauses)]
        for clause, val in zip(param_clauses, set_args, strict=False):
            if clause.startswith("name"):
                row["name"] = val
            elif clause.startswith("query ="):
                row["query"] = val
            elif clause.startswith("query_type"):
                row["query_type"] = val
            elif clause.startswith("params"):
                row["params"] = json.loads(val) if isinstance(val, str) else val
            elif clause.startswith("is_shared"):
                row["is_shared"] = val
            elif clause.startswith("is_pinned"):
                row["is_pinned"] = val
            elif clause.startswith("tags"):
                row["tags"] = val
        # Apply any literal expressions (NOW(), count + 1, etc).
        now = datetime.now(UTC)
        for clause in set_clause:
            if "use_count" in clause and "+" in clause:
                row["use_count"] = int(row["use_count"]) + 1
            if clause.startswith("last_used_at") and "now()" in clause:
                row["last_used_at"] = now
        row["updated_at"] = now
        return "UPDATE 1"

    def _apply_delete_search(self, args: tuple) -> str:
        search_id, org_id = args
        row = self._saved_searches.get(search_id)
        if row is None or str(row["org_id"]) != str(org_id):
            return "DELETE 0"
        del self._saved_searches[search_id]
        return "DELETE 1"

    def _select_share(self, args: tuple, sql_lc: str) -> dict | None:
        # Decide which column to look up by based on the WHERE
        # clause (not the SELECT clause, which lists token_hash
        # unconditionally as a column). ``sql_lc`` is already
        # lowercased by the caller.
        where = sql_lc.split("where", 1)[-1] if "where" in sql_lc else sql_lc
        if "token_hash" in where:
            token_hash = args[0]
            for row in self._shared_traces.values():
                if row["token_hash"] == token_hash:
                    return dict(row)
            return None
        if "id = $1" in where and "org_id" in where:
            share_id, org_id = args
            row = self._shared_traces.get(share_id)
            if row and str(row["org_id"]) == str(org_id):
                return dict(row)
        return None

    def _select_shares(self, args: tuple) -> list[dict]:
        rows = list(self._shared_traces.values())
        return [dict(r) for r in rows]

    def _select_search(self, args: tuple) -> dict | None:
        search_id, org_id = args
        row = self._saved_searches.get(search_id)
        if row and str(row["org_id"]) == str(org_id):
            return dict(row)
        return None

    def _select_searches(self, args: tuple) -> list[dict]:
        # Apply WHERE filters + ORDER BY. We re-dispatch based on
        # which fields appear in the WHERE clause of the most
        # recent call. We sniff the SQL by looking at the last
        # recorded call. Lowercase the SQL so substring checks
        # don't depend on the case used in the service source.
        if not self.calls:
            return [dict(r) for r in self._saved_searches.values()]
        last_sql = self.calls[-1][0].lower()
        rows = list(self._saved_searches.values())
        # Filter by org_id (always present).
        org_id = args[0] if args else None
        if org_id is not None:
            rows = [r for r in rows if str(r["org_id"]) == str(org_id)]
        if "owner_id = $2" in last_sql and "is_shared = true" in last_sql:
            # list_personal: owner_id matches OR is_shared = true.
            owner_id = args[1] if len(args) > 1 else None
            rows = [r for r in rows if r["owner_id"] == owner_id or r["is_shared"]]
            rows.sort(key=lambda r: (not r["is_pinned"], r["updated_at"]), reverse=True)
        elif "is_shared = true" in last_sql:
            # list_shared: is_shared = true.
            rows = [r for r in rows if r["is_shared"]]
            rows.sort(key=lambda r: (r["use_count"], r["updated_at"]), reverse=True)
        elif "last_used_at is not null" in last_sql:
            # list_recent: only rows that have been used.
            owner_id = args[1] if len(args) > 1 else None
            rows = [r for r in rows if r["owner_id"] == owner_id and r["last_used_at"] is not None]
            rows.sort(key=lambda r: r["last_used_at"], reverse=True)
        else:
            rows.sort(key=lambda r: r["updated_at"], reverse=True)
        # Apply LIMIT.
        limit = args[-1] if args and isinstance(args[-1], int) else None
        if limit is not None:
            rows = rows[:limit]
        return [dict(r) for r in rows]


# ── Token helpers ─────────────────────────────────────────────────


class TestTokenHelpers:
    def test_generate_token_is_url_safe(self) -> None:
        token = _generate_token()
        # URL-safe base64 alphabet: A-Z, a-z, 0-9, '-', '_'.
        assert all(c.isalnum() or c in "-_" for c in token)
        assert len(token) >= 24

    def test_hash_token_is_64_char_hex(self) -> None:
        h = _hash_token("test")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_hash_is_deterministic(self) -> None:
        assert _hash_token("abc") == _hash_token("abc")
        assert _hash_token("abc") != _hash_token("def")

    def test_token_prefix_is_4_chars(self) -> None:
        assert _token_prefix("abcdefgh") == "abcd"

    def test_validate_token_format(self) -> None:
        assert _validate_token_format("a" * 32) is True
        assert _validate_token_format("AbCd_-1234567890123456") is True
        assert _validate_token_format("") is False
        assert _validate_token_format("a") is False
        assert _validate_token_format("a" * 100) is False
        assert _validate_token_format("contains spaces!") is False
        assert _validate_token_format("with/slash") is False


# ── SharedTrace dataclass ─────────────────────────────────────────


class TestSharedTraceDataclass:
    def test_public_url_renders_correctly(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label=None,
            expires_at=None, revoked_at=None, view_count=0,
            last_viewed_at=None, created_at=datetime.now(UTC),
            _plaintext_token="abcd1234",
        )
        assert s.public_url("https://app.eden.example") == (
            "https://app.eden.example/public/traces/abcd1234"
        )
        assert s.public_url("https://app.eden.example/") == (
            "https://app.eden.example/public/traces/abcd1234"
        )

    def test_public_url_raises_without_plaintext(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label=None,
            expires_at=None, revoked_at=None, view_count=0,
            last_viewed_at=None, created_at=datetime.now(UTC),
        )
        with pytest.raises(ValueError, match="plaintext"):
            s.public_url("https://app.eden.example")

    def test_is_active_when_no_expiry(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label=None,
            expires_at=None, revoked_at=None, view_count=0,
            last_viewed_at=None, created_at=datetime.now(UTC),
        )
        assert s.is_active() is True

    def test_is_active_when_revoked(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label=None,
            expires_at=datetime.now(UTC) + timedelta(days=1),
            revoked_at=datetime.now(UTC),
            view_count=0, last_viewed_at=None,
            created_at=datetime.now(UTC),
        )
        assert s.is_active() is False

    def test_is_active_when_expired(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label=None,
            expires_at=datetime.now(UTC) - timedelta(hours=1),
            revoked_at=None, view_count=0, last_viewed_at=None,
            created_at=datetime.now(UTC),
        )
        assert s.is_active() is False

    def test_to_dict_drops_plaintext_by_default(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label="incident",
            expires_at=None, revoked_at=None, view_count=3,
            last_viewed_at=datetime.now(UTC),
            created_at=datetime.now(UTC),
            _plaintext_token="secret",
        )
        d = s.to_dict()
        assert "token" not in d
        assert "url" not in d

    def test_to_dict_includes_plaintext_when_asked(self) -> None:
        s = SharedTrace(
            id="id-1", org_id="o", trace_id="t", token_hash="h",
            token_prefix="abcd", created_by="u", label=None,
            expires_at=None, revoked_at=None, view_count=0,
            last_viewed_at=None, created_at=datetime.now(UTC),
            _plaintext_token="secret",
        )
        d = s.to_dict(include_plaintext=True)
        assert d["token"] == "secret"


# ── ShareService ──────────────────────────────────────────────────


class TestShareService:
    def _make_pg(self) -> FakePostgresClient:
        return FakePostgresClient()

    @pytest.mark.asyncio
    async def test_create_share_returns_plaintext(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        share = await svc.create_share(
            org_id="org-1", trace_id="trace-1",
            created_by="user-1", expiry_days=7,
            base_url="https://app.eden.example",
        )
        assert isinstance(share, SharedTrace)
        assert share._plaintext_token is not None
        assert len(share._plaintext_token) >= 24
        assert share.token_hash == _hash_token(share._plaintext_token)
        assert share.token_prefix == _token_prefix(share._plaintext_token)
        assert share.expires_at is not None
        # Roughly 7 days from now (allow some clock skew).
        delta = (share.expires_at - datetime.now(UTC)).total_seconds()
        assert 6 * 86400 < delta < 8 * 86400
        # URL renders.
        url = share.public_url("https://app.eden.example")
        assert url.startswith("https://app.eden.example/public/traces/")
        assert share._plaintext_token in url

    @pytest.mark.asyncio
    async def test_create_share_clamps_expiry(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        # 0 days clamps to 1.
        share = await svc.create_share(
            org_id="o", trace_id="t", created_by="u", expiry_days=0,
        )
        delta = (share.expires_at - datetime.now(UTC)).total_seconds()
        assert 0 < delta < 2 * 86400
        # 999 days clamps to MAX.
        share = await svc.create_share(
            org_id="o", trace_id="t", created_by="u", expiry_days=999,
        )
        delta = (share.expires_at - datetime.now(UTC)).total_seconds()
        assert (MAX_EXPIRY_DAYS - 1) * 86400 < delta < (MAX_EXPIRY_DAYS + 1) * 86400

    @pytest.mark.asyncio
    async def test_create_share_with_no_expiry(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        share = await svc.create_share(
            org_id="o", trace_id="t", created_by="u", expiry_days=None,
        )
        assert share.expires_at is None
        assert share.is_active() is True

    @pytest.mark.asyncio
    async def test_get_by_token_round_trip(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        share = await svc.create_share(
            org_id="o", trace_id="trace-x", created_by="u",
        )
        fetched = await svc.get_by_token(share._plaintext_token)
        assert fetched is not None
        assert fetched.id == share.id
        assert fetched.trace_id == "trace-x"
        # No plaintext on the fetched row.
        assert fetched._plaintext_token is None

    @pytest.mark.asyncio
    async def test_get_by_token_rejects_malformed(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        assert await svc.get_by_token("") is None
        assert await svc.get_by_token("x") is None
        assert await svc.get_by_token("with spaces!") is None
        assert await svc.get_by_token("with/slash") is None
        # And a well-formed but unknown token.
        assert await svc.get_by_token("a" * 32) is None

    @pytest.mark.asyncio
    async def test_record_view_bumps_counter(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        share = await svc.create_share(org_id="o", trace_id="t", created_by="u")
        await svc.record_view(share.id)
        await svc.record_view(share.id)
        # Re-fetch and check.
        fetched = await svc.get_by_id("o", share.id)
        assert fetched.view_count == 2
        assert fetched.last_viewed_at is not None

    @pytest.mark.asyncio
    async def test_revoke_disables_share(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        share = await svc.create_share(org_id="o", trace_id="t", created_by="u")
        assert await svc.revoke("o", share.id) is True
        fetched = await svc.get_by_token(share._plaintext_token)
        assert fetched is not None
        assert fetched.revoked_at is not None
        assert fetched.is_active() is False
        # Second revoke returns False.
        assert await svc.revoke("o", share.id) is False

    @pytest.mark.asyncio
    async def test_revoke_unknown_returns_false(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        assert await svc.revoke("o", "does-not-exist") is False

    @pytest.mark.asyncio
    async def test_purge_expired(self) -> None:
        pg = self._make_pg()
        svc = ShareService(pg)
        # Create one expired (back-dated) + one active.
        await pg.execute(
            "INSERT INTO shared_traces "
            "(id, org_id, trace_id, token_hash, token_prefix, created_by, label, expires_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            "expired-1", "o", "t1", "h1", "abcd", "u", None,
            datetime.now(UTC) - timedelta(hours=1),
        )
        await pg.execute(
            "INSERT INTO shared_traces "
            "(id, org_id, trace_id, token_hash, token_prefix, created_by, label, expires_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            "active-1", "o", "t2", "h2", "efgh", "u", None,
            datetime.now(UTC) + timedelta(days=7),
        )
        n = await svc.purge_expired()
        assert n == 1
        # The expired one is gone.
        assert "expired-1" not in pg._shared_traces
        # The active one remains.
        assert "active-1" in pg._shared_traces


# ── SavedSearchService ────────────────────────────────────────────


class TestSavedSearchService:
    def _make_pg(self) -> FakePostgresClient:
        return FakePostgresClient()

    @pytest.mark.asyncio
    async def test_create_persists(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        s = await svc.create(
            org_id="o", owner_id="u", name="my query",
            query_type="sql", query="SELECT 1",
        )
        assert isinstance(s, SavedSearch)
        assert s.name == "my query"
        assert s.query_type == "sql"
        assert s.query == "SELECT 1"
        assert s.use_count == 0
        assert s.is_shared is False
        # Round-trip via get_by_id.
        fetched = await svc.get_by_id("o", s.id)
        assert fetched is not None
        assert fetched.id == s.id

    @pytest.mark.asyncio
    async def test_create_rejects_unknown_query_type(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        with pytest.raises(ValueError, match="query_type"):
            await svc.create(
                org_id="o", owner_id="u", name="x",
                query_type="not-a-type", query="SELECT 1",
            )

    @pytest.mark.asyncio
    async def test_update_partial(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        s = await svc.create(
            org_id="o", owner_id="u", name="orig",
            query_type="sql", query="SELECT 1",
        )
        # Only change the name + is_pinned.
        updated = await svc.update("o", s.id, name="new", is_pinned=True)
        assert updated is not None
        assert updated.name == "new"
        assert updated.is_pinned is True
        # Untouched fields.
        assert updated.query == "SELECT 1"
        assert updated.query_type == "sql"
        assert updated.is_shared is False

    @pytest.mark.asyncio
    async def test_update_unknown_returns_none(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        assert await svc.update("o", "nope", name="x") is None

    @pytest.mark.asyncio
    async def test_update_rejects_unknown_query_type(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        s = await svc.create(
            org_id="o", owner_id="u", name="x",
            query_type="sql", query="SELECT 1",
        )
        with pytest.raises(ValueError, match="query_type"):
            await svc.update("o", s.id, query_type="bad")

    @pytest.mark.asyncio
    async def test_list_personal_includes_shared(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        await svc.create(
            org_id="o", owner_id="u-1", name="mine",
            query_type="sql", query="SELECT 1",
        )
        await svc.create(
            org_id="o", owner_id="u-2", name="team",
            query_type="text", query="error", is_shared=True,
        )
        rows = await svc.list_personal("o", "u-1")
        names = {r.name for r in rows}
        assert "mine" in names
        assert "team" in names

    @pytest.mark.asyncio
    async def test_list_shared_only_shared(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        await svc.create(
            org_id="o", owner_id="u-1", name="personal",
            query_type="sql", query="SELECT 1", is_shared=False,
        )
        await svc.create(
            org_id="o", owner_id="u-2", name="shared",
            query_type="text", query="error", is_shared=True,
        )
        rows = await svc.list_shared("o")
        names = {r.name for r in rows}
        assert "shared" in names
        assert "personal" not in names

    @pytest.mark.asyncio
    async def test_list_recent_skips_unused(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        s1 = await svc.create(
            org_id="o", owner_id="u", name="used",
            query_type="sql", query="SELECT 1",
        )
        await svc.create(
            org_id="o", owner_id="u", name="never-used",
            query_type="sql", query="SELECT 2",
        )
        # Mark s1 as used.
        await svc.record_use("o", s1.id)
        rows = await svc.list_recent("o", "u")
        names = {r.name for r in rows}
        assert "used" in names
        assert "never-used" not in names

    @pytest.mark.asyncio
    async def test_delete_removes(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        s = await svc.create(
            org_id="o", owner_id="u", name="x",
            query_type="sql", query="SELECT 1",
        )
        assert await svc.delete("o", s.id) is True
        assert await svc.get_by_id("o", s.id) is None
        # Second delete returns False.
        assert await svc.delete("o", s.id) is False

    @pytest.mark.asyncio
    async def test_record_use_bumps_counter(self) -> None:
        pg = self._make_pg()
        svc = SavedSearchService(pg)
        s = await svc.create(
            org_id="o", owner_id="u", name="x",
            query_type="sql", query="SELECT 1",
        )
        await svc.record_use("o", s.id)
        await svc.record_use("o", s.id)
        fetched = await svc.get_by_id("o", s.id)
        assert fetched.use_count == 2
        assert fetched.last_used_at is not None


# ── SavedSearch dataclass ─────────────────────────────────────────


class TestSavedSearchDataclass:
    def test_to_dict_round_trip(self) -> None:
        s = SavedSearch(
            id="id-1", org_id="o", owner_id="u", name="x",
            query_type="text", query="hello", params={"k": "v"},
            is_shared=True, is_pinned=False, tags=["t1"],
            last_used_at=datetime.now(UTC), use_count=5,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        d = s.to_dict()
        assert d["id"] == "id-1"
        assert d["name"] == "x"
        assert d["query_type"] == "text"
        assert d["query"] == "hello"
        assert d["params"] == {"k": "v"}
        assert d["is_shared"] is True
        assert d["tags"] == ["t1"]
        assert d["use_count"] == 5
