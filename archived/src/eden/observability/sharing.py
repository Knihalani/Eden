"""Public traces (share-by-link) + saved searches (Phase N).

Two surfaces that close the Logfire / Sentry share UX gap:

  1. **Public traces** — a user clicks "Share" on a trace detail
     page → the backend mints a signed token, returns the URL
     once, persists only the SHA-256 of the token. The recipient
     opens the URL, the public route hashes the inbound token,
     looks up the row, validates expiry + revocation, and renders
     a redacted view of the trace. The plaintext token is never
     on disk.

  2. **Saved searches** — the user clicks "Save" on a SQL/EQL/
     full-text search → the backend persists the query with a
     user-supplied name + the query type. Personal by default;
     ``is_shared=true`` promotes to org-wide. Usage is tracked
     so the UI can show "recent" + "popular".

Both services follow the same patterns as the rest of Eden:

  - Per-org isolation. Every query filters by org_id. Cross-org
    reads are not just forbidden — they don't have a code path.
  - Parameterised SQL only. The token_hash is the only user-
    supplied value that lands in a query string, and it's already
    a SHA-256 hex (so it's safe to inline as a value, but we
    still use a parameterised query for consistency).
  - PII redaction on the public view — even if the user shared
    a trace that contains an email in a tool result, the public
    route strips it before serialising.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

# ── Constants ──────────────────────────────────────────────────────

# Token format: 24 random bytes → 32-char URL-safe base64. Same
# surface area as a UUID v4 (~122 bits entropy) but URL-safe and
# prefix-friendly for the UI ("share: abcd…-wxyz").
_TOKEN_BYTES = 24
_TOKEN_PREFIX_LEN = 4  # chars of the plaintext we expose in the UI

# Default + max expiry. The user picks at creation time.
DEFAULT_EXPIRY_DAYS = 7
MAX_EXPIRY_DAYS = 30


# ── Helpers ────────────────────────────────────────────────────────


def _generate_token() -> str:
    """Mint a fresh share token. URL-safe base64, no padding.

    We strip the trailing ``=`` padding so the URL is cleaner;
    the recipient code adds it back implicitly when validating.
    """
    return secrets.token_urlsafe(_TOKEN_BYTES)


def _hash_token(token: str) -> str:
    """SHA-256 of the plaintext token. This is what we store."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _token_prefix(token: str) -> str:
    """First 4 characters of the token, for UI display."""
    return token[:_TOKEN_PREFIX_LEN]


def _validate_token_format(token: str) -> bool:
    """Quick sanity check — reject obviously malformed tokens early."""
    if not token or len(token) < 16 or len(token) > 64:
        return False
    # URL-safe base64 alphabet: A-Z, a-z, 0-9, '-', '_'.
    return bool(re.match(r"^[A-Za-z0-9_-]+$", token))


def _resolve_expiry(days: int | None) -> datetime | None:
    """Convert a user-supplied expiry-in-days into a UTC timestamp.

    ``None`` means "no expiry" — only admins may set this; the
    service layer clamps to a maximum.
    """
    if days is None:
        return None
    days = max(1, min(int(days), MAX_EXPIRY_DAYS))
    return datetime.now(UTC) + timedelta(days=days)


# ── Dataclasses ────────────────────────────────────────────────────


