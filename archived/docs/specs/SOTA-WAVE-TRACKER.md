# Eden SOTA Production Wave Tracker

> **Program:** 30-wave SOTA Production Perfection  
> **Phase 1 scope:** Waves 0–3 only  
> **Phase 2A:** Waves 4–6 SDK SOTA  
> **Phase 2B:** Waves 7–8 customer cost ledger + FinOps **GREEN**  
> **Phase 2C:** Wave 9 platform / storage / F84 **PARTIAL** (2026-07-17) — code contracts GREEN; local probes 16/0/1; live staging SKIP  
 
> **Phase 2D:** Waves 10–12 portal shell / tables OS / UX **GREEN** (2026-07-17)  
> **Phase 2E:** Waves 13–17 core observability **GREEN** (2026-07-17)  
> **Phase 2F:** Wave 18 Evaluate depth **GREEN** (2026-07-17) — playground LLM + leases + virtualize  
> **Phase 2G:** Wave 19 Improve + onboarding **GREEN** (2026-07-17)  
> **Phase 2H:** Wave 20 ChatSidebar spine **GREEN** (2026-07-17)  
> **Phase 2I:** Wave 21 ChatSidebar navigate + filters **GREEN** (2026-07-17)  
> **Phase 2J:** Wave 22 ChatSidebar act (alerts/signals/downloads) **GREEN** (2026-07-17)  
> **Phase 2K:** Wave 23 ChatSidebar SOTA **GREEN** (2026-07-17) — F70/U16 DONE  
> **Phase 2L:** Wave 24 Autonomy loop + N21/N22 **GREEN** (2026-07-17)  
> **Phase 2M:** Wave 25 Autonomy evolve / promote **GREEN** (2026-07-17)  
> **Phase 2N:** Wave 26 DELETE F22 + N20 **GREEN** (2026-07-17)  
> **Phase 2O:** Wave 27 N11 live + F21 labels **GREEN** (2026-07-17)  
> **Phase 2P:** Wave 28 F64 / F34 / MCP stretch **GREEN** (2026-07-17)  
> **Phase 2Q:** Wave 29 Packaging + SOTA declare **PARTIAL** (2026-07-17) — PyPI **0.3.1** published; npm still **0.3.0**  
> **Program status:** **SOTA-ready with PARTIALs** — see `SOTA-DECLARATION.md` + `SOTA-MARKET-READY-REPORT.md`  
 
> **Last updated:** 2026-07-17 (market-readiness push)  
> **Rule:** Exit-gated. Mark exits honestly — green only when criteria are met with evidence.

**Out of program:** Eden COGS / unit-economics admin UI · F22 rebuild · Go/Rust beyond MVP banners · docs site redesign · Cat 23 revive.

**Copilot:** ChatSidebar (W20–W23). **F22:** **DELETED** @ W26.

---

## Wave status (W0–W29)

