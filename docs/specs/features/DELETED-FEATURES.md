# Deleted Feature Specs — Rationale & Merge Map

> **Updated:** July 16, 2026 (portal consolidate + polish)  
> **Inventory:** 24 F-features + **14 N-features** (N23 added; Cat 23 retired)

---

## July 2026 SOTA W26 — F22 DELETED

| Removed | Reason | Replacement |
|---|---|---|
| `src/eden/patches/issue_fix_chat.py` | In-portal SSE fix chat; dual path vs N20 | N20 `improvement/issue_patch_trigger` → `improvement_plans` |
| `POST/GET …/agent-issues/{id}/fix/*` | Fix chat / apply / session routes | Improve approve → GitHub App PR |
| Portal `/issues/[id]/fix` | Fix tab UI | Redirect → `/issues/:id?tab=handoff` |
| Flags `issue_fix_chat_v1`, `issue_fix_auto_verify_v1` | Feature gates for F22 | Removed |
| Table `issue_fix_sessions` | Session store for F22 | Dropped in migration `110_w26_drop_issue_fix_sessions` |

**Status stamp:** F22 = **DELETED** (2026-07-17). Do not rebuild.

---

## July 2026 portal consolidation

### GitHub auto-integrate PR path (removed)

| Removed | Reason | Replacement |
|---|---|---|
| `src/eden/integrations/onboarding_agent.py` | LLM agent that opened SDK integration PRs | Manual SDK install in onboarding overlay |
| `POST /orgs/{id}/github/integrate` | Auto-PR create | Returns **410 Gone** |
| `POST /orgs/{id}/onboarding/sample-request` | Unused stub | Removed |
| `/onboarding/wait` + PR polling UI | Wait-for-merge step | Overlay: Welcome → Connect (optional) → Install SDK → Done |
| `onboarding_integration` in model router `COMPLEX_AGENTS` | Only used by deleted agent | Dropped |

**Kept:** GitHub App authorize / claim / list-repos for Agents → Connect; heuristic `framework_detector` / `sdk_integrator` for local/CLI.

### Portal IA — ghost routes redirected (12-item nav)

| Route | Redirect |
|---|---|
| `/pr-suggestions`, `/agents/eden/inbox` | `/improve?tab=plans` |
| `/closed-loop`, `/autonomous` | `/improve` |
| `/observability`, `/observability/apm` | `/traces` |
| `/inspector` | `/traces?view=inspect` |
| `/replay` | `/traces?view=replay` |
| `/debugger`, `/observability/time-travel` | `/traces?view=debug` |
| `/fleet` | `/agents?tab=fleet` |
| `/llmops` | `/optimization` |
| `/profile` | `/settings?tab=account` |
| `/billing` | `/settings?tab=billing` |
| `/users` | `/analytics?tab=users` |
| `/insights`, `/tools` | `/analytics?tab=…` |
| `/signals` | `/alerts?tab=signals` |
| `/datasets`, `/labeling`, `/studio`, `/synthetic`, `/observability/eval` | `/evals?tab=…` |
| `/incidents` | `/issues?tab=incidents` |
| `/redteam` | `/guardrails?tab=redteam` |
| `/onboarding/*` | `/dashboard?onboarding=1` (skippable overlay) |

Orphan page trees deleted: onboarding wizard, pr-suggestions, closed-loop, autonomous, llmops, billing list, agents/eden inbox. Tab source pages (insights, tools, …) remain for dynamic import behind redirects.

### Unfinished non-core backends (unchanged)

Leave Phase-1-cut predict endpoints, HIPAA stubs, multimodal `None`, AgentBenchmarkRunner synthetics, spreadsheet AI stub as-is — do not rebuild.

---

## July 2026 bloat cut

### Cat 23 — Autonomous code modification (full removal)

| Removed | Reason | Replacement |
|---|---|---|
| `src/eden/code_change/` (~62 files) | Stub-heavy package; dual inbox with JSONL suggester; cluster scheduler disconnected from F29 issues | [N23](n23-recurring-improvement-agent.md) recurring improvement agent (spec) |
| `src/eden/api/routes/intelligence_code_change.py` (46 routes) | No portal consumers; `not_implemented` envelopes | `GET/POST /orgs/{id}/improve/plans` (N23) |
| Cat 23 cron (`code_change/scheduler.py`) | Overlapped N20 weekly optimization without issue context | Per-org `improvement_schedule_cron` (N23) |

**Salvaged modules** (moved to `src/eden/improvement/`):

- `issue_patch_trigger.py` — issue → plan enqueue
- `patch_generator.py` — unified diff generation
- `pr_creator.py` — GitHub PR via `PRProvider`

**F22 chat removed in W26** (was briefly salvaged then deleted — see § July 2026 SOTA W26).

**Legacy DB tables preserved (read-only):** `proposed_patches`, `pr_rejection_memory`. New writes target `improvement_plans` (N23).

### Portal routes — nav-hidden or redirected (moderate cut)

| Route | Action | Redirect / notes |
|---|---|---|
| `/observability/apm` | Nav removed | Redirect to `/traces` |
| `/users` | Nav removed | Tab under Analytics |
| `/synthetic` | Nav removed | Tab under Evals |
| `/redteam` | Nav removed | Tab under Guardrails |
| `/billing` | Merged | Settings → Billing |
| `/closed-loop`, `/autonomous` | Redirect | `/improve` |
| `/pr-suggestions` | Superseded | `/improve?tab=plans` |
| `/onboarding/*` | Deleted | Dashboard overlay |

### P2 competitor-parity specs — archived

Moved to [`../archive/`](../archive/) (not on execution roadmap): F59, F63, F67, F69, F72, F77, F78, F80.

---

## Restored as N-features (high value returned)

| Deleted | Restored as | Why restored |
|---|---|---|
| F11 Trace deduplication | **N09** | Enterprise storage cost + query speed |
| F36 Deep search → classifier | **N10** | Raindrop conversion UX |
| F10 Local dev server | **N11** Live streaming | Real-time debug without OSS Workshop |
| F17 Session timeline UI | **N12** | Sentrial session-first parity |
| F38 Transcript UI v2 | **N13** | Demo-quality portal UX |

## Still deleted (low incremental value)

F13–F16, F18, F19, F24, F25, F31, F32, F43 — see prior rationale.

---

## Full inventory

### F-features (24 active + 8 archived)
F01, F03, F04, F06, F09, F12, F20, F21, F22, F23, F28, F29, F30, F33, F34, F35, F39, F40, F41, F42, F44, F46, F47, F48 (+ F49–F85 eval/portal band; archived set above)

### N-features (14)
N01–N13, N14–N23 (N20 inbox superseded by N23; Cat 23 retired)

---

## Performance requirement

All surviving and restored specs include **§ Performance & cost optimization** per [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).

---

*Git history for deleted files: `git show 5b3da62:docs/specs/features/fXX-*.md`*
