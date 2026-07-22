# Interview log — Portal rebuild discovery

Frozen answers. Do not reinterpret without a dated amendment.

---

## Round 1 — 2026-07-21

### A. Product wedge

1. **Winning sentences (both):**  
   - “Closed loop: failure → fix artifact → PR”  
   - “Gateway + observe + improve in one product”

2. **Explicitly refuse in v1:** red team

3. **Day-1 user:** Solo AI eng debugging their agent tonight

### B. Core loop & IA

4. **Surface triage** (table order from Round 1 prompt):

| Surface | Call |
|---------|------|
| Traces / transcript viewer | must |
| Sessions | must |
| Issues / clustered failures | must |
| Alerts / detectors / signals | must |
| Evals (datasets / experiments / playground) | must |
| Improve / plans / artifacts / promote | must |
| Prompts registry | later |
| Guardrails / red-team | must\* |
| Cost / optimization | must |
| Agents / fleet | must |
| Analytics / users / tools | later |
| Audit trail / compliance | must |
| AI assistant / chat-with-trace | must |
| Debugger sessions / replay / time-travel | must |
| Settings / billing / keys | must |
| Home / dashboard | must (landing) |

\*Conflict with A2: red-team killed; guardrails row marked must → resolved in Round 2 or default to **policies without red-team UI**.

5. **Default landing:** Dashboard

6. **Self-heal / PRs:** Eden’s multifaceted improve system (artifacts, optimization, PRs, etc.). **PRs are a big part.**

### C. Pain

7. **Hate list:** Everything looks disorganized and cluttered; visually wrong placement/styling; components look terrible; not clean; confusing; stuff all over the place. Design is broadly bad — not one screen.

8. **Adaptation failure:** Mobile first.

9. **Steal wholesale:** Laminar — “perfect UI as a whole for this stuff”; agent as the first page, well designed.

### D. Constraints

10. **Keep:** docs as they are; i18n. Everything else good to change.

11. **Teardown:** **A** — delete portal app routes/components → stub shell + docs until rebuild.

12. **Success (30 days):**  
    - Look at it → “this looks good, I can use this”  
    - Immediately understand what everything does / where to go  
    - Never think “ooh, that looks wrong”

### E. Feel

13. **Density / grammar:** Laminar

14. **AI placement:** Agent is its **own page** as well as a **clickable bubble**

---

## Round 2 — defaults applied 2026-07-21 (pending explicit confirmation)

Questions were posed in chat. Until answered, these **defaults** are locked for implementation:

| # | Question | Default applied |
|---|----------|-----------------|
| R2.1 | Guardrails must vs red-team kill | **Guardrails policies = must.** Red-team UI = killed forever in v1 (`/redteam` → `/dashboard`). |
| R2.2 | Dashboard vs Laminar agent-first | **Dashboard = agent-centric OS** (health / diagnosis / next action), not Helicone KPI cards. Agents list is core leaf #2. |
| R2.3 | Ship order despite many musts | Follow engineering phases **P0→P7** in README; all must-ships land before “usable v1”, but order is Agents/Dashboard → Observe → Evals → Improve → AI/Debugger → Settings/Audit. |

Amend this section when Round 2 answers arrive.

---

## Phase 1 complete — 2026-07-21

**Branch:** `portal/phase-1-shell`  
**Summary:** Replaced StubChrome with AppShell + DensityProvider; 12-leaf sidebar (Phase 1 `/_stub` hrefs); PortalHeader + single `ui/command-palette`; MobileBottomNav (5) + More sheet; empty Dashboard OS; ComingSoonPanel stubs; en/de shell keys; IA + kill-list contract tests. Product surfaces still stubbed until Phase 2.

---

## Phase 2 complete — 2026-07-22

**Summary:** Live `/agents` (list + fleet), `/agents/connect` (Gateway|SDK, API key create, checklist, troubleshoot, first-trace poll), `/agents/[id]` peeks + ledger + thin redirects; Dashboard populated via `useAgentOsData` / `agent-health` (DiagnosisStrip, Agent OS list, next-action, QueryState). Sidebar agents → `/agents`. Cross-links to Observe/Improve/Cost/Guardrails use `/_stub/...` with query ids. **Gaps:** agent delete UI omitted (no backend delete API); ledger is thin local page (Improve share deferred to Phase 5); Observe/Evals/Improve bodies not started.

---

## Phase 3 complete — 2026-07-22

**Summary:** Live Observe: `/traces` (transcript-first master–detail, modes tree/timeline/meta/scores, sessions lens via `?view=sessions`), `/issues` (+ `[id]`), `/alerts` (inbox|rules|signals). Sidebar + mobile + Cmd+K Sessions (`/traces?view=sessions`); Phase 2 cross-links flipped from `/_stub/traces|issues` to live routes. Contract tests + kill-list (`TraceViewerModal`/redteam bans); Playwright `e2e/golden/agent08-observe-probe.mjs`. **Gaps:** Evals/Improve/Cost/Guardrails/AI/Debugger/Settings still stub; thin APIs use honest empty/error (no invented rows).

---

## Phase 4 complete — 2026-07-22