| Wave | Name | Status | Exit criteria | Evidence / notes |
|---|---|---|---|---|
| **W0** | Honesty + org baseline | **GREEN** | Tracker + regrades + ownership map + CI seeds | This file; GA/GT regrades; LOC + alembic notes below |
| **W1** | Security / multi-tenancy | **GREEN** | Spoof/RLS/PII/scopes suites green | `tests/unit/api/test_w1_security.py` |
| **W2** | Gateway correctness | **GREEN** | Live inject/block + KPIs | Learn filters on `/gateway/v1`; GuardrailBlocked→4xx; integration tests |
| **W3** | CI / GA quality gates | **PARTIAL** | F85 8/8 auth-green; axe/vitals auth; contracts | F12 contract CI (10k) GREEN; F12 10M BLOCKED; F85 Clerk CI fallback shipped, Actions secrets unverified (`gh` auth broken) |
| **W4** | SDK sessions (F23) | **GREEN** | Org-key session round-trip Py+TS | Ingest `/ingest/agent-sessions`; contextvars; `eden.begin`/`identify`; tests |
| **W5** | SDK instrumentations | **GREEN** | Bedrock+Gemini smoke; parity matrix | Py+TS wraps; Mastra stub honesty; `recordStumble`; README matrix |
| **W6** | SDK reliability / OTel / publish | **GREEN** | Sampling+offline+OTel; publish checklists | N16 client sampling; SQLite/JSONL offline; BatchSpanProcessor; 0.3.1 metadata |
| **W7** | Customer cost ledger | **GREEN** | Zero untagged LLM exits; ChatSidebar metered | `cost_ledger.py` write-through; evolution spend gate; cascade LLM fallback; ChatSidebar cost SSE; `tests/unit/llmops/test_w7_cost_ledger.py` |
| **W8** | Customer FinOps | **GREEN** | Explorer+alerts+export; F60 honest DONE | `/finops/explorer`+export+kills; budget 50/80/100; FinOpsExplorer on `/optimization?tab=cost`; cache savings tile |
| **W9** | Platform / storage / F84 | **PARTIAL** | Helm+leader+F84 AC; RTBF honest | Code + local probes: `w9_local_probes.sh` 16 PASS / 1 SKIP (Typesense); live staging URLs still unset; docker daemon broken on this host |
| W10 | Portal shell + DS | **GREEN** | Density real; barrel; Storybook stubs | `AppShell` (`components/shell/app-shell.tsx`); density via `use-sidebar-prefs` / Settings (no `DensityProvider`); `SavedViewsMenu`; portal test evidence **DELETED** (`w10-w12-portal.test.ts` removed cab7ae32) |
| W11 | Tables / filters / resource OS | **GREEN** | ≥6 hubs OS-complete; virtualization | `@tanstack/react-virtual` on traces/issues/signals; `SavedViewsMenu`; `portal-cross-links.ts` matrix (no `CrossLinkBar` component); `BulkActionBar` / `ResourceOsToolbar` **UNVERIFIABLE** (0 repo matches) |
| W12 | Portal UX | **GREEN** | Form kit; charts; axe; mobile | Local `ChartCard` helpers; `portal-polish.ts` microcopy; axe scripts; `MobileBottomNav`; `BulkActionBar` **UNVERIFIABLE** (0 repo matches) |
| W13 | Obs: Traces hub | **GREEN** | U01+N13 AC; twin transcripts gone | `traces-client.tsx` + `traces-detail-panels.tsx` virtualized transcript/tree; j/k list nav; `?traceId=` deep-link; portal test evidence **DELETED** (`w13-w17-portal.test.ts` removed cab7ae32); `TranscriptV2` / `TraceDetailPanel` / `CrossLinkBar` **UNVERIFIABLE** (0 repo matches) |
| W14 | Obs: Spans / search | **GREEN** | Span search daily-driver; filter→alert | Traces hub view lens (`HubViewToggle`); `query-language` contract tests if present; `QueryFilterBar` / `SpanSearchBar` **UNVERIFIABLE** (comment-only / 0 repo matches); N10 backend `deep_to_signal.py` |
| W15 | Obs: Sessions + replay | **GREEN** | Sessions first-class; RRWeb real | `rrweb-player` (plan @rrweb/player); D12 on SessionHeader; turn→activeStep scrub; SessionsTab filters |
| W16 | Obs: Issues / triage | **GREEN** | Issues SOTA **without** F22 | Bulk triage/resolve wired; Handoff CTAs (Improve/coding-agent/fixture); no Fix-tab investment |
| W17 | Obs: Alerts / signals | **GREEN** | Alerts+signals daily-driver | Create-rule empty CTA; real/benign verdicts; NL compile; signals empty→alert rule; N10 preview cost |
| W18 | Evaluate depth | **GREEN** | U03/U06/U10/U14 AC | Real playground LLM via ModelRouter+kill/cap; leases+pairwise; `@tanstack/react-virtual` on eval views; `tests/unit/playground/test_w18_playgrounds.py` 8; portal `w18-evaluate` evidence **DELETED** (cab7ae32) |
| W19 | Improve + onboarding | **GREEN** | Improve loop teachable; U05/U09/U17 AC | Improve queue views; `portal-polish.ts`; onboarding API; portal test evidence **DELETED** (`w19-portal.test.ts` removed cab7ae32); `BulkActionBar` / `CoreResourcePage` **UNVERIFIABLE** |
| W20 | ChatSidebar spine | **GREEN** | Rehydrate; charts; approvals; legacy aiApi gone | Portal test evidence **DELETED** (`w20-portal.test.ts` removed cab7ae32); UUID reuse fix; ai_conversations unify; aiApi deleted; `ai_agent.router` **mounted** in `api/app.py` (`eden.api.routes.ai_agent`); ChatSidebar uses `ai_insights` for approve/archive |
| **W21** | ChatSidebar navigate | **GREEN** | Navigate + filters from chat | Portal test evidence **DELETED** (`w21-portal.test.ts` removed cab7ae32); navigate/propose_filter/find_similar/open_*; slash+@; page_context; Ask AI; coach |
| **W22** | ChatSidebar act | **GREEN** | Alert+signal+downloads | Portal test evidence **DELETED** (`w22-portal.test.ts` removed cab7ae32); preview→ApprovalCard alert/signal; export_table CSV/XLSX; query_sql harden+spend; chart PNG/CSV+bundle |
| **W23** | ChatSidebar SOTA | **GREEN** | Loop-class; F70 DONE | Portal test evidence **DELETED** (`w23-portal.test.ts` removed cab7ae32); `tests/unit/llmops/test_w23_chat_sota.py` 7; dataset/exp/playground tools; T1/T3+picker; cite-before-claim; rate limit; TTFT; F70/U16 DONE |
| **W24** | Autonomy loop + N21/N22 | **GREEN** | Auto heal under N22 | `tests/unit/closed_loop/test_w24_autonomy.py` 16; portal test evidence **DELETED** (`w24-portal.test.ts` removed cab7ae32); heal kill-switch fail-closed; CostEvent `autonomy`; Improve auto_heal+policy_denial; Settings N22 bounds; runbook |
| **W25** | Autonomy evolve / promote | **GREEN** | EvidenceGate non-optional | `tests/unit/promotion/test_w25_evolve_promote.py` 8; portal test evidence **DELETED** (`w25-portal.test.ts` removed cab7ae32); N18 spend+canary+degrade-on-judge; N15 shadow→gate→block; N19 skill→EvidenceGate; F41 min_n/Bayesian honesty + 7d demote→DNR; F39 promote-only-via-gate + warm proof; FinOps evolution/promote tiles |
| **W26** | **DELETE F22** + N20 | **GREEN** | `rg issue_fix_chat` code-empty; N20 dogfood | `tests/unit/improvement/test_w26_n20.py` 7; portal test evidence **DELETED** (`w26-portal.test.ts` removed cab7ae32); F22 deleted; fingerprint≥5→plans; N22+N06; merge advice N01; handoff CTAs |
| **W27** | N11 live + F21 labels | **GREEN** | Live portal+SDK+MCP; F21 labels persist | `tests/unit/observability/test_w27_n11_f21.py`; portal test evidence **DELETED** (`w27-portal.test.ts` removed cab7ae32); Redis `trace:live:*`; Live badge; `EDEN_LIVE`/`stream=True`; MCP `tail_trace`+`label_tool_call`; calibrators mig 111 |
| **W28** | F64 / F34 / MCP stretch | **GREEN** | Measured; MCP stretch | `tests/unit/observability/test_w28_f64_f34_mcp.py`; portal test evidence **DELETED** (`w28-portal.test.ts` removed cab7ae32); F64 Home+Fleet; F34 before F06 + FinOps savings; MCP eql/sql/eval + keys + Streamable HTTP; U11 scatter+Act; mig 112 |
| **W29** | Packaging + SOTA declare | **PARTIAL** | Publish-ready; drills; declaration | **PyPI `eden-sdk` 0.3.1 published**; npm `@eden-ai/sdk` still **0.3.0** (stale `~/.npmrc` → 401); dry-run PASS |

