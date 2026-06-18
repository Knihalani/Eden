"""Unit tests for Phase O — Session recorder.

What's covered:

  redact_event (5 tests)
  ─────────────────────
  * Email pattern redacted
  * SSN redacted
  * Phone redacted
  * Recursive dict / list
  * No PII → unchanged

  event_id (3 tests)
  ────────────────
  * Same input → same id
  * Different input → different id
  * Different sequence → different id

  SessionRecorder (8 tests)
  ──────────────────────
  * start creates session
  * append adds event with sequence
  * end marks ended_at
  * append after end is a no-op
  * events listed in order
  * redact=True removes PII
  * redact=False preserves
  * get_session returns the session

  build_timeline (3 tests)
  ─────────────────────
  * Empty events → empty timeline
  * Counts per type
  * Sorted by count desc
"""

from __future__ import annotations

import pytest

from eden.replay.events import (
    SessionRecorder,
    SessionEventType,
    build_timeline,
    event_id,
    redact_event,
    SessionEvent,
)


# ─- redact_event ─────────────────────────────────────────


class TestRedactEvent:
    def test_email_redacted(self) -> None:
        ev = SessionEvent(
            id="x", session_id="s", sequence=0,
            event_type="user_input",
            timestamp="2026-06-17T12:00:00+00:00",
            payload={"value": "email alice@example.com please"},
        )
        out = redact_event(ev)
        assert "alice@example.com" not in str(out.payload)
        assert "[REDACTED:email]" in str(out.payload)

    def test_ssn_redacted(self) -> None:
        ev = SessionEvent(
            id="x", session_id="s", sequence=0,
            event_type="user_input", timestamp="",
            payload={"value": "my SSN is 123-45-6789"},
        )
        out = redact_event(ev)
        assert "123-45-6789" not in str(out.payload)
        assert "[REDACTED:ssn]" in str(out.payload)

    def test_phone_redacted(self) -> None:
        ev = SessionEvent(
            id="x", session_id="s", sequence=0,
            event_type="user_input", timestamp="",
            payload={"value": "call 555-123-4567"},
        )
        out = redact_event(ev)
        assert "555-123-4567" not in str(out.payload)
        assert "[REDACTED:phone]" in str(out.payload)

    def test_recursive_dict_list(self) -> None:
        ev = SessionEvent(
            id="x", session_id="s", sequence=0,
            event_type="meta", timestamp="",
            payload={
                "user": "alice@example.com",
                "history": ["call 555-123-4567", "SSN 123-45-6789"],
                "nested": {"email": "bob@example.com"},
            },
        )
        out = redact_event(ev)
        p = out.payload
        assert "[REDACTED:email]" in p["user"]
        assert "[REDACTED:phone]" in p["history"][0]
        assert "[REDACTED:ssn]" in p["history"][1]
        assert "[REDACTED:email]" in p["nested"]["email"]

    def test_no_pii_unchanged(self) -> None:
        ev = SessionEvent(
            id="x", session_id="s", sequence=0,
            event_type="meta", timestamp="",
            payload={"value": "no PII here"},
        )
        out = redact_event(ev)
        assert out.payload == ev.payload


# ─- event_id ────────────────────────────────────────────


class TestEventId:
    def test_same_input_same_id(self) -> None:
        a = event_id("s", 0, "dom_mutation", {"x": 1})
        b = event_id("s", 0, "dom_mutation", {"x": 1})
        assert a == b

    def test_different_input_different_id(self) -> None:
        a = event_id("s", 0, "dom_mutation", {"x": 1})
        b = event_id("s", 0, "dom_mutation", {"x": 2})
        assert a != b

    def test_different_sequence_different_id(self) -> None:
        a = event_id("s", 0, "dom_mutation", {"x": 1})
        b = event_id("s", 1, "dom_mutation", {"x": 1})
        assert a != b


# ─- SessionRecorder ─────────────────────────────────────


class TestSessionRecorder:
    def test_start_creates_session(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1", user_agent="Mozilla/5.0")
        assert s.id.startswith("sess-")
        assert s.org_id == "o1"
        assert s.user_agent == "Mozilla/5.0"
        assert s.ended_at is None

    def test_append_adds_event_with_sequence(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1")
        ev0 = rec.append(s.id, SessionEventType.DOM_MUTATION, {"op": "add"})
        ev1 = rec.append(s.id, SessionEventType.DOM_MUTATION, {"op": "modify"})
        assert ev0.sequence == 0
        assert ev1.sequence == 1

    def test_end_marks_ended_at(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1")
        out = rec.end(s.id)
        assert out.ended_at is not None

    def test_append_after_end_noop(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1")
        rec.end(s.id)
        ev = rec.append(s.id, SessionEventType.DOM_MUTATION, {})
        assert ev is None

    def test_list_events_in_order(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1")
        rec.append(s.id, SessionEventType.DOM_MUTATION, {"i": 0})
        rec.append(s.id, SessionEventType.USER_INPUT, {"i": 1})
        rec.append(s.id, SessionEventType.NAVIGATION, {"i": 2})
        events = rec.list_events(s.id)
        assert [e.event_type for e in events] == [
            SessionEventType.DOM_MUTATION.value,
            SessionEventType.USER_INPUT.value,
            SessionEventType.NAVIGATION.value,
        ]
        assert [e.sequence for e in events] == [0, 1, 2]

    def test_redact_true_removes_pii(self) -> None:
        rec = SessionRecorder(redact=True)
        s = rec.start(org_id="o1")
        rec.append(s.id, SessionEventType.USER_INPUT, {"value": "alice@example.com"})
        events = rec.list_events(s.id)
        assert "alice@example.com" not in str(events[0].payload)

    def test_redact_false_preserves(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1")
        rec.append(s.id, SessionEventType.USER_INPUT, {"value": "alice@example.com"})
        events = rec.list_events(s.id)
        assert "alice@example.com" in str(events[0].payload)

    def test_get_session_returns_session(self) -> None:
        rec = SessionRecorder(redact=False)
        s = rec.start(org_id="o1")
        assert rec.get_session(s.id) is s
        assert rec.get_session("nope") is None


# ─- build_timeline ────────────────────────────────────


class TestBuildTimeline:
    def test_empty(self) -> None:
        assert build_timeline([]) == []

    def test_counts_per_type(self) -> None:
        events = [
            SessionEvent(
                id="1", session_id="s", sequence=0,
                event_type="dom_mutation",
                timestamp="", payload={},
            ),
            SessionEvent(
                id="2", session_id="s", sequence=1,
                event_type="dom_mutation",
                timestamp="", payload={},
            ),
            SessionEvent(
                id="3", session_id="s", sequence=2,
                event_type="user_input",
                timestamp="", payload={},
            ),
        ]
        tl = build_timeline(events)
        assert {t["event_type"]: t["count"] for t in tl} == {
            "dom_mutation": 2, "user_input": 1,
        }

    def test_sorted_by_count_desc(self) -> None:
        events = [
            SessionEvent(id="1", session_id="s", sequence=0,
                         event_type="a", timestamp="", payload={}),
            SessionEvent(id="2", session_id="s", sequence=1,
                         event_type="a", timestamp="", payload={}),
            SessionEvent(id="3", session_id="s", sequence=2,
                         event_type="a", timestamp="", payload={}),
            SessionEvent(id="4", session_id="s", sequence=3,
                         event_type="b", timestamp="", payload={}),
        ]
        tl = build_timeline(events)
        assert tl[0]["event_type"] == "a"
        assert tl[1]["event_type"] == "b"
        assert tl[0]["count"] == 3
        assert tl[1]["count"] == 1