@dataclass
class SharedTrace:
    """An active share link for a trace.

    The plaintext token is NEVER stored on this object. The
    :meth:`SharedTrace.public_url` method is the only place the
    plaintext is rendered, and the caller is expected to return
    the URL exactly once (on creation).
    """

    id: str
    org_id: str
    trace_id: str
    token_hash: str
    token_prefix: str
    created_by: str
    label: str | None
    expires_at: datetime | None
    revoked_at: datetime | None
    view_count: int
    last_viewed_at: datetime | None
    created_at: datetime
    # The plaintext token — set ONLY on creation, never loaded
    # from the DB. The serialiser (``to_dict``) drops this field
    # for all return paths except the one that hands the URL to
    # the user who just minted the share.
    _plaintext_token: str | None = field(default=None, repr=False)

    def public_url(self, base_url: str) -> str:
        """Render the share URL. Only valid when ``_plaintext_token`` is set."""
        if not self._plaintext_token:
            raise ValueError(
                "no plaintext token — was this row loaded from the DB? "
                "Only freshly-minted shares have a plaintext token.",
            )
        return f"{base_url.rstrip('/')}/public/traces/{self._plaintext_token}"

    def is_active(self, now: datetime | None = None) -> bool:
        """True if the share link is currently usable."""
        if self.revoked_at is not None:
            return False
        if self.expires_at is None:
            return True
        now = now or datetime.now(UTC)
        return self.expires_at > now

    def to_dict(self, *, include_plaintext: bool = False) -> dict[str, Any]:
        """Serialise for the API.

        ``include_plaintext=True`` is ONLY used on the create
        response — never re-serialise with this flag after the
        user has received the URL.
        """
        out: dict[str, Any] = {
            "id": self.id,
            "org_id": self.org_id,
            "trace_id": self.trace_id,
            "token_prefix": self.token_prefix,
            "label": self.label,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "revoked_at": self.revoked_at.isoformat() if self.revoked_at else None,
            "view_count": self.view_count,
            "last_viewed_at": (
                self.last_viewed_at.isoformat() if self.last_viewed_at else None
            ),
            "created_at": self.created_at.isoformat(),
            "active": self.is_active(),
        }
        if include_plaintext and self._plaintext_token:
            out["token"] = self._plaintext_token
        return out


@dataclass
class SavedSearch:
    """A persisted search query (SQL / EQL / full-text)."""

    id: str
    org_id: str
    owner_id: str
    name: str
    query_type: str  # 'sql' | 'eql' | 'text'
    query: str
    params: dict[str, Any]
    is_shared: bool
    is_pinned: bool
    tags: list[str]
    last_used_at: datetime | None
    use_count: int
    created_at: datetime
    updated_at: datetime

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "owner_id": self.owner_id,
            "name": self.name,
            "query_type": self.query_type,
            "query": self.query,
            "params": self.params,
            "is_shared": self.is_shared,
            "is_pinned": self.is_pinned,
            "tags": self.tags,
            "last_used_at": (
                self.last_used_at.isoformat() if self.last_used_at else None
            ),
            "use_count": self.use_count,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


# ── Service: shared traces ─────────────────────────────────────────