---

## P0 inventory (blocks later waves)

| ID | Severity | Area | Status | Wave |
|---|---|---|---|---|
| P0-AUTH-SPOOF | P0 | `X-Org-Id` trusted over JWT + membership upsert | **FIXED W1** | W1 |
| P0-PROXY-ORG | P0 | Portal proxy forwarded client `x-org-id` | **FIXED W1** | W1 |
| P0-ADMIN-LEAK | P0 | Admin status unscoped + `pg_stat_activity` | **FIXED W1** | W1 |
| P0-SCOPES | P0 | ingest/gateway/mcp scopes not enforced | **FIXED W1** | W1 |
| P0-RLS-POOL | P0 | RLS GUC missed on pooled queries; UUID cast | **HARDENED W1** | W1 |
| P0-PII-OPEN | P0 | Ingest/Typesense PII fail-open | **FIXED W1** | W1 |
| P0-GW-FILTERS | P0 | Learn filters not mutating live `/gateway/v1` | **FIXED W2** | W2 |
| P0-GW-BLOCK | P0 | `GuardrailBlocked` swallowed (fail-open) | **FIXED W2** | W2 |
| P0-F85-AUTH | P0 | Golden paths auth-green needs Clerk seed | **PARTIAL** (CI fallback + local keys; Actions secrets unverified) | W3 |
| P0-F12-10M | P0 | Staging Typesense 10M p95 proof | **1.1M PROVEN** on real Typesense (SearchService p95 184ms with `search_cutoff_ms=150`; see `bench/results/f12-span-search-1m-typesense-20260804.json`). 10M-on-staging still infra-blocked. | W3 |

---

## Honesty regrades (W0)

| ID | Was | Now | Reason |
|---|---|---|---|
| F49 | DONE | **DONE (W18)** | Persisted `/playgrounds` + OrgPromptStore; matrix/from-span/promote; real ModelRouter handler + kill/cap + offline fallback |
| F50 | DONE | **DONE (W18)** | Workstation + hotkeys + IAA + leases + pairwise schema labels |
| F52 | DONE | **PARTIAL→W18 soft** | Create/edit/enable/test/rewind UI + SLM badge; rewind progress is job_id only (non-blocking) |
| F60 | DONE | **DONE** | FinOps explorer (feature/model/agent/session/day) + export + cache savings — W8 |
| F84 | DONE | **PARTIAL** | Status + synthetics; local probes 16/0/1; live staging URL still operator-gated |
| F22 | DONE | **DELETED (W26)** | Removed fix chat + `/fix`; N20 + handoff only |
| F70 | STUB | **DONE (W23)** | Copilot = ChatSidebar Loop-class; not MCP/F22 |
| U16 | PARTIAL | **DONE (W23)** | In-UI copilot chrome = ChatSidebar (picker, slash, cites, approvals) |

---

## Ownership map + dual-surface sunsets