**Summary:** Live Evaluate hub at `/evals` with primary underline tabs (datasets | playgrounds | experiments) and advanced overflow (labeling | studio | synthetic | eval). URL grammar via `lib/evals-url.ts` + `useEvalsUrlState`; Braintrust compare grades; full tab panels wired to datasetsApi/playgroundApi/offlineExperimentsApi/labelingQueuesApi/metricStudioApi/qaApi/evalApi. `AddToDatasetDialog` closed-loop from Traces + Issues (≤2 clicks). Legacy `/datasets|/playgrounds|/experiments|/labeling|/studio|/synthetic` redirect into hub tabs; softLand excludes evals family; sidebar `evals` → `/evals`. Contract tests (`rebuild-evals`, url/grades), en+de `evals` i18n, Playwright `e2e/golden/agent09-evaluate-probe.mjs` (auth soft-skip). **Gaps:** Phase 5 Improve/Cost/Guardrails still stub (`/_stub/improve`, `/_stub/cost`); live e2e needs auth state.

---

## Phase 5 complete — 2026-07-22

**Branch:** `portal/phase-1-shell`

**Summary:** Live Improve/Cost/Guardrails hubs. `/improve` (queue|plans|artifacts|promotions|ledger|history) + `/improve/plans/[id]` with EvidenceGate, Promote, Open PR; shared `components/improve/*` (LedgerTimeline reused on agents ledger). `/cost` (overview|budget|outcomes|forecast|advisor) on budget/finops/advisor APIs. `/guardrails` policies|violations only — `/redteam` redirects to policies; zero red-team UI. Sidebar/mobile live; IA redirects out of softLand; Issue→Improve via `buildCreatePlanHref` (`/improve?tab=plans&issueId=…`). Contract tests `rebuild-improve|cost|guardrails` (8/8 each); en+de i18n; kill-list clean; `bun run typecheck` + `bun run test` green (256 tests); Playwright `e2e/golden/agent10-improve-probe.mjs` (auth soft-skip). **Gaps (accepted):** Admin EvidenceGate override dialog; Generate Artifact (`authorArtifactNl`); optional ViewsMenu; Guardrails create-only (no update/delete policy API); Cost single-org budget API. Phase 6 AI Agent + Debugger unblocked.

---

## Phase 6 complete — 2026-07-22

**Branch:** `portal/phase-1-shell`

**Summary:** Live `/agent` (page + `AiSessionProvider` + FAB/bubble with mobile-nav mutual exclusion via `data-ai-rail-open`); citations/actions/context model; `/debugger` list + `/debugger/[id]` (replay|compare|time-travel|notes). Sidebar `agent` → `/agent`; Cmd+K Open AI + Debugger; legacy `/debugger-sessions` and `/replay` redirect into debugger. Contract tests `rebuild-ai-agent` + `rebuild-debugger` + `rebuild-phase7`. en+de `ai` / `debugger` / `nav.leaves.agent` = “AI Agent” (≠ Agents).


**Re-run hardening (2026-07-22):** Wired `AiSessionProvider` into `providers.tsx`; replaced stale `/debugger/page.tsx` with Phase 6 version; added `sessions/[sessionId]/page.tsx` redirect; fixed `/replay` → `?tab=replay` + added `/debugger-sessions` redirect in `next.config.ts`; removed orphaned `home-kpi-strip.tsx`; fixed contract test contradictions; **365/365 tests green**.

---

## Phase 7 complete — 2026-07-22

**Branch:** `portal/phase-1-shell`

**Summary:** Live `/settings` (≤8 daily tabs: overview, account, org, members, api-keys, gateway, billing, security + Advanced disclosure); gateway + API keys first-class (read for all, mutate gated in-panel). Live `/audit` (events|packs) + AuditPack generate (`complianceApi.exportPack`); `/audit-trail` → `/audit`; profile/billing/finops → settings tabs. All 12 IA leaves live (`STUB_SURFACE_IDS = []`). Kill-list: no EmbeddedSurface, single `ui/command-palette`, no `/redteam` page. Density via `DensityProvider`; AppShell + MobileBottomNav (5) + More. Golden `e2e/golden/agent11-phase7-probe.mjs` (auth soft-skip). **Gates:** `bun run typecheck` + `bun run test` — **365 tests green**. Engineering DoD §10 signed in `engineering/00-overview.md`. Later Prompts/Analytics remain soft-landed only.

---

## Later complete — Prompts + Analytics — 2026-07-22

**Branch:** `portal/phase-1-shell`

**Summary:** Shipped Later secondary hubs without expanding core nav (still 12 leaves). Live `/prompts` (master–detail version registry, related strip to Evals playgrounds + Improve). Live `/analytics` (`overview|insights|topics|tools|users`); aliases `/users`, `/tools`, `/insights`, `/insights/topics` → analytics tabs. Removed from softLand; Cmd+K + Mobile More entry points; en/de i18n; surface specs `prompts.md` / `analytics.md`; contracts `rebuild-prompts` / `rebuild-analytics`. Settings `tab=analytics` remains prefs-only.

---

## Rebuild verification pass — 2026-07-22

**Branch:** `portal/phase-1-shell`

**Summary:** Post-Phase-7 audit closed remaining gaps. Fixed middleware `HUB_REDIRECT_RULES` that hijacked live `/debugger` → traces and mis-routed `/replay`, `/redteam`, `/promotions`, cost farms; IA §3.4 legacy Tools (`view=replay|debug|time-travel`) now redirect to Debugger (client + link map); deleted kill-list zombie product pages (fleet/incidents/signals/inspector/observability leaves/datasets/playgrounds/experiments/ledger/promotions/optimization farm, etc.) — redirects only; mobile nav yields to AI bubble (`data-ai-rail-open` + `eden:ai-rail-open`); focus rings use `--terminal`/`FOCUS_RING_CLASS`; density/typography polish on traces toolbar, transcript labels, improve queue, detail chrome. Kill-list contract asserts zombies absent.

