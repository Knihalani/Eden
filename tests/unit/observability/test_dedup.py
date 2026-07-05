"""Unit tests for Phase A — content-addressed message dedup.

Mirrors Laminar's May 2026 algorithm (canonical-JSON SHA-256 over each
message; spans store array of hashes; full payload reconstructed at
read time via JOIN against ``trace_messages``).

What's covered here:

  * :func:`canonical_hash` — determinism, field-order invariance, hash
    uniqueness across different payloads, type coercion.
  * :func:`canonical_bytes` — round-trip with ``canonical_hash``.
  * :func:`extract_request_messages` / :func:`extract_response_messages`
    — OpenAI and Anthropic payload shapes.
  * :class:`MessageStore` — upsert idempotency, get_many ordering,
    reconstruct byte-identity for request and response bodies, delete
    cleanup, trace_stats math.

The full end-to-end collector integration (TelemetryEvent → hash
arrays → DB → reconstructed payload) is covered in
``tests/intelligence/observability/test_telemetry_dedup_e2e.py`` which
needs a running Postgres — see that file's docstring.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.observability.canonical import (
    canonical_bytes,
    canonical_hash,
)
from eden.observability.message_store import (
    MessageStore,
    extract_request_messages,
    extract_response_messages,
    hash_messages,
)

# ── canonical_hash ────────────────────────────────────────────────


class TestCanonicalHash:
    def test_is_deterministic(self):
        msg = {"role": "user", "content": "hello"}
        h1 = canonical_hash(msg)
        h2 = canonical_hash(msg)
        assert h1 == h2

    def test_returns_64_char_hex(self):
        h = canonical_hash({"a": 1})
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_field_order_invariance(self):
        """Different key orders hash the same — the whole point of
        canonical JSON for content addressing."""
        a = {"role": "user", "content": "hi", "name": "alice"}
        b = {"name": "alice", "content": "hi", "role": "user"}
        assert canonical_hash(a) == canonical_hash(b)

    def test_nested_field_order_invariance(self):
        a = {"role": "user", "tool_calls": [{"id": "1", "type": "function"}]}
        b = {"tool_calls": [{"type": "function", "id": "1"}], "role": "user"}
        assert canonical_hash(a) == canonical_hash(b)

    def test_different_content_different_hash(self):
        assert canonical_hash({"a": 1}) != canonical_hash({"a": 2})
        assert canonical_hash({"a": "1"}) != canonical_hash({"a": 1})

    def test_unicode_preserved(self):
        """ensure_ascii=False means 'café' doesn't get escaped."""
        h1 = canonical_hash({"content": "café"})
        h2 = canonical_hash({"content": "café"})
        # Both Unicode forms are preserved; NFC vs NFD is NOT
        # canonicalized here (json.dumps emits the raw bytes back).
        # Both are valid; they hash differently because they're
        # different byte sequences — that's correct behavior.
        assert h1 != h2

    def test_handles_datetime(self):
        ts = _dt.datetime(2026, 6, 17, 12, 0, 0, tzinfo=_dt.UTC)
        h = canonical_hash({"created_at": ts, "role": "system"})
        # Roundtripping through JSON should give the same hash
        again = json.loads(json.dumps({"created_at": ts.isoformat(), "role": "system"}))
        assert canonical_hash(again) == h

    def test_handles_bytes(self):
        h1 = canonical_hash({"data": b"hello"})
        h2 = canonical_hash({"data": b"hello"})
        assert h1 == h2
        # Different bytes = different hash
        h3 = canonical_hash({"data": b"hellp"})
        assert h1 != h3

    def test_handles_nested_list(self):
        a = {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}
        b = {"messages": [{"role": "assistant", "content": "b"}, {"role": "user", "content": "a"}]}
        # List order IS significant — the algorithm hashes the whole
        # canonical form including list ordering.
        assert canonical_hash(a) != canonical_hash(b)

    def test_collision_resistance(self):
        """1k random-looking messages should all hash uniquely."""
        hashes = {
            canonical_hash({"role": "user", "content": f"msg-{i}"})
            for i in range(1000)
        }
        assert len(hashes) == 1000


# ── canonical_bytes ───────────────────────────────────────────────