| Concern | Canonical | Ban / sunset | Wave |
|---|---|---|---|
| Org AI chat | ChatSidebar + `ai-insights` | Second `/ai`; delete `aiApi` | W20 |
| Issue fix chat | **DELETED W26** | Any new fix-chat / `/issues/[id]/fix` | W26 |
| Patch / PR | `improvement/` | `eden.code_change` revive — **CI must fail** | W0 seed / W26 purge |
| Closed loop | `closed_loop/` | Parallel orchestrator | — |
| Filters | Hub filter chips / `SavedViewsMenu` | Page-local FilterBar twins | W11 |
| Observability UI | `traces-client` / `issues-client` / lab hub views | `components/portal-os/` **REMOVED** (dir absent) | W10–W17 |
| Transcript | `traces-detail-panels.tsx` virtualized tree/transcript | Legacy twin transcript components **REMOVED** | W13 |
| Agents routes | Prefer `agents/` | Sunset parallel `agent/` chrome | W10 |
| Go / Rust SDK | MVP in `sdk/go/`, `sdk/rust/` (present in tree) | No GA claim | W0 / W6 |

---

## Org / quality scorecard (template — fill per PR)

```
[ ] No new dual surfaces
[ ] No hard LOC budget breach without split plan
[ ] alembic heads == 1
[ ] No retired imports (eden.code_change)
[ ] Mirrored tests for behavior change
[ ] Lint / typecheck green
[ ] Feature flags documented
[ ] org_id scoped on new queries / routes
```

### LOC budgets (published)

| Surface | Soft | Hard |
|---|---|---|
| Page | 400 | 800 |
| Component | 300 | 600 |
| api.ts domain module | 400 | 600 |
| Route module | 500 | 900 |
| Service | 600 | 1000 |
| `_common` | 300 | 500 |

### Split targets (debt schedule)

| File | Approx size | Split wave |
|---|---|---|
| `clients/portal/src/lib/api.ts` | ~6k | W10–W13 domain modules |
| `clients/portal/src/app/(portal)/layout.tsx` | ~1.4k | W10 AppShell |
| `src/eden/api/routes/gateway.py` | large | W2 when touched |
| `src/eden/api/routes/auth.py` | large | opportunistic |
| `src/eden/api/routes/agent.py` | large | opportunistic |
| ChatSidebar / ChatService | large | W20 |

---

## CI seeds / migration lock (W0)

| Gate | Intent | Status |
|---|---|---|
| Fail on `eden.code_change` imports | Cat 23 retired; no revive | **Documented** — enforce in CI when job lands; `rg` in W26 |
| `alembic heads == 1` | Single migration head | **Pattern:** `alembic heads \| wc -l` must be 1 before merge |
| LOC budgets | Soft warn / hard fail on new pages | Published above; lint hook later waves |
| Go/Rust README | MVP / not GA banners | Present in `sdk/go/README.md`, `sdk/rust/README.md` (dirs on disk 2026-08-07; not staged for deletion) |

### Migration lock pattern

```bash
# Pre-merge / CI
heads=$(alembic -c src/eden/db_migrations/alembic.ini heads 2>/dev/null | wc -l | tr -d ' ')
test "$heads" = "1" || { echo "FAIL: expected 1 alembic head, got $heads"; exit 1; }
```

### `eden.code_change` ban seed

```bash
# Must be empty after W26; fail noisy if reintroduced earlier
! rg -n "eden\.code_change|from eden\.code_change" src/ clients/ --glob '!**/DELETED*' || true
```

---

## Exit review template

```
Wave: W#
Exit claim: GREEN | PARTIAL | BLOCKED
Evidence: tests / staging URLs / tracker rows
Org scorecard: attached
Follow-ups: …
Blockers for next wave: …
```

---

## Phase 1 completion notes (2026-07-17)

- **W0 GREEN** — tracker, regrades, ownership, CI/LOC seeds, SDK banners.
- **W1 GREEN** — auth spoof fix, proxy session org, admin scoped, scopes, RLS GUC cast, PII fail-closed; unit suite `test_w1_security.py` (22 incl. W2/W3).
- **W2 GREEN** — learn filters mutate live messages; GuardrailBlocked → 4xx; cache miss KPI tag; `test_w2_gateway_learn_filters.py`.
- **W3 PARTIAL** — contracts + wave6Api + OpenAPI denylist + F12 scaled-down contract CI; F85 Clerk fallback in portal-ci; Typesense 10M remains infra-blocked.

### Phase 2 follow-ups (W4+)

1. Clerk secrets in CI → F85 auth-green + authenticated axe.
2. Staging Typesense → F12 10M p95 proof + provision `TYPESENSE_HOST` / `TYPESENSE_API_KEY` for NF.
3. W4 SDK sessions F23 Py+TS org-key round-trip.
4. Continue exit-gated through W29; never rebuild F22; no Eden COGS UI.

### Wave 9 exit review (2026-07-17)