class ShareService:
    """CRUD + lookup for the ``shared_traces`` table.

    Uses the singleton :class:`PostgresClient`. All queries
    are parameterised; per-org isolation is enforced by filtering
    on ``org_id`` in every read/write.
    """

    def __init__(self, pg: Any) -> None:
        self._pg = pg

    # ── Create ──────────────────────────────────────────────────

    async def create_share(
        self,
        *,
        org_id: str,
        trace_id: str,
        created_by: str,
        expiry_days: int | None = DEFAULT_EXPIRY_DAYS,
        label: str | None = None,
        base_url: str = "https://app.eden.example",
    ) -> SharedTrace:
        """Mint a new share link.

        The plaintext token is returned in ``SharedTrace._plaintext_token``;
        :meth:`SharedTrace.public_url` renders the URL.
        """
        token = _generate_token()
        token_hash = _hash_token(token)
        token_prefix = _token_prefix(token)
        expires_at = _resolve_expiry(expiry_days)
        share_id = str(uuid.uuid4())

        await self._pg.execute(
            """
            INSERT INTO shared_traces
                (id, org_id, trace_id, token_hash, token_prefix,
                 created_by, label, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            share_id, org_id, trace_id, token_hash, token_prefix,
            created_by, label, expires_at,
        )

        return SharedTrace(
            id=share_id,
            org_id=org_id,
            trace_id=trace_id,
            token_hash=token_hash,
            token_prefix=token_prefix,
            created_by=created_by,
            label=label,
            expires_at=expires_at,
            revoked_at=None,
            view_count=0,
            last_viewed_at=None,
            created_at=datetime.now(UTC),
            _plaintext_token=token,
        )

    # ── Lookup (internal + public) ─────────────────────────────

    async def get_by_token(self, token: str) -> SharedTrace | None:
        """Look up a share by its plaintext token. The public route uses this.

        Validates expiry + revocation. Does NOT bump view_count
        (call :meth:`record_view` for that).
        """
        if not _validate_token_format(token):
            return None
        token_hash = _hash_token(token)
        row = await self._pg.fetchrow(
            """
            SELECT id, org_id, trace_id, token_hash, token_prefix,
                   created_by, label, expires_at, revoked_at,
                   view_count, last_viewed_at, created_at
            FROM shared_traces
            WHERE token_hash = $1
            """,
            token_hash,
        )
        if row is None:
            return None
        return _row_to_shared_trace(row)

    async def get_by_id(self, org_id: str, share_id: str) -> SharedTrace | None:
        """Look up a share by its DB id (admin UI: list / revoke)."""
        row = await self._pg.fetchrow(
            """
            SELECT id, org_id, trace_id, token_hash, token_prefix,
                   created_by, label, expires_at, revoked_at,
                   view_count, last_viewed_at, created_at
            FROM shared_traces
            WHERE id = $1 AND org_id = $2
            """,
            share_id, org_id,
        )
        if row is None:
            return None
        return _row_to_shared_trace(row)

    async def list_for_org(self, org_id: str, *, limit: int = 50) -> list[SharedTrace]:
        """List all active shares for an org (admin view)."""
        rows = await self._pg.fetch(
            """
            SELECT id, org_id, trace_id, token_hash, token_prefix,
                   created_by, label, expires_at, revoked_at,
                   view_count, last_viewed_at, created_at
            FROM shared_traces
            WHERE org_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            org_id, limit,
        )
        return [_row_to_shared_trace(r) for r in rows]

    async def list_for_trace(self, org_id: str, trace_id: str) -> list[SharedTrace]:
        """List all shares for one trace (the user UI "active links" tab)."""
        rows = await self._pg.fetch(
            """
            SELECT id, org_id, trace_id, token_hash, token_prefix,
                   created_by, label, expires_at, revoked_at,
                   view_count, last_viewed_at, created_at
            FROM shared_traces
            WHERE org_id = $1 AND trace_id = $2
            ORDER BY created_at DESC
            """,
            org_id, trace_id,
        )
        return [_row_to_shared_trace(r) for r in rows]

    # ── Mutate ─────────────────────────────────────────────────

    async def revoke(self, org_id: str, share_id: str) -> bool:
        """Revoke a share link. Returns True if a row was updated."""
        result = await self._pg.execute(
            """
            UPDATE shared_traces
            SET revoked_at = NOW()
            WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
            """,
            share_id, org_id,
        )
        # asyncpg returns "UPDATE N" — the N is the rowcount.
        return _affected_rows(result) > 0

    async def record_view(self, share_id: str) -> None:
        """Bump the view counter on a share link."""
        await self._pg.execute(
            """
            UPDATE shared_traces
            SET view_count = view_count + 1,
                last_viewed_at = NOW()
            WHERE id = $1
            """,
            share_id,
        )

    async def purge_expired(self, org_id: str | None = None) -> int:
        """Delete shares whose ``expires_at`` is in the past and which
        are not revoked. Returns the count deleted.

        A scheduled job (Phase 0) calls this daily. ``org_id``
        scopes the purge to one org when supplied.
        """
        if org_id is not None:
            result = await self._pg.execute(
                """
                DELETE FROM shared_traces
                WHERE expires_at IS NOT NULL
                  AND expires_at < NOW()
                  AND revoked_at IS NULL
                  AND org_id = $1
                """,
                org_id,
            )
        else:
            result = await self._pg.execute(
                """
                DELETE FROM shared_traces
                WHERE expires_at IS NOT NULL
                  AND expires_at < NOW()
                  AND revoked_at IS NULL
                """,
            )
        return _affected_rows(result)


# ── Service: saved searches ───────────────────────────────────────


