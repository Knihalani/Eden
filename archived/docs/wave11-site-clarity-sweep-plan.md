# Wave 11 — Site-wide clarity sweep (every page, one vocabulary)

**Goal:** make the data in Eden readable at a glance across *every* surface.
Audited all 20+ portal routes; the systemic problem was the UI leaking the
data model — raw enum fragments ("fail", "warn", "ok") in badges, filters, and
counts, and raw ISO timestamps in feed rows. Fixed the whole class at once
through shared helpers, then swept each page for stragglers.

---

## 1 — One severity vocabulary for the entire site

`lab/lab-ui.tsx` now exports a single `severityLabel()`:
`critical → Critical`, `error → Failed`, `warn → Warning`,
`none/ok → OK`, unknown values pass through unchanged. `SeverityBadge`
delegates to it, so **every** page that renders severity now speaks the same
plain words.

Surfaces that previously showed raw enum fragments, all now consistent:

| Surface | Before | After |
|---|---|---|
| Trace/issue/agent/run badges (9 files) | `fail` / `warn` / `ok` | `Failed` / `Warning` / `OK` |
| Traces filter chips | `Fail` / `Warn` / `Ok` | `Failed` / `Warning` / `OK` |
| Agents + Issues filter chips | `Fail` / `Warn` | `Failed` / `Warning` |
| Home "Needs attention" count | `2 fail · 1 warn` | `2 failed · 1 warning` |
| Agents "in list" hint | `fail · warn` | `failed · warning` |
| Session lens turn outcomes | `error` / `mixed` / `ok` | `Failed` / `Warning` / `OK` |
| Alerts panel severity chips | `critical` / `error` / `warn` | `Critical` / `Failed` / `Warning` |
| Alerts panel status chips | `firing` / `muted` / `resolved` | `Firing` / `Muted` / `Resolved` |
| Detectors severity chips | `warn` | `Warning` |
| Automations run status | `completed` / `sent` | `Completed` / `Sent` (Failed dedupes error) |
| Prompt status chips | `draft` / `shadow` / `live` | `Draft` / `Shadow` / `Live` |
| Compare metric | `Fail` | `Fail rate` |

## 2 — Human timestamps instead of raw ISO strings

Feed rows and detail metadata showed raw `startedAt` ISO strings. Now routed
through the existing `formatRelativeTime()`:

- Traces feed rows (`RunListButton`) — "2026-08-01T00:00:00Z" → "3h ago".
- Transcript step "Started" metadata row.
- Session lens: session rows, detail headers, and turn outcomes.

## 3 — Consolidation (removed duplicate helpers)

Three hand-rolled severity-label functions (alerts panel, detectors, and the
inline badge ternaries) collapsed into the single shared `severityLabel`.
One vocabulary, one place to change it.

## 4 — Tests

New `lab/severity-vocabulary.test.tsx` (6 tests): badge labels for each
severity, a no-raw-fragments guard over the badge output, the shared helper's
full mapping, and unknown-value passthrough. Existing suites (alerts, signals,
sessions lens, traces, home) all pass unmodified — confirming the vocabulary
change broke nothing.

## Validation

- Portal: **357 vitests pass (72 files)**, typecheck clean, lint 0 errors.
- Backend untouched.
- Audited-but-unchanged (already clear): Evals (gradeLabel), Prompts chrome,
  Compare (verdictLabel), Artifacts modes, Topics trend badges, Ledger status,
  redteam severities (critical/high/medium/low are already plain English),
  sessions page (redirects to Traces lens), alerts soft-land page, all main
  page headers (live meta + actions).