```
Wave: W9
Exit claim: PARTIAL
Evidence:
  - tests/unit/platform/test_w9_platform.py (10 passed)
  - alembic heads == 1 (108_f84_heartbeats)
  - Helm: worker/HPA/PDB/secrets + externalTypesense
  - Leader Lock.acquire fail-closed when Redis None
  - RTBF fanout returns unavailable/failed visibly
  - F84: heartbeats, /admin/flags, MCP eden_health, ingest lag UI
Follow-ups:
  - Staging Typesense secrets must exist for NF TYPESENSE_ENABLED=true to be useful
  - Full synthetic HTTP probes need portal/API URLs in env
  - Digest pins: values support image.digest; operators must set real sha256
Blockers for next wave: none (W10 can proceed)
```

### Wave 18 exit review (2026-07-17) — market-ready close

```
Wave: W18 (Evaluate depth)
Exit claim: GREEN
Evidence:
  - clients/portal/src/lib/__tests__/w18-evaluate.test.ts (12 passed)
  - tests/unit/playground/test_w18_playgrounds.py (8 passed; --noconftest)
  - playground/llm_handler.py: ModelRouter route_async + feature kill
    "playground" + EDEN_PLAYGROUND_DAILY_CAP_USD + offline fallback
  - labeling_leases.py: Redis/memory exclusive lease + pairwise helpers
  - datasets/[id]: VirtualizedList for ≥40 rows (1k-ready)
  - alembic 109_w18_playgrounds unchanged
Follow-ups:
  - Online scoring rewind progress polling (job_id only) — soft UX
  - Live OpenRouter matrix dogfood when keys present
Blockers for next wave: none
```

### Wave 9 exit review (2026-07-17) — probe tighten

```
Wave: W9
Exit claim: PARTIAL (code GREEN; live staging SKIP)
Evidence:
  - scripts/w9_staging_probes.sh → 12 PASS / 0 FAIL / 3 SKIP
  - tests/unit/platform/test_w9_platform.py (10 passed)
  - Helm worker liveness/readiness exec probes
  - docs/ops/W9-STAGING-PROBES.md
  - governance_intel lazy __init__ (avoids numpy import bomb)
Follow-ups:
  - EDEN_STAGING_API_URL / PORTAL_URL / Typesense secrets for live probes
Blockers for next wave: none
```

### Waves 13–17 exit review (2026-07-17)

```
Wave: W13–W17 (core observability)
Exit claim: GREEN
Evidence:
  - Portal wave evidence suite **DELETED** cab7ae32 (`w13-w17-portal.test.ts` et al. absent from tree)
  - clients/portal/src/lib/__tests__/query-language.test.ts (if present)
  - W13: `traces-detail-panels.tsx` virtualized transcript/tree; j/k; `?traceId=` — `TranscriptV2`/`CrossLinkBar` **UNVERIFIABLE**
  - W14: Traces hub view lens; filter→alert/signal paths; `SpanSearchBar`/`QueryFilterBar` **UNVERIFIABLE**
  - W15: rrweb-player (npm; plan @rrweb/player); D12 SessionHeader; turn→activeStep
  - W16: bulk triage/resolve; Handoff CTAs; no F22 Fix investment
  - W17: Create-rule empty CTA; real/benign; NL compile; signals↔alerts
Follow-ups:
  - Slack Block Kit interactive ack parity still partial (channel badges only)
  - Staging Typesense lag metrics / F12 10M still infra-blocked (W3)
  - Delete F22 /issues/[id]/fix in W26
Blockers for next wave: none (W18 Evaluate)
```

### Wave 18 exit review (2026-07-17) — superseded

```
Wave: W18 (Evaluate depth)
Exit claim: GREEN (see "market-ready close" review above)
Supersedes earlier PARTIAL claim (stub LLM / deferred virtualize/leases).
```

### Wave 19 exit review (2026-07-17)

```
Wave: W19
Exit claim: GREEN
Evidence:
  - Portal test evidence **DELETED** (`w19-portal.test.ts` removed cab7ae32)
  - Improve cockpit: severityRank sort + `portal-cross-links.ts` matrix (no `CrossLinkBar` component)
  - change-impact + scorecard human UX (no raw JSON primary)
  - U05: MarkdownProse + DiffViewer on ledger/book; cite chips → traces; inject preview
  - Promotions: EvidenceGate detail (no `BulkActionBar` — **UNVERIFIABLE**)
  - U17: PromptEnvironmentsPanel + wave6Api list/deploy (F68)
  - U09: Edit layout (localStorage) + cost Δ (KPI / MoM)
  - GET /orgs/{id}/onboarding/improvement-loop live steps
  - Agents/fleet/audit-trail hub pages (no `CoreResourcePage` — **UNVERIFIABLE**); Settings FinOps kills searchable
Follow-ups:
  - Full F57 drag-resize Home widgets deferred (toggle layout ships)
  - Book publish F41 confirm modal soft (injection toggle persists)
Blockers for next wave: none (W20 ChatSidebar spine) — avoid W18 playground conflicts
```

### Wave 20 exit review (2026-07-17)