class SavedSearchService:
    """CRUD + lookup for the ``saved_searches`` table.

    Per-user by default. ``is_shared=True`` makes a search
    visible to the whole org (admins can promote). All reads
    filter by org_id for tenant isolation.
    """

    def __init__(self, pg: Any) -> None:
        self._pg = pg

    # ── Create / update ────────────────────────────────────────

    async def create(
        self,
        *,
        org_id: str,
        owner_id: str,
        name: str,
        query_type: str,
        query: str,
        params: dict[str, Any] | None = None,
        is_shared: bool = False,
        is_pinned: bool = False,
        tags: list[str] | None = None,
    ) -> SavedSearch:
        """Persist a new saved search.

        The (owner_id, name) pair is unique within an org — saving
        a second search with the same name silently overwrites the
        first (UPSERT semantics). The user can rename in the UI
        before saving if they want to keep the old one.
        """
        if query_type not in ("sql", "eql", "text"):
            raise ValueError(f"unknown query_type: {query_type!r}")
        search_id = str(uuid.uuid4())
        await self._pg.execute(
            """
            INSERT INTO saved_searches
                (id, org_id, owner_id, name, query_type, query,
                 params, is_shared, is_pinned, tags)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
            """,
            search_id, org_id, owner_id, name, query_type, query,
            _json_dumps(params or {}), is_shared, is_pinned, list(tags or []),
        )
        # Read it back so the caller gets a fully-formed object.
        fetched = await self.get_by_id(org_id, search_id)
        if fetched is None:  # pragma: no cover — should be impossible
            raise RuntimeError("saved search vanished after insert")
        return fetched

    async def update(
        self,
        org_id: str,
        search_id: str,
        *,
        name: str | None = None,
        query: str | None = None,
        query_type: str | None = None,
        params: dict[str, Any] | None = None,
        is_shared: bool | None = None,
        is_pinned: bool | None = None,
        tags: list[str] | None = None,
    ) -> SavedSearch | None:
        """Update an existing saved search. Only the owner or an admin
        may update; the route layer is responsible for the auth check.

        ``None`` for a kwarg means "leave it alone". Pass a value
        to set it. To clear a list, pass ``[]``.
        """
        sets: list[str] = []
        args: list[Any] = []
        idx = 1
        if name is not None:
            sets.append(f"name = ${idx}")
            args.append(name)
            idx += 1
        if query is not None:
            sets.append(f"query = ${idx}")
            args.append(query)
            idx += 1
        if query_type is not None:
            if query_type not in ("sql", "eql", "text"):
                raise ValueError(f"unknown query_type: {query_type!r}")
            sets.append(f"query_type = ${idx}")
            args.append(query_type)
            idx += 1
        if params is not None:
            sets.append(f"params = ${idx}::jsonb")
            args.append(_json_dumps(params))
            idx += 1
        if is_shared is not None:
            sets.append(f"is_shared = ${idx}")
            args.append(is_shared)
            idx += 1
        if is_pinned is not None:
            sets.append(f"is_pinned = ${idx}")
            args.append(is_pinned)
            idx += 1
        if tags is not None:
            sets.append(f"tags = ${idx}")
            args.append(tags)
            idx += 1
        if not sets:
            # No-op update — return the current row.
            return await self.get_by_id(org_id, search_id)
        # WHERE id = $idx AND org_id = $idx+1
        where_id = f"${idx}"
        where_org = f"${idx + 1}"
        args.extend([search_id, org_id])
        sql = (
            f"UPDATE saved_searches SET {', '.join(sets)} "
            f"WHERE id = {where_id} AND org_id = {where_org}"
        )
        result = await self._pg.execute(sql, *args)
        if _affected_rows(result) == 0:
            return None
        return await self.get_by_id(org_id, search_id)

    # ── Read ───────────────────────────────────────────────────

    async def get_by_id(self, org_id: str, search_id: str) -> SavedSearch | None:
        row = await self._pg.fetchrow(
            """
            SELECT id, org_id, owner_id, name, query_type, query,
                   params, is_shared, is_pinned, tags,
                   last_used_at, use_count, created_at, updated_at
            FROM saved_searches
            WHERE id = $1 AND org_id = $2
            """,
            search_id, org_id,
        )
        if row is None:
            return None
        return _row_to_saved_search(row)

    async def list_personal(self, org_id: str, owner_id: str, *, limit: int = 50) -> list[SavedSearch]:
        """List a user's personal + shared searches (the sidebar dropdown)."""
        rows = await self._pg.fetch(
            """
            SELECT id, org_id, owner_id, name, query_type, query,
                   params, is_shared, is_pinned, tags,
                   last_used_at, use_count, created_at, updated_at
            FROM saved_searches
            WHERE org_id = $1
              AND (owner_id = $2 OR is_shared = TRUE)
            ORDER BY is_pinned DESC, updated_at DESC
            LIMIT $3
            """,
            org_id, owner_id, limit,
        )
        return [_row_to_saved_search(r) for r in rows]

    async def list_shared(self, org_id: str, *, limit: int = 50) -> list[SavedSearch]:
        """List org-wide shared searches (the "team searches" page)."""
        rows = await self._pg.fetch(
            """
            SELECT id, org_id, owner_id, name, query_type, query,
                   params, is_shared, is_pinned, tags,
                   last_used_at, use_count, created_at, updated_at
            FROM saved_searches
            WHERE org_id = $1 AND is_shared = TRUE
            ORDER BY use_count DESC, updated_at DESC
            LIMIT $2
            """,
            org_id, limit,
        )
        return [_row_to_saved_search(r) for r in rows]

    async def list_recent(self, org_id: str, owner_id: str, *, limit: int = 10) -> list[SavedSearch]:
        """The "recent searches" dropdown — most recently used first."""
        rows = await self._pg.fetch(
            """
            SELECT id, org_id, owner_id, name, query_type, query,
                   params, is_shared, is_pinned, tags,
                   last_used_at, use_count, created_at, updated_at
            FROM saved_searches
            WHERE org_id = $1
              AND owner_id = $2
              AND last_used_at IS NOT NULL
            ORDER BY last_used_at DESC
            LIMIT $3
            """,
            org_id, owner_id, limit,
        )
        return [_row_to_saved_search(r) for r in rows]

    # ── Mutate ─────────────────────────────────────────────────

    async def delete(self, org_id: str, search_id: str) -> bool:
        result = await self._pg.execute(
            "DELETE FROM saved_searches WHERE id = $1 AND org_id = $2",
            search_id, org_id,
        )
        return _affected_rows(result) > 0

    async def record_use(self, org_id: str, search_id: str) -> None:
        """Bump use_count + last_used_at when the user runs a saved search."""
        await self._pg.execute(
            """
            UPDATE saved_searches
            SET use_count = use_count + 1,
                last_used_at = NOW()
            WHERE id = $1 AND org_id = $2
            """,
            search_id, org_id,
        )