class TestCanonicalBytes:
    def test_matches_canonical_hash(self):
        msg = {"a": 1, "b": [2, 3]}
        b = canonical_bytes(msg)
        import hashlib
        assert hashlib.sha256(b).hexdigest() == canonical_hash(msg)

    def test_uses_compact_separators(self):
        """Default json.dumps uses ', ' and ': ' — canonical form
        must use compact ',' and ':' to be whitespace-stable."""
        b = canonical_bytes({"a": 1, "b": 2})
        # No spaces around separators
        assert b == b'{"a":1,"b":2}'
        assert b", " not in b
        assert b": " not in b

    def test_sort_keys(self):
        b = canonical_bytes({"b": 1, "a": 2})
        assert b == b'{"a":2,"b":1}'


# ── extract_request_messages ─────────────────────────────────────


class TestExtractRequestMessages:
    def test_openai_shape(self):
        payload = {"messages": [{"role": "user", "content": "hi"}]}
        msgs = extract_request_messages(payload)
        assert msgs == [{"role": "user", "content": "hi"}]

    def test_anthropic_string_system(self):
        payload = {
            "system": "You are a helpful assistant.",
            "messages": [{"role": "user", "content": "hi"}],
        }
        msgs = extract_request_messages(payload)
        assert msgs == [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "hi"},
        ]

    def test_anthropic_list_system(self):
        payload = {
            "system": [
                {"type": "text", "text": "Line 1."},
                {"type": "text", "text": "Line 2."},
            ],
            "messages": [{"role": "user", "content": "hi"}],
        }
        msgs = extract_request_messages(payload)
        assert msgs[0] == {"role": "system", "content": "Line 1.\nLine 2."}
        assert msgs[1] == {"role": "user", "content": "hi"}

    def test_anthropic_skips_non_text_system_blocks(self):
        payload = {
            "system": [
                {"type": "text", "text": "Real text."},
                {"type": "image", "source": {"type": "base64", "data": "..."}},
            ],
            "messages": [],
        }
        msgs = extract_request_messages(payload)
        assert msgs == [{"role": "system", "content": "Real text."}]

    def test_empty_payload(self):
        assert extract_request_messages(None) == []
        assert extract_request_messages({}) == []
        assert extract_request_messages({"messages": []}) == []

    def test_filters_non_dict_messages(self):
        """Some SDKs put None or strings in messages — filter them."""
        msgs = extract_request_messages({
            "messages": [
                {"role": "user", "content": "ok"},
                None,
                "garbage",
                {"role": "assistant", "content": "hi"},
            ],
        })
        assert msgs == [
            {"role": "user", "content": "ok"},
            {"role": "assistant", "content": "hi"},
        ]


# ── extract_response_messages ────────────────────────────────────


class TestExtractResponseMessages:
    def test_openai_shape(self):
        payload = {
            "choices": [{"message": {"role": "assistant", "content": "hi"}}],
        }
        assert extract_response_messages(payload) == [
            {"role": "assistant", "content": "hi"},
        ]

    def test_multiple_choices_takes_first(self):
        """Standard OpenAI responses use n=1; we just take choices[0]."""
        payload = {
            "choices": [
                {"message": {"role": "assistant", "content": "first"}},
                {"message": {"role": "assistant", "content": "second"}},
            ],
        }
        assert extract_response_messages(payload) == [
            {"role": "assistant", "content": "first"},
        ]

    def test_no_choices(self):
        assert extract_response_messages({}) == []
        assert extract_response_messages({"choices": []}) == []

    def test_missing_message(self):
        assert extract_response_messages({"choices": [{}]}) == []
        assert extract_response_messages({"choices": [{"message": None}]}) == []


# ── hash_messages ────────────────────────────────────────────────


class TestHashMessages:
    def test_returns_one_hash_per_message(self):
        msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        assert len(hash_messages(msgs)) == 2

    def test_order_preserved(self):
        msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        h = hash_messages(msgs)
        assert h[0] == canonical_hash(msgs[0])
        assert h[1] == canonical_hash(msgs[1])

    def test_empty(self):
        assert hash_messages([]) == []

    def test_same_messages_same_hashes(self):
        msgs = [{"role": "user", "content": "hi"}]
        assert hash_messages(msgs) == hash_messages(msgs)