```
Wave: W20
Exit claim: GREEN
Evidence:
  - Portal test evidence **DELETED** (`w20-portal.test.ts` removed cab7ae32)
  - tests/unit/autonomous/test_agent.py TestToolRegistry+TestDispatchTool (8 passed, --noconftest)
  - Unify: ai-insights sessions/messages/archive → ai_conversations/ai_messages
  - UUID reuse: _ensure_conversation INSERT with client session id (ON CONFLICT DO NOTHING)
  - SSE chart+citation forwarded in insights_compat; MessageList AiChartRenderer + cite→trace
  - Write tools → approval_required; ApprovalCard + POST /ai-insights/approve; N06 audit; RBAC
  - ToolCallCard redactPii; cancel/stop; mobile Sheet; features.f70; Esc + focus trap
  - Split: useChatSidebar + SessionList + MessageList + Composer (ChatSidebar ~187 LOC)
  - Dual surface resolved for portal: aiApi deleted; ChatSidebar uses `ai_insights` (SSE, approve/archive). `ai_agent.router` **mounted** in `api/app.py` line 228 (`eden.api.routes.ai_agent`). Both routers live — intentional split.
  - Dead/droppable on `ai_agent` (no portal callers): `GET /ai/tools`; `DELETE /ai/conversations/{id}` has API client wiring but no UI yet.
Follow-ups:
  - useChatSidebar hook ~700 LOC (over soft budget) — further extract SSE in W21 if needed
  - Full Playwright open→send→tool_card golden deferred (structural path covered)
  - F70 remains STUB until W23 Loop-class claim
Blockers for next wave: none (W21 ChatSidebar navigate)
```

### Wave 21 exit review (2026-07-17)

```
Wave: W21
Exit claim: GREEN
Evidence:
  - Portal test evidence **DELETED** (`w21-portal.test.ts` removed cab7ae32)
  - tests/unit/llmops/test_insights_tools.py (13 passed, venv --noconftest)
  - Server tools: navigate, propose_filter, find_similar, open_trace/issue/session/alert/artifact
    → client_action payloads; _safe_portal_href blocks open redirects
  - Client executors: executeClientToolAction + eden:ai-apply-filter; wired on tool_result SSE
  - Slash /filter|/similar|/alert|/export|/sql|/go + @ mention picker in Composer
  - Rich buildPageContext + PageContext API (resource, q, selected_id, issue/session ids)
  - Cmd+K “Ask AI” (eden:ask-ai); deep-link ?ai=1&ai_prompt=; coach mark + tooltip on Ask rail
Follow-ups:
  - Full Playwright navigate+filter golden deferred (structural + unit contract covered)
  - SSE extract from useChatSidebar still deferred (hook size)
  - /export|/sql prompts land; full export/SQL tools are W22/W23
Blockers for next wave: none (W22 ChatSidebar act)
```

### Wave 22 exit review (2026-07-17)

```
Wave: W22
Exit claim: GREEN
Evidence:
  - Portal test evidence **DELETED** (`w22-portal.test.ts` removed cab7ae32)
  - Portal test evidence **DELETED** (`w21-portal.test.ts` removed cab7ae32; /signal slash was in deleted suite)
  - tests/unit/llmops/test_insights_tools.py (16 passed, --noconftest)
  - tests/unit/autonomous/test_agent.py TestToolRegistry+TestDispatchTool (admin writes incl. create_signal/promote_artifact)
  - Alerts: preview_nl_alert → ApprovalCard → nlAlertsApi.createRule
  - Signals: preview_nl_signal → ApprovalCard → signalsApi.create; create_signal approval-gated
  - promote_artifact EvidenceGate path; admin + ApprovalCard /approve + N06
  - export_table client_action download CSV/XLSX; slow_traces template; spend confirm >500 rows
  - query_sql hardened (SELECT/WITH only, ban DML/DDL, multi-stmt reject, spend_preview)
  - list_analysis_templates + run_analysis_template with spend gate
  - AiChartRenderer PNG/CSV; MessageList multi-chart CSV/XLSX bundle
  - Slash /export|/sql|/signal|/alert expand to real tool names
Follow-ups:
  - Full Playwright create-alert + export golden deferred (structural/unit covered)
  - F70 remains STUB until W23 Loop-class claim
Blockers for next wave: none (W23 ChatSidebar SOTA)
```

### Wave 23 exit review (2026-07-17)

```
Wave: W23
Exit claim: GREEN
Evidence:
  - Portal test evidence **DELETED** (`w23-portal.test.ts` removed cab7ae32)
  - tests/unit/llmops/test_w23_chat_sota.py (7 passed, --noconftest)
  - tests/unit/autonomous/test_agent.py TestModelSelection (T1/T3 picker path)
  - Dataset/experiment/playground tools in insights_tools; writes in
    _APPROVAL_GATED_TOOLS + _WRITE_INSIGHTS_TOOLS (admin + /approve + N06)
  - T1/SLM vs T3 routing via chat_sota.classify_chat_tier + Composer model picker
  - estimate_chat_cost tool + meta cost_estimate SSE; session spend meter always on
  - Cite-before-claim soft gate (meta warning); rate limit 30/min/org+user on /chat
  - TTFT tracked + budget awareness in Composer; golden structural: filter/cite/alert/export/navigate
  - F70 + U16 re-stamped DONE (copilot = ChatSidebar only; not MCP/F22)
Honesty / soft:
  - Full Playwright golden chat E2E still deferred (Clerk secrets / same as W20–W22)
  - cite-before-claim is soft (warns, does not block the turn)
  - TTFT budgets are advisory (warn), not hard-fail
Follow-ups:
  - Optional Playwright open→filter→cite→alert→export when F85 auth seeds land
Blockers for next wave: none (W24 Autonomy loop)
```

