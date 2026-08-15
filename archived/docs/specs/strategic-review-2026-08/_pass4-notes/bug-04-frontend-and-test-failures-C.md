# Pass 4 — Agent C (Adversarial Skeptic) notes on bugs/04-frontend-and-test-failures.md

Mandate: actively try to prove every claim stale/false. Did not coordinate with Agent B's notes
(`bug-04-frontend-and-test-failures-B.md`) until after finishing my own independent re-execution;
read them only at the end to avoid anchoring. Where our findings overlap I note it and move on;
where I found something B didn't, I flag it as new.

## STALENESS CHECK RESULTS (with git evidence)

**Central claim under test: does any commit after `ab490f2a1` (the commit the doc blames for the
`TriageAgent UnboundLocalError`) already fix it?**

- `git log --oneline ab490f2a1..HEAD -- src/eden/issues/triage_agent.py` → **empty**. No commit
  touches this file between the regression-introducing commit and `HEAD` (`6f2a09d3`).
- Confirmed by direct re-execution, not just git history:
  `.venv/bin/python -m pytest -q tests/intelligence/test_triage_agent.py::test_triage_falls_back_to_llm`
  → still fails today with the identical `UnboundLocalError: cannot access local variable
  'llm_error' where it is not associated with a value` at `src/eden/issues/triage_agent.py:282`.
- **Verdict: NOT STALE. Bug is real, unfixed, reproduces today.**

**Full fresh whole-repo backend suite, independently re-run this pass** (not trusting the doc's
number, ran it myself in the background while doing other checks, `623.59s`):
`9 failed, 8491 passed, 161 skipped, 1 xfailed, 8 warnings` — **exact match** to the doc's claimed
`9 failed, 8491 passed, 161 skipped, 1 xfailed, 8 warnings in 385.93s` (only wall-clock differs,
expected on a warm-vs-cold run). The 9 `FAILED` lines match the doc's five-bucket breakdown
1-for-1: `test_triage_falls_back_to_llm`, `test_issue_created_triage_transition`,
`test_no_unwrapped_exc_log_sites`, 3×`test_api_surface_snapshot.py`, 2×`test_migration_matrix.py`,
1×`test_wave6_api_paths_subset_of_backend`.

**Portal work referenced in the task (SavedViewsMenu stub, session timeline, automations tab,
saved views 953286b7/534112b0) — does it already fix anything the doc flags?** No — the doc's
claims about this work are all *positive* (tests pass, stub is justified), not gap claims, and all
independently reproduced fresh this pass:
- `bun run test -- saved-views-menu.test.tsx "traces/traces-client.test.tsx" "signals/automations-panel.test.tsx" traces-session-lens.test.tsx` → `Test Files 4 passed (4)`, `Tests 12 passed (12)`. Exact match.
- Full portal suite: `Test Files 43 passed (43)`, `Tests 203 passed (203)`. Exact match. `node_modules/recharts/lib/util/cursor/getCursorRectangle.js` is present on disk and `git status --porcelain package.json bun.lock` is clean — the doc's narrated "fixed the corruption, reverted the incidental lockfile bump" state genuinely persists in the working tree, not just narrated in prose.
- `grep -rn "\.skip(\|\.todo(\|test\.skip\|it\.skip\|describe\.skip\|xit(\|xdescribe(" src --include="*.test.ts*"` → 0 matches. Exact match.

