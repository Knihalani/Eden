---
title: "44 — Browser session recording (Phase O)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 44 — Browser session recording (Phase O)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Laminar "browser session recording" gap. Ships
> the **event model + storage + redaction** backend
> (``eden.replay.events.SessionRecorder``); the actual
> browser-side recorder (RRWeb / DOM-diff) is Phase O.5.
> ~370 LOC backend + 19 unit tests.

## Goal & motivation

Laminar's biggest differentiator: when an agent run fails,
the operator can replay the exact browser session that
produced the failure. The user sees a DOM-diff timeline
("at step 5, the form was empty; at step 6, the user
typed 'foo'; at step 7, the agent returned a hallucination").

Browser recordings contain PII. The recorder applies
``MultiLangPIIMasker`` (Phase K) before sending events to
the server, and the server applies a second pass. The
default redaction removes emails / SSNs / credit cards /
IP addresses; org-configurable via the existing
``org_pii_policies`` table.

This phase ships the **backend half** (event model,
storage, redaction, replay timeline). The browser-side
recorder (RRWeb integration) is Phase O.5 because it
requires a JavaScript build that depends on the rrweb
library.

## What's in Eden

### Event model

Five event types cover the user-visible surface of a
browser session:

| Type | Captures | Example |
|---|---|---|
| `dom_mutation` | DOM add / remove / modify | `<input id="email" value="alice@…">` |
| `user_input` | Keyboard / mouse / form events | keypress, click, submit |
| `navigation` | URL changes | `pushState`, `location.assign` |
| `console` | `console.log` / `.error` | debug breadcrumb |
| `meta` | Session-level markers | start, end, viewport size |

Each event is identified by a content-addressed hash
(SHA-256 of the canonical JSON form). Two recordings of
the same logical event get the same id — this is the
foundation of idempotent re-runs (the same agent run can
be replayed, and the recording dedupes automatically).

### Redaction

The recorder applies regex-based redaction before sending
events to the server. The redaction catches:

  * Emails → `[REDACTED:email]`
  * SSNs → `[REDACTED:ssn]`
  * Phone numbers → `[REDACTED:phone]`
  * Credit cards (16 digits) → `[REDACTED:cc]`
  * API keys → `[REDACTED:apikey]`

Production wires the full ``MultiLangPIIMasker`` (Phase
K) which catches EU VAT, Chinese ID, etc. The v1 ships
the regex scrubber because it's unit-testable without
the full PII library.

### Replay timeline

The :func:`build_timeline` function returns a renderable
list of "buckets" (one per event type) with counts. The
frontend uses this to render the replay scrubber — a
coloured bar with a "DOM mutations" segment, a "user
inputs" segment, etc.

### Privacy considerations

Browser recordings are sensitive. The default redaction
is conservative (always-on). The user can opt in to
recording per-session (not globally); the operator can
opt out of storing the recording (keeping only the
trace_id association). Both flags live in the existing
``org_pii_policies`` table.

GDPR: the recording is a "user-generated content" record
under Art. 4(2). The operator must disclose the recording
in their privacy policy. The redaction (Phase K) is the
Art. 5(1)(c) data-minimisation control. The
``RtbfRequestTracker`` (Phase K) erases the recording on
RTBF.

## Routes (deferred to O.5)

The backend ships the event model + storage; the routes
are Phase O.5. The deferred routes are:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{org}/sessions` | Start a session |
| `POST` | `/orgs/{org}/sessions/{id}/events` | Append an event |
| `GET` | `/orgs/{org}/sessions/{id}` | Get session + events |
| `GET` | `/orgs/{org}/sessions/{id}/timeline` | Get the renderable timeline |

These are mechanical wrappers around the SessionRecorder.
The hard work — event model, content addressing, redaction,
timeline — is what this phase ships.

## RagaAI / Laminar parity matrix

| Laminar feature | Eden Phase O | Notes |
|---|---|---|
| Browser session recording | ✅ event model + redaction | RRWeb integration in O.5 |
| DOM mutation capture | ✅ dom_mutation event | Wire RRWeb in O.5 |
| User input capture | ✅ user_input event | Same |
| Navigation capture | ✅ navigation event | Same |
| Console capture | ✅ console event | Same |
| PII redaction (basic) | ✅ regex scrubber | MultiLangPIIMasker in O.5 |
| Multi-language PII | ❌ deferred (O.5) | Wired via MultiLangPIIMasker |
| Replay timeline | ✅ build_timeline() | Frontend renders it |
| RRWeb format | ❌ deferred (O.5) | The actual JS build |
| Sandbox replay | ❌ deferred (O.5) | Sandboxed iframe |
| Side-by-side replay (2 sessions) | ❌ deferred (O.5) | The diff timeline |
| Auto-redact org secrets | ❌ deferred (O.5) | Hooks into org_pii_policies |
| Multi-device (mobile, native) | ❌ deferred (O.10) | Big scope |

## What's NOT in this phase (deferred)

- **RRWeb integration** — the actual JS build that
  records the DOM. Phase O.5.
- **Multi-language PII** — wire ``MultiLangPIIMasker``
  (Phase K) into the recorder. O.5.
- **Sandbox replay** — the iframe that replays the
  recorded events deterministically. O.5.
- **Side-by-side replay** — compare two sessions on the
  same timeline. O.5.
- **Routes** — the FastAPI wrappers. Mechanical work,
  O.5.
- **Migration** — ``session_events`` table for durable
  storage. O.5.
- **Frontend timeline** — the React scrubber component.
  Pairs with Phase E (UI polish).

## Failure modes

| Failure | Behaviour |
|---|---|
| Append after session end | No-op (returns None) |
| Unknown session_id | No-op |
| PII pattern not matched | String passes through unchanged |
| Redaction disabled | All PII passes through (logged warning) |
| Network failure (when wired) | Re-queued + retry (Phase O.5) |

## Tests

19 unit tests in ``tests/unit/test_session_recorder.py``:

- `TestRedactEvent` (5) — email, SSN, phone, recursive,
  no-PII unchanged.
- `TestEventId` (3) — same input same id, different
  input different id, different sequence different id.
- `TestSessionRecorder` (8) — start creates session,
  append adds event with sequence, end marks ended_at,
  append after end noop, list events in order, redact
  true removes PII, redact false preserves, get_session
  returns session.
- `TestBuildTimeline` (3) — empty, counts per type,
  sorted by count desc.

All 19 pass; 0 regressions in the existing unit suite.

## Files added

| File | LOC | Purpose |
|---|---|---|
| ``src/eden/replay/events.py`` | ~230 | Event model + recorder + redaction |
| ``src/eden/replay/__init__.py`` | ~10 | Exports |
| ``tests/unit/test_session_recorder.py`` | ~190 | Unit tests |
| ``docs/docs/observability/44-session-recording.md`` | this | Docs |

## Cross-references

- [Phase K — PII Anonymization](33-pii-anonymization-upgrades.md)
  — the ``MultiLangPIIMasker`` that the recorder will
  wire in O.5.
- [Cat 10 — Governance Intelligence](10-governance-intelligence.md)
  — the ``org_pii_policies`` table that controls
  redaction behaviour per org.
- [Phase K — RTBF Tracker](33-pii-anonymization-upgrades.md#rtbf-tracking)
  — the lifecycle that erases the recording on a
  right-to-be-forgotten request.
- [Phase G — TypeScript SDK](43-typescript-sdk.md) — the
  sibling SDK for non-browser agents (Node / Deno).