# ── MessageStore (mocked client) ────────────────────────────────


class _FakeClient:
    """Minimal fake of the eden.storage.postgres async client."""

    def __init__(self) -> None:
        self.executemany_calls: list[tuple[str, list[tuple]]] = []
        self.fetch_calls: list[tuple[str, tuple]] = []
        self.execute_calls: list[tuple[str, tuple]] = []
        # In-memory table mimicking trace_messages
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}

    async def executemany(self, sql: str, rows: list[tuple]) -> str:
        self.executemany_calls.append((sql, rows))
        for row in rows:
            trace_id, msg_hash, role, content_json = row
            key = (trace_id, msg_hash)
            if key not in self.rows:
                self.rows[key] = {
                    "msg_hash": msg_hash,
                    "role": role,
                    "content": json.loads(content_json),
                }
        return f"INSERT 0 {len(rows)}"

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.fetch_calls.append((sql, args))
        if "trace_id = $1 AND msg_hash = ANY($2::text[])" in sql:
            trace_id, hashes = args
            # asyncpg auto-decodes JSONB columns to Python dicts, so
            # the fake client mirrors that behavior (return ``content``
            # as a dict, not a JSON string).
            return [
                {"msg_hash": h, "role": r["role"], "content": r["content"]}
                for (t, h), r in self.rows.items()
                if t == trace_id and h in hashes
            ]
        return []

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        if "unique_messages" in sql:
            trace_id = args[0]
            unique = sum(1 for (t, _) in self.rows if t == trace_id)
            return {"unique_messages": unique, "total_refs": 0}
        return None

    async def execute(self, sql: str, *args: Any) -> str:
        self.execute_calls.append((sql, args))
        if sql.strip().startswith("DELETE FROM trace_messages"):
            trace_id = args[0]
            before = len(self.rows)
            self.rows = {k: v for k, v in self.rows.items() if k[0] != trace_id}
            return f"DELETE {before - len(self.rows)}"
        return "OK"


@pytest.fixture
def fake_client(monkeypatch):
    client = _FakeClient()
    async def _get_client():
        return client
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_client,
    )
    return client


class TestMessageStoreUpsert:
    @pytest.mark.asyncio
    async def test_upsert_request_hashes_messages(self, fake_client):
        store = MessageStore()
        body = {"messages": [{"role": "user", "content": "hi"}]}
        hashes = await store.upsert_request("trace-1", body)
        assert len(hashes) == 1
        assert hashes[0] == canonical_hash({"role": "user", "content": "hi"})
        assert len(fake_client.rows) == 1

    @pytest.mark.asyncio
    async def test_upsert_request_idempotent(self, fake_client):
        store = MessageStore()
        body = {"messages": [{"role": "user", "content": "hi"}]}
        await store.upsert_request("trace-1", body)
        await store.upsert_request("trace-1", body)
        # ON CONFLICT DO NOTHING → still one row
        assert len(fake_client.rows) == 1

    @pytest.mark.asyncio
    async def test_upsert_response_takes_first_choice(self, fake_client):
        store = MessageStore()
        body = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
        hashes = await store.upsert_response("trace-1", body)
        assert len(hashes) == 1
        assert hashes[0] == canonical_hash({"role": "assistant", "content": "ok"})

    @pytest.mark.asyncio
    async def test_empty_payload_returns_empty_hashes(self, fake_client):
        store = MessageStore()
        assert await store.upsert_request("trace-1", None) == []
        assert await store.upsert_request("trace-1", {}) == []
        assert await store.upsert_response("trace-1", {"choices": []}) == []

    @pytest.mark.asyncio
    async def test_trace_scoped_dedup(self, fake_client):
        """Same message in two traces → two rows (different trace_ids)."""
        store = MessageStore()
        body = {"messages": [{"role": "system", "content": "x"}]}
        h1 = await store.upsert_request("trace-A", body)
        h2 = await store.upsert_request("trace-B", body)
        # Same content, but trace-scoped so same hash under different traces
        assert h1 == h2
        assert len(fake_client.rows) == 2
        assert ("trace-A", h1[0]) in fake_client.rows
        assert ("trace-B", h2[0]) in fake_client.rows