**Issues "ignored" status wiring — is this already fixed, or is the doc's framing stale/duplicated?**
Re-read current code directly (not trusting the doc's line citations blind):
- `src/eden/api/routes/agent_issues.py:107-114` — `_RESOLVE_STATUSES` still includes `"ignored"`.
- `clients/portal/src/lab/fixtures/issues.ts:5` — still `export type IssueStatus = "open" | "acknowledged" | "resolved";`, no `"ignored"`.
- `grep -n "Dismiss\|Ignore\|ignored" issues-client.tsx` → **zero hits**. No dismiss affordance exists today.
- `src/eden/api/routes/portal.py:156-167`, `_map_issue_status` — confirmed `"ignored"` still maps to `"resolved"` before the frontend sees it (the crash-risk rule-out still holds).
- Cross-checked `bugs/03-api-mcp-contracts.md` directly (not just trusting doc 04's self-description of the cross-reference): §3 "carried-forward findings" lists this as **#3** and the priority list has it as **P0 item 4**, independently, with the same core facts. **Not stale, not contradicted — genuinely still-open, and doc 04's own framing of "primary analysis lives in 03" is accurate**, not a hand-wave.

**Section 8 (`next/dynamic`/`React.lazy` "dead retry button" claim) — this is the doc's most
elaborate mechanism claim and the one most worth trying to break.** Verified byte-for-byte against
the actual installed libraries rather than trusting the doc's paraphrase:
- `node_modules/next/package.json` → `"version": "16.2.10"` — matches the doc's citation exactly.
- `node_modules/next/dist/shared/lib/lazy-dynamic/loadable.js:49-52` →
  `const hasSuspenseBoundary = !opts.ssr || !!opts.loading; const Wrap = hasSuspenseBoundary ? _react.Suspense : _react.Fragment;` — confirms the doc's "because `loading` is always provided, `hasSuspenseBoundary` is true regardless of the `ssr` flag" claim precisely.
- `loadable.js:40` → `const Lazy = (0, _react.lazy)(()=>opts.loader().then(convertModule));` — confirms `next/dynamic` is a thin `React.lazy` wrapper, exactly as claimed.
- `node_modules/react/package.json` → `"version": "19.2.7"` — matches.
- `node_modules/react/cjs/react.development.js:460-513` (`lazyInitializer`) — read the actual function body: `payload._status` starts unset (`-1` guard), the loader `thenable` is invoked only inside the `if (-1 === payload._status)` branch, rejection sets `payload._status = 2; payload._result = error`, and the function unconditionally does `throw payload._result;` (line 513) whenever `_status !== 1`. **This is an exact match** to the doc's "permanently caches a rejection... every subsequent render unconditionally throws" claim — not paraphrase-level, line-for-line.
- `find src/app -iname "*error*.tsx"` → `global-error.tsx`, `(portal)/error.tsx`, `(marketing)/error.tsx`; no nested `traces/error.tsx`; `grep -rln "ErrorBoundary\|componentDidCatch\|getDerivedStateFromError" src` → only `client-error-reporter.ts` (a reporting *utility*, not a boundary component). Confirms no custom boundary exists anywhere, matching the doc.
- **Verdict: this section's technical claims are NOT speculative dressing — they check out precisely against the actual vendored library source at the actual pinned versions.** This upgrades Agent B's "plausible but not independently re-verified byte-for-byte" hedge (see `bug-04-frontend-and-test-failures-B.md` §5) to independently source-verified. I did not build a live browser reproduction of the full click-through (neither did B), but the chain of individually-verified facts (Suspense wrapping → `React.lazy` permanent-rejection caching → unconditional re-throw → no nested boundary → `(portal)/error.tsx`'s `reset()` re-renders the segment without re-creating the module-scoped `Lazy` singleton) is airtight enough that I'd treat "Try again doesn't work for this failure class" as effectively confirmed, not merely "traced."

## CUT (quote + reason)

1. **§6**: `"grep -rln \"= dynamic(\" src --include=\"*.tsx\"` → 17 files (`gateway-client.tsx`, ... `OnboardingOverlay.tsx`)"` — independently re-ran the identical grep: **actual count is 18**, not 17 (`wc -l` on the same command = 18). This duplicates Agent B's finding (`bug-04-frontend-and-test-failures-B.md` §5/CUT#1: missing `traces-client.tsx` and `agents-client.tsx`) — confirmed independently, don't need to re-litigate in synthesis, just flagging that a second independent pass reproduces the same off-by-one so it should be treated as settled fact, not a one-off grep flake.

2. **§9**: `"16 of them in resources.ts (:2987-:4520)"` and `"22 non-test call sites"` total — **NOT caught by Agent B, genuinely new**. Re-ran the exact scoped greps:
   - `grep -n "as unknown as Record" resources.ts` → **17** matches (`2987, 3014, 3162, 3262, 3336, 4509–4520` inclusive — the doc's own cited range `:2987-:4520` does span 17 distinct lines, so the range citation is right but the "16" count is off by one), not 16.
   - `grep -rn "as unknown as" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."` → **24** total non-test sites, not 22 (17 in `resources.ts` + 1 in `analytics.ts:97` + 6 in `core.ts:128/222/241/413/489/492`).
   - This is a pure counting slip, not a wrong conclusion — the qualitative finding ("all intentional, two patterns, no broken-contract marker") still holds under the corrected count. Recommend synthesis fix "22" → "24" and "16" → "17" rather than cutting the section; the systemic finding underneath (no runtime response-shape validation in `core.ts`) is unaffected and I found no reason to doubt it (`grep -rn "zod\|io-ts" src/lib/api/` → no hits, confirms "zero runtime schema validation" independently).

3. **§8**: `"find src/app -iname \"error.tsx\" → only global-error.tsx, (portal)/error.tsx, (marketing)/error.tsx exist"` — **the literal command as quoted does not produce that result**. I ran the identical command (`find src/app -iname "error.tsx"`, note: exact-basename glob, no wildcard) and got only **2** results (`(portal)/error.tsx`, `(marketing)/error.tsx`) — `-iname "error.tsx"` cannot match `global-error.tsx` since it requires an exact basename match, not a substring. The actual 3-file result requires `-iname "*error*.tsx"` or similar. This is a small reproducibility/precision defect in the doc's own quoted command (someone likely ran a different, unquoted command and then wrote down a tidier-looking one), but **the underlying substantive claim is still correct** — I independently confirmed via `find src/app -iname "*error*.tsx"` that exactly those 3 files exist and no nested `traces/error.tsx` exists. Recommend a one-line command fix, not a retraction.

4. **Concur with Agent B's CUT#2** (§5's four-layer Issues "ignored" re-citation is redundant with `bugs/03`'s own primary, more detailed treatment) — independently confirmed by reading `bugs/03-api-mcp-contracts.md` directly myself (see staleness section above): `03`'s §3 carried-forward #3 and P0-priority item 4 cite the identical files/lines. Recommend trimming §5 to a pointer + keeping only the novel kanban-crash-risk rule-out, as B already recommended. Not re-deriving further detail here to avoid duplicating B's note.

## NEW FINDINGS

1. **The doc's single most load-bearing claim — the `TriageAgent` regression — survives the harshest test I could apply (a fresh `git log` diff plus a fresh, direct pytest re-run against current `HEAD`) with zero drift.** Nothing after `ab490f2a1` touches the file; the failure reproduces character-for-character. This is the opposite of stale — if anything it's the most solid, most independently-reproducible finding in the whole doc.

2. **`as unknown as` counting error** (see CUT #2) — 24 actual non-test sites / 17 in `resources.ts`, not the doc's 22 / 16. New, not previously flagged by Agent B.

3. **§8's cited `find` command doesn't reproduce its own stated output** (see CUT #3) — a reproducibility nit, substance unaffected. New, not previously flagged by Agent B.

4. **Section 8's mechanism claims are stronger than "traced, not black-box tested" (Agent B's hedge)** — after reading the actual `lazyInitializer` function body and the actual `loadable.js` Suspense-wrapping logic at the exact pinned versions, I'd upgrade this from "plausible reasoning" to "independently source-verified, line-accurate." Recommend synthesis not water this down further; if anything the one remaining gap is a literal in-browser click-through, which neither pass has done, but the source-level chain leaves very little room for the conclusion to be wrong.

5. Spot-checked two claims not touched by Agent B and found them accurate: `tests/portal/test_session31_pq4_pq13.py:59` and `test_session32_pq7_pq14.py:160` skip reasons match the doc's quoted strings verbatim (`"install / marketing snippet surface N/A"`, `"billing page removed; PQ-9 surface N/A"`), and `find src/app -iname "*billing*"` in the portal turns up nothing, confirming the billing page really was removed (not a stale/false product-descope claim). Also independently confirmed the `sql_schema_guard_baseline.json` violation count is exactly **14** via a direct `json.load` + `len()`, matching the doc's xfail-burn-down citation exactly.

## Overall assessment

Could not break any of this doc's substantive claims. Every test-count, every file:line citation,
and even the deepest mechanism claim (§8's React internals trace) reproduced exactly on
independent, fresh re-execution — including a full 10-minute whole-repo backend suite run I did
not shortcut. The only defects found across two independent adversarial passes (mine + Agent B's)
are small counting/reproducibility slips (dynamic-import count 17→18, `as unknown as` count
22→24/16→17, one non-reproducing `find` command) that don't change any conclusion. Recommend
synthesis treat this as the most reliable of the bugs/ docs reviewed so far, fix the three small
counts/commands, and trim §5's redundancy with `bugs/03` per both B's and my independent
agreement.