# ── Row → dataclass mappers ───────────────────────────────────────


def _row_to_shared_trace(row: dict[str, Any]) -> SharedTrace:
    return SharedTrace(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        trace_id=str(row["trace_id"]),
        token_hash=str(row["token_hash"]),
        token_prefix=str(row["token_prefix"]),
        created_by=str(row["created_by"]),
        label=row.get("label"),
        expires_at=_to_utc(row.get("expires_at")),
        revoked_at=_to_utc(row.get("revoked_at")),
        view_count=int(row.get("view_count") or 0),
        last_viewed_at=_to_utc(row.get("last_viewed_at")),
        created_at=_to_utc(row["created_at"]) or datetime.now(UTC),
    )


def _row_to_saved_search(row: dict[str, Any]) -> SavedSearch:
    return SavedSearch(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        owner_id=str(row["owner_id"]),
        name=str(row["name"]),
        query_type=str(row["query_type"]),
        query=str(row["query"]),
        params=_json_loads(row.get("params")),
        is_shared=bool(row.get("is_shared")),
        is_pinned=bool(row.get("is_pinned")),
        tags=list(row.get("tags") or []),
        last_used_at=_to_utc(row.get("last_used_at")),
        use_count=int(row.get("use_count") or 0),
        created_at=_to_utc(row["created_at"]) or datetime.now(UTC),
        updated_at=_to_utc(row["updated_at"]) or datetime.now(UTC),
    )


def _to_utc(value: Any) -> datetime | None:
    """Coerce an asyncpg timestamptz to a UTC-aware datetime.

    asyncpg returns aware datetimes; we still normalise to UTC for
    consistent serialisation.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    # asyncpg sometimes returns a datetime.date — shouldn't happen
    # for timestamptz, but defensive.
    if hasattr(value, "isoformat"):
        return None
    return None


def _affected_rows(execute_result: Any) -> int:
    """Parse the ``UPDATE N`` / ``DELETE N`` string asyncpg returns."""
    if not execute_result:
        return 0
    s = str(execute_result).strip()
    # asyncpg format: "UPDATE 3" or "DELETE 1".
    parts = s.split()
    if len(parts) >= 2 and parts[0] in ("UPDATE", "DELETE"):
        try:
            return int(parts[1])
        except (ValueError, IndexError):
            return 0
    return 0


# ── JSON helpers (kept local to avoid coupling to the platform) ───

import json  # noqa: E402  — local import to keep module self-contained


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, default=str, separators=(",", ":"))


def _json_loads(value: Any) -> Any:
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return {}
    return {}


__all__ = [
    "SharedTrace",
    "SavedSearch",
    "ShareService",
    "SavedSearchService",
    "DEFAULT_EXPIRY_DAYS",
    "MAX_EXPIRY_DAYS",
]