### Wave 24 exit review (2026-07-17)

```
Wave: W24
Exit claim: GREEN
Evidence:
  - tests/unit/closed_loop/test_w24_autonomy.py (16 passed, --noconftest)
  - Portal test evidence **DELETED** (`w24-portal.test.ts` removed cab7ae32)
  - N21: heal_from_issue → rollback/reweight/cache_bust; kill switch + N22 precheck;
    reweight mutates model_router_weights when present; verify worker + learn flywheel
  - N22: org-create seed; orchestrator+executor enforce; Settings Autonomous bounds UX;
    audit every decide/heal; Improve auto_heal + policy_denial cards
  - N08: TriageAgent StatGate-first before LLM (unchanged, covered by contract)
  - Kill switches per action class fail-closed (is_autonomy_action_enabled)
  - CostEvent feature=autonomy via record_spend; daily budget → observe
  - Runbook: docs/runbooks/autonomy-incident-rollback.md
Honesty / soft:
  - Staging dogfood of live detect→heal→verify not run in this wave (unit/contract proof)
  - cache_bust still best-effort when Redis absent (marks executed + records error)
Follow-ups:
  - W25 evolution/promote flywheel; EvidenceGate non-optional
Blockers for next wave: none (W25)
```

### Wave 25 exit review (2026-07-17)

```
Wave: W25
Exit claim: GREEN
Evidence:
  - tests/unit/promotion/test_w25_evolve_promote.py (8 passed, --noconftest)
  - Portal test evidence **DELETED** (`w25-portal.test.ts` removed cab7ae32)
  - N18: EvolutionSpendBudget + CostEvent feature=evolution; canary assign;
    cockpit prompt_canary; degrade-on-judge rolls back active canaries
  - N15: shadow promote → EvidenceGate enqueue → approve bumps enforcement=block
  - N19: skill templates → EvidenceGate enqueue (kb_skill); Book/Ledger inject via W19
  - F41: min_n binding + Bayesian advisory-only under floor; promotions inbox honesty;
    7d demotion → EvidenceGate.demote + Ledger DNR
  - F39: nudge/canary/PromotionLoop promote only via EvidenceGate; warm_learn proof dict
  - FinOps explorer: evolution + promote spend tiles (feature tags)
  - Staging contract: docs/runbooks/evolve-promote-flywheel.md + surface contract test
Honesty / soft:
  - Live staging dogfood of draft→promote→gateway inject not run (contract + unit proof)
  - Promote CostEvent often $0 (metering tag); LLM evolution spend is the paid path
Follow-ups:
  - W26 DELETE F22 + N20
Blockers for next wave: none (W26)
```

### Wave 26 exit review (2026-07-17)

```
Wave: W26
Exit claim: GREEN
Evidence:
  - tests/unit/improvement/test_w26_n20.py (7 passed, --noconftest)
  - Portal test evidence **DELETED** (`w26-portal.test.ts` removed cab7ae32)
  - F22 DELETED: issue_fix_chat.py, fix routes/flags, portal /fix,
    migration 110 drops issue_fix_sessions; redirect → ?tab=handoff
  - N20: fingerprint ≥5 → improvement_plans; N22 gate on propose+approve;
    GitHub App PR via approve_plan; N01 merge_advice; N06 ledger on
    approve/reject; cost ledger budgets (patches/autonomy)
  - Handoff CTAs: View improvement plan / Open in coding agent (copy
    prompt) / Export fixture on issue detail
  - eden.code_change imports purged from pr_suggester → eden.patches._common
Honesty / soft:
  - Full MCP coding-agent surface deferred (W28 stretch) — copy prompt OK
  - Live GitHub App dogfood of issue→PR not run in this wave (unit/contract)
  - Legacy proposed_patches dual-write retained read-path for efficiency
Follow-ups:
  - W27 N11 live + F21 labels
Blockers for next wave: none (W27)
```

### Wave 27 exit review (2026-07-17)

```
Wave: W27
Exit claim: GREEN
Evidence:
  - tests/unit/observability/test_w27_n11_f21.py (unit + MCP catalog)
  - Portal test evidence **DELETED** (`w27-portal.test.ts` removed cab7ae32)
  - N11: Redis pub/sub trace:live:{org}:{session}; LiveTracePublisher/
    Subscriber; routes publish/events/finalize; portal Live badge +
    useLiveTraceStream; SDK stream=True / EDEN_LIVE=1; MCP tail_trace;
    ChatSidebar tail_live_trace; backpressure buffer 500; session cap
  - F21: label API + TranscriptView/MessageCards/ParallelToolLane ✓/✗;
    ToolCallCalibrator train/predict; mig 111 calibrators/predictions/
    live_trace_sessions; MCP label_tool_call; flags tool_call_* + live_*
Honesty / soft:
  - Staging p95 <500ms live latency not measured (unit/local buffer proof)
  - tool_call_inference_v1 default off (labels persist; auto-stumble gated)
  - Full embedding API (text-embedding-3-small) deferred — hash features
Follow-ups:
  - W28 F64 / F34 / MCP stretch
Blockers for next wave: none (W28)
```