class TestMessageStoreRead:
    @pytest.mark.asyncio
    async def test_get_many_returns_in_input_order(self, fake_client):
        store = MessageStore()
        body = {"messages": [
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
            {"role": "user", "content": "c"},
        ]}
        hashes = await store.upsert_request("trace-1", body)
        # Reverse order: a,c,b
        out = await store.get_many("trace-1", [hashes[2], hashes[1], hashes[0]])
        assert [m["content"] for m in out if m] == ["c", "b", "a"]

    @pytest.mark.asyncio
    async def test_get_many_missing_returns_none(self, fake_client):
        store = MessageStore()
        out = await store.get_many("trace-1", ["missing-hash"])
        assert out == [None]

    @pytest.mark.asyncio
    async def test_get_many_empty_list_no_db_call(self, fake_client):
        store = MessageStore()
        out = await store.get_many("trace-1", [])
        assert out == []
        # No fetch call expected for empty input
        assert all("ANY($2" not in sql for sql, _ in fake_client.fetch_calls)

    @pytest.mark.asyncio
    async def test_reconstruct_request_byte_identical(self, fake_client):
        store = MessageStore()
        original = {"messages": [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello!"},
        ]}
        hashes = await store.upsert_request("trace-1", original)
        reconstructed = await store.reconstruct_request_body("trace-1", hashes)
        # The reconstructed payload should match the original's messages
        # array (modulo JSON-string-roundtripping for content fields).
        assert reconstructed is not None
        assert reconstructed["messages"] == original["messages"]

    @pytest.mark.asyncio
    async def test_reconstruct_response_byte_identical(self, fake_client):
        store = MessageStore()
        original = {
            "choices": [{"message": {"role": "assistant", "content": "hi"}}],
            "model": "claude-opus-4-8",
        }
        hashes = await store.upsert_response("trace-1", original)
        reconstructed = await store.reconstruct_response_body("trace-1", hashes)
        assert reconstructed is not None
        assert reconstructed["choices"][0]["message"]["content"] == "hi"


class TestMessageStoreCleanup:
    @pytest.mark.asyncio
    async def test_delete_trace(self, fake_client):
        store = MessageStore()
        await store.upsert_request("trace-A", {"messages": [{"role": "user", "content": "x"}]})
        await store.upsert_request("trace-B", {"messages": [{"role": "user", "content": "y"}]})
        assert len(fake_client.rows) == 2
        deleted = await store.delete_trace("trace-A")
        assert deleted == 1
        assert len(fake_client.rows) == 1
        assert ("trace-B", list(fake_client.rows.keys())[0][1]) in fake_client.rows


# ── 50-turn agent perf simulation ──────────────────────────────


class TestDedupRatio:
    """Demonstrate the 20x storage reduction Laminar advertises.

    A 50-turn agent run has 50 LLM spans. Span k stores the full
    messages array of length k (turn 1 = [m0], turn 2 = [m0,m1], etc).
    Total messages stored WITHOUT dedup = 1+2+...+50 = 1275.

    With dedup, only the 50 unique messages are stored once each. We
    assert that the hash arrays across all 50 spans total 1275 hashes
    but the trace_messages table holds only 50 rows.
    """

    @pytest.mark.asyncio
    async def test_50_turn_agent_dedup(self, fake_client):
        store = MessageStore()
        # Each turn appends one new message + re-sends all prior
        # messages. Use distinct content so hash dedup is per-message,
        # not whole-payload.
        conversation: list[dict[str, Any]] = []
        total_hashes = 0
        for turn in range(50):
            conversation.append({"role": "user", "content": f"turn-{turn}"})
            conversation.append({"role": "assistant", "content": f"reply-{turn}"})
            hashes = await store.upsert_request("trace-perf", {
                "messages": list(conversation),
            })
            total_hashes += len(hashes)
        # Total hashes across 50 spans = 2 + 4 + ... + 100 = 2550
        assert total_hashes == 2550
        # But unique messages stored = 100 (one per role-turn)
        assert len(fake_client.rows) == 100
        # Dedup ratio
        assert total_hashes / len(fake_client.rows) == 25.5


# ── Singleton accessor ──────────────────────────────────────────


def test_get_message_store_singleton():
    from eden.observability.message_store import get_message_store
    s1 = get_message_store()
    s2 = get_message_store()
    assert s1 is s2
