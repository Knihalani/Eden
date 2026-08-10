# Wave 10 — Data clarity, not gimmicks (revised)

**Pivot:** the first Wave 10 pass shipped a trace-share dialog — but the feature
was dead weight (the server service was never surfaced, no user asked for it).
Per review it was **removed entirely** (component, test, both API layers). The
real mandate: make it as easy as possible to *understand the data* in Eden —
a focused, clear, usable dashboard; clear navigation; obvious page function.

---

## What was removed — the share feature

- `lab/share-trace-dialog.tsx` + `lab/share-trace-dialog.test.tsx` **deleted**.
- `createTraceShare` + `TraceShare` type removed from `lib/api/portal.ts`.
- `createTraceShare` / `listTraceShares` / `revokeTraceShare` removed from
  `lib/api/resources.ts`.
- Share button, `ShareTraceDialog` mount, `shareOpen` state, and `Share2`
  import removed from the trace action bar in `traces-client.tsx` (plus the
  Share test in `traces-client.test.tsx`). Grep-verified: zero references left;
  `TraceDiffRollup` (used by the diff) correctly preserved.

## What was improved — dashboard clarity

1. **Recent runs + Fleet render by default.** The traces/issues/agents/cost
   queries were already unconditional — `showFleet` only gated the *render*,
   so the previous "Show fleet" button was pure friction hiding already-fetched
   data. The section now shows by default under a "Runs & fleet" header with a
   Collapse/Show toggle for users who want the attention-first view.
2. **Plain-language KPI hints.** Internal jargon removed:
   - Traces: "24h · analytics" / "24h · live" / "from feed" → **"last 24h"** /
     **"recent runs"** / "no runs yet".
   - Failures: "in feed" → **"failing runs"**.
   - Spend: bare "24h" → **"last 24h"**; "X cached" → **"X saved by cache"**;
     "N% vs prior" → **"N% vs prior 24h"**.
   - Dead `data_source` field dropped from the `liveTiles` memo (was only read
     by the removed jargon hint).
3. **"Needs attention" is honest about truncation.** The list caps at 3 — the
   header now says "showing 3 of N" and a **"See all N runs needing attention"**
   link appears (→ `/issues` when open issues exist, else `/traces`), so the
   count in the header never silently exceeds what the page shows.

4. **Hardening (reviewer pass):** `traces-client.tsx` now uses the non-throwing
   `useLabToastSafe()` instead of the conditional-hook try/catch that the
   dialogs were already migrated off — no suppressed rules-of-hooks violations
   remain anywhere.

## Tests

New `home-client.test.tsx` (3 tests): fleet + recent runs visible without a
click; plain-language KPI hints ("recent runs", "none"); see-all link + "showing
3 of 4" note when attention exceeds 3. Share removal verified by the traces
action-bar suite (6 tests) and typecheck.

## Validation

- Portal: **351 vitests pass (72 files)**, typecheck clean, lint 0 errors
  (14 pre-existing warnings).
- Backend untouched this wave.

## Kept from the original Wave 10 (still valuable)

- **A — Living ⌘K palette** (live trace/issue/agent search + direct trace-id
  jump + visible Search (⌘K) triggers) — shipped and tested (8 tests).
- **C — Compare-to-previous-run** ("vs prev" pre-fills the diff dialog with the
  previous same-agent run) — shipped and tested.
- **B — Share** — **removed**, per the pivot above.