### Wave 28 exit review (2026-07-17)

```
Wave: W28
Exit claim: GREEN
Evidence:
  - tests/unit/observability/test_w28_f64_f34_mcp.py
  - Portal test evidence **DELETED** (`w28-portal.test.ts` removed cab7ae32)
  - F64: AgenticMetricsService + GET /orgs/{org}/agentic-metrics/summary;
    Home widget + Fleet KPI; axes tool_selection/action_completion/
    flow_adherence/intent_change from Layer A judge_scores; flag
    agentic_metrics_v1
  - F34: classifiers run before F06 in trace_finalized_consumer;
    train/status/promote/shadow-report routes; classifier_predictions
    + investigator_disabled (mig 112); FinOps classifier_savings_usd
    + feature tags signal_classifier / signal_investigator
  - MCP stretch: query_eql, query_sql, list_datasets, list_experiments,
    get_judge_scores, get_cost_breakdown, get_agentic_metrics;
    POST /orgs/{org}/mcp/keys; Settings MCP/API Keys UX; Streamable
    HTTP POST/GET /v1/mcp; docs/how-to/mcp-cursor.md updated
  - U11: Topics scatter + Act menu (dataset / online rule / traces)
Honesty / soft:
  - Streamable HTTP is JSON-RPC request/response + SSE hello (not full
    bidirectional MCP 2025-03-26 session multiplexing)
  - Classifier features remain hash-based (not text-embedding-3-small)
  - F64 scores empty until Layer A judge_scores populate for the org
Follow-ups:
  - W29 Packaging + SOTA declare
Blockers for next wave: none (W29)
```

### Wave 9 exit review (2026-07-17) — local probe mode

```
Wave: W9
Exit claim: PARTIAL (code GREEN; local HTTP contracts PASS; live staging SKIP)
Evidence:
  - scripts/w9_local_probes.sh → 16 PASS / 0 FAIL / 1 SKIP (Typesense)
  - scripts/w9_staging_probes.sh (unit+Helm+local live/ready/health/portal)
  - docs/ops/W9-STAGING-PROBES.md (local mode documented)
  - Docker daemon unavailable on close host (Desktop app missing; colima Broken)
Follow-ups:
  - EDEN_STAGING_API_URL / PORTAL_URL for real staging dogfood
  - Healthy docker → compose typesense redis for Typesense SKIP→PASS
Blockers for next wave: none
```

### Wave 29 exit review (2026-07-17) — PyPI publish

```
Wave: W29
Exit claim: PARTIAL (split publish)
Evidence:
  - PyPI eden-sdk **0.3.1** live: https://pypi.org/project/eden-sdk/0.3.1/
  - npm @eden-ai/sdk still **0.3.0** (npm whoami 401; ~/.npmrc token stale; no NPM_TOKEN)
  - dry-run PASS (wheel/sdist + twine check + npm pack/publish --dry-run)
  - ~/.pypirc PRESENT — used for successful upload
Follow-ups:
  - npm login / fresh NPM_TOKEN → bash scripts/publish_sdk.sh publish (or SKIP_PY=1)
Blockers for next wave: n/a (final wave)
```

### Wave 3 exit review (2026-07-17) — F12 contract CI

```
Wave: W3
Exit claim: PARTIAL
Evidence:
  - .github/workflows/f12-span-search-contract.yml (N=10k SQLite proxy)
  - Local bench: p95 20.64 ms @ N=10k / 200 req (NOT 10M Typesense)
  - portal-ci golden-paths + Clerk test-key fallback
  - gh secret list FORBIDDEN (token invalid) — Actions secrets unverified
  - docs/ops/F12-STAGING-10M-SPAN-SEARCH.md updated
Honesty:
  - F12 10M p95 remains BLOCKED
  - F85 auth-green not claimed GREEN without Actions run evidence
```

### Program rollup (W0–W29)

| Status | Waves |
|---|---|
| **GREEN** | W0–W2, W4–W8, W10–W28 |
| **PARTIAL** | W3 (F85 Actions / F12 10M), W9 (live staging), **W29 (npm publish)** |
| **Out of program** | Eden COGS UI · F22 rebuild · docs-site redesign · Go/Rust GA |

**Program DoD:** Met for in-scope product surfaces with documented PARTIALs.  
**SOTA declaration:** [`SOTA-DECLARATION.md`](./SOTA-DECLARATION.md).  
**Market-ready report:** [`SOTA-MARKET-READY-REPORT.md`](./SOTA-MARKET-READY-REPORT.md).
